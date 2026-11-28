# Local runner execution

The paired CLI runs the common chess rules and model runner on the owner's machine.
Every actual provider request uses the local authority described in
[Local runner authority](./runner-local-authority.md). The website supplies current
chess settings, locally permitted model identifiers and prompt version `1`; it
cannot supply provider keys, endpoints, paths, tools or system instructions.
The CLI resolves the immutable prompt bundle locally and refuses unknown versions.

For OpenRouter, set `OPENROUTER_API_KEY` in the private terminal's environment
before invoking the CLI. The key is never entered into the claim page or sent
to the Cockpit website. Alternatively, select a local loopback model in the
local configuration. The root command reads local `runner-policy.json` before pairing. Explicit
`--max-match-usd`, `--max-day-usd`, `--max-concurrency`, `--provider-url` and
`--allow-model` flags override that file. With no allowlist, the model catalog is
fetched locally from OpenRouter. An explicitly selected loopback endpoint requires
local model identifiers. The startup notice prints active price-checked hard and
operating limits. Browser operating-limit revisions use the durable local limit controller. Raises require the existing browser step-up; every applied or refused revision is echoed in the private terminal. A reduction aborts and durably fences active local games before its receipt is sent, while new games may use the reduced limits.

`RunnerGameLoop` consumes the fixed schemas in `runner-protocol.ts`. An offer
contains the current config and `runnerConfigDigest(config)`. The digest normalizes
FEN and the default illegal-move policy. The executor derives allowed capabilities
locally, takes a concurrency authority and journals acceptance before replying.
Only models and protocols advertised by that executor may be selected.

Game `expectedSeq` and `acceptedSeq` count legal moves, starting at zero. They are
separate from the WebSocket envelope's sequence and the local archive's event
sequence. A move carries its resulting one-based `ply` and resulting `fen`.
Each `start` runs at most one automatic turn; a human `start` arms the common
bounded human turn and waits for `human-move`. Before another automatic turn,
`resume` must confirm the exact local move count and FEN. A snapshot distinguishes
the locally computed ply from the last confirmed server sequence. Transport ACKs
alone never authorize another paid turn. E4 supplies durable server commands and
checks every move against the authoritative board; client scores and completion
events are advisory and never official.

The journal follows the selected local spending authority under the OS user's
`~/.cockpit-chess/runner-games/` directory. New machine claims, website origins and
CLI config overrides do not reset it; its local scope fingerprint never goes on
the wire. The private journal records `offered`, `ready`, `uncertain` or `terminal`, the
archive, config digest and confirmed move count. Before automatic execution it
persists `uncertain`; only after execution settles does it persist a known result.
An unresolved inference is never retried after reconnect or restart. A stop is
acknowledged only after a durable terminal fence; the final archive may settle
later, but a terminal fence can never be downgraded to a resumable phase. Fresh-context
matches may restore a known `ready` archive after explicit reconciliation.
Persistent-context matches keep private memory only in the current process and
refuse process-restart restoration because that memory was not persisted. A
transport reconnect may reuse that same process's settled memory. Human games
require fresh context.

All evaluations use the same local engine module as hosted execution: Stockfish
19.0.1 lite single-thread, one thread, 8 MiB hash, cleared hash per search and a
finite 1,000–100,000-node allowance. The subprocess receives an empty environment.
Player tools/feedback use the common runner; spectator scores use the same local
pool's lower-priority lane. The engine is probed locally before advertising its
capability. Missing engine assets disable the capability; engine-enabled rules
are then refused. There is no server evaluation fallback. E6 proves resolution
inside the self-contained npm artifact.

Connection loss aborts the originating session signal; new paid calls stop,
in-flight authorization is aborted and unknown reservations remain held. Failed
outbound sends abort that match. Local stop, credential expiry, permanent
transport failure and exhausted reconnect budgets close execution and wait for
local tasks before releasing authority. Corrupt or unsafe journal files and
uncertain persistence fail closed; a crash leaves an exclusive lock for explicit
local operator recovery. Never remove the JSON journal or spending ledger to
recover a connection.

Terminal events carry only bounded `result` and `termination` enums alongside the
kind. They do not carry raw provider errors, headers, private model replies or
credentials. The server must validate this advisory metadata under its own rules
and ownership fences. Capability lists are bounded both by entry count and the
complete transport frame's byte limit.
