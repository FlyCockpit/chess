# Local runner authority

The local runner policy is the spending boundary for the paired runner. The
website never supplies keys, inference endpoints, filesystem paths, provider
headers or hard limits. The E3a module supplies authority to the E3b game loop;
it does not enable a remote game executor or change the standalone local lab.

Startup uses `readLocalRunnerOptions()` and `RunnerPolicy.open()`. The local
`runner-policy.json` in the CLI config directory may contain `baseUrl`,
`allowModels`, `maxMatchUsd`, `maxDayUsd` and `maxConcurrent`. Startup flags with
the same fields override that file. Dollar values are decimal strings with at
most six decimal places. These options are never wire-message fields. Print
`policy.startupNotice()` to stderr before pairing; the later CLI command owns
flag registration and that startup flow.

Local price-checked ceiling defaults are **$25 per match, $100 per rolling 24 hours and 8 concurrent
matches**. Operating defaults are **$1, $10 and 2**. Only local startup options
change hard ceilings. `applyOperatingLimits()` accepts a strict operating shape
and the next revision, bounded by the hard ceilings. E3S owns browser step-up,
wire validation, terminal change notices and acknowledgement handling. Reducing
a limit stops active authorities before an in-flight reservation can authorize
another request; the loop must settle those authorities before releasing their
concurrency slots. Raising a limit never revives a stopped authority.

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

Every actual response has its own awaited settlement callback. Complete
provider-reported cost reduces that request's reservation to the charge, rounded
up to integer micros. Otherwise complete exact token/category counts can settle
against identical locally quoted route tariffs. Missing categories, ambiguous
overlap, differing route tariffs, malformed usage and process crashes keep the
full hold. No guessed discount frees authority. A reported charge above the
reservation stops the policy and persistently blocks the ledger; uncertain
block persistence leaves its lock for local investigation. Expensive routes or
large windows may need lower output limits or explicitly raised local limits.
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
persistence poisons the handle.
Rolling-day timestamps use a persisted clock high-water mark and monotonic
elapsed time; midnight and clock rollback do not reset authority. Match totals
and one-use request IDs, original reservations and successful settlements survive restart. A bounded 32,768-record ledger refuses
new calls when full; it never drops old reservations to make room.

A crashed process leaves the lock intentionally. A local operator may remove
only that authority's `.lock` after verifying its recorded PID is no longer
running. Keep the `.json` ledger. Do not remove or reset it to reconnect, switch
websites, change profiles or recover a network failure. File corruption,
unavailable storage or uncertain recovery prevents dispatch. Windows keeps
file sync and same-volume atomic replacement but cannot fsync directories;
the package's platform acceptance must exercise that storage behavior.
