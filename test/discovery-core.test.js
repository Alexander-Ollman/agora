'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NOW = new Date('2026-09-07T12:00:00.000Z');
const ISSUED = '2026-09-07T11:00:00.000Z';
const EXPIRES = '2026-09-07T13:00:00.000Z';
const RFC3339_SCHEMA_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$';

const load = Promise.all([
  import('../lib/discovery/contracts.mjs'),
  import('../lib/discovery/rank.mjs'),
  import('../lib/discovery/adapter.mjs'),
  import('../lib/discovery/in-memory.mjs'),
]);

function common(kind, overrides = {}) {
  return {
    v: 1,
    kind,
    topicFacets: ['systems:distributed'],
    stableRefs: ['work://example/shared-topic'],
    capabilityFacets: ['review'],
    keywords: ['consensus'],
    contactModes: kind === 'controller_route' ? ['ask'] : kind === 'agent' ? ['direct_message'] : ['observe', 'request_join'],
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    sourceVersion: 'fixture-1',
    ...overrides,
  };
}

function route(id = 'alpha', overrides = {}) {
  return common('controller_route', {
    routeId: `route://hosted/${id}`,
    handle: id,
    authorityId: 'authority://hosted.example',
    ...overrides,
  });
}

function agent(id = 'alpha', overrides = {}) {
  return common('agent', {
    principalId: `agent://local.example/${id}`,
    handle: id,
    authorityId: 'authority://local.example',
    ...overrides,
  });
}

function thread(id = 'shared', overrides = {}) {
  return common('thread', {
    threadId: `thread://network/${id}`,
    title: 'Distributed systems review',
    authorityId: 'authority://network.example',
    status: 'open',
    joinMode: 'request',
    memberCount: 2,
    descriptorVersion: 1,
    ...overrides,
  });
}

function record(card, overrides = {}) {
  return { card, optedIn: true, visibility: 'public', visibleTo: [], ...overrides };
}

function query(overrides = {}) {
  return {
    v: 1,
    kinds: ['controller_route', 'agent', 'thread'],
    topicFacets: ['systems:distributed'],
    stableRefs: ['work://example/shared-topic'],
    capabilityFacets: ['review'],
    textTokens: ['consensus'],
    limit: 100,
    ...overrides,
  };
}

function access(id = 'one') {
  return { requesterId: `agent://local.example/${id}` };
}

test('published schemas are closed JSON Schema 2020-12 documents', () => {
  for (const file of ['DiscoveryCardV1.schema.json', 'DiscoveryQueryV1.schema.json', 'DiscoveryPageV1.schema.json']) {
    const schema = JSON.parse(readFileSync(path.join(ROOT, 'schema', file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^urn:agora:discovery:v1:/);
  }
  const page = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'DiscoveryPageV1.schema.json'), 'utf8'));
  assert.equal(page.additionalProperties, false);
  assert.equal(page.properties.items.items.additionalProperties, false);
  assert.equal(page.properties.items.items.properties.evidence.items.oneOf.length, 3);
  assert.equal(page.$defs.stableRefEvidence.additionalProperties, false);
  assert.equal(page.properties.items.items.properties.action.const, 'suggest_only');
  assert.equal(page.properties.items.items.properties.authorization.const, 'required');
  assert.equal(page.properties.items.items.properties.participation.const, 'unverified');
  const card = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'DiscoveryCardV1.schema.json'), 'utf8'));
  assert.equal(card.$defs.common.properties.issuedAt.pattern, RFC3339_SCHEMA_PATTERN);
  assert.equal(card.$defs.uri.pattern, '^[a-z][a-z0-9+.-]*://[!-~]{1,240}$');
  assert.equal(card.$defs.controllerRoute.allOf[1].properties.routeId.pattern, '^route://[!-~]{1,240}$');
  assert.equal(card.$defs.agent.allOf[1].properties.principalId.pattern, '^agent://[!-~]{1,240}$');
  assert.equal(card.$defs.thread.allOf[1].properties.threadId.pattern, '^thread://[!-~]{1,239}$');
  assert.equal(card.$defs.thread.allOf[1].properties.title.maxLength, 256);
  assert.equal(card.$defs.thread.allOf[1].properties.title.pattern, '^[^\\u0000-\\u001f\\u007f]+$');
  const querySchema = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'DiscoveryQueryV1.schema.json'), 'utf8'));
  assert.equal(querySchema.$defs.uris.items.pattern, card.$defs.uri.pattern);
  assert.equal(page.$defs.stableRefEvidence.properties.value.pattern, card.$defs.uri.pattern);
  assert.equal(page.properties.observedAt.pattern, RFC3339_SCHEMA_PATTERN);
});

