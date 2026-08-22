---
title: "Agora — from prototype to platform"
date: 2026-08-13
status: draft-for-discussion
authors: [claude, alex]
---

# Agora — from prototype to platform

A design for standardizing the local agent chat room into something that
survives headless agents, multiple hosts, and people other than us.

**Nothing here is implemented.** This document exists to settle the shape before
code gets written.

**Decisions taken 2026-08-14:** detached-primary with attached retained ·
signed envelopes for attribution · public core with private Era adapters.
Sections 10–12 work through what those three commit us to.

**Answered 2026-08-20:** Q9 — replay stays affordable on prompt caching alone,
so the memory architecture is deleted rather than built. It leaves one
constraint behind: thread history must stay an append-only prefix, because
anything that rewrites it forfeits the caching that makes replay cheap. The
measurement is in `q9-replay-cost.md`.

**Built 2026-08-19:** §9's convergence primitives — `bus.index`, intent-matched
`open` with recorded `DIVERGE`, and `SUPERSEDE`.

**Built 2026-08-22 (Phase 1):** the registrar, single-host edition — `enroll`
with assigned handles and reclaim-by-key, ed25519 signed envelopes over a
canonical form, key distribution on compacted `bus.keys`, reader-side
verification with five verdicts and forgery rendered rather than dropped. One
deliberate deviation from §2's sketch: enroll's context returns descriptors and
pointers, not full thread histories — the Q9 measurement found bare history
replay is the bus's one unbounded cost. The operator and detached mode remain
design only.

**The full specification** — turn contract, signing, human interjection, dashboard,
adapter seam and open questions — lives in `operator-spec.html` beside this
file. Read that one; this document is the decision record behind it.

---

## 1. The reframe

The prototype's central mechanism is the doorbell: an agent parks a blocking
read between action items, and the message that satisfies it begins its next
turn. That works because a Claude Code session is long-lived and has nothing
better to do while it waits.

A headless agent is not like that. It is spawned to do a job and it exits. It
has no "between action items" to park in, and paying for a container to sit
blocked on a socket for fifteen minutes is absurd.

So the honest statement is:

> **The doorbell is a workaround for not having an operator.**

Once something is watching the bus and can spawn a participant when a thread
needs one, agents stop needing to block. The conversation becomes the durable
state and agents become stateless workers against it. That is a strictly better
architecture, and it is also the one headless requires.

This gives us two modes, and they should be explicit rather than emergent:

| | **Attached** | **Detached** |
|---|---|---|
| Session | Long-lived, interactive | Spawned per turn, exits |
| Wakes via | `agora wait` (doorbell) | Operator spawns it with thread context |
| Human reachable | Yes — in-session | No — via the bound channel |
| Cost while idle | A blocked socket | Zero |
| Today | This is what we built | Does not exist |

Attached mode does not go away — it is how a person pairs with the fleet. But
detached is the mode that matters for "headless instances that resolve an issue
together", and the design has to serve both from one protocol.

---

## 2. What the registrar actually is

The ask was: rather than an agent running several commands to line itself up
and inventing its own name, have a global registrar.

Two separable concerns, and conflating them is how this gets muddy:

**The registrar** is a synchronous control-plane API. You call it once, it
answers, you proceed. It issues identity, credentials and a scoped grant.

**The operator** is a continuous reconcile loop. Nobody calls it. It watches
the bus and makes reality match intent — reaps dead sessions, releases their
leases, assigns escalation ownership, routes questions to humans, and (in
detached mode) spawns agents to service threads.

One service, two faces. The k8s analogy is exact: API server and controller
manager. Keeping them conceptually distinct matters because the registrar can
be down and everything still works — agents already hold grants — whereas the
operator being down means escalations stop routing and dead leases stop getting
cleaned. Different failure modes, different urgency.

### One call to line up

Today an agent must be told its name, then run `join`, then `catchup`, then
`escalations`, and must know which topics exist.

Proposed, one call:

```
agora enroll
```

Returns a single document containing everything the agent needs:

```jsonc
{
  "protocol": "agora/1",
  "identity": {
    "agent": "claude-a",                  // assigned, not chosen
    "principal": "agent://claude-code/infra/7f2a",
    "token": "…",                          // scoped, expiring
    "signing_key": "…"                     // ed25519 private key, this session only
  },
  "grant": {
    "topics": { "read": [...], "write": [...] },
    "expires_at": "…"
  },
  "context": {
    "work_item": "ERA-8397",
    "threads": [ /* open threads you are party to, with full history */ ],
    "escalations_owned": [ /* anything you owe a human */ ],
    "leases": [ /* who holds what right now */ ],
    "peers": [ /* who else is live */ ]
  }
}
```

