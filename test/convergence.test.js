'use strict';

/**
 * Convergence primitives, exercised against the real broker.
 *
 * Kafka cannot delete individual records, so a test that writes to the live bus
 * is a test that permanently pollutes it — twice already this repo has needed a
 * manual cleanup pass for exactly that. Instead every run stands up its own
 * topic namespace via AGORA_TOPIC_PREFIX and drops it afterwards. The code
 * under test is the shipped CLI, unmodified, talking to a real Redpanda.
 *
 *   node --test test/
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const CLI = path.resolve(__dirname, '..', 'bin', 'agora');
const CONTAINER = process.env.AGORA_CONTAINER || 'agora-redpanda';
const PREFIX = `test-${crypto.randomBytes(3).toString('hex')}.`;

function agora(...args) {
  return agoraOn(PREFIX, ...args);
}

function agoraOn(prefix, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGORA_TOPIC_PREFIX: prefix },
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

before(() => {
  const r = agora('topics', '--ensure');
  assert.strictEqual(r.code, 0, `topic setup failed: ${r.err}`);
}, { timeout: 60000 });

after(() => {
  for (const t of ['threads', 'edits', 'claims', 'decisions', 'presence', 'index']) {
    spawnSync('docker', ['exec', CONTAINER, 'rpk', 'topic', 'delete', PREFIX + t],
      { encoding: 'utf8' });
  }
});

const opts = { timeout: 120000 };

test('topics --ensure creates every topic the protocol needs', opts, () => {
  const r = agora('topics');
  assert.strictEqual(r.code, 0);
  assert.ok(!/MISSING/.test(r.out), r.out);
  assert.strictEqual((r.out.match(/^ok /gm) || []).length, 6);
});

test('open with nothing to match creates the thread and indexes it', opts, () => {
  const r = agora('open', '--as', 'a1', '--title', 'Hop cap should be per thread',
    '--paths', 'README.md', '-m', 'Opening: the cap is global and should not be.');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /OPENED\s+th-hop-cap-should-be-per/);
  assert.match(r.out, /sent REQUEST_REVIEW/);

  const l = agora('list');
  assert.match(l.out, /OPEN\s+th-hop-cap-should-be-per/);
  assert.match(l.out, /paths: README\.md/);
  assert.match(l.out, /\[a1\]/);
});

test('the same intent twice yields a candidate, not a second thread', opts, () => {
  const r = agora('open', '--as', 'a2', '--title', 'Hop cap should be per thread',
    '--paths', 'README.md');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /CANDIDATES \(1\)/);
  assert.match(r.out, /exact/);
  assert.match(r.out, /the derived thread id is this thread/);
  assert.match(r.out, /Nothing was created/);

  // and it really did not create one
  const l = agora('list', '--json');
  const rows = JSON.parse(l.out);
  assert.strictEqual(rows.filter((d) => d.thread === 'th-hop-cap-should-be-per').length, 1);
});

test('declining the thread your own title derives is refused as the no-op it is', opts, () => {
  const r = agora('open', '--as', 'a2', '--title', 'Hop cap should be per thread',
    '--decline', 'th-hop-cap-should-be-per', '--reason', 'not really a different question');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /is the id this intent derives/);
  assert.match(r.err, /Change --title/);
});

test('declining requires a reason', opts, () => {
  const r = agora('open', '--as', 'a2', '--title', 'Rendering of the hop cap doc',
    '--decline', 'th-hop-cap-should-be-per');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /--reason/);
});

test('a declined candidate is recorded as DIVERGE and the new thread opens', opts, () => {
  const r = agora('open', '--as', 'a2', '--title', 'Rendering of the hop cap doc',
    '--paths', 'README.md',
    '--decline', 'th-hop-cap-should-be-per',
    '--reason', 'That thread is settling the cap. This is about how the doc renders it.',
    '-m', 'Different question.');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /1 declined on the record/);
  assert.match(r.out, /OPENED\s+th-rendering-of-the-hop-cap/);

  const l = agora('list', '--diverges');
  assert.match(l.out, /DIVERGE\s+th-rendering-of-the-hop-cap declined th-hop-cap-should-be-per/);
  assert.match(l.out, /how the doc renders it/);
});

test('a path overlap is offered but does not block — fragmentation is the recoverable failure', opts, () => {
  const r = agora('open', '--as', 'a3', '--title', 'Totally unrelated subject entirely',
    '--paths', 'README.md', '-m', 'Opening a genuinely different thread.');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /OPENED\s+th-totally-unrelated-subject-entirely/);
  assert.match(r.out, /candidate.* considered/);
});

test('list --path answers "is anyone already talking about this file"', opts, () => {
  const r = agora('list', '--path', 'README.md', '--json');
  const rows = JSON.parse(r.out);
  assert.ok(rows.length >= 3, `expected several threads citing README.md, got ${rows.length}`);
  for (const d of rows) assert.ok(d.paths.includes('README.md'));

  const none = agora('list', '--path', 'docs/protocol.md', '--json');
  assert.deepStrictEqual(JSON.parse(none.out), []);
});

test('read is observation, not participation', opts, () => {
  const r = agora('read', 'th-hop-cap-should-be-per', '--as', 'a9');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /REQUEST_REVIEW/);
  assert.match(r.out, /not a participant until you post/);

  // a9 read it and is still not listed as a participant
  const l = agora('list', '--agent', 'a9', '--json');
  assert.deepStrictEqual(JSON.parse(l.out), []);
});

test('claim denial names the conversation instead of only refusing', opts, () => {
  assert.strictEqual(agora('claim', 'README.md', '--as', 'a1').code, 0);
  const r = agora('claim', 'README.md', '--as', 'a2');
  assert.strictEqual(r.code, 75);
  assert.match(r.err, /DENIED/);
  assert.match(r.err, /discussing in th-/);
  assert.match(r.err, /agora read th-/);
  assert.strictEqual(agora('release', 'README.md', '--as', 'a1').code, 0);
});

test('an unleased edit warns about the open thread that cites the path', opts, () => {
  const r = agora('edit', 'README.md', '--as', 'a4', '-m', 'touched it');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /no lease held/);
  assert.match(r.err, /is open and cites README\.md/);
});

test('say SUPERSEDE is refused and points at the command that needs a target', opts, () => {
  const r = agora('say', 'SUPERSEDE', '--as', 'a1', '--thread', 'th-hop-cap-should-be-per',
    '-m', 'x');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /agora supersede --thread <source> --into <target>/);
});

test('supersede refuses the degenerate and the impossible', opts, () => {
  const self = agora('supersede', '--as', 'a1', '--thread', 'th-x', '--into', 'th-x');
  assert.strictEqual(self.code, 65);
  assert.match(self.err, /cannot supersede itself/);

  const ghost = agora('supersede', '--as', 'a1', '--thread', 'th-nope', '--into',
    'th-hop-cap-should-be-per');
  assert.strictEqual(ghost.code, 65);
  assert.match(ghost.err, /no such thread: th-nope/);
});

test('supersede links two threads and read follows the pointer', opts, () => {
  const r = agora('supersede', '--as', 'a3', '--thread', 'th-totally-unrelated-subject-entirely',
    '--into', 'th-hop-cap-should-be-per', '-m', 'Same subject after all.');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /SUPERSEDE\s+th-totally-unrelated-subject-entirely → th-hop-cap-should-be-per/);
  assert.match(r.out, /budgets do not sum/);

  const src = agora('list', '--all', '--json');
  const rows = JSON.parse(src.out);
  const from = rows.find((d) => d.thread === 'th-totally-unrelated-subject-entirely');
  const into = rows.find((d) => d.thread === 'th-hop-cap-should-be-per');
  assert.strictEqual(from.status, 'superseded');
  assert.strictEqual(from.superseded_by, 'th-hop-cap-should-be-per');
  assert.ok(into.absorbed.includes('th-totally-unrelated-subject-entirely'));

  // the merged thread's evidence is readable from the target, unmoved
  const read = agora('read', 'th-hop-cap-should-be-per');
  assert.match(read.out, /Opening a genuinely different thread/);
  assert.match(read.out, /absorbed: th-totally-unrelated-subject-entirely/);
});

test('a superseded thread is closed to further conversation', opts, () => {
  const r = agora('say', 'COMMENT', '--as', 'a3',
    '--thread', 'th-totally-unrelated-subject-entirely', '-m', 'one more thing');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /is closed \(SUPERSEDE/);
});

test('opening onto a settled thread\'s derived id is refused, and its descriptor stays honest', opts, () => {
  // Found in review: the matcher only ranks open threads, so a settled thread
  // never blocked its own id. `open` then rewrote its descriptor to "open" and
  // printed OPENED immediately before the post was refused — a phantom open
  // thread in every future `list`, offered as a candidate nobody can post to.
  agora('open', '--as', 'a5', '--title', 'Question already settled once', '-m', 'opening');
  agora('say', 'RESOLVE', '--as', 'a5', '--thread', 'th-question-already-settled-once', '-m', 'done');

  const r = agora('open', '--as', 'a6', '--title', 'Question already settled once',
    '-m', 'a second run at it');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /already settled \(RESOLVE/);
  assert.match(r.err, /agora read th-question-already-settled-once/);
  assert.ok(!/OPENED/.test(r.out), 'must not claim to have opened anything');

  const d = JSON.parse(agora('list', '--all', '--json').out)
    .find((x) => x.thread === 'th-question-already-settled-once');
  assert.strictEqual(d.status, 'resolved', 'descriptor must not be rewritten to open');
});

test('bare --join is refused with usage, not treated as a thread named "true"', opts, () => {
  const r = agora('open', '--as', 'a6', '--join');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /--join needs a thread id/);
});

test('you cannot merge into a settled thread', opts, () => {
  agora('open', '--as', 'a5', '--title', 'Settled subject here', '-m', 'opening');
  agora('say', 'RESOLVE', '--as', 'a5', '--thread', 'th-settled-subject-here', '-m', 'done');
  agora('open', '--as', 'a6', '--title', 'Live subject here', '-m', 'opening');

  const r = agora('supersede', '--as', 'a6', '--thread', 'th-live-subject-here',
    '--into', 'th-settled-subject-here');
  assert.strictEqual(r.code, 65);
  assert.match(r.err, /cannot merge into a settled thread/);
});

test('reindex rebuilds descriptors for threads opened without open', opts, () => {
  const raw = agora('say', 'REQUEST_REVIEW', '--as', 'a7', '--thread', 'th-legacy-slug',
    '-m', 'Opened the old way, by naming a slug into existence.',
    '--ref', 'docs/protocol.md');
  assert.strictEqual(raw.code, 0, raw.err);

  const r = agora('reindex');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /indexed th-legacy-slug/);

  const l = agora('list', '--path', 'docs/protocol.md', '--json');
  const rows = JSON.parse(l.out);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].thread, 'th-legacy-slug');
  assert.deepStrictEqual(rows[0].participants, ['a7']);
});

test('a work item derives the thread id rather than a slug', opts, () => {
  const r = agora('open', '--as', 'a8', '--title', 'Anything at all',
    '--work-item', 'ERA-8397', '-m', 'opening');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /OPENED\s+thread:\/\/work\/ERA-8397/);

  // a different agent, a different title, the same item — same thread, by arithmetic
  const again = agora('open', '--as', 'a9', '--title', 'Completely different words',
    '--work-item', 'ERA-8397');
  assert.match(again.out, /CANDIDATES \(1\)/);
  assert.match(again.out, /the derived thread id is this thread/);
});

/* ── read integrity ────────────────────────────────────────────────────
 *
 * `rpk topic consume -o :end` was observed returning early and exiting 0 — a
 * topic holding 191 records answered 142 on one call and 191 on the next. Every
 * guarantee above folds over readAll, so a short read is not a degraded answer,
 * it is a confidently wrong one: a thread that exists looks absent and the
 * agent opens the duplicate this whole feature exists to prevent.
 */