test('cards accept portable owner-defined facets and stable references', async () => {
  const [{ validateDiscoveryCard }] = await load;
  const card = validateDiscoveryCard(agent('portable', {
    topicFacets: ['climate:modeling', 'owner.example/custom-topic'],
    stableRefs: ['ticket://another-system/42'],
    capabilityFacets: ['simulation'],
  }));
  assert.deepEqual(card.topicFacets, ['climate:modeling', 'owner.example/custom-topic']);
  assert.deepEqual(card.stableRefs, ['ticket://another-system/42']);
});

test('public URI fields share printable ASCII schema and runtime bounds', async (t) => {
  const [{ validateDiscoveryAccess, validateDiscoveryCard, validateDiscoveryPage, validateDiscoveryQuery, validateDiscoveryRecord, DiscoveryValidationError }, { rankDiscoveryCards }] = await load;
  const maximumUri = `${'a'.repeat(13)}://${'x'.repeat(240)}`;
  assert.equal(maximumUri.length, 256);
  assert.equal(validateDiscoveryCard(route('minimum', { routeId: 'route://x', authorityId: maximumUri })).routeId, 'route://x');
  assert.equal(validateDiscoveryCard(agent('minimum', { principalId: 'agent://x' })).principalId, 'agent://x');
  assert.equal(validateDiscoveryCard(thread('minimum', { threadId: 'thread://x' })).threadId, 'thread://x');

  const page = rankDiscoveryCards(query({ kinds: ['agent'] }), [agent()], { now: NOW });
  const invalidCases = (invalidUri) => [
    () => validateDiscoveryCard(route('route-uri', { routeId: `route://${invalidUri}` })),
    () => validateDiscoveryCard(agent('agent-uri', { principalId: `agent://${invalidUri}` })),
    () => validateDiscoveryCard(thread('thread-uri', { threadId: `thread://${invalidUri}` })),
    () => validateDiscoveryCard(agent('authority-uri', { authorityId: `authority://${invalidUri}` })),
    () => validateDiscoveryCard(agent('stable-ref', { stableRefs: [`work://${invalidUri}`] })),
    () => validateDiscoveryRecord(record(agent(), { visibility: 'restricted', visibleTo: [`agent://${invalidUri}`] })),
    () => validateDiscoveryAccess({ requesterId: `agent://${invalidUri}` }),
    () => validateDiscoveryQuery(query({ stableRefs: [`work://${invalidUri}`] })),
    () => validateDiscoveryPage({
      v: 1,
      items: [{ ...page[0], evidence: [{ kind: 'stable_ref', value: `work://${invalidUri}` }] }],
      nextCursor: null,
      observedAt: NOW.toISOString(),
    }),
  ];
  for (const [name, invalidUri] of [['unicode', 'é'], ['control', '\u0001']]) {
    await t.test(name, () => {
      for (const reject of invalidCases(invalidUri)) {
        assert.throws(reject, DiscoveryValidationError);
      }
    });
  }
});

test('cards reject private or credential-like extension fields', async (t) => {
  const [{ validateDiscoveryCard, DiscoveryValidationError }] = await load;
  for (const field of ['workspaceId', 'sessionId', 'message', 'path', 'token']) {
    await t.test(field, () => {
      assert.throws(() => validateDiscoveryCard({ ...agent(), [field]: 'private' }), (error) =>
        error instanceof DiscoveryValidationError && error.code === 'invalid_shape');
    });
  }
});

test('kind-specific contact modes are closed', async () => {
  const [{ validateDiscoveryCard, DiscoveryValidationError }] = await load;
  assert.throws(() => validateDiscoveryCard(agent('alpha', { contactModes: ['direct_message', 'ask'] })), (error) =>
    error instanceof DiscoveryValidationError && error.pointer === '/contactModes');
  assert.throws(() => validateDiscoveryCard(route('alpha', { contactModes: ['direct_message'] })), (error) =>
    error instanceof DiscoveryValidationError && error.pointer === '/contactModes');
  assert.throws(() => validateDiscoveryCard(thread('alpha', { contactModes: ['ask'] })), (error) =>
    error instanceof DiscoveryValidationError && error.pointer === '/contactModes');
});

