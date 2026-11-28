# Runner transport v1

The runner connects outbound to `wss://<origin>/api/cli/runner/ws`. Its only
credential is the purpose-scoped runner machine bearer from enrollment. Cookies,
browser Origins, query parameters and WebSocket subprotocol credentials are
refused. Companion sessions and API keys cannot authorize this connection.
The browser continues to use protected cookie/CSRF RPC controls.

E2 implements transport simulation. It does not create games, dispatch model
requests, write moves or settle results. Valid match messages receive
`UNSUPPORTED` after the ownership check. E4 owns durable command delivery,
runner-machine/match association and legal move/sequence CAS. An `offer` currently
contains only a command ID and configuration digest; E4 must extend its strict
payload before game execution is enabled.

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
sequences are E4's responsibility. Reconnect never automatically replays a model
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
Match messages require the authenticated owner and runner source; E4 adds the
specific machine association and transactional match mutation fence.

Every replica subscribes to E1's transactional PostgreSQL
`runner_machine_revoked` channel and the Redis `runner_ws_replaced` channel.
Notifications contain IDs/generation only. Either subscription failing closes
live connections and blocks new upgrades until subscriptions recover. Durable
rechecks remain mandatory because a notification may be missed.

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