test('a read is complete, and stays complete across repeated calls', opts, () => {
  const before = JSON.parse(agora('list', '--all', '--json').out).length;
  for (let i = 0; i < 4; i++) {
    agora('open', '--as', 'r1', '--title', `Integrity probe number ${i} here`,
      '-m', `probe ${i}`);
  }
  const expected = before + 4;

  // Ten reads, every one of them whole. Before the fix this was a coin flip.
  for (let i = 0; i < 10; i++) {
    const r = agora('list', '--all', '--json');
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(JSON.parse(r.out).length, expected,
      `read ${i} returned a different number of threads — short read`);
    assert.ok(!/short read/.test(r.err), `read ${i} needed a retry: ${r.err}`);
  }
});

test('a write is visible to the very next read in the same process', opts, () => {
  // The read cache is invalidated by produce, or `open` would rank against a
  // stale index and refreshDescriptor would write back a descriptor missing the
  // message that triggered it.
  const r = agora('open', '--as', 'r2', '--title', 'Cache invalidation check here',
    '-m', 'first');
  assert.strictEqual(r.code, 0, r.err);
  const d = JSON.parse(agora('list', '--all', '--json').out)
    .find((x) => x.thread === 'th-cache-invalidation-check-here');
  assert.ok(d, 'thread missing from the index immediately after open');
  assert.deepStrictEqual(d.participants, ['r2']);
  assert.strictEqual(d.hop, 1);
});

test('a topic that does not exist is empty, not fatal', opts, () => {
  // doctor on a fresh install has to be able to report the topics are missing
  // rather than dying on the way to reporting it.
  const r = agoraOn('test-absent-none.', 'doctor');
  assert.strictEqual(r.code, 69);
  assert.match(r.out, /MISSING/);
  assert.match(r.out, /agora topics --ensure/);
  assert.ok(!/short read|refusing to answer/.test(r.err), r.err);
});

test('an unreachable broker is refused, not answered from nothing', opts, () => {
  const res = spawnSync(process.execPath, [CLI, 'list'], {
    encoding: 'utf8',
    env: { ...process.env, AGORA_TOPIC_PREFIX: PREFIX, AGORA_CONTAINER: 'no-such-container' },
  });
  assert.strictEqual(res.status, 69);
});