test('visibility records reject ambiguous policy state', async () => {
  const [{ validateDiscoveryRecord, DiscoveryValidationError }] = await load;
  assert.throws(() => validateDiscoveryRecord(record(agent(), { visibleTo: [access().requesterId] })), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'invalid_visibility');
  assert.throws(() => validateDiscoveryRecord(record(agent(), { visibility: 'restricted' })), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'invalid_visibility');
});

test('queries reject empty, duplicate, oversized, and unknown inputs', async (t) => {
  const [{ validateDiscoveryQuery, DiscoveryValidationError }] = await load;
  const cases = [
    query({ topicFacets: [], stableRefs: [], capabilityFacets: [], textTokens: [] }),
    query({ kinds: ['agent', 'agent'] }),
    query({ limit: 101 }),
    { ...query(), authority: 'caller-controlled' },
  ];
  for (const [index, value] of cases.entries()) {
    await t.test(String(index), () => assert.throws(() => validateDiscoveryQuery(value), DiscoveryValidationError));
  }
});

test('ranker orders exact, strong, and weak matches with stable evidence', async () => {
  const [, { rankDiscoveryCards }] = await load;
  const cards = [
    agent('weak', { topicFacets: [], stableRefs: [], capabilityFacets: [], keywords: ['consensus'] }),
    agent('strong', { stableRefs: [], keywords: [] }),
    agent('exact'),
  ];
  const ranked = rankDiscoveryCards(query({ kinds: ['agent'] }), cards, { now: NOW });
  assert.deepEqual(ranked.map((item) => [item.card.handle, item.rank]), [
    ['exact', 'exact'],
    ['strong', 'strong'],
    ['weak', 'weak'],
  ]);
  assert.deepEqual(ranked[0].evidence.map((item) => item.kind), [
    'stable_ref', 'topic_facet', 'capability_facet', 'text_token',
  ]);
});

test('ranker rejects duplicate card identities and stabilizes ties by identity', async () => {
  const [{ DiscoveryValidationError }, { rankDiscoveryCards }] = await load;
  const left = agent('alpha', { stableRefs: [], capabilityFacets: [], keywords: [] });
  const right = agent('beta', { stableRefs: [], capabilityFacets: [], keywords: [] });
  const tiedQuery = query({ kinds: ['agent'], stableRefs: [], capabilityFacets: [], textTokens: [] });
  assert.deepEqual(rankDiscoveryCards(tiedQuery, [right, left], { now: NOW }).map((item) => item.card.handle), ['alpha', 'beta']);
  assert.throws(() => rankDiscoveryCards(tiedQuery, [left, left], { now: NOW }), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'duplicate_card');
});

test('adapter filters opt-out, caller visibility, future, and expired cards before ranking', async () => {
  const [, , , { InMemoryDiscoveryAdapter }] = await load;
  const requester = access('allowed');
  const adapter = new InMemoryDiscoveryAdapter({
    now: () => NOW,
    records: [
      record(agent('public-strong', { stableRefs: [] })),
      record(agent('opted-out'), { optedIn: false }),
      record(agent('private'), { visibility: 'restricted', visibleTo: [access('other').requesterId] }),
      record(agent('allowed'), { visibility: 'restricted', visibleTo: [requester.requesterId] }),
      record(agent('future', { issuedAt: '2026-09-07T12:01:00.000Z', expiresAt: '2026-09-07T13:01:00.000Z' })),
      record(agent('expired', { issuedAt: '2026-09-07T10:00:00.000Z', expiresAt: '2026-09-07T12:00:00.000Z' })),
    ],
  });
  const page = await adapter.search(query({ kinds: ['agent'] }), requester);
  assert.deepEqual(page.items.map((item) => item.card.handle), ['allowed', 'public-strong']);
  assert.ok(page.items.every((item) => !Object.hasOwn(item.card, 'visibleTo')));
});

