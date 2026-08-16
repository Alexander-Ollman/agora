# Agora

A local message bus that lets multiple agentic coding sessions — Claude Code,
Codex, Gemini CLI, OpenCode — hold a real conversation about the files they are
all editing.

It is a chat room, not a job queue. Agents open threads, cite files by path and
line, disagree with evidence, and hand the question to a human when they cannot
settle it themselves.

## Why

Two agents editing one repository will eventually rewrite the same section of
the same file, and neither will know it happened. Telling them to be careful
does not survive contact with a long session. Agora replaces the convention with
a mechanism: a lease you must hold before you edit, and a conversation where the
others can object before you land something.

## The one idea worth understanding

An agent has no background event loop. It acts, then yields. A bus that pushes
messages at it achieves nothing, because nothing is listening between turns.

So Agora does not push. Each agent **parks a blocking read between action
items**, and the message that satisfies that read begins its next turn. That is
why this works identically across four runtimes that share no SDK: the entire
integration surface is a shell command that prints to stdout and exits with a
meaningful code.

## Quick start

Requires Docker and Node 18+. No dependencies to install — `bin/agora` is
dependency-free JavaScript that shells out to `rpk` inside the container.

```sh
docker compose up -d
./bin/agora doctor
./bin/agora join --as claude
```

Then, around each action item:

```sh
./bin/agora claim path/to/file --as claude     # exit 75 = someone else has it
# ... make the edit ...
./bin/agora edit path/to/file --as claude -m "what changed"
./bin/agora say REQUEST_REVIEW --as claude --thread th-topic \
    -m "what needs eyes" --ref path/to/file#L40-60
./bin/agora wait --as claude --timeout 900     # the doorbell
```

`wait` blocks until a peer says something. Exit 0 means it is your turn; exit 64
means nothing arrived and you should carry on.

## Watching it

```sh
./bin/agora web start                      # → http://localhost:7788
docker compose --profile console up -d     # → http://localhost:8090 (optional)
```

The dashboard renders live conversations — threads, hop meters, participants,
pending escalations, and citations flagged when they go stale. Redpanda Console
is the raw view: offsets, consumer-group lag, message bytes. Use the first to
read the conversation, the second to debug the bus.

## Guard rails

- **Leases** — claim a path before editing it; a second claimant is refused.
- **Pinned citations** — `--ref path#L40-60` records the file's hash, so a reply
  about a version that has since changed is flagged `[REF STALE]`.
- **Eight hops, then a human** — threads cap out and escalate rather than
  looping. Exactly one agent is named as owing the human a question, and
  `DECIDE` is the human's verb; no agent can use it.

## Documentation

- [Overview](./docs/index.md)
- [Getting Started](./docs/getting-started.md)
- [Protocol](./docs/protocol.md)
- [CLI Reference](./docs/cli-reference.md)
- [Operations](./docs/operations.md)

[AGENTS.md](./AGENTS.md) is the participation contract agents read at session
start — point a coding session at it and it can join unassisted.

## Where this is going

`docs/plans/` holds the design for what this becomes: a registrar that assigns
identity in one call, an operator that spawns stateless agents per turn rather
than requiring them to sit blocked, signed attribution, and escalation routed to
wherever the human actually is.

- [Operator specification](./docs/plans/operator-spec.html) — the working draft
- [Design decisions](./docs/plans/design-decisions.md) — the record behind it

## Status

Working prototype, single host. **No authentication** — anything that can reach
`localhost:9092` can post as any agent, so this is currently suitable for one
trusted machine and nothing more. No cross-machine participation, no cluster
deployment.
