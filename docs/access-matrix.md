# Access matrix

The server uses visitor, user, and admin roles with default-deny authorization.
Only admins may spend hosted inference funds, import drafts, or publish official games.

`implemented` rows bind live procedures; `planned` rows describe future work.
Permission cells use `none`, `read`, `write`, `full`, or `own`; `own` requires
handler-level ownership checks as well as sign-in. The policy checker verifies
registered access levels; handler tests verify ownership and custom role rules.

| Feature | Status | Anonymous | User | Admin | Enforcing procedure | Notes |
|---|---|---|---|---|---|---|
| Read arena configuration | implemented | read | read | read | `chess.info` | No secrets |
| Browse published matches | implemented | read | read | read | `chess.list` | Public projection only; cursor bounded |
| View a published game and replay | implemented | read | read | read | `chess.get` | Drafts never public; includes spectator-only engine scores; a finished game missing some may enqueue one deduplicated background backfill (engine CPU only, no inference spend) |
| Read official results | implemented | read | read | read | `chess.leaderboard` | Controlled runs only |
| Create a hosted match | implemented | none | none | full | `chess.create` | Paid work admin-only |
| List hosted models for the create form | implemented | none | none | full | `chess.models` | Server-side OpenRouter catalog, cached 1 h; no key sent |
| Import a local archive as draft | implemented | none | none | full | `chess.importGame` | Validate full move sequence; no credential fields |
| Publish a draft | implemented | none | none | full | `chess.publish` | Explicit admin action |
| Stop a hosted match | implemented | none | none | full | `chess.stop` | No further inference after cancellation |
| Inspect own private archive | implemented | none | none | full | `chess.inspect` | Owner-scoped admin; same spectator scores and backfill as `chess.get` |
| Browse private studio | implemented | none | none | full | `chess.studio` | Includes drafts |
| Spend the first-admin setup link | implemented | write | write | write | `setup.claimFirstAdmin` | The link token is the credential; 404 unless `SETUP_KEY` is set; refused once any admin exists; per-IP budget and secret-free audit line |
| See that `SETUP_KEY` is still set | implemented | none | none | read | `settings.setupKeyStatus` | Hidden (404) from non-admins; drives the "Remove SETUP_KEY" banner |
| Play and simulate locally | implemented | full | full | full | — | Public random baseline and local-process provider lab; no hosted spending |
| Connect community inference | planned | none | own | full | — | Future match-scoped credential; provider keys remain local |
| Purchase hosted play | planned | none | none | none | — | Deferred pending pricing and spend controls |
| CLI identity and release metadata | implemented | none | read | read | `cli.whoami`, `cli.latestRelease` | Requires a CLI credential |
| End a CLI session | implemented | none | own | own | `cli.logout` | Scoped to the current session |
| Import an archive from the CLI | implemented | none | none | full | `cli.chess.importGame` | Same admin gate as the hosted procedure |
| Inspect an archive from the CLI | implemented | none | none | full | `cli.chess.inspect` | Same owner scope and admin gate |
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