test('expiry uses the injected clock at the boundary', async () => {
  const [{ validateDiscoveryCard, DiscoveryValidationError }] = await load;
  validateDiscoveryCard(agent(), { now: new Date('2026-09-07T12:59:59.999Z') });
  assert.throws(() => validateDiscoveryCard(agent('future', {
    issuedAt: '2026-09-07T12:00:00.001Z',
    expiresAt: '2026-09-07T13:00:00.001Z',
  }), { now: NOW }), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'card_not_current');
  assert.throws(() => validateDiscoveryCard(agent(), { now: new Date(EXPIRES) }), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'card_expired');
  assert.throws(() => validateDiscoveryCard(agent(), { now: () => new Date('invalid') }), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'invalid_clock');
});

test('date-time validation matches the RFC3339 UTC schema boundary', async () => {
  const [{ validateDiscoveryCard, DiscoveryValidationError }] = await load;
  assert.throws(() => validateDiscoveryCard(agent('loose-date', {
    issuedAt: 'September 7, 2026 11:00 UTC',
  })), (error) => error instanceof DiscoveryValidationError && error.pointer === '/issuedAt');
  assert.throws(() => validateDiscoveryCard(agent('offset-date', {
    issuedAt: '2026-09-07T11:00:00-01:00',
  })), (error) => error instanceof DiscoveryValidationError && error.pointer === '/issuedAt');
  assert.throws(() => validateDiscoveryCard(agent('calendar-date', {
    issuedAt: '2026-02-30T11:00:00Z',
  })), (error) => error instanceof DiscoveryValidationError && error.pointer === '/issuedAt');
  assert.throws(() => validateDiscoveryCard(agent('fraction-date', {
    issuedAt: '2026-09-07T11:00:00.1234567890Z',
  })), (error) => error instanceof DiscoveryValidationError && error.pointer === '/issuedAt');
});

test('thread title validation matches the schema character and control bounds', async () => {
  const [{ validateDiscoveryCard, DiscoveryValidationError }] = await load;
  assert.equal(validateDiscoveryCard(thread('unicode', { title: 'é'.repeat(256) })).title.length, 256);
  assert.throws(() => validateDiscoveryCard(thread('long-title', { title: 'é'.repeat(257) })), (error) =>
    error instanceof DiscoveryValidationError && error.pointer === '/title');
  assert.throws(() => validateDiscoveryCard(thread('control-title', { title: 'line one\nline two' })), (error) =>
    error instanceof DiscoveryValidationError && error.pointer === '/title');
});

test('pagination is deterministic, repeatable, and query-bound', async () => {
  const [{ DiscoveryValidationError }, , , { InMemoryDiscoveryAdapter }] = await load;
  const adapter = new InMemoryDiscoveryAdapter({
    now: () => NOW,
    records: ['delta', 'beta', 'alpha', 'charlie'].map((id) => record(agent(id))),
  });
  const first = await adapter.search(query({ kinds: ['agent'], limit: 2 }), access());
  assert.deepEqual(first.items.map((item) => item.card.handle), ['alpha', 'beta']);
  assert.equal(typeof first.nextCursor, 'string');
  const continuation = query({ kinds: ['agent'], limit: 2, cursor: first.nextCursor });
  const second = await adapter.search(continuation, access());
  const repeated = await adapter.search(continuation, access());
  assert.deepEqual(second, repeated);
  assert.deepEqual(second.items.map((item) => item.card.handle), ['charlie', 'delta']);
  assert.equal(second.nextCursor, null);
  await assert.rejects(() => adapter.search({ ...continuation, textTokens: [] }, access()), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'cursor_query_mismatch');
});

test('a cursor fails closed when the visible snapshot changes', async () => {
  const [{ DiscoveryValidationError }, , , { InMemoryDiscoveryAdapter }] = await load;
  const firstAdapter = new InMemoryDiscoveryAdapter({ now: () => NOW, records: ['alpha', 'beta'].map((id) => record(agent(id))) });
  const first = await firstAdapter.search(query({ kinds: ['agent'], limit: 1 }), access());
  const changedAdapter = new InMemoryDiscoveryAdapter({ now: () => NOW, records: ['alpha', 'charlie'].map((id) => record(agent(id))) });
  await assert.rejects(() => changedAdapter.search(query({ kinds: ['agent'], limit: 1, cursor: first.nextCursor }), access()), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'cursor_stale');
});

