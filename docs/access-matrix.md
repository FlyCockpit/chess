# Access matrix

The server uses visitor, user, and admin roles with default-deny authorization.
Only admins may spend the operator's inference funds or import drafts. Operator-funded
hosted inference rechecks the owner's live admin role at every HTTP dispatch, ordered
against role updates; demotion interrupts that funding without switching keys. Eligible hosted
matches may be committed as official by their verified owner before acceptance.
Signed-in users with a verified email may run hosted matches billed to their own
connected OpenRouter key once the operator sets `CHESS_USER_MATCHES_ENABLED`
(owner decision 2026-11-26: "any verified user who connects OpenRouter"; user
matches are private by default and the owner may publish them). Neither owners
nor admins may change official status after acceptance.

`implemented` rows bind live procedures; `planned` rows describe future work.
Permission cells use `none`, `read`, `write`, `full`, or `own`; `own` requires
handler-level ownership checks as well as sign-in. The policy checker verifies
registered access levels; handler tests verify ownership and custom role rules.

| Feature | Status | Anonymous | User | Admin | Enforcing procedure | Notes |
|---|---|---|---|---|---|---|
| Read arena configuration | implemented | read | read | read | `chess.info` | No secrets; includes immutable code-shipped prompt bundle IDs/text/hashes and the per-side hosted budget limits, whether user matches are open, the per-user daily limit and the source-code link (operator config) |
| Browse published matches | implemented | read | read | read | `chess.list` | Public projection only; cursor bounded; excludes hidden and deletion-pending-owner replays. Public list optionally filters to hosted/self-run human-v-model games using pinned participant types; same visibility and bounded public-ID cursor, no archive or owner disclosure. |
| View a published game and replay | implemented | read | read | read | `chess.get` | Drafts/hidden/pending-owner transcripts never public; an unsupported ruleset returns its card with no archive. Spectator-only scores; finished hosted games or parked hosted human turns may enqueue purpose/generation-scoped backfill after fresh visibility check. Local/runner games never trigger server engine work |
| Check public replay visibility | implemented | read | read | read | `chessModeration.visibility` | Lightweight publication/hide/deletion fence; no transcript, owner address, reports or engine work. Mounted finished replays refresh every 20 s and on focus; every export revalidates |
| Report a published replay | implemented | write | write | write | `chessModeration.report` | Anonymous or signed in. Independent fail-closed trusted-IP and replay/IP budgets, daily purpose-bound HMAC dedup, bounded reason/note, no copied transcript/raw IP. Private/hidden/deletion-pending slugs are NOT_FOUND; signed-in reporters require live active authority. Reporter deletion cascades their notes |
| Review replay reports | implemented | none | none | read | `chessModeration.list` | Registered admin gate plus live authority under credential lock and final disclosure check; bounded cursor page with latest ten reports/actions; no raw IP/dedup digest/reporter addresses |
| Hide or restore a replay | implemented | none | none | full | `chessModeration.setHidden` | Live admin session under credential lock, row-serialized reason and audit. Independent hide/version fence survives owner republish and anonymization; reason/history visible only to uploader/admin. Official commitments/results unchanged |
| Read official results | implemented | read | read | read | `chess.leaderboard` | All committed hosted starts, independently of transcript publication; points / all starts, W/D/L, pending, withdrawals, provider/account/infrastructure errors. Database aggregation over the full ledger with bounded cursor pages. Comparison scope includes prompt, rules, initial position, billing cohort and opponent type |
| Read official commitments | implemented | read | read | read | `chess.officialEntries` | Cursor-bounded permanent minimal public model/settings/outcome ledger; no owner, title, slug, private transcript, credentials or match IDs. Entries survive match/account deletion |
| Create a hosted match | implemented | none | own | full | `chess.create` | `hostedPlayerProcedure` (verified email, no API key, 2FA policy). Users: only billed to their own connected OpenRouter key, only while `CHESS_USER_MATCHES_ENABLED`; one active match, `CHESS_USER_DAILY_MATCHES` per 24 h. Practice by default; explicit per-match pre-start official consent is available only for hosted model-v-model or model-v-random with server-resolved identities and prompt/settings. Exactly one human against a model requires fresh context and practice, with a finite server think deadline; only the model side uses the selected authorized key. The supported prompt ID is resolved server-side and pinned with its hash/text at creation; clients cannot supply instructions or edit a pin. Admins: operator key or their own key (user caps), same practice default/consent. No human, local, imported or random-v-random enrollment. Owner-scoped creation key + config digest replays accepted creation exactly; match, receipt and commitment share the admission transaction. Queue cap for everyone; counts under one advisory lock |
| List hosted models for the create form | implemented | none | read | read | `chess.models` | Server-side OpenRouter catalog, cached 1 h; no key sent |
| Import a local archive as draft | implemented | none | none | full | `chess.importGame` | Validate full move sequence and exact current prompt/rules shape; no credential fields. Imported bundle pins describe reproducibility, never trusted execution; source is forced local and no official entry is created |
| Publish or unpublish own game | implemented | none | own | own | `chess.publish` | Owner-scoped; publishing or unpublishing never changes the pre-start official commitment or its denominator |
| See hosted capacity | implemented | none | none | read | `chess.capacity` | Running vs limit, queued vs cap, engine pool; bounded list of titles and owner names only |
| Stop a hosted match | implemented | none | own | own | `chess.stop` | Owner-scoped; no further inference after cancellation. Credential lock orders cancellation with deletion; a previously admitted stop preserves owner-delete after a committed pending fence |
| Play an own hosted human turn | implemented | none | own | own | `chess.move` | Same verified browser-only hosted gate; live session under credential lock, exact owner/hosted source/human side/turnId/event sequence and server deadline CAS. UCI promotion or resign only; stale/repeated/foreign input cannot create another turn. Dedicated fail-closed 120/min owner budget. Human waits release worker claims; accepted moves commit before deterministic wake and bounded repair; no official enrollment |
| Offer an own local runner match | implemented | none | own | own | `chess.createRunner` | Protected cookie browser only; fresh verified non-impersonated sign-in/forced-2FA and deletion eligibility rechecked under credential lock. Exact live owner machine; source forced runner, archive local, billing runner-local and never official. Owner creation key/config digest receipt, bounded active matches and durable offer committed before ID-only Redis hint; no hosted queue or inference |
| Request an own runner start | implemented | none | own | own | `chess.startRunner` | Same live browser/owner gate and dedicated control budget; only an accepted, current-generation owner machine may start. Exact command/input receipt and revision CAS commit a bounded start before delivery; server clocks/deadlines run through disconnects |
| Play an own runner human turn | implemented | none | own | own | `chess.moveRunner` | Same live browser/session/owner gate and 120/min control budget; runner source, human side, exact revision/accepted ply/FEN and server deadline. Legal UCI/promotion or resign is applied before one durable local forwarding command; duplicate command IDs bind all input and cannot spend twice. No hosted queue or credentials |
| Stop an own runner match | implemented | none | own | own | `chess.stopRunner` | Same live browser gate; exact owner, command ID/payload receipt and expected revision CAS. Cancels prior outbox, clears generation/grace and commits terminal stop before delivery. Same ID cannot target another match or parameters |
| Read own runner control state | implemented | none | own | own | `chess.runnerStatus` | Same live browser gate; owner-scoped authoritative accepted sequence/FEN/ply and state/revision/contact/grace only. No credentials, local endpoints, hard policy or inference context |
| Inspect own private archive | implemented | none | own | own | `chess.inspect` | Owner-scoped; queue position and who pays; same spectator scores and backfill as `chess.get` |
| Browse private studio | implemented | none | own | own | `chess.studio` | Owner-scoped; includes drafts and safe moderation statement/recent ten decisions independently of replay support; no reporter/actor identity or private reports |
| See own OpenRouter connection | implemented | none | own | own | `openrouter.status` | Label, last four characters, key hash and OpenRouter's limit/usage numbers (cached 60 s); never the key or its ciphertext. Introspection HTTP rechecks durable owner authority under the credential lock and retains the original key-use lease deadline |
| Export own account data | implemented | none | own | own | — | Cookie-only `POST /api/account/export?format=json\|pgn`, CSRF and expected-document-identity checks; live non-impersonated browser session with genuine primary authentication within five minutes, fresh forced-2FA/ban/deletion gates. Independent fail-closed IP floor and own download budget (defaults 120/min and 3/hour). Bounded streamed private attachment includes own private/published games, safe account/OpenRouter/runner metadata, only reports filed by the requester and safe statements about owned replays. Never credentials, proofs, IP dedup hashes, reporter/actor identities or other-account audits; no emailed capability |
| Disconnect own OpenRouter key | implemented | none | own | own | `openrouter.disconnect` | Deletes the sealed key and fences the caller's queued/running own-key match as an owner withdrawal in the same transaction; answers `stopped: "stopped"` only once no key-use lease remains on the key (`"pending"` after 10 s without confirmation). Own budget: 20 per 10 min. Credential → admission ordering preserves owner-delete when a previously admitted disconnect crosses the durable deletion fence |
| Spend the first-admin setup link | implemented | write | write | write | `setup.claimFirstAdmin` | The link token is the credential; 404 unless `SETUP_KEY` is set; refused once any admin exists; per-IP budget and secret-free audit line |
| See that `SETUP_KEY` is still set | implemented | none | none | read | `settings.setupKeyStatus` | Hidden (404) from non-admins; drives the "Remove SETUP_KEY" banner |
| Resend an unfinished invite | implemented | none | none | full | `users.resendInvite` | Hidden (404) from non-admins; mints a fresh one-time set-password link and kills the earlier one; refused (409) unless the user is a pending invite (unverified, only a password account, never signed in), and for archived users, re-checked under a per-user lock a finishing password reset also takes; fail-closed budgets per admin (`rl:users-invite-mail`, shared with invite) and per invitee (`rl:users-resend-invite`) |
| Change a user's role | implemented | none | none | full | `users.setRole` | Named confirmation; self-demotion refused; shared Serializable last-active-verified-admin guard; structured audit after commit; localized refusal reasons |
| Archive a user | implemented | none | none | full | `users.archive` | Self-archive refused; same last-admin guard; ban and session deletion in the guarded transaction |
| Request deletion of a user | implemented | none | none | full | `users.remove` | Self-delete refused; same last-admin guard and durable deletion request as self-service. Revokes credentials and fences spending immediately; fsyncs external suppression before pending acceptance; the same bounded cleanup as self-service removes the account only after confirmed stop and data cleanup, never claims early completion |
| Request own account deletion | implemented | none | own | own | `settings.deleteAccount` | Cookie browser session only, protected/forced-2FA gate; exact DELETE confirmation, live non-impersonated session with primary `authenticatedAt` proof no older than five minutes (password or SSO re-sign-in; rotations preserve it), own fail-closed budget. Session identity only. Administrators transfer authority first. Returns durable pending acceptance only after external suppression is fsynced and revokes sessions; active settings UI requires fresh primary proof and typed confirmation. The minute worker completes bounded erasure only after positive live-stop evidence; accepted never means complete |
| Create an own CLI API key | implemented | none | own | own | `cliAccess.apiKeys.create` | Existing protected/forced-2FA gate; live session checked under credential lock before and after mint; revoked/expired session remains UNAUTHORIZED |
| List own runner machines | implemented | none | own | own | `cliAccess.runners.list` | Cookie browser session only, protected/forced-2FA gate; fresh live non-impersonated browser session and ban check under the CLI-credential lock; cursor bounded; safe metadata only |
| Read own runner operating limits | implemented | none | own | own | `cliAccess.runners.getLimits` | Same live verified non-impersonated browser gate under the credential lock; actual CLI-confirmed values, local ceilings, pending revision and safe acknowledgement only |
| Verify an own runner limit increase | implemented | none | own | own | `cliAccess.runners.proveLimits` | Fresh password or authenticator verification with an independent fail-closed attempt budget; expiring one-use proof binds user, live session, machine/run, connection generation, exact proposed values and current revision. No supported method requires security setup |
| Change own runner operating limits | implemented | none | own | own | `cliAccess.runners.setLimits` | Raises consume the exact bound proof under the reset/revoke credential lock; reductions need ordinary live owner authority. One pending revision; CLI acknowledgement confirms application. Local hard ceilings, provider/key/model authority and accrued spend are never browser writable |
| Claim a local runner run | implemented | none | own | own | `cliAccess.runners.claim` | Cookie session and CSRF only; live verified non-impersonated browser identity and forced-2FA checked under credential lock. Atomic first eligible account wins; foreign/expired links reveal no owner. Fragment secret grants no poll/exchange or machine authority |
| Revoke an own runner machine | implemented | none | own | own | `cliAccess.runners.revoke` | Same live browser gate and lock; foreign IDs are NOT_FOUND; durable revocation increments generation and publishes transactional ID-only invalidation; revoked runners cannot resume |
| Connect a paired runner transport | implemented | none | own | own | — | `GET /api/cli/runner/ws`: runner machine bearer only; no cookies, browser Origins, API keys or query credentials. Strict v1, active/non-deleting owner, machine/generation/lease checks on messages and heartbeat; independent fail-closed connect budgets. Durable bounded offer/accept/reject/start/stop/move/evaluation/terminal/snapshot/ack control and exact machine binding across reconnect. Server validates ply/FEN, legal moves and terminal evidence; local scores/costs remain unverified and never official |
| Play and simulate locally | implemented | full | full | full | — | Public random baseline and local-process provider lab; no hosted spending |
| Connect own OpenRouter account | implemented | none | own | own | — | Hono routes `POST /api/openrouter/connect` and `GET /api/openrouter/callback` (OAuth PKCE S256, single-use state bound to the session user and a cookie, CSRF header, own fail-closed limiter); key sealed AES-256-GCM, never returned |
| Purchase hosted play | planned | none | none | none | — | Deferred pending pricing and spend controls |
| CLI identity and release metadata | implemented | none | read | read | `cli.whoami`, `cli.latestRelease` | Requires a CLI credential |
| End a CLI session | implemented | none | own | own | `cli.logout` | Scoped to the current session |
| Import an archive from the CLI | implemented | none | none | full | `cli.chess.importGame` | Same admin gate as the hosted procedure |
| Inspect an archive from the CLI | implemented | none | none | full | `cli.chess.inspect` | Same owner scope; the CLI copy keeps the admin gate. API procedure for CLI clients; the companion CLI has no `inspect` command |
| Publish a draft from the CLI | implemented | none | none | full | `cli.chess.publish` | Explicit admin action; API keys cannot pass the admin gate |

