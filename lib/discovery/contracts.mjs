const URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,240}$/;
const FACET_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export const DISCOVERY_LIMITS = Object.freeze({
  cardsPerAdapter: 500,
  pageItems: 100,
  queryValues: 16,
  cardValues: 16,
  visiblePrincipals: 100,
  cursorBytes: 512,
  titleCharacters: 256,
});

export const DISCOVERY_CARD_KINDS = Object.freeze(['controller_route', 'agent', 'thread']);
export const DISCOVERY_RANKS = Object.freeze(['exact', 'strong', 'weak']);

/** @typedef {'controller_route'|'agent'|'thread'} DiscoveryCardKindV1 */
/** @typedef {'exact'|'strong'|'weak'} DiscoveryRankV1 */
/** @typedef {{requesterId: string}} DiscoveryAccessV1 */
/** @typedef {{v: 1, kinds: DiscoveryCardKindV1[], topicFacets: string[], stableRefs: string[], capabilityFacets: string[], textTokens: string[], limit: number, cursor?: string}} DiscoveryQueryV1 */
/** @typedef {{kind: 'stable_ref'|'topic_facet'|'capability_facet'|'text_token', value: string}} DiscoveryEvidenceV1 */
/** @typedef {{v: 1, card: object, rank: DiscoveryRankV1, score: number, evidence: DiscoveryEvidenceV1[], action: 'suggest_only', authorization: 'required', participation: 'unverified'}} DiscoverySuggestionV1 */
/** @typedef {{v: 1, items: DiscoverySuggestionV1[], nextCursor: string|null, observedAt: string}} DiscoveryPageV1 */

export class DiscoveryValidationError extends Error {
  constructor(code, pointer, message) {
    super(message);
    this.name = 'DiscoveryValidationError';
    this.code = code;
    this.pointer = pointer;
  }
}

function fail(code, pointer, message) {
  throw new DiscoveryValidationError(code, pointer, message);
}

function plainObject(value, pointer) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_type', pointer, 'expected an object');
  }
  return value;
}

function exactKeys(value, keys, pointer) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_shape', pointer, 'object keys do not match the closed contract');
  }
}

function literal(value, allowed, pointer) {
  if (!allowed.includes(value)) fail('invalid_value', pointer, 'value is outside the closed set');
  return value;
}

