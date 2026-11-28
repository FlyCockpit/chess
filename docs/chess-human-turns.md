# Durable turn contract

C1a defines storage and strict readers. C1b integrates hosted human creation,
worker parking, wake jobs, repair, move/timeout legality and action budgets.

The required `archive.turn` discriminated union is exported by
`@cockpit-chess/chess`. Prerelease snapshots missing it are unsupported; readers
never upgrade or guess state. A terminal archive has `{ type: "idle" }`.
Existing automatic and local runners emit idle until they opt into durable turns.
Existing `playing` and `move-timeout` endings cover parked turns and think expiry;
there is no new ending kind or rules version.

| Type | Durable meaning | Worker claim |
| --- | --- | --- |
| idle | No active durable turn or pending input | Existing automatic workers may hold their existing runToken |
| model | One active inference/automatic turn | Nonempty runToken; compare on every persist |
| human | Human think interval, parked | runToken NULL; release BullMQ slot |
| human-move | One server-received UCI input awaiting authoritative replay | runToken NULL; deterministic wake/repair can acquire processing authority |

Every active state has UUID `turnId`, `side`, `expectedSeq`, `startedAt` and
`deadline` (UTC ISO timestamps with exactly three fractional digits). `expectedSeq`
is the event count at turn start; it fits a PostgreSQL nonnegative Int. A parked
human or pending input must be at the exact archive event tail. Model processing
may append events after its anchor. Replay validation verifies the side to move.
A deadline is after start and at most the configured per-move limit, itself
bounded to 300 seconds. Even an untimed hosted human game needs this deadline.

A `human-move` has exactly one `pendingMove: { move, receivedAt }`: UCI with optional
q/r/b/n promotion and a server timestamp in `[startedAt, deadline)`. This is input,
not proof of a legal move. C1b reuses the authoritative board/attempt rules before
it becomes an event. No user comments, tool payloads, key, runToken or private
inference transcript enter turn state. Cards expose phase/identity/timing metadata
without pending input; the full strict archive can contain that bounded input.

The row stores the union as `turnType`, `turnId`, `turnSide`, `turnExpectedSeq`,
`turnStartedAt`, `turnDeadline`, `pendingMove`. Its CHECK rejects partial states,
unknown types, excessive deadlines, a claim on a human wait/input, a claimless
model turn, oversized/extra pending fields, and active terminal rows. Idle clears
all turn columns. Use SQL NULL (`Prisma.DbNull`) for absent JSON. The deadline
index supports bounded keyset repair by type/deadline/id.

C1b must commit row columns and `archive.turn` in one transaction, using
`status = running`, `turnType`, `turnId` and `turnExpectedSeq` predicates. A model
write also compares `runToken`; each next turn gets a fresh UUID. Human acceptance
also predicates on the server deadline still being future and the exact current
event tail. One successful CAS changes human to human-move, so a second tab cannot
overwrite input. Stop, timeout, revocation and settlement atomically clear all
turn columns, pending input and ownership. Never hold a transaction while a
human thinks or while a provider request runs. `finishMatch` clears archive state;
it does not persist the row.

`beginTurn`, `acceptHumanMove`, `expectTurn`, `clearTurn` are pure validation/state
helpers, not database authorization or scheduling. Finish the old turn and begin
the new turn atomically with its new event count. Notifications are wake hints;
durable accepted input plus bounded repair must recover a lost hint. A model
claim interrupted after dispatch is uncertain: recovery marks it interrupted
instead of starting inference again. These concurrency/spend rules are C1b's
integration contract; C1a's SQL fixtures prove the storage/CAS/rollback contract.

## Hosted human execution

C1b enables exactly one human against one catalog-resolved model, with fresh
context and practice status. Creation uses the existing authorized billing,
per-owner admission and global queue limits. Humans never receive credentials
or dispatch provider calls. Persistent human context is refused until a complete
private transcript persistence contract exists.

A worker claims queued work and establishes one model turn, or parks a human
turn with a finite server deadline and NULL runToken, returning its BullMQ slot
before loading any key/catalog/engine. Model reservations persist under that
claim before dispatch. A legal model move atomically parks the next human turn
and releases the claim. Unfinished spectator scoring moves to its separate
bounded backfill queue; parked replay polling repairs a lost handoff, without
resuming gameplay. A lost active model claim is interrupted; it is never
redispatched after an uncertain reservation or request.

`chess.move` accepts owner-only UCI or `resign`, turnId and expectedSeq under a
separate fail-closed action budget. It applies authoritative board legality and
server clocks directly in the credential-locked transaction, then commits the
archive and turn columns through one deadline/turn/sequence CAS. Duplicate or
stale input conflicts. Late input settles timeout without applying a move.
Illegal retries get a new CAS identity while preserving the original think
deadline; elapsed time is charged once per interval. Archive headroom follows
the existing runner limit. No transaction is held while thinking or dispatching.

An accepted legal human move becomes idle/queued model work. After commit it
wakes one deterministic `chess-<id>-turn-<event count>` job (the initial empty
snapshot uses `chess-<id>`). Lost hints leave durable accepted work; the bounded
keyset reconciler repairs missing/terminal human continuation jobs without
reapplying input or admitting another match. A separate bounded deadline scan
expires human waits; stale heartbeat sweeps exclude parked human states. Stop,
disconnect and reset clear all row turn fields and claims atomically; terminal
readers normalize the last durable archive snapshot through `finishMatch`,
preserving any move that committed before cancellation.

Hosted credentials require OpenRouter `provider.data_collection: "deny"` at the
actual HTTP seam for all supported protocols. This routing policy preserves the
cacheable prompt/tool bytes and provider-affinity session identifiers. The key
lease and claim guards still run before every provider request, including after
asynchronous request-body decoding.