Route visibility never substitutes for procedure authorization. Public records
must exclude keys, private inference context, owner account details, and drafts.
CLI endpoints retain the access levels registered in the server.

Better Auth's cookie-only `POST /api/auth/admin/stop-impersonating` restores only
the live original admin session named by its signed saved-session cookie and
bound to the live target session's `impersonatedBy`. The original actor must
still satisfy the shared verified-admin, ban/deletion and forced-2FA policy;
the saved session must be a non-impersonated browser sign-in session. The target's
role, verification, ban or pending-deletion state cannot authorize or veto this
return. Better Auth retains its origin/CSRF checks and session restoration;
every other admin plugin endpoint continues to require active admin authority.
Impersonation session insertion also takes the actor's credential lock and
rechecks the active actor and exact live parent within its committing transaction,
so delayed requests cannot retain a physically erased actor in a peer's session.

Runner enrollment uses a per-run claim/exchange surface. Anonymous POSTs to
`/api/cli/runner/begin`, `/poll` and `/exchange` have independent fail-closed IP
budgets, strict bounded bodies and no cookie/bearer fallback. Begin stores
separate purpose-bound link/proof digests with a ten-minute expiry; pending
and retained recovery rows have a global cap and bounded expiration cleanup.
Only the originating CLI's high-entropy proof can poll claimant identity or
exchange authority. The browser receives no reusable runner secret. Exchanges
derive one credential from that proof and the claim ID, so lost responses replay
without minting another machine; expired claims, revoked machines and loss of
the original approving session fail closed. A fresh invocation creates a new
claim; explicit local resume restores only that origin's existing machine.
Enrollment requires a live,
non-impersonated browser session, a verified unbanned owner, the current forced
second-factor policy, a finite expiry and a cap of 25 active machines under the
same credential lock as reset. Only a purpose-bound digest and display prefix
are stored. Runner secrets are refused by the companion CLI resolver and never
become browser sessions, API keys or admin authority.