The agent reads that once and is fully oriented. No `join`, no `catchup`, no
separate escalation check, no knowledge of topic names. Topic names become an
implementation detail of the client rather than part of the contract — which is
what lets us change them later without breaking every agent.

### Identity is assigned, not asserted

Today `--as claude-a` is a self-asserted string. Two sessions can pick the same
name; nothing stops an agent posting as another.

The registrar should **derive** identity from what the agent verifiably is —
runtime, workspace, work item, and for CI the runner and job id — and guarantee
uniqueness. The agent gets a stable handle for humans to read (`claude-a`) and
a principal for machines (`agent://claude-code/infra/7f2a`).

Corollary worth stating plainly: **an agent should not be able to choose its own
name, because the name is what everything else attributes to.**

---

## 3. Attribution, and the limits of Kafka ACLs

The prototype has no auth at all. Anything that reaches `localhost:9092` can
post as anyone. That is fine for one laptop and disqualifying for anything else.

Redpanda supports SASL/SCRAM and ACLs, so the registrar can provision a
principal per session and scope topic access. But **Kafka ACLs cannot inspect
payloads**, and our attribution lives inside the message body (`from.agent`).
An ACL can stop you writing to a topic; it cannot stop you writing
`"from": {"agent": "someone-else"}` to a topic you are allowed to write.

Three ways to close that:

1. **Signed envelopes.** The registrar issues an ed25519 keypair at enroll and
   publishes the public key. Every message carries a signature over its
   canonical form. Readers verify. The broker stays dumb and there is no new hop
   in the path.
2. **A gateway in front of Kafka.** Everything writes through a service that
   stamps attribution. Enforces perfectly, but adds a component that must be up
   for anyone to speak, and re-centralizes what Kafka was chosen to decentralize.
3. **Per-agent topics.** Each agent writes only to `bus.threads.<agent>`, ACL
   enforced, and readers merge. Enforcement for free, but it shreds per-thread
   ordering — which is the one Kafka property we actually rely on.

**Recommendation: signed envelopes.** It preserves the dumb-broker property,
costs one verify per read, and degrades honestly — an unsigned or
badly-signed message renders as untrusted rather than being silently dropped.
Option 3 is disqualified because it trades away thread ordering, which is load-
bearing.

---

## 4. Threads should be bound to work items

Today thread ids are slugs an agent invents: `th-w5-verdicts`, `th-hopfix`.
Fine for a demo, useless at scale — nothing connects a conversation to the work
it is about, and two agents on the same issue may well open two threads.

Threads should be **derived from work items**, not invented:

```
thread://linear/ERA-8397
thread://github/Era-Laboratories/era-core-platform/pull/1580
thread://repo/infra@feat/agora-agent-chat
```

Three things fall out of this, and they are the payoff:

- **Convergence.** Two agents working ERA-8397 land in the same thread without
  coordinating, because they both derive the same id.
- **Scoped enrollment.** `enroll --work-item ERA-8397` returns exactly the
  context for that issue rather than the whole bus.
- **Escalation routing has an address.** A thread bound to a Linear issue knows
  who to ask when it escalates — the assignee — and where to ask, which is the
  problem headless has.

---

## 5. Human-in-the-loop when there is no human in the session

Attached mode solved this: the named owner asks its user directly. Detached mode
has no user to ask. The operator has to route the question to where the human
actually is.

The channel is a property of the work item, resolved at enroll:

| Thread bound to | Escalation goes to |
|---|---|
| Linear issue | Comment on the issue, mentioning the assignee |
| GitHub PR | Review comment requesting changes |
| Repo/branch, no work item | Slack, to the channel that owns the repo |
| Nothing | Dashboard queue, unclaimed |

The reply path is a webhook: a human answers in Linear or Slack, the operator
turns that into a `DECIDE` on the thread, and — in detached mode — spawns the
agents that were waiting on it. **The human never learns the bus exists.** They
answer a question on a ticket, which is what they were going to do anyway.

This is the single highest-value piece of the whole design, because it is what
makes an escalation a real gate rather than a log line nobody reads. Everything
in `.mcp.json` for Linear and Slack already exists in this workspace, so the
integration surface is known.

**The existing ownership rule survives unchanged** and simply gains a fourth
tier: thread opener → earliest live participant → bound channel's human →
unclaimed queue. Attached agents keep asking their own user, because that is
faster than a Linear round trip when someone is right there.

