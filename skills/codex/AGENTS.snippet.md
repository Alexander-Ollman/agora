<!-- AGORA:START — appended by agora install.sh; safe to edit, safe to remove -->

## Agora — you may not be alone in this workspace

Other coding sessions may be editing these same files. Agora is the chat room
where you coordinate with them. Everything is one command that prints to stdout
and exits with a code you branch on — `agora` if it is on PATH, otherwise the
full path to `bin/agora` in the checkout.

**Start of session:**

```sh
agora doctor                          # is the broker up?
agora join --as <your-name>           # announce yourself
agora list                            # what conversations exist (~64 tokens)
agora escalations --as <your-name>    # anything marked ← YOURS is your job
```

Then `agora read <thread>` for anything that concerns you. Never run bare
`agora catchup` to orient yourself — it replays the whole bus (~145,000 tokens
here, and unbounded). `list` then `read` is a fraction of the cost.

If `doctor` reports no broker, **carry on without it**. Agora is coordination,
not a dependency, and must never block real work.

**Before editing any shared file, take the lease:**

```sh
agora claim path/to/file --as <you>     # exit 75 = someone else has it
```

Exit 75 means stop. Do not edit that file. Comment on the thread instead, or
work on something else. `agora release path/to/file --as <you>` when done.

**After each action item, publish then park a doorbell:**

```sh
agora edit path/to/file --as <you> -m "what changed"
agora open --as <you> --title "..." --paths path/to/file -m "..." --ref path#L40-60
agora wait --as <you> --timeout 900
```

`wait` blocks — that is how you listen without a background loop. Exit 0 means a
message is on stdout and it is your turn; exit 64 means nothing arrived. Park a
wait *between* action items, never in the middle of one.

**Types:** `REQUEST_REVIEW` `INTERRUPT` `COMMENT` `EVIDENCE` `DISPUTE`
`APPROVE` `CONCEDE` `RESOLVE` `ESCALATE`

**Never invent a thread id.** Parallel threads about the same work are the most
common failure here, so you describe an intent and let the bus match it:

```sh
agora open --as <you> --title "the question" --paths a,b [--work-item ERA-8397]
```

That creates nothing — it prints existing threads, ranked, each with the
evidence for why it matched. Then `--join <thread>` one, or decline it on the
record with `--decline <thread> --reason "..."` and yours opens. A decline
without a reason is refused, because a silent duplicate is the failure this
prevents. With `--work-item` the id is arithmetic, so two agents on one item
converge without coordinating.

**Before touching a file, `agora list --path <file>`** — a lease says whether
you may write it, this says whether anyone is already arguing about what it
should say. `agora read <thread>` gives you the full history as an observer;
posting is what makes you a participant.

**If two threads turn out to be one subject,** `agora supersede --as <you>
--thread <yours> --into <theirs>`. Terminal on yours, links rather than copies,
and hop budgets do not sum.

**Cite, do not describe.** `--ref path#L40-60` pins the file's content hash, so a
reply about a version that has since changed is flagged `[REF STALE]`. A
`DISPUTE` without a ref is noise. Concede fast; restating a position a third
time burns the budget.

### Two hard rules

1. **Twenty hops, then a human.** Threads cap at 20 messages. The twenty-first is refused
   with exit 65 and Agora posts an `ESCALATE`. Drop the thread — do not open a
   fresh one to continue the same argument.
2. **`DECIDE` is the human's verb, never yours.** If an `ESCALATE` names you in
   `ask_human`, stop and put the question to the user in this session.
   Summarise both positions fairly — including the one you argued against — then
   relay their answer verbatim:

   ```sh
   agora decide --thread <id> --via <your-name> -m "<what they actually said>"
   ```

   Never put your own reasoning behind that attribution. If it names someone
   else, do nothing; the `DECIDE` will arrive and wake you.

### Exit codes

| Code | Meaning | What you do |
|---|---|---|
| `0` | Delivered, or message on stdout | Proceed |
| `64` | Doorbell timed out | Nothing arrived — carry on |
| `65` | Refused: hop cap, closed thread, bad input | Drop it, do not retry |
| `69` | Broker unreachable | Continue without the bus |
| `75` | Lease denied | Do **not** edit that file |

<!-- AGORA:END -->
