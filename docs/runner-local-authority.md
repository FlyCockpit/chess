# Local runner authority

The local runner policy is the spending boundary for the paired runner. The
website never supplies keys, inference endpoints, filesystem paths, provider
headers or hard limits. The policy supplies authority to the paired
[local game loop](./runner-game-loop.md); the standalone local lab keeps its own
existing local provider configuration.

Startup uses `readLocalRunnerOptions()` and `RunnerPolicy.open()`. The local
`runner-policy.json` in the CLI config directory may contain `baseUrl`,
`allowModels`, `maxMatchUsd`, `maxDayUsd` and `maxConcurrent`. Startup flags with
the same fields override that file. Dollar values are decimal strings with at
most six decimal places. These options are never wire-message fields. The default CLI command prints
`policy.startupNotice()` to its private terminal before pairing and registers
these startup options.

Local price-checked ceiling defaults are **$25 per match, $100 per rolling 24 hours and 8 concurrent
matches**. Operating defaults are **$1, $10 and 2**. Only local startup options
change hard ceilings. `applyOperatingLimits()` accepts a strict operating shape
and the next revision, bounded by the hard ceilings. Settings → Command-line
access → Operating limits shows confirmed values, ceilings and pending changes.
Increasing any component requires a fresh password or authenticator code;
reductions require the live owner session. Accounts without either supported
method get a link to Security to set up an authenticator. Reducing
a limit stops active authorities before an in-flight reservation can authorize
another request; the loop must settle those authorities before releasing their
concurrency slots. Raising a limit never revives a stopped authority.

`RunnerLimitController` owns strict operating revisions and terminal receipts.
Construct it with the local hard limits and a `runnerLimitFileStore(origin,
machineId)`; the game executor passes its `RunnerPolicy` as the policy adapter.
Restore happens before any match starts. Keep one controller through transport
reconnects and supply `hello` as a callback so it advertises current values.
Each accepted or refused request, including replay, prints requested/current
values, revision and the local ceilings. Above-ceiling values are refused,
never clamped. Limits do not reset or replace the separate spend ledger.

The browser's two-minute one-use proof binds the user, live browser session,
machine/run, connection generation, current revision and exact proposed values.
Proof creation, consumption and durable command state use existing Verification
storage under the same credential lock as reset/revoke. Only one change may be
pending. A queued request is not a confirmed change: the CLI durably saves a
receipt before applying/acknowledging it. The server redelivers the same command
after a lost ACK; replay returns the saved receipt. Sign-out, expiry, reset,
revocation, archival and deletion cannot preserve proof authority.

Local limit state lives in the private CLI config directory's
`runner-limits-v1/`, separately from provider spend. It uses an exclusive lock,
atomic replacement and file/directory sync. Before exposing authority, the store
preallocates one private one-byte `.stop` cell per paired run and keeps its writable
descriptor open. Cancellation writes and syncs permanent intent through that
descriptor before acceptance, even if directory permissions or new-name allocation
prevent the subsequent JSON save. Restart reads this cell before restoring limits;
stopped intent overrides an older unstopped JSON snapshot. The cell is never reset,
replaced or deleted, and adds one fixed file rather than per-crash history. Existing
state without a cell, or an empty cell beside existing state, refuses storage.
Only never-usable initialization with no JSON may complete an empty cell under
exclusive ownership. Malformed or unsafe cells always refuse; there is no
old-format fallback. Explicit local stop persists for
that run and cannot be reversed by remote commands or explicit resume. An exactly
identified dead owner can be reclaimed through the shared ownership chain described
below. Keep the state JSON and ownership history. Corruption, an unsafe directory
or a failed durable write stops authority. Terminal transport cleanup drains
writes while local cancellation stays active. A guarded synchronous unlock is
the close boundary; cancellation accepted before it is durably recorded, and
a stop after completed closure fails explicitly. Receipt storage is bounded; a full
receipt history refuses further updates rather than forgetting an old command.
If the underlying device cannot write or sync even the preallocated byte, cancellation
rejects with storage failure, stops in-process and retains ownership. No new durable
intent was accepted: arbitrary total write failure followed by process death cannot
preserve information that never reached storage. This physical limit does not permit
clearing a successfully recorded stop. Ordinary clean crashes leave the cell runnable
and remain eligible for exact-dead-owner recovery.

For each accepted match, call `policy.beginMatch(matchId, sessionSignal)` with
the **validated E2 message handler's session signal**. E2's local heartbeat and
60-second liveness timer abort this signal on connection loss. Pass the returned
authority's signal to the chess runner and use
`localCredentials(archive, { runnerAuthority: authority })`. Both sides then
use the same persistent match total. Stop aborts the authority; call `finish()`
only after the local loop has settled. `policy.close()` permanently stops the
run, waits for pending ledger writes and releases its exclusive ledger lock.
Neither reconnect nor a remote command can reopen that policy. E3b owns durable
turn/command reconciliation and must never replay an inference with an unknown
outcome after a lost acknowledgement or process crash.
After settling the old loop and reconciling a known turn, E3b may call
`authority.resumeConnection(newSessionSignal)`. This replaces an already-aborted
transport signal while retaining the same ledger match total. It refuses a live
old connection, a local stop, a limit-reduction stop or a finished authority.