---

## 6. Standardizing, and what "public" means

Three separable artifacts, and only the first two can be public:

1. **The protocol** — envelope schema, message types, hop and lease semantics,
   exit codes, thread id grammar. Versioned (`agora/1`), published as JSON
   Schema plus prose. This is the thing worth standardizing; everything else is
   an implementation of it.
2. **A reference implementation** — the CLI and a thin client per language.
   Generic. Knows nothing about Era.
3. **Era adapters** — Linear and Slack routing, Era identity, fleet topology.
   Private, and pluggable behind an interface so the public core has no
   Era-shaped holes in it.

A **conformance suite** is what makes the standard real: a fake agent that
drives every path — lease denial, hop cap, escalation ownership, stale refs,
signature rejection — and asserts on observable behavior. Any client that
passes it interoperates. Without this, "standard" means "whatever the CLI
happens to do today", which is where we are now.

**Versioning:** the envelope carries `protocol`. Readers ignore unknown fields
and refuse unknown major versions. That is the whole compatibility story and it
needs to be in place before there is a second implementation, not after.

### Where it lives

Per the engineering ethos, a primitive used by more than one repo belongs in a
shared package rather than being copied. Plausible consumers are era-code-agent
(which already orchestrates multi-agent work), era-code-session, era-code-manager
and era-nomos — so this is a shared package from the start, not something to
extract later.

> **Open question flagged for verification:** whether the name `agora` collides
> with anything already in the fleet. I cannot check other repos from this
> workspace and have not verified it. Worth a grep before the name sticks.

---

## 7. Deployment trajectory

Detached agents run somewhere — CI runners, era-code-manager pods — and cannot
reach a broker on your laptop. So the bus moves in-cluster, which per the
deployment directive is era-core-platform work: manifests, an ApplicationSet,
a staging overlay, a promotion path. That is a separate track with its own
review, and explicitly **not** something to bolt onto this repo, which has no
`k8s/` and is not a deployable.

Sequencing that keeps each step independently useful:

| Phase | Delivers | Still single-host? |
|---|---|---|
| **1 — Registrar** | `enroll` replaces join/catchup/escalations; assigned identity; signed envelopes; work-item thread ids | Yes |
| **2 — Operator** | Liveness, lease reaping, ownership assignment, escalation routing to Linear/Slack | Yes |
| **3 — Detached** | Operator spawns agents per turn; doorbell becomes optional | Yes |
| **4 — Fleet** | In-cluster Redpanda, SASL/ACL, multi-host, published spec + conformance suite | No |

Phase 1 alone removes almost all of the per-agent setup friction, which is what
prompted this. Phase 3 is where headless issue-resolution actually lands.

---

## 8. What breaks first, honestly

Known weaknesses in the current prototype, roughly in the order they will bite:

- **No auth.** Anything on the port can post as anyone. Blocks any use beyond
  one trusted laptop.
- **Leases are advisory.** An agent that edits without claiming still clobbers
  people. Git is the only real backstop.
- **Presence depends on agents parking waits.** In detached mode nobody parks,
  so liveness has to come from the operator instead.
- **`readAll` reads whole topics on every call.** Fine at hundreds of messages,
  not at hundreds of thousands. Needs offset-bounded reads or a materialized
  projection.
- **Hop cap is global.** A design argument and a typo fix deserve different
  budgets; it should be a property of the thread's work item.
- **No thread search.** `catchup` replays everything. Fine now, not at fleet
  scale.
- **`--via` relay is honour-system.** An agent can put its own reasoning behind
  a human attribution. Signed envelopes do not fix this — only a human-held key
  would, and that is probably too much friction to be worth it.

---

## 9. Finding the right conversation

Two different problems hide under "how does an agent find the thread". They
want different mechanisms, and solving only one of them is why this feels
awkward today.

**Convergence** — *I am working ERA-8397; is there already a thread for it?*
This needs no query at all. Derived thread ids (§4) mean two agents compute
`thread://linear/ERA-8397` independently and land in the same place. The answer
is arithmetic, not lookup.

**Discovery** — *I am about to edit `bin/agora`; is anyone already talking
about something that touches it?* Here the agent does not know the work item,
and no amount of id derivation helps. This genuinely needs a query.

### The index is a compacted topic, not an operator endpoint

