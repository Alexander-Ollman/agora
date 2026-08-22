---
title: "Q9 — does replay stay affordable?"
date: 2026-08-20
status: answered
---

# Q9 — does replay stay affordable?

**Answer: yes, and §8 of `operator-spec.html` should be deleted rather than
built.** Prompt caching alone covers it. The measurement also found a real
unbounded cost somewhere else entirely, which has been fixed.

This is a measurement, not a design argument. Everything below comes from the
running prototype — 23 threads, 191 messages, 168 turns of real multi-agent
conversation — not from a model of one.

## Method and its error bars

Token counts are `bytes / 3.8`, applied consistently to both sides of every
ratio. That approximation is worth roughly ±15% on an absolute number and much
less than that on a ratio, since the error largely cancels. Nothing here turns
on a margin narrower than that. Message sizes are measured over what an agent
actually replays — body, citations, and envelope headers — not raw topic bytes.

Reproduce with `agora dump` and the numbers below.

## What a thread actually costs

| | measured |
|---|---|
| Threads on the bus | 23 |
| Messages | 191 |
| Mean tokens per message | **582** |
| Median message body | 2,369 chars |
| Longest thread | 20 messages (at the hop cap), **~11.6k tokens** |

Replay per turn, and the cumulative cost over a thread's whole life:

| Thread length | Replay/turn | Cached-equivalent | Cumulative raw |
|---|---|---|---|
| 5 | 2.9k | 291 | 5.8k |
| 10 | 5.8k | 582 | 26k |
| **20 (the cap)** | **11.6k** | **1.2k** | 110k |
| 40 | 23k | 2.3k | 454k |
| 100 | 58k | 5.8k | 2.9M |

## The number that decided it

Replay is only expensive if it is a fresh read. It is not:

| | measured over 168 turns |
|---|---|
| Median gap between messages | **91s** |
| Mean | 235s |
| p90 | 657s (11 min) |
| Max | 2,820s (47 min) |
| Within a 5-minute cache TTL | 139/168 — **83%** |
| Within a 60-minute cache TTL | 168/168 — **100%** |

Every observed turn on this bus lands inside a one-hour cache window. Replay is
a cache read priced at 0.1×, not a fresh read at 1×.

**Scope caveat, stated rather than buried:** every turn in this sample is
attached-mode — long-lived sessions replying within minutes. Detached mode, the
scenario that motivated §8, has no measured turns yet. The conclusion transfers
on two grounds rather than on the sample: a detached agent is spawned *because a
message just arrived*, so its gap is operator spawn latency, not human-scale
silence; and the structural argument is mode-independent — a projection that
rewrites the prefix defeats caching for attached and detached alike. If detached
turns ever show gaps beyond the cache TTL, the remedy is still not §8; it is a
cache-warming read at spawn, which costs one uncached replay and rewrites
nothing.

## Replay share of a turn

| Everything else a turn spends | Hop 20, uncached | Hop 20, cached |
|---|---|---|
| Contract + one 15k source-file read | 39% | **6%** |
| + harness prompt, tool definitions, a second file, output | 21% | **3%** |
| A turn that reads widely across the repo | 11% | **1%** |

Against the 10% threshold the question set: **1–6%, comfortably under.** Even at
hop 100 — five times the current cap — cached replay stays around 11%.

## Why §8 would have made it worse

The arithmetic says §8 is unnecessary. The structure says it is actively
harmful, and that is the stronger finding.

§8 proposes a snapshot-plus-verbatim-tail projection: an extractive summary that
recompresses as the thread grows. **A projection that recompresses rewrites the
prefix on every turn**, and a rewritten prefix is a cache miss by definition. So
§8 would convert a 3% cached cost into a 21% uncached one — roughly seven times
worse — while adding a projection step per turn and a new class of bug in which
an agent argues against a paraphrase of a position rather than the position.

The constraint this leaves behind is worth stating plainly, because it now
governs anything built on top:

> **Thread history must stay an append-only prefix.** Anything that reorders,
> rewrites, or recompresses it forfeits the caching that makes replay
> affordable.

`SUPERSEDE` already complies — it links rather than copies, so merged evidence
stays at the offsets where it was published and no prefix is rewritten. That
property was chosen for a different reason, and it turns out to be load-bearing
for this one too.

## What the measurement did find

The unbounded cost was in the orientation step, not the replay step. Session
start told agents to run bare `agora catchup`:

| Command | Cost |
|---|---|
| `agora catchup` (whole bus) | **~145,000 tokens**, growing without bound |
| `agora list` | **~64 tokens** |
| `agora read <longest thread>` | ~12.6k tokens |

Six places recommended the 145k version — `README.md`, `AGENTS.md`, and all four
runtime skills. All now say `list`, then `read` only what concerns you. Bare
`catchup` is documented as forensics rather than orientation.

That is a 2,265× reduction on the one command every agent runs first, and it was
found by measuring the thing the question was not about.

## Consequences

1. **Delete §8** from the spec rather than deferring it. Do not build a memory
   architecture.
2. **Keep the hop cap bounded.** The cap is what keeps replay in the range where
   caching suffices; at hop 100 the margin is gone. This is now a second,
   independent reason for the cap, alongside the original one.
3. **Preserve prefix stability** in anything downstream — the detached turn
   contract especially, since a detached agent's whole economic case rests on
   the prefix being cacheable across spawns.
