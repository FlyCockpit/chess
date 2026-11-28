# Runner transport v1

The runner connects outbound to `wss://<origin>/api/cli/runner/ws`. Its only
credential is the purpose-scoped runner machine bearer from enrollment. Cookies,
browser Origins, query parameters and WebSocket subprotocol credentials are
refused. Companion sessions and API keys cannot authorize this connection.
The browser continues to use protected cookie/CSRF RPC controls.

E4a adds durable create/offer/accept/reject/stop/snapshot/ack control. It never
dispatches model requests, writes moves or settles game results. The protected
`chess.startRunner` control fails closed with `runner-gameplay-unavailable` until
E4b supplies independent move legality and terminal handling. The current offer
contract includes the bounded match configuration and its digest, pinned to the
code-shipped prompt bundle; it contains no arbitrary instructions or local policy.

Live upgrades use D2a's authoritative `isOwnerActive` predicate from
`packages/auth/src/account-deletion.ts`. `RunnerOwnerActive` in
`apps/server/src/runner-ws-authority.ts` is the seam:
`(userId: string) => Promise<boolean>`. It must query durable account eligibility,
return false for missing or deletion-pending owners, and propagate storage
failures so transport fails closed. The limits service also uses the same
transaction-bound owner check while holding the credential lock. There is no
permissive interim predicate.

## Wire contract

`packages/chess/src/runner-protocol.ts` is the shared strict Zod contract.
Every envelope contains `version`, `generation`, `id`, `seq`, `ack`, `type` and
typed `payload`; match messages additionally require `matchId`. Every object is
strict and all strings, arrays and integers are bounded. Maximum encoded message
size is 64 KiB, checked before JSON parsing. Unknown versions, fields, actions,
binary messages and invalid sequences close the connection.

The server sends `welcome` with its positive durable generation, sequence 1 and
acknowledgement 0. The client replies with `hello` at that generation, sequence 1
and acknowledgement 1. Each direction then increments its sequence by exactly
one and acknowledges only sequences already sent, without decreasing its ack.
Connection sequences restart on reconnect; durable match command IDs and match
sequences survive independently in PostgreSQL. Reconnect never automatically replays a model
request, command callback or move.

Allowed client messages are hello, heartbeat, pong, accept, reject, move,
evaluation, snapshot, event, limits-result, ack and error. Server messages are welcome,
heartbeat, pong, offer, start, stop, human-move, resume, limits, ack and error.
The client advertises operating values/revision and its local hard ceilings in
hello. A server `limits` command contains only operating integer micros,
concurrency, expected/current revision and command ID. The client returns an
explicit `limits-result` with the requested revision, applied/refused reason,
actual values and ceilings. Server polling redelivers one durable pending
command until this acknowledgement arrives. The protocol
has no provider URL, headers, credential, filesystem path, executable tool,
arbitrary JSON metadata or remotely writable local hard-ceiling field.
Model protocol IDs reuse the chess package's `MODEL_PROTOCOLS`:
`openai-chat`, `openai-responses` and `anthropic`.

## Authority and leases

Each accepted connection increments `RunnerMachine.connectionGeneration` under
the same per-user CLI credential lock used by reset and revocation. Its Redis
lease contains the owner, machine, generation, random connection ID and canonical
client IP. A delayed lower generation cannot replace a newer lease. Releases
compare the exact lease before deleting it, so a stale socket cannot remove its
replacement. Lease and per-IP membership expire after 60 seconds using Redis
time. Each machine has one authoritative connection; an IP has at most 16
unexpired connection reservations. Local capacity is also bounded.

Connect, every application message and every heartbeat recheck the durable
machine credential, owner deletion predicate, generation and Redis lease.
Revoked, expired, unverified, banned or deletion-pending authority is refused.
Match messages require the authenticated owner, runner source and exact stable
machine association. Durable actions recheck the live machine generation and
owner eligibility under the same credential lock as reset, then serialize the
match transition with its advisory lock and revision CAS. Replacing a socket can
replace only the authorized generation, never the machine binding.

Every replica subscribes to E1's transactional PostgreSQL
`runner_machine_revoked` channel and the Redis `runner_ws_replaced` channel.
Notifications contain IDs/generation only. Either subscription failing closes
live connections and blocks new upgrades until subscriptions recover. Durable
rechecks remain mandatory because a notification may be missed.

## Durable controls and execution sources

`chess.createRunner`, `startRunner`, `stopRunner` and `runnerStatus` are protected
cookie/CSRF browser controls. The helper rechecks a live verified,
non-impersonated sign-in, forced-2FA policy and pending-deletion fence under the
credential lock. A creation key binds its owner, machine and configuration digest
to one match; retries return that match. Creation is limited to 16 active matches
per machine and 64 per owner. Mutating controls share their own fail-closed 120/min
owner budget. Source and billing are server-assigned `runner` / `runner-local`;
the existing strict archive has source `local`. Runner matches are never official.

