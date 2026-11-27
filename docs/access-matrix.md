# Access matrix

The server uses visitor, user, and admin roles with default-deny authorization.
Only admins may spend the operator's inference funds or import drafts. Eligible hosted
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
| Browse published matches | implemented | read | read | read | `chess.list` | Public projection only; cursor bounded |
| View a published game and replay | implemented | read | read | read | `chess.get` | Drafts never public; an unsupported ruleset returns its card with no archive; includes spectator-only engine scores; a finished game missing some may enqueue one deduplicated background backfill (engine CPU only, no inference spend) |
| Read official results | implemented | read | read | read | `chess.leaderboard` | All committed hosted starts, independently of transcript publication; points / all starts, W/D/L, pending, withdrawals, provider/account/infrastructure errors. Database aggregation over the full ledger with bounded cursor pages. Comparison scope includes prompt, rules, initial position, billing cohort and opponent type |
| Read official commitments | implemented | read | read | read | `chess.officialEntries` | Cursor-bounded permanent minimal public model/settings/outcome ledger; no owner, title, slug, private transcript, credentials or match IDs. Entries survive match/account deletion |
| Create a hosted match | implemented | none | own | full | `chess.create` | `hostedPlayerProcedure` (verified email, no API key, 2FA policy). Users: only billed to their own connected OpenRouter key, only while `CHESS_USER_MATCHES_ENABLED`; one active match, `CHESS_USER_DAILY_MATCHES` per 24 h. Practice by default; explicit per-match pre-start official consent is available only for hosted model-v-model or model-v-random with server-resolved identities and prompt/settings. The supported prompt ID is resolved server-side and pinned with its hash/text at creation; clients cannot supply instructions or edit a pin. Admins: operator key or their own key (user caps), same practice default/consent. No human, local, imported or random-v-random enrollment. Owner-scoped creation key + config digest replays accepted creation exactly; match, receipt and commitment share the admission transaction. Queue cap for everyone; counts under one advisory lock |
| List hosted models for the create form | implemented | none | read | read | `chess.models` | Server-side OpenRouter catalog, cached 1 h; no key sent |
| Import a local archive as draft | implemented | none | none | full | `chess.importGame` | Validate full move sequence and exact current prompt/rules shape; no credential fields. Imported bundle pins describe reproducibility, never trusted execution; source is forced local and no official entry is created |
| Publish or unpublish own game | implemented | none | own | own | `chess.publish` | Owner-scoped; publishing or unpublishing never changes the pre-start official commitment or its denominator |
| See hosted capacity | implemented | none | none | read | `chess.capacity` | Running vs limit, queued vs cap, engine pool; bounded list of titles and owner names only |
| Stop a hosted match | implemented | none | own | own | `chess.stop` | Owner-scoped; no further inference after cancellation |
| Inspect own private archive | implemented | none | own | own | `chess.inspect` | Owner-scoped; queue position and who pays; same spectator scores and backfill as `chess.get` |
| Browse private studio | implemented | none | own | own | `chess.studio` | Owner-scoped; includes drafts |
| See own OpenRouter connection | implemented | none | own | own | `openrouter.status` | Label, last four characters, key hash and OpenRouter's limit/usage numbers (cached 60 s); never the key or its ciphertext |
| Disconnect own OpenRouter key | implemented | none | own | own | `openrouter.disconnect` | Deletes the sealed key and fences the caller's queued/running own-key match as an owner withdrawal in the same transaction; answers `stopped: "stopped"` only once no key-use lease remains on the key (`"pending"` after 10 s without confirmation). Own budget: 20 per 10 min |
| Spend the first-admin setup link | implemented | write | write | write | `setup.claimFirstAdmin` | The link token is the credential; 404 unless `SETUP_KEY` is set; refused once any admin exists; per-IP budget and secret-free audit line |
| See that `SETUP_KEY` is still set | implemented | none | none | read | `settings.setupKeyStatus` | Hidden (404) from non-admins; drives the "Remove SETUP_KEY" banner |
| Resend an unfinished invite | implemented | none | none | full | `users.resendInvite` | Hidden (404) from non-admins; mints a fresh one-time set-password link and kills the earlier one; refused (409) unless the user is a pending invite (unverified, only a password account, never signed in), and for archived users, re-checked under a per-user lock a finishing password reset also takes; fail-closed budgets per admin (`rl:users-invite-mail`, shared with invite) and per invitee (`rl:users-resend-invite`) |
| Change a user's role | implemented | none | none | full | `users.setRole` | Named confirmation; self-demotion refused; shared Serializable last-active-verified-admin guard; structured audit after commit; localized refusal reasons |
| Archive a user | implemented | none | none | full | `users.archive` | Self-archive refused; same last-admin guard; ban and session deletion in the guarded transaction |
| Delete a user | implemented | none | none | full | `users.remove` | Self-delete refused; same last-admin guard; existing FK/cascade behavior retained |
| Create an own CLI API key | implemented | none | own | own | `cliAccess.apiKeys.create` | Existing protected/forced-2FA gate; live session checked under credential lock before and after mint; revoked/expired session remains UNAUTHORIZED |
| List own runner machines | implemented | none | own | own | `cliAccess.runners.list` | Cookie browser session only, protected/forced-2FA gate; fresh live non-impersonated browser session and ban check under the CLI-credential lock; cursor bounded; safe metadata only |
| Revoke an own runner machine | implemented | none | own | own | `cliAccess.runners.revoke` | Same live browser gate and lock; foreign IDs are NOT_FOUND; durable revocation increments generation and publishes transactional ID-only invalidation; revoked runners cannot resume |
| Connect a paired runner transport | implemented | none | own | own | — | `GET /api/cli/runner/ws`: runner machine bearer only; no cookies, browser Origins, API keys or query credentials. Strict v1, owner/generation/lease checks on messages and heartbeat; independent fail-closed connect budgets. Simulation only; live upgrades remain 503 until D2a supplies its deletion predicate |
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

Runner enrollment is an internal helper for the later per-run claim/exchange
surface; no public enrollment endpoint is enabled. It requires a live,
non-impersonated browser session, a verified unbanned owner, the current forced
second-factor policy, a finite expiry and a cap of 25 active machines under the
same credential lock as reset. Only a purpose-bound digest and display prefix
are stored. Runner secrets are refused by the companion CLI resolver and never
become browser sessions, API keys or admin authority.

Password recovery, authorized admin password reset, untrusted-password-write
quarantine, pending invite/SSO activation and archival revoke runner machines.
Admin deletion revokes and publishes invalidation before the user cascade.
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