Password recovery, authorized admin password reset, untrusted-password-write
quarantine, pending invite/SSO activation and archival revoke runner machines.
Admin deletion establishes the same durable pending fence as self-deletion and publishes runner invalidation; it does not cascade the account before physical cleanup.
The authorized admin reset fences live credentials in its account before hook,
before the password write; unauthorized reset bodies have no revocation effect.
An ordinary signed-in password change retains runner machines while preserving
the existing companion API-key/device-session policy. Unarchive never restores
revoked machines. Transactional `runner_machine_revoked` PostgreSQL notifications
carry user/machine IDs only; runner transport must subscribe on each replica and
also check durable authority on connect, action and heartbeat so missed pushes
cannot preserve access.

The cookie OpenAPI procedure surface (`/api-reference/<procedure>`) requires
the `x-csrf-token: orpc` request header, just like `/rpc`.

Authenticated gates reject active bans, including permanent archival bans,
even if a session row survives. Expired temporary bans permit access. Cookie
session resolution treats active bans as anonymous for rate-limit/context
consumers; hidden admin procedures retain their 404 response. These checks
use the resolved user; Better-Auth's cookie cache is disabled so session reads see revocations on the next request.

The reviewed endpoint baseline in `scripts/access-matrix-pre-notes-baseline.json`
additionally preserves the minimum access level of existing procedures. Change
exact entries only in the same reviewed change that removes their endpoints.