`RunnerCommand` stores the command ID, match revision, strict payload, five-minute
expiry and acknowledgement/cancellation timestamps before a Redis
`chess_runner_command` ID-only wake hint is published. A failed/lost hint cannot
lose the command: hello/reconnect and five-second live polling read at most 32
pending commands. The envelope reuses the durable command ID with a fresh socket
sequence. A semantic offer acceptance is distinct from a transport ACK.
`RunnerEvent` stores a bounded exact message/payload receipt; reusing an ID with
another match or payload is refused. Per-match receipt and retained-command caps
are 4096, with one reserved terminal stop command so an exhausted journal cannot
prevent owner cancellation. Acknowledgements cannot authorize a start or change
accepted board state.
Each socket delivers at most four unacknowledged match commands, once per socket,
with room for heartbeat and acknowledgement traffic. Successful semantic replies
or durable cancellation free delivery slots; reconnect starts a fresh window with
the same durable IDs. Polls query those outstanding IDs independently before the
bounded FIFO page, so page truncation cannot free a live command. Polls cannot
replay a stale pre-acknowledgement snapshot.

Live polling binds the current generation, records contact and renews the 120s
resume deadline. A legitimate replacement generation first receives a fresh
offer with the original validated configuration so the CLI can restore its
journal and bind the new connection. Accepting a fresh offer creates one durable
resume with the authoritative accepted sequence/FEN/ply. The CLI persists that
resume, acknowledges it, and returns a snapshot. Snapshots must match server state
and never create another resume or replace accepted moves. Stop commits a terminal
state, cancels earlier outbox
commands and clears generation/grace. Expired offers/grace are terminalized on
the next authenticated recovery poll, which cannot revive them. E4b supplies the
offline runner sweep and final reset/revoke/delete/gameplay settlement.

Hosted admission, queue position/capacity, worker claims/writes/heartbeat and
reconciliation explicitly exclude runner rows. Replay/inspect spectator helpers
never enqueue runner backfill; worker backfill and completion handoff check the
durable source before enqueue, before each engine evaluation and at the write.
Only creation assigns execution source/machine binding; subsequent controls use
that exact binding in their CAS. The database validates the machine FK and
runner archive/billing partition. Missing runner scores never authorize
server Stockfish. Hosted human waits retain D3's purpose-scoped spectator
behavior. Imported local archives can display stored scores and never request
server backfill.

## Liveness and cleanup

Application heartbeats run every 25 seconds with nonce-bound pong responses.
Transport ping/pong is separate. Valid liveness expires after 60 seconds; the
120-second match resume grace is a different contract and grants no authority
after reset or revocation. New work pauses immediately when the CLI loses its
connection. The CLI aborts callback signals and never overlaps new work with a
callback that ignored cancellation.
Replies use `RunnerConnection.send(action, originatingSignal)` with the exact
signal supplied to that session's `onMessage` callback; retired callbacks cannot
send through a replacement connection. Server liveness uses monotonic elapsed time.

Incoming queues and outgoing buffers are bounded; the outgoing buffer cap is
256 KiB. Redis also limits messages per machine independently of HTTP request
budgets. Storage calls, handshakes and callback processing have deadlines.
Runner database controls share one four-second budget covering lock-slot
admission, checkout and transaction work. Expired queued work is removed before
it can begin; final browser/machine and original command/grace deadlines are
checked inside the transaction before commit. Ordinary control conflicts receive
fixed `STALE`/`BUSY`/`UNSUPPORTED` replies without retiring a valid machine.
Transient storage unavailability closes resumably with 1012; actual authorization
or replacement failures retain their terminal authority codes.

The independent connect defaults are 240 attempts/minute per canonical client IP
and 12/minute per authenticated machine; neither has an in-memory fail-open fallback.
Restart closes sockets with 1012; the CLI reconnects using capped exponential
full jitter. Protocol/authorization failures are terminal; repeated replacement
is bounded. Explicit local stop never reconnects.

The server lifecycle drains upgraded connections, joins their outstanding
storage work and closes notification subscribers before disconnecting Prisma or
Redis. A failed drain does not claim shared dependencies are safe to close.
Request logs include only sanitized paths, never headers, frames, query strings,
credential lookup errors or remote error details.

Named tests cover the protocol, CLI state machine, HTTP boundary, authority,
transport, lease commands, invalidation monitor, notification subscriber and
server lifecycle. The disposable runtime harness has a `--runner-transport-only`
mode for real Redis/PG integration; the full Boat gate includes it automatically.
The `--chess-runner-only` mode covers durable control races, lost delivery,
deduplication, generation replacement, strict source partition and zero hosted
inference/engine work. The real socket heartbeat fixture controls the production
25s clock while retaining actual native/application socket traffic, so VM
scheduling cannot consume its IO deadline.
