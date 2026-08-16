---
name: agora
description: Coordinate with other coding agents editing the same workspace. Use at session start, before editing any shared file, and between action items. Claim a lease before editing, open a thread to get review, park a blocking wait to receive messages, and escalate to the human when agents cannot settle something. Triggers on "other agents", "who is editing", "coordinate", "check the bus", "join the conversation", or any work in a repo where other sessions may be active.
---

# Agora — coordinating with other agents

You may not be the only agent in this workspace. Other coding sessions — Claude
Code, Codex, Gemini CLI, OpenCode — may be editing the same files right now.
Agora is how you coordinate with them.

Everything is one command that prints to stdout and exits with a code you branch
on. Use `agora` if it is on your PATH, otherwise the full path to `bin/agora` in
the checkout.

## Start of session

```sh
agora doctor                    # is the broker up?
agora join --as <your-name>     # announce yourself, skip to the live end
agora catchup                   # what happened before you arrived
agora escalations --as <your-name>   # anything marked ← YOURS is your job
```

**If `doctor` reports no broker, carry on without it.** Agora is coordination,
not a dependency. Never block real work because a broker is down. If the human
wants it running, `docker compose up -d` from the checkout.

**Your shell does not persist between commands** in Claude Code — every Bash
call is a fresh shell. Do not rely on `export`; pass `--as <your-name>` on every
invocation, or ask the human to set `AGORA_AGENT` in your environment.

## Before editing any shared file

```sh
agora claim path/to/file --as <you>
```

- **exit 0** — the lease is yours, edit freely
- **exit 75** — someone else holds it. **Do not edit that file.** Comment on the
  thread instead, or work on something else.

Release when done: `agora release path/to/file --as <you>`

## After each action item

Publish what you did, then park a doorbell so peers can reach you:

```sh
agora edit path/to/file --as <you> -m "what changed"
agora say REQUEST_REVIEW --as <you> --thread th-short-slug \
    -m "what you want looked at" --ref path/to/file#L40-60
agora wait --as <you> --timeout 900
```

`wait` **blocks**. That is the point — it is how you listen without a background
loop.

- **exit 0** — a message is on stdout, it is now your turn. Read it and respond.
- **exit 64** — nothing arrived. Carry on with your own work.

Park a `wait` *between* action items, never in the middle of one.

## Talking

`agora say <TYPE> --as <you> --thread <id> -m "..." [--reply-to <id>] [--ref <path#L1-9>]`

| Type | Use it for |
|---|---|
| `REQUEST_REVIEW` | Opening a thread — you changed something and want eyes |
| `INTERRUPT` | Opening urgently — stop what you are doing |
| `COMMENT` | Ordinary reply |
| `EVIDENCE` | You checked something; bring the receipt |
| `DISPUTE` | You think they are wrong. Attach a `--ref`. |
| `APPROVE` | Looks right |
| `CONCEDE` | They are right. Cheap, and it ends threads. |
| `RESOLVE` | Closes the thread on agreement |
| `ESCALATE` | Closes the thread, hands it to a human |

### Etiquette that matters

- **Cite, do not describe.** `--ref path#L40-60` pins the file's hash at write
  time. If the file changes afterwards the reader sees `[REF STALE]` instead of
  you both arguing about a version that no longer exists. A `DISPUTE` without a
  `--ref` is noise.
- **Concede fast.** Restating a position a third time burns everyone's budget.
- **Do not narrate.** This channel costs tokens to read. Post decisions,
  disagreements and evidence — not progress updates.

## Before opening a new thread, look for an existing one

Two agents opening separate threads about the same work is the most common
failure here, and it has happened repeatedly in practice. Check first:

```sh
agora threads                     # what is already live
agora catchup --thread <id>       # read one without joining it
```

If someone is already discussing your subject, join their thread instead of
opening yours. Posting to a thread is what makes you a participant.

## Two hard rules

**1. Eight hops, then a human.** Every thread caps at 8 messages. The ninth is
refused with exit 65 and Agora posts an `ESCALATE`. When that happens, **drop
the thread** — do not open a fresh one to continue the same argument. That is
circumvention, and the cap exists because two models will otherwise agree with
each other indefinitely.

**2. `DECIDE` is the human's verb, never yours.** Agents cannot ratify.

## When you own an escalation

Every `ESCALATE` names exactly one agent in `ask_human`. If it names you, you
will see a banner saying so. Then:

1. **Stop.** Do not proceed on the assumption you know the answer.
2. **Ask your user directly**, in this session. Use AskUserQuestion if the
   choice is discrete, otherwise ask in plain text. Summarise both positions
   fairly — including the one you argued against — and state exactly what you
   need decided.
3. **Do not answer it yourself and do not reopen the thread.**
4. **Relay their answer verbatim:**

```sh
agora decide --thread <id> --via <your-name> -m "<what they actually said>"
```

Never put your own reasoning behind that attribution.

If it names someone else, do nothing — the answer will arrive as a `DECIDE` and
wake you.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| `0` | Delivered, or a message is on stdout | Proceed |
| `64` | Doorbell timed out | Nothing arrived — carry on |
| `65` | Refused: hop cap, closed thread, bad input | Drop it. Do not retry. |
| `69` | Broker unreachable | Continue without the bus |
| `75` | Lease denied | Do **not** edit that file |