Password reset and activation retain the existing permission contract. A shown
invite link is usable only for an unverified user with exactly one credential
account and no live sessions; mailed proof verifies only the token's recorded
mailbox. The consume decision, competing-link retirement, verification and
password commit share one transaction. Verify-email and authorized IdP insertion
serialize on the same per-user locks. Pending authorized IdP insertion clears
prior password access and standing credentials before creating the new IdP
session. Existing Better Auth implicit-link denial for unverified local users,
SSO trust, signup flags and procedure access levels remain unchanged.

Official enrollment metadata is immutable. Existing status/runToken/heartbeat compare-and-set writes settle the ledger once through a database trigger in the same transaction. Owner stop, disconnect, recovery reset and deletion earn no points; provider/account/infrastructure errors remain unscored categories, never fabricated model losses. Late workers cannot replace a settled outcome. Unpublishing and subsequent replay moderation cannot remove participation. Ordinary signed-in password changes retain active matches. The old admin setOfficial endpoint is retired, with no replacement post-start write; the reviewed baseline contains no entry for it.

Deletion-pending accounts have no admission, credential mint, callback, move or future provider dispatch authority. Deletion serializes password writes, CLI credentials, setup and hosted admission before committing its tombstone and revocations. Published replay readers immediately hide pending owners. D2b resumes bounded cleanup, anonymizes retained published replays (including hidden ones), removes private matches and then deletes the account; the permanent official ledger remains independent. See [Account deletion](./account-deletion.md) for the lifecycle and cleanup inventory.
