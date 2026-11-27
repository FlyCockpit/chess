# Access matrix

The server uses visitor, user, and admin roles with default-deny authorization.
Only admins may spend the operator's inference funds, import drafts, or mark games official.
Signed-in users with a verified email may run hosted matches billed to their own
connected OpenRouter key once the operator sets `CHESS_USER_MATCHES_ENABLED`
(owner decision 2026-11-26: "any verified user who connects OpenRouter"; user
matches are private by default, the owner may publish them, and only an admin
marks a game official for the leaderboard).

`implemented` rows bind live procedures; `planned` rows describe future work.
Permission cells use `none`, `read`, `write`, `full`, or `own`; `own` requires
handler-level ownership checks as well as sign-in. The policy checker verifies
registered access levels; handler tests verify ownership and custom role rules.

| Feature | Status | Anonymous | User | Admin | Enforcing procedure | Notes |
|---|---|---|---|---|---|---|
| Read arena configuration | implemented | read | read | read | `chess.info` | No secrets; includes the per-side hosted budget limits, whether user matches are open, the per-user daily limit and the source-code link (operator config) |
| Browse published matches | implemented | read | read | read | `chess.list` | Public projection only; cursor bounded |
| View a published game and replay | implemented | read | read | read | `chess.get` | Drafts never public; an old-rules (`cockpit-v2`) game returns its card with no archive; includes spectator-only engine scores; a finished game missing some may enqueue one deduplicated background backfill (engine CPU only, no inference spend) |
| Read official results | implemented | read | read | read | `chess.leaderboard` | Controlled runs only |
| Create a hosted match | implemented | none | own | full | `chess.create` | `hostedPlayerProcedure` (verified email, no API key, 2FA policy). Users: only billed to their own connected OpenRouter key, only while `CHESS_USER_MATCHES_ENABLED`; one active match, `CHESS_USER_DAILY_MATCHES` per 24 h, never official. Admins: operator key (official) or their own key (user caps). Queue cap for everyone; counts under one advisory lock |
| List hosted models for the create form | implemented | none | read | read | `chess.models` | Server-side OpenRouter catalog, cached 1 h; no key sent |
| Import a local archive as draft | implemented | none | none | full | `chess.importGame` | Validate full move sequence; no credential fields |
| Publish or unpublish own game | implemented | none | own | own | `chess.publish` | Owner-scoped; publishing never makes a game official |
| Mark a published hosted game official | implemented | none | none | full | `chess.setOfficial` | Admin leaderboard curation, any owner's published hosted game |
| See hosted capacity | implemented | none | none | read | `chess.capacity` | Running vs limit, queued vs cap, engine pool; bounded list of titles and owner names only |
| Stop a hosted match | implemented | none | own | own | `chess.stop` | Owner-scoped; no further inference after cancellation |
| Inspect own private archive | implemented | none | own | own | `chess.inspect` | Owner-scoped; queue position and who pays; same spectator scores and backfill as `chess.get` |
| Browse private studio | implemented | none | own | own | `chess.studio` | Owner-scoped; includes drafts |
| See own OpenRouter connection | implemented | none | own | own | `openrouter.status` | Label, last four characters, key hash and OpenRouter's limit/usage numbers (cached 60 s); never the key or its ciphertext |
| Disconnect own OpenRouter key | implemented | none | own | own | `openrouter.disconnect` | Deletes the sealed key and cancels the caller's queued own-key match; answers `stopped: "stopped"` only once no key-use lease remains on the key (`"pending"` after 10 s without confirmation). Own budget: 20 per 10 min |
| Spend the first-admin setup link | implemented | write | write | write | `setup.claimFirstAdmin` | The link token is the credential; 404 unless `SETUP_KEY` is set; refused once any admin exists; per-IP budget and secret-free audit line |
| See that `SETUP_KEY` is still set | implemented | none | none | read | `settings.setupKeyStatus` | Hidden (404) from non-admins; drives the "Remove SETUP_KEY" banner |
| Resend an unfinished invite | implemented | none | none | full | `users.resendInvite` | Hidden (404) from non-admins; mints a fresh one-time set-password link and kills the earlier one; refused (409) unless the user is a pending invite (unverified, only a password account, never signed in), and for archived users, re-checked under a per-user lock a finishing password reset also takes; fail-closed budgets per admin (`rl:users-invite-mail`, shared with invite) and per invitee (`rl:users-resend-invite`) |
| Change a user's role | implemented | none | none | full | `users.setRole` | Named confirmation; self-demotion refused; shared Serializable last-active-verified-admin guard; structured audit after commit; localized refusal reasons |
| Archive a user | implemented | none | none | full | `users.archive` | Self-archive refused; same last-admin guard; ban and session deletion in the guarded transaction |
| Delete a user | implemented | none | none | full | `users.remove` | Self-delete refused; same last-admin guard; existing FK/cascade behavior retained |
| Create an own CLI API key | implemented | none | own | own | `cliAccess.apiKeys.create` | Existing protected/forced-2FA gate; live session checked under credential lock before and after mint; revoked/expired session remains UNAUTHORIZED |
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

The cookie OpenAPI procedure surface (`/api-reference/<procedure>`) requires
the `x-csrf-token: orpc` request header, just like `/rpc`.

Authenticated gates reject active bans, including permanent archival bans,
even if a session row survives. Expired temporary bans permit access. Cookie
session resolution treats active bans as anonymous for rate-limit/context
consumers; hidden admin procedures retain their 404 response. These checks
use the resolved user and do not remove Better-Auth's 60-second cookie cache.

The reviewed endpoint baseline in `scripts/access-matrix-pre-notes-baseline.json`
additionally preserves the minimum access level of existing procedures. Change
exact entries only in the same reviewed change that removes their endpoints.