With no local model allowlist, the permitted identifiers come from the fixed
OpenRouter model catalog fetched locally, without a key. An optional local
allowlist narrows it. Remote models must accept text input and produce only text.
Aliases, variable or unknown prices, unknown pricing dimensions and unsupported
endpoints fail closed. Only the exact OpenRouter
API prefix or an explicitly selected loopback endpoint is supported by this
runner policy. Loopback models require a local allowlist and receive no vendor
key; the existing explicit local provider key may be selected by the operator.
The website never connects to a loopback listener.

Before every actual paid HTTP attempt, the CLI refreshes the pinned provider's
endpoint prices, persists the reservation, then re-fetches and compares every
price/bound before dispatch. A changed or expired snapshot refuses the request
and retains the reservation. A monotonic 15-second authorization deadline and
a synchronous final check prevent stalled storage or scheduling from using an
expired quote. Provider variants selected by that routing tag are bounded
together. The request pins `provider.only` and `order`, disables fallback,
requires supported parameters, denies provider data collection, and supplies
token/request maximum prices. These preferences apply to native Messages,
Responses and Chat Completions. See the official
[provider routing contract](https://openrouter.ai/docs/guides/routing/provider-selection)
and [endpoint catalog](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).
All priced text models remain eligible; there is no author/provider family
allowlist. Base input, cache reads and cache writes are added even for overlapping
categories; separate reasoning rates are included in the output reservation.
Gemini requests remove explicit `cache_control` markers because those activate
an independently charged cache-storage feature. Implicit caching, prefix text,
session IDs and cache keys remain. Other routes without a known explicit-write
price also remove only their explicit markers. Ordinary known write prices keep
their markers. Common runtime and standalone local-lab caching remain unchanged.

OpenRouter exposes no atomic tariff token or separate maximum-price fields for
cache/read/write/reasoning tariffs. This boundary authorizes against the current
locally fetched finite tariff snapshot, rechecks it after persistence, and caps
supported base prices. It does not claim the snapshot is an upstream price lease:
an auxiliary tariff may change after the last read and before acceptance. The
provider's authoritative pricing/billing contract remains external to the local
ledger. A provider price change in that window can exceed a limit once, after
which the runner stops and permanently blocks the local authority. Set a spend
limit on the OpenRouter key for an absolute cap; the local price-checked ceiling
is not an absolute guarantee.

The local bound uses the route's entire accepted input window and the request's
explicit output limit, including separate priced reasoning, cache reads,
cache writes and per-request surcharges. Decimal prices round up to integer
micros. Overlapping cache read/write charges are included together. Explicit
cache creation needs a known write price or is disabled; unsupported cache TTLs, built-in
paid tools, images/audio/video, dynamic service tiers, model fallbacks and
opaque stored context are refused. Cache session headers, prefix keys, fixed
prompt text and cache breakpoints remain unchanged by routing enforcement.

`AgentModel.authorizeRequest` runs at the final serialized HTTP boundary after
cache transforms and the canonical `dataCollection: "deny"` privacy injection.
The CLI selects that existing model/credential flag; it has no second privacy
mechanism. Its routing rewrite preserves the injected preference. It awaits the durable reservation and may return authorized
body bytes to insert the local routing policy. The original hosted
`beforeDispatch` guard runs before and after the await; abort is rechecked and
redirects are disabled. Its returned `beforeSend` guard validates the exact
authorization immediately before HTTP. Every transport retry and fallback needs a separate
reservation. There is no background authorization write.
Both dispatch guards synchronously consult spend validity, including poison, permanent
block, shutdown and recovery-only state. A known invalid charge revokes already-issued
unsent tickets while block publication is still pending; successful safe settlement
does not revoke another live ticket.

Every actual response has its own awaited financial callback. The callback passes
opaque usage into the spend authority; it does not price or compare the response
first. The reservation durably retains the original protocol and exact tariff
context. A detached JSON capture is limited to 64 KiB, 4,096 nodes and depth 16.
The authority serializes capture with reservations under the same exclusive lock.
It writes and file-syncs a receipt, atomically publishes it, and syncs the POSIX
parent directory **before** running the shared pure settlement arithmetic.

Complete provider-reported cost reduces that request's reservation to the charge,
rounded up to integer micros. Otherwise complete exact token/category counts can
settle against identical original route tariffs. Missing categories, ambiguous
overlap, differing route tariffs and malformed usage retain the full hold. No
guessed discount frees authority. A known charge above the reservation, or a
charge contradicting a prior settlement, permanently blocks authority and restores
the original full reservation. The accepted receipt is sufficient evidence even
when both the independent block marker and blocked-ledger rewrite fail.

The receipt and staging file are two fixed names, each capped at 128 KiB; a ledger
sequence/digest/outcome checkpoint binds the input to its original record. A safe
receipt is reused only after a matching ledger checkpoint has committed. Invalid
evidence is never checkpointed or overwritten. Restart reads and classifies the
receipt before returning either normal or recovery authority. A safe receipt
whose ledger reduction did not commit keeps the full uncertain hold; replay does
not invent a refund. A durably settled ledger with the matching receipt/checkpoint
reopens at the actual amount even if SIGKILL preceded receipt reuse. Missing,
corrupt, torn committed evidence or inconsistent checkpoints refuse storage.
Partial uncommitted staging never authorizes classification or a refund.

Acceptance requires durable capture, not merely callback/API invocation. If all
writes fail before acceptance, the report has not been classified and the original
unknown hold remains; no algorithm can remember an input that never reached
storage while also guaranteeing clean-crash liveness. The prerelease numeric test
adapter has this same acceptance boundary and cannot settle production tariff
reservations. POSIX durability assumes working file sync, atomic same-filesystem
rename and directory sync. Expensive routes or large windows may need lower output
limits or explicitly raised local limits.
The startup notice discloses this price-check window and recommends an
OpenRouter key spend limit for an absolute cap.

The ledger is private (0600; private parent directory) under the OS user's
`~/.cockpit-chess/spend-v1/`, keyed by a domain-separated SHA-256 of the locally
selected provider key. It does not depend on website origin, claim, current
directory, config override or runner profile. One exclusive lock refuses a
second process sharing that authority. Atomic replacement, file sync and POSIX
directory sync complete before HTTP. Each app-owned directory is validated as
private, owned by the current user and not a symlink, and its parent is synced
before descent so first-use directory creation also survives a crash. Failed
persistence poisons the handle. The current ledger format is version 2 at the
same `spend-v1` key/path; unsupported old state is refused, never migrated or reset.
Rolling-day timestamps use a persisted clock high-water mark and monotonic
elapsed time; midnight and clock rollback do not reset authority. Match totals
and one-use request IDs, original reservations and successful settlements survive restart. A bounded 32,768-record ledger refuses
new calls when full; it never drops old reservations to make room.

### Crash ownership and local recovery

Spend, game journals and operating limits share the same immutable-generation lock
implementation. Each owner record contains a version, random generation token, PID,
native creation identity, machine identity, boot identity and process namespace.
The current owner format is version 2; unsupported prior formats fail closed.
There is no PID-only compatibility and no age/TTL rule. A live exact owner remains
exclusive, regardless of how long it has held the lock. Unknown permissions, invalid
records, a different machine/namespace, missing identity tools or unsupported storage
fail closed. A changed boot UUID on the same machine, a missing PID within the same
boot/namespace, or a different native creation identity proves the old owner is gone.

A candidate is written privately and file-synced before an atomic same-filesystem
hard link publishes it into a fixed ownership slot. Every generation has exactly one
successor slot, named from its random token. Concurrent restarts must compete for
that same slot; losers follow the published successor and cannot erase it. Successful
close publishes an immutable release marker. Published generations and release markers
are **never unlinked or renamed**, so an observer delayed across multiple handoffs
cannot delete an active successor. No temporary acquisition/reaper guard is installed.
Candidate filenames include a fresh never-reused UUID, PID, birth digest, machine
digest, boot UUID and namespace digest, within NAME_MAX255, so even an empty or
partially initialized dead candidate can be identified. Acquisition scans at most
200,000 entries and refuses admission at 128 retained candidates for that lock.
Only provably dead candidate aliases are removed; live/unknown/foreign candidates
remain. Different boot cleanup requires stable positive same-machine evidence;
the boot-scoped Linux fallback cannot authorize cross-boot cleanup. A candidate
alias left after publication can be collected without touching its published inode
names. A concurrent burst can admit up to one candidate per in-flight acquisition
beyond the scan-time threshold; this is not a global filesystem quota. Generic
ledger/journal/limits atomic-persist UUID temporaries can also survive hard death;
this narrow candidate collector does not claim to bound or collect those files.
Death after publication leaves a complete owner that the next process can reclaim.
POSIX publication and release require parent-directory sync. Windows supports file
flush and atomic hard links on NTFS but Node cannot directory-fsync there; power-loss
durability on Windows is a platform acceptance gap, not a POSIX-equivalent claim.
Use local storage with atomic hard-link support. Network/shared filesystems, file
copy/sync across machines, non-NTFS Windows volumes and manually edited records are
outside the supported authority boundary; unavailable operations refuse authority.

Acquisition traverses at most 65,536 generations per lock (roughly two small files
per successful acquire/release). Names have fixed length rather than nested paths.
History is retained; there is no online garbage collector or unsafe manual cleanup
recipe. Capacity exhaustion refuses new authority and needs an operator-supported
storage migration. Recovery inventory is bounded to 32,768 game records and 200,000
directory entries, retaining only phase/ID metadata and one bounded archive at a time.
These bounds may refuse a long-lived full profile; they never reset a spend ceiling.

Native identity differs by platform:

- Linux first requires `/proc/self/status` NSpid to contain exactly one PID equal
  to `process.pid`. Inherited outer procfs in a nested PID namespace refuses before
  numeric lookup; correctly mounted nested procfs works. It then reads native start
  ticks, kernel boot UUID, machine identity and active PID namespace. Absent/empty
  `/etc/machine-id` uses an explicit boot-scoped identity that cannot establish
  cross-boot sameness. Nonempty malformed/unreadable machine identity refuses.
  Z/X terminal singleton tasks are dead even before reap; a terminal group leader
  with peer threads remains locked. Hidden/unreadable PID evidence never proves
  death; absent procfs needs the kernel's ESRCH too.
- macOS uses standard `/bin/ps` creation display and state, `kern.bootsessionuuid`
  through `/usr/sbin/sysctl`, and `IOPlatformUUID` through `/usr/sbin/ioreg`, with
  fixed `LC_ALL=C` and `TZ=UTC`. No Python/Command Line Tools or install prompt is
  used. Birth display has one-second precision: a same-second PID reuse collision
  conservatively stays LOCKED. Equal birth or approximate age never proves death.
  Native macOS acceptance remains unexecuted on the Linux development host.
- Windows uses native `GetProcessTimes` FILETIME, the boot GUID from
  `NtQuerySystemInformation(SystemBootEnvironmentInformation)`, and registry machine
  GUID through noninteractive PowerShell/.NET. A zero-time native wait distinguishes
  an irrevocably exited process object retained by another handle. Unavailable
  PowerShell, restricted native APIs or permissions fail closed. Native Windows
  acceptance remains unexecuted on the Linux development host.

Every platform rejects missing, all-zero and all-FF machine/boot identity sentinels.
Native helper commands use fixed executable paths and bounded execution/output,
without a shell or server-supplied program text. Only a validated numeric PID is
supplied, and helpers receive a minimal environment without provider credentials.
No time-based stale-lock timeout is used.

Normal startup refuses **any unsettled spend reservation**, even after its rolling
24-hour charge ages out. It also requires successful journal inventory and refuses
any uncertain game journal before pairing, engine setup or game execution. Missing
inventory capability or unreadable inventory refuses storage authority; startup
never silently skips this check. It prints the translated local recovery command:

```sh
cockpit-chess runner-recover --json
cockpit-chess runner-recover --resolve-as-spent --json
```

Run these with the same local provider selection/key as the crashed runner. For a
loopback provider, also supply its original `--provider-url`; that explicit option
overrides `runner-policy.json`. A subcommand provider flag overrides the root flag.
Keys remain in the local environment: there is no key argument and no key in output.
Inspection fetches no model catalog, contacts no server/provider and starts no engine.
It prints bounded request IDs, match IDs, reservations, timestamps, current costs,
settlement-block status and affected game phases. `--json` writes one result object
to stdout; failures use the existing CLI error/exit contract and sanitized text.

`--resolve-as-spent` is the explicit local confirmation. It takes the same spend
lock as normal execution, then the same authority-scoped game journal lock. It first
durably abandons every uncertain/affected unfinished game (or writes a cancellation
tombstone if its journal is absent), then marks unsettled reservations settled at
their **unchanged full reserved amount**. Original timestamps, original reservations,
rolling-day and lifetime match totals, and one-use request IDs are preserved. No
provider call, retry, replay, discount or refund occurs. If death interrupts recovery,
remaining uncertainty or unsettled spend still fences startup; repeat inspection and
confirmation. Already abandoned games remain abandoned. An uncertain journal without
an unsettled reservation (death before dispatch) uses exactly the same command.
Known completed game evidence remains terminal and cannot authorize another inference.
A true overbilling/contradictory-settlement block is inspectable but cannot be cleared
by this command; it requires local investigation. PID-only or corrupt lock records
are also refused for investigation, never interpreted as permission to spend.

Never remove the ledger, journals or lock history to reconnect, change profiles,
switch websites or recover a network failure. `--resume <machineId>` still requires
an existing unrevoked server credential, server-side resume grace, and exact saved
board reconciliation; reclaiming local ownership does not extend those permissions.