function integer(value, minimum, maximum, pointer) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('invalid_value', pointer, `expected an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedString(value, minimumBytes, maximumBytes, pointer, pattern) {
  if (typeof value !== 'string') fail('invalid_type', pointer, 'expected a string');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minimumBytes || bytes > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('invalid_value', pointer, 'string is outside its UTF-8 or control-character bound');
  }
  if (pattern && !pattern.test(value)) fail('invalid_value', pointer, 'string does not match its contract');
  return value;
}

function boundedUnicodeString(value, minimumCharacters, maximumCharacters, pointer) {
  if (typeof value !== 'string') fail('invalid_type', pointer, 'expected a string');
  const characters = [...value].length;
  if (characters < minimumCharacters || characters > maximumCharacters || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('invalid_value', pointer, 'string is outside its character or control-character bound');
  }
  return value;
}

function uniqueStringArray(value, maximum, pointer, pattern) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('invalid_type', pointer, `expected an array with at most ${maximum} items`);
  }
  const seen = new Set();
  return value.map((item, index) => {
    const checked = boundedString(item, 1, 256, `${pointer}/${index}`, pattern);
    if (seen.has(checked)) fail('duplicate_value', `${pointer}/${index}`, 'array values must be unique');
    seen.add(checked);
    return checked;
  });
}

function dateTime(value, pointer) {
  boundedString(value, 20, 64, pointer);
  const match = RFC3339_PATTERN.exec(value);
  if (!match) fail('invalid_value', pointer, 'expected an RFC3339 UTC date-time');
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) fail('invalid_value', pointer, 'expected an RFC3339 date-time');
  const parsed = new Date(instant);
  const expected = match.slice(1, 7).map(Number);
  const actual = [
    parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(),
    parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds(),
  ];
  if (actual.some((part, index) => part !== expected[index])) {
    fail('invalid_value', pointer, 'expected a valid RFC3339 calendar date');
  }
  return value;
}

function commonCard(input, kind) {
  const topicFacets = uniqueStringArray(input.topicFacets, DISCOVERY_LIMITS.cardValues, '/topicFacets', FACET_PATTERN);
  const stableRefs = uniqueStringArray(input.stableRefs, DISCOVERY_LIMITS.cardValues, '/stableRefs', URI_PATTERN);
  const capabilityFacets = uniqueStringArray(input.capabilityFacets, DISCOVERY_LIMITS.cardValues, '/capabilityFacets', FACET_PATTERN);
  const keywords = uniqueStringArray(input.keywords, DISCOVERY_LIMITS.cardValues, '/keywords', TOKEN_PATTERN);
  const contactModes = uniqueStringArray(input.contactModes, 4, '/contactModes');
  for (const [index, mode] of contactModes.entries()) {
    literal(mode, ['ask', 'direct_message', 'observe', 'request_join'], `/contactModes/${index}`);
  }
  const issuedAt = dateTime(input.issuedAt, '/issuedAt');
  const expiresAt = dateTime(input.expiresAt, '/expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail('invalid_expiry', '/expiresAt', 'expiresAt must be after issuedAt');
  }
  return {
    v: literal(input.v, [1], '/v'),
    kind,
    topicFacets,
    stableRefs,
    capabilityFacets,
    keywords,
    contactModes,
    issuedAt,
    expiresAt,
    sourceVersion: boundedString(input.sourceVersion, 1, 64, '/sourceVersion', VERSION_PATTERN),
  };
}

const COMMON_KEYS = [
  'v', 'kind', 'topicFacets', 'stableRefs', 'capabilityFacets', 'keywords',
  'contactModes', 'issuedAt', 'expiresAt', 'sourceVersion',
];

/** Validate one external discovery card and return a closed copy. */
export function validateDiscoveryCard(value, options = {}) {
  const input = plainObject(value, '');
  const kind = literal(input.kind, DISCOVERY_CARD_KINDS, '/kind');
  let card;
  if (kind === 'controller_route') {
    exactKeys(input, [...COMMON_KEYS, 'routeId', 'handle', 'authorityId'], '');
    card = {
      ...commonCard(input, kind),
      routeId: boundedString(input.routeId, 10, 256, '/routeId', /^route:\/\/[^\s]{1,240}$/),
      handle: boundedString(input.handle, 2, 64, '/handle', HANDLE_PATTERN),
      authorityId: boundedString(input.authorityId, 5, 256, '/authorityId', URI_PATTERN),
    };
    if (card.contactModes.length !== 1 || card.contactModes[0] !== 'ask') {
      fail('invalid_value', '/contactModes', 'controller routes support only ask');
    }
  } else if (kind === 'agent') {
    exactKeys(input, [...COMMON_KEYS, 'principalId', 'handle', 'authorityId'], '');
    card = {
      ...commonCard(input, kind),
      principalId: boundedString(input.principalId, 10, 256, '/principalId', /^agent:\/\/[^\s]{1,240}$/),
      handle: boundedString(input.handle, 2, 64, '/handle', HANDLE_PATTERN),
      authorityId: boundedString(input.authorityId, 5, 256, '/authorityId', URI_PATTERN),
    };
    if (card.contactModes.length !== 1 || card.contactModes[0] !== 'direct_message') {
      fail('invalid_value', '/contactModes', 'agent cards support only direct_message');
    }
  } else {
    exactKeys(input, [...COMMON_KEYS, 'threadId', 'title', 'authorityId', 'status', 'joinMode', 'memberCount', 'descriptorVersion'], '');
    card = {
      ...commonCard(input, kind),
      threadId: boundedString(input.threadId, 11, 256, '/threadId', /^thread:\/\/[^\s]{1,239}$/),
      title: boundedUnicodeString(input.title, 1, DISCOVERY_LIMITS.titleCharacters, '/title'),
      authorityId: boundedString(input.authorityId, 5, 256, '/authorityId', URI_PATTERN),
      status: literal(input.status, ['open', 'resolved', 'escalated', 'decided', 'superseded'], '/status'),
      joinMode: literal(input.joinMode, ['invite_only', 'request', 'closed'], '/joinMode'),
      memberCount: integer(input.memberCount, 0, 10000, '/memberCount'),
      descriptorVersion: integer(input.descriptorVersion, 1, Number.MAX_SAFE_INTEGER, '/descriptorVersion'),
    };
    for (const mode of card.contactModes) {
      if (!['observe', 'request_join'].includes(mode)) {
        fail('invalid_value', '/contactModes', 'thread cards support observe and request_join only');
      }
    }
  }

  if (options.now !== undefined) {
    const nowMs = readClock(options.now).getTime();
    if (Date.parse(card.issuedAt) > nowMs) {
      fail('card_not_current', '/issuedAt', 'discovery card is not current');
    }
    if (Date.parse(card.expiresAt) <= nowMs) {
      fail('card_expired', '/expiresAt', 'discovery card has expired');
    }
  }
  return deepFreeze(card);
}

/** Validate an adapter-private visibility record. It never leaves the adapter. */
export function validateDiscoveryRecord(value) {
  const input = plainObject(value, '');
  exactKeys(input, ['card', 'optedIn', 'visibility', 'visibleTo'], '');
  if (typeof input.optedIn !== 'boolean') fail('invalid_type', '/optedIn', 'expected a boolean');
  const visibility = literal(input.visibility, ['public', 'restricted'], '/visibility');
  const visibleTo = uniqueStringArray(input.visibleTo, DISCOVERY_LIMITS.visiblePrincipals, '/visibleTo', URI_PATTERN);
  if (visibility === 'public' && visibleTo.length !== 0) {
    fail('invalid_visibility', '/visibleTo', 'public records cannot contain an allow-list');
  }
  if (visibility === 'restricted' && visibleTo.length === 0) {
    fail('invalid_visibility', '/visibleTo', 'restricted records require an allow-list');
  }
  return deepFreeze({
    card: validateDiscoveryCard(input.card),
    optedIn: input.optedIn,
    visibility,
    visibleTo,
  });
}

/** Validate the trusted access context supplied by a deployment adapter. */
export function validateDiscoveryAccess(value) {
  const input = plainObject(value, '');
  exactKeys(input, ['requesterId'], '');
  return deepFreeze({
    requesterId: boundedString(input.requesterId, 5, 256, '/requesterId', URI_PATTERN),
  });
}

/** Validate one bounded discovery query. */
export function validateDiscoveryQuery(value) {
  const input = plainObject(value, '');
  const allowed = ['v', 'kinds', 'topicFacets', 'stableRefs', 'capabilityFacets', 'textTokens', 'limit', 'cursor'];
  const required = allowed.filter((key) => key !== 'cursor');
  const actual = Object.keys(input);
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) {
    fail('invalid_shape', '', 'query keys do not match the closed contract');
  }
  const kinds = uniqueStringArray(input.kinds, 3, '/kinds');
  if (kinds.length === 0) fail('invalid_value', '/kinds', 'query requires at least one card kind');
  for (const [index, kind] of kinds.entries()) literal(kind, DISCOVERY_CARD_KINDS, `/kinds/${index}`);
  const topicFacets = uniqueStringArray(input.topicFacets, DISCOVERY_LIMITS.queryValues, '/topicFacets', FACET_PATTERN);
  const stableRefs = uniqueStringArray(input.stableRefs, DISCOVERY_LIMITS.queryValues, '/stableRefs', URI_PATTERN);
  const capabilityFacets = uniqueStringArray(input.capabilityFacets, DISCOVERY_LIMITS.queryValues, '/capabilityFacets', FACET_PATTERN);
  const textTokens = uniqueStringArray(input.textTokens, DISCOVERY_LIMITS.queryValues, '/textTokens', TOKEN_PATTERN);
  if (topicFacets.length + stableRefs.length + capabilityFacets.length + textTokens.length === 0) {
    fail('invalid_value', '', 'query requires at least one discovery signal');
  }
  let cursor;
  if (input.cursor !== undefined) {
    cursor = boundedString(input.cursor, 1, DISCOVERY_LIMITS.cursorBytes, '/cursor', /^[A-Za-z0-9_-]+$/);
  }
  return deepFreeze({
    v: literal(input.v, [1], '/v'),
    kinds,
    topicFacets,
    stableRefs,
    capabilityFacets,
    textTokens,
    limit: integer(input.limit, 1, DISCOVERY_LIMITS.pageItems, '/limit'),
    ...(cursor ? { cursor } : {}),
  });
}

/** Validate one suggestion page returned by any discovery adapter. */
export function validateDiscoveryPage(value) {
  const input = plainObject(value, '');
  exactKeys(input, ['v', 'items', 'nextCursor', 'observedAt'], '');
  literal(input.v, [1], '/v');
  const observedAt = dateTime(input.observedAt, '/observedAt');
  if (!Array.isArray(input.items) || input.items.length > DISCOVERY_LIMITS.pageItems) {
    fail('invalid_type', '/items', `expected at most ${DISCOVERY_LIMITS.pageItems} suggestions`);
  }
  const seenCards = new Set();
  const items = input.items.map((value, index) => {
    const suggestion = plainObject(value, `/items/${index}`);
    exactKeys(suggestion, ['v', 'card', 'rank', 'score', 'evidence', 'action', 'authorization', 'participation'], `/items/${index}`);
    const card = validateDiscoveryCard(suggestion.card, { now: new Date(observedAt) });
    const cardKey = discoveryCardKey(card);
    if (seenCards.has(cardKey)) fail('duplicate_card', `/items/${index}/card`, 'page card IDs must be unique');
    seenCards.add(cardKey);
    if (!Array.isArray(suggestion.evidence) || suggestion.evidence.length < 1 || suggestion.evidence.length > 64) {
      fail('invalid_type', `/items/${index}/evidence`, 'evidence must contain from 1 through 64 records');
    }
    const seenEvidence = new Set();
    const evidence = suggestion.evidence.map((value, evidenceIndex) => {
      const item = plainObject(value, `/items/${index}/evidence/${evidenceIndex}`);
      exactKeys(item, ['kind', 'value'], `/items/${index}/evidence/${evidenceIndex}`);
      const kind = literal(item.kind, ['stable_ref', 'topic_facet', 'capability_facet', 'text_token'], `/items/${index}/evidence/${evidenceIndex}/kind`);
      const evidencePattern = kind === 'stable_ref' ? URI_PATTERN : kind === 'text_token' ? TOKEN_PATTERN : FACET_PATTERN;
      const evidenceValue = boundedString(item.value, 1, 256, `/items/${index}/evidence/${evidenceIndex}/value`, evidencePattern);
      const key = `${kind}:${evidenceValue}`;
      if (seenEvidence.has(key)) fail('duplicate_value', `/items/${index}/evidence/${evidenceIndex}`, 'evidence records must be unique');
      seenEvidence.add(key);
      return { kind, value: evidenceValue };
    });
    return {
      v: literal(suggestion.v, [1], `/items/${index}/v`),
      card,
      rank: literal(suggestion.rank, DISCOVERY_RANKS, `/items/${index}/rank`),
      score: integer(suggestion.score, 1, 399999, `/items/${index}/score`),
      evidence,
      action: literal(suggestion.action, ['suggest_only'], `/items/${index}/action`),
      authorization: literal(suggestion.authorization, ['required'], `/items/${index}/authorization`),
      participation: literal(suggestion.participation, ['unverified'], `/items/${index}/participation`),
    };
  });
  let nextCursor = null;
  if (input.nextCursor !== null) {
    nextCursor = boundedString(input.nextCursor, 1, DISCOVERY_LIMITS.cursorBytes, '/nextCursor', /^[A-Za-z0-9_-]+$/);
  }
  return deepFreeze({ v: 1, items, nextCursor, observedAt });
}

export function discoveryCardKey(card) {
  if (card.kind === 'controller_route') return `controller_route:${card.routeId}`;
  if (card.kind === 'agent') return `agent:${card.principalId}`;
  return `thread:${card.threadId}`;
}

export function readClock(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('invalid_clock', '/now', 'clock must return a valid Date');
  }
  return new Date(value.getTime());
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