test('maximum-length identities produce bounded deterministic cursors', async () => {
  const [, , , { InMemoryDiscoveryAdapter }] = await load;
  const longAgent = (suffix) => agent(suffix, {
    principalId: `agent://${'a'.repeat(239)}${suffix}`,
    handle: `h${suffix}`,
    sourceVersion: 's'.repeat(64),
  });
  const adapter = new InMemoryDiscoveryAdapter({
    now: () => NOW,
    records: [record(longAgent('x')), record(longAgent('y'))],
  });
  const first = await adapter.search(query({ kinds: ['agent'], limit: 1 }), access());
  assert.ok(first.nextCursor.length <= 512);
  const second = await adapter.search(query({ kinds: ['agent'], limit: 1, cursor: first.nextCursor }), access());
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
});

test('results remain suggestion-only and immutable', async () => {
  const [, , , { InMemoryDiscoveryAdapter }] = await load;
  const adapter = new InMemoryDiscoveryAdapter({ now: () => NOW, records: [record(route())] });
  const page = await adapter.search(query({ kinds: ['controller_route'] }), access());
  assert.deepEqual(Object.keys(page.items[0]).sort(), [
    'action', 'authorization', 'card', 'evidence', 'participation', 'rank', 'score', 'v',
  ]);
  assert.equal(page.items[0].action, 'suggest_only');
  assert.equal(page.items[0].authorization, 'required');
  assert.equal(page.items[0].participation, 'unverified');
  assert.ok(Object.isFrozen(page));
  assert.equal(typeof adapter.records, 'undefined');
  assert.equal(typeof adapter.send, 'undefined');
  assert.equal(typeof adapter.join, 'undefined');
});

test('two local agents find the same themed thread without joining or messaging', async () => {
  const [, , , { InMemoryDiscoveryAdapter }] = await load;
  const adapter = new InMemoryDiscoveryAdapter({ now: () => NOW, records: [record(thread())] });
  const themedQuery = query({ kinds: ['thread'], capabilityFacets: [], textTokens: [] });
  const one = await adapter.search(themedQuery, access('one'));
  const two = await adapter.search(themedQuery, access('two'));
  assert.equal(one.items[0].card.threadId, 'thread://network/shared');
  assert.equal(two.items[0].card.threadId, one.items[0].card.threadId);
  assert.equal(one.items[0].participation, 'unverified');
  assert.equal(typeof adapter.join, 'undefined');
  assert.equal(typeof adapter.send, 'undefined');
});

test('adapter port rejects missing search behavior', async () => {
  const [, , { assertDiscoveryAdapter }] = await load;
  assert.throws(() => assertDiscoveryAdapter({}), /must implement search/);
  assert.equal(assertDiscoveryAdapter({ search() {} }).search instanceof Function, true);
});

test('external adapter results pass through a strict public validator', async () => {
  const [{ DiscoveryValidationError }, , { searchDiscovery }, { InMemoryDiscoveryAdapter }] = await load;
  const valid = new InMemoryDiscoveryAdapter({ now: () => NOW, records: [record(agent())] });
  const page = await searchDiscovery(valid, query({ kinds: ['agent'] }), access());
  assert.equal(page.items[0].action, 'suggest_only');

  const leaking = {
    async search() {
      return { ...page, items: [{ ...page.items[0], sessionId: 'private' }] };
    },
  };
  await assert.rejects(() => searchDiscovery(leaking, query({ kinds: ['agent'] }), access()), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'invalid_shape');

  const lying = {
    async search() {
      return {
        ...page,
        items: [{
          ...page.items[0],
          rank: 'exact',
          score: 301000,
          evidence: [{ kind: 'stable_ref', value: 'work://example/not-on-card' }],
        }],
      };
    },
  };
  await assert.rejects(() => searchDiscovery(lying, query({ kinds: ['agent'] }), access()), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'invalid_result');

  const twoItems = new InMemoryDiscoveryAdapter({
    now: () => NOW,
    records: [record(agent('alpha')), record(agent('beta'))],
  });
  const oversizedPage = await twoItems.search(query({ kinds: ['agent'], limit: 2 }), access());
  await assert.rejects(() => searchDiscovery({ search: async () => oversizedPage }, query({ kinds: ['agent'], limit: 1 }), access()), (error) =>
    error instanceof DiscoveryValidationError && error.code === 'invalid_result' && error.pointer === '/items');
});

test('the executable example reports discovery only', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'examples', 'find-themed-thread.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'discovery_only');
  assert.equal(output.agentOne.threadId, output.agentTwo.threadId);
  assert.equal(output.agentOne.action, 'suggest_only');
  assert.equal(output.messagingPerformed, false);
});