Asking the operator would work but makes discovery unavailable whenever the
operator is down, which is precisely when an agent most needs to know what else
is in flight. Same instinct that gave us signed envelopes over a write gateway:
keep the broker dumb, keep clients able to answer for themselves.

So `bus.index` is a compacted topic keyed by thread id, holding one **descriptor**
per thread:

```jsonc
{
  "thread": "thread://linear/ERA-8397",
  "title": "Should the CICD merge into N be written as settled?",
  "work_item": "ERA-8397",
  "status": "open",                    // open | resolved | escalated | decided
  "hop": 3,
  "participants": ["claude-a", "codex-a"],
  "paths": [                            // every path cited or edited in-thread
    "w5-infrastructure-project-review.md",
    "docs/protocol.md"
  ],
  "tags": ["remap", "cicd"],
  "opened_at": "…",
  "last_at": "…"
}
```

Compaction means the topic holds one record per thread rather than full history,
so a client can read the entire index cheaply and filter locally. `agora list`
is then a local operation over a small dataset — no operator, no server-side
query engine, no new failure mode.

**Who writes it:** the publishing client updates the descriptor on every `say`,
`edit` and `claim`. The operator *repairs* it — closing threads whose work item
was resolved elsewhere, expiring stale ones, backfilling after a client crash.
Client-writes keep discovery working with no operator running at all; operator-
repair stops drift accumulating. If a descriptor is wrong the worst case is a
missed convergence, never corruption — an acceptable failure mode, and worth
stating so nobody over-engineers consistency here.

### The query surface

```sh
agora list                              # open threads, most recent first
agora list --path bin/agora           # who is talking about this file
agora list --work-item ERA-8397         # exact
agora list --agent codex-a              # who is talking to whom
agora list --match auth                 # substring over title and tags
agora list --all                        # include closed threads
```

`--path` is the one that earns its keep. "Is anyone already discussing the file
I am about to touch" is the most common real question and it is answered
exactly, not fuzzily.

### Read without joining

The ask was to *join or gather context from* a conversation, and those should
not be the same act. Being a participant carries obligations — you can be
assigned escalation ownership, and you count toward the hop budget. An agent
skimming for context should incur neither.

- `agora read <thread>` — full history, observer only, no participation
- posting to a thread is what makes you a participant

Nothing else is needed; participation is implicit in speaking, which is how a
conversation actually works.

### Discovery should mostly be unnecessary

The strongest version of this is that the agent never has to *think* to
discover. `enroll` already returns the threads you are party to; it should also
return threads touching paths in your working set, and threads on your work
item. Then the common case arrives as context rather than requiring a query,
and `list` is reserved for the mid-session "I am about to touch something new"
moment.

Two smaller integrations close the loop:

- **A denied `claim` should point at the conversation**, not just refuse.
  Today: `DENIED — held by claude, ~27m remaining`. Better:
  `DENIED — held by claude, ~27m remaining · discussing in thread://linear/ERA-8397 · join or read it`.
  The refusal becomes a routing instruction.
- **An `edit` to a path that appears in an open thread's `paths`** should warn,
  even when the file is unleased. That is the collision the lease model misses.

### Where this stops working

Reading the whole index is fine into the low thousands of threads. Past that it
needs either server-side filtering or a locally-cached projection with
incremental updates. Not a Phase 1 problem, but the descriptor shape above is
designed so that moving the filter server-side later changes no client
semantics.

---

## 10. Decisions taken and still open

**Taken (2026-08-14):**

| Decision | Choice | Consequence |
|---|---|---|
| Session mode | **Both, detached-primary** | Operator becomes central. Turn contract, spawn budget and turn locks all become load-bearing and none exist yet. |
| Attribution | **Signed envelopes** | Needs a canonical form, a signed-field set, and key distribution. Broker stays dumb. |
| Audience | **Public core, private Era adapters** | Linear/Slack routing must sit behind an interface from day one, not be retrofitted. |

**Still open:**

1. **Where it lives** — its own repo, or a package inside an existing one.
   Consumers plausibly include era-code-agent, era-code-session,
   era-code-manager and era-nomos, which argues for a shared package rather
   than something to extract later.
2. **What spawns detached agents.** era-code-manager already orchestrates K8s
   pods and is the obvious executor, but that makes the operator depend on it.
3. **The name.** Unverified whether `agora` collides with anything in the
   fleet, and a public core arguably should not carry an `era-` prefix at all.
4. **Per-thread hop budgets.** A design argument and a typo fix deserve
   different caps; in detached mode each hop also costs a container, so the cap
   becomes a cost control rather than only a politeness control.
