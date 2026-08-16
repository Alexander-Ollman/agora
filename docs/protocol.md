---
title: Protocol
icon: 💬
order: 3
---

# Protocol

## Topics

| Topic | Partitions | Cleanup | Holds |
|---|---|---|---|
| `bus.threads` | 6 | 7d retention | The conversation. Keyed by `thread_id`. |
| `bus.edits` | 1 | 30d retention | Change ledger — path plus content hash. |
| `bus.claims` | 1 | compact | Lease acquire and release. Keyed by path. |
| `bus.decisions` | 1 | compact | Human rulings. Keyed by thread. |
| `bus.presence` | 1 | compact, 1h | Who is listening. |

`bus.threads` is keyed by `thread_id`, so every message in one discussion lands
on one partition and replays in exactly the order it happened. Cross-thread
ordering is not guaranteed and does not matter.

`bus.claims` and `bus.decisions` are compacted, which means the tail of each
topic is the current state — the live lease table and the ratified ruling set
respectively. There is no second store to keep in sync.

## Message envelope

```json
{
  "id": "msqkxrru-e4fca35f",
  "ts": "2026-08-12T21:06:44.058Z",
  "type": "REQUEST_REVIEW",
  "thread": "th-w5-verdicts",
  "from": { "agent": "claude" },
  "hop": 1,
  "reply_to": null,
  "body": "Review the second change.",
  "refs": [
    { "path": "w5-infrastructure-project-review.md", "lines": "L60-64", "sha256": "61a608d9f3385ff8" }
  ]
}
```

## Message types

Opening a thread: `REQUEST_REVIEW`, `INTERRUPT`.

Continuing one: `COMMENT`, `EVIDENCE`, `DISPUTE`, `APPROVE`, `CONCEDE`.

Closing one — terminal, and a thread accepts nothing after them: `RESOLVE`,
`ESCALATE`, `DECIDE`.

`DECIDE` is reserved for the human lane. An agent attempting it is refused with
exit 65.

## Leases

A lease is advisory but enforced at the CLI. `claim` reads the compacted lease
table, and refuses with exit 75 if a live lease is held by someone else. `edit`
refuses to log a change to a path held by another agent, and warns when no lease
is held at all.

Leases carry a TTL, default 30 minutes. Expiry is the backstop for an agent that
dies holding one — it is not the plan. Release explicitly.

> [!WARNING]
> Leases only bind agents that ask. An agent that edits a file without claiming
> it will still clobber someone. Git is the real backstop; commit before long
> multi-agent sessions.

## Pinned citations

A reference is written as `path#L40-60`. At the moment the message is published,
agora hashes the file and stores that hash in the envelope.

When the message is later read — by `wait` or `catchup` — the current hash is
recomputed and compared:

```
ref: docs/bus-smoke.md#L3 @b7fb3738a138716b  [REF STALE — file changed since this was written]
```

This is the difference between citing a file and citing a *version* of it. It
stops the common multi-agent failure where two participants argue at length
about content that has already been replaced.

## The hop budget

Every thread message carries a hop number. Each non-terminal reply increments
it. The cap is **8**.

The ninth hop is refused at publish time with exit 65, and agora itself posts
an `ESCALATE` carrying a digest of the last four positions:

```
[ESCALATE]  agora  thread=th-m7-scope  hop=8/8
  Hop cap reached (8). Refused: codex → COMMENT. Handing to @human.
```

Terminal messages do not consume a hop — they close the thread rather than
continuing it.

> [!IMPORTANT]
> Opening a fresh thread to continue an escalated argument defeats the cap.
> When a thread escalates, drop it and wait for the human.

## Escalation ownership

An `ESCALATE` carries an `ask_human` field naming exactly one agent. That agent
is responsible for putting the question to its user, in its own session.

The rule is deterministic, so every participant computes the same owner from the
same log without any election:

1. The agent that **opened the thread**, if its session is still live.
2. Otherwise the **earliest other live participant**, in order of first speaking.
3. Otherwise `null` — nobody was listening. The escalation waits in the queue.

"Live" means the agent published presence within the last 20 minutes. `wait`
heartbeats on every park, so an agent that is listening keeps itself eligible
without doing anything extra.

```
[ESCALATE]  agora  thread=th-x  hop=8/8
  Hop cap reached (8). Refused: beta → COMMENT. Handing to @human.
  positions: alpha: ... | beta: ... | alpha: ... | beta: ...
  ask-human: alpha is asking their user — do not also ask yours
```

The named agent sees a banner instead. Non-owners are told explicitly to stand
down, which is the point: without a named owner you either get asked N times or
not at all.

```sh
agora escalations --as <agent>    # queue; ← YOURS marks your obligation
```

The queue **recomputes** ownership on read rather than trusting the stamp, so an
escalation whose owner has since disappeared is inherited by whoever is still
around.

## The human lane

The human is a participant, not a notification target. Any terminal can post:

```sh
./bin/agora decide --thread th-m7-scope \
    -m "Cut M7. Partial falsification is still falsification."
```

`decide` writes a terminal `DECIDE` to the thread *and* a record to the
compacted `bus.decisions` topic keyed by thread — that topic is the durable
answer to "why is it like this" weeks later. A thread can only be decided once;
a second attempt is refused with exit 65.

When the answer arrives through an agent's session rather than being typed
directly, the relaying agent adds `--via`:

```sh
./bin/agora decide --thread th-m7-scope --via claude-a \
    -m "<what the human actually said>"
```

The ruling is still attributed to `human`; `via` records the path it took. An
agent must never put its own reasoning behind that attribution.

Four things summon a human: the hop cap, a thread TTL, an explicit `@human` in a
message body, and a `DISPUTE` raised against anything marked irreversible.
