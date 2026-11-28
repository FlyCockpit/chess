# Account data export

Settings → Profile → Export account data offers a JSON download containing account
data and a PGN download containing owned games. Both private and published games
are included. Files download directly to the signed-in browser; no email link,
public export URL or server-side export file is created.

Sign in again before downloading if the last primary password or identity-provider
authentication was more than five minutes ago. Session rotation does not renew
that proof. The existing forced second-factor policy still applies. Export is
available to active users even before email verification; it grants no spending or
credential authority. Impersonation, device-flow sessions, API keys and runner
bearers cannot authorize an export.

The cookie-only `POST /api/account/export?format=json|pgn` endpoint requires the
same `x-csrf-token: orpc` header as the cookie RPC surface. The account comes from
the session; the request cannot select another user. The browser sends its expected
document identity and discards downloads if that identity changes.

The endpoint has an independent fail-closed budget (by default three downloads per
hour, allowing JSON, PGN and a retry). Invalid methods, missing cookies/CSRF or
unsupported query parameters do not spend that account quota.
An independent fail-closed IP budget (by default 120 requests per minute) protects
session lookup, including requests that fail those checks. Database reads use
explicit field allow-lists and bounded keyset pages (50 metadata rows or five
archives), with fresh session, ban, deletion and
second-factor checks under the credential lock, including a final completion
check. The response is a private,
non-cacheable attachment streamed with backpressure. A revoked session or deletion
request interrupts the export; an interrupted download must be retried after
signing in. An export is bounded to four minutes and one GiB; exceeding either
limit interrupts it and the UI directs the user to support. Downloads reflect
data read during the export rather than a historical
database snapshot. Already downloaded files remain the user's responsibility.

## Inventory and exclusions

JSON includes safe account/profile and linked sign-in metadata, owned private and
published games, OpenRouter connection metadata, runner machines and current runner
operating-limit settings, reports filed by the account and moderation statements
about owned replays. PGN is the portable game representation; JSON carries the accompanying
account data. Unsupported prerelease archives are identified explicitly rather than
accepted as an older archive format.

`runnerLimitStates` includes current stored operating/hard limits, pending revision
and last acknowledgement for each owned machine. The export reuses the runner's
strict current-state parser and checks exact owner/machine binding. Expired settings
are omitted. Malformed, oversized or mismatched settings produce only an
`unsupported_runner_state` marker for the owned machine, never the raw stored value.

`reports` contains only notices filed while signed in as the requesting account;
notices from other people about that account's replays and anonymous notices are
excluded. Daily IP-derived deduplication hashes and reporter identities are never
exported. `moderationActions` contains safe statements of reasons for owned replays,
without administrator identities. Privileged decisions about other accounts are
excluded even if the requester authored them. Owned game metadata also includes
the current hide state, reason, statement and visibility revision.

Authentication and connection secrets are excluded: passwords and their hashes,
session tokens, linked-provider access/refresh/ID tokens, two-factor seeds and
backup codes, device/user approval codes, API keys and their hashes, runner secrets
and their digests, claim-link tokens and CLI proofs, and OpenRouter key ciphertext,
nonce and encryption-secret identifier. Short-lived verification/reset/email,
runner-limit proof and TOTP replay-fence records are security proofs, not portable
settings, and are excluded. Operational logs and backups follow their separate
retention policy and are not exposed through this self-service endpoint.

The schema inventory test walks Prisma DMMF relations from `User`. Every reachable
model must be exported or explicitly excluded with a reason. New user-linked models
must update both the allow-listed projection and that inventory, including indirect
relations. `Verification` has no User foreign key, so its supported settings
namespace and excluded proof namespaces are inventoried separately.

Account deletion and physical verification-record cleanup are documented in
[Account deletion](./account-deletion.md). The account export creates no additional
persisted data to erase.
