# Sitemap

Current routes for the web app (`apps/web/src/routes/`).

> Every URL is prefixed with a locale segment — `/{lang}/...` where `{lang}` is one of the supported BCP 47 tags (currently `en-US`, `es-MX`). Visiting an unprefixed path or an unknown locale 302s to `/${DEFAULT_LOCALE}/...`. See [apps/web/src/i18n/index.ts](./apps/web/src/i18n/index.ts) for the routing contract.

## Public Routes

Only indexable content pages belong in `apps/server/src/seo.ts` `PUBLIC_PATHS` for `/sitemap.xml` and `/llms.txt`. Auth, demo, and restricted/watch utility routes below are public routes in the router sense, but intentionally excluded from SEO discovery.

| Path | Description |
|------|-------------|
| `/{lang}/` | Cockpit Chess arena, published live/historical replay (`?game=<slug>`), leaderboard (`?tab=leaderboard`), local baseline lab (`?tab=lab`) and methodology (`?tab=methodology`). Copy lives in the `chess` locale namespace. Studio (`?tab=studio`) exposes operator controls only after admin authentication; all writes enforce server permissions. Only the canonical arena is in `PUBLIC_PATHS`. |
| `/{lang}/login` | Sign in page with SSO, email/password, and 2FA support. Shows a "Sign Up" link to `/{lang}/signup` when `SIGNUP_ENABLED=true` |
| `/{lang}/signup` | Create-account page (email/password). Gated on `SIGNUP_ENABLED`; redirects to `/{lang}/login` when signup is disabled or the visitor is already signed in |
| `/{lang}/forgot-password` | Request a password-reset link (email/password). Always shows the same "check your email" success state (no account enumeration); deflects to `/{lang}/login` when `FORCE_SSO` or SMTP is unconfigured |
| `/{lang}/reset-password` | Complete a password reset from the emailed link — reads `?token=`/`?error=` from Better-Auth's `/api/auth/reset-password/:token` redirect. Renders an invalid/expired state with a link back to `/{lang}/forgot-password`; on success toasts and redirects to `/{lang}/login` |
| `/{lang}/verify-email` | Landing page for the emailed account-verification link. Better-Auth's `/api/auth/verify-email` validates the token first and redirects here — with `?ok=1` on success, or `?ok=1&error=TOKEN_EXPIRED\|INVALID_TOKEN\|USER_NOT_FOUND` when the token fails. `?ok=1` is set by `packages/auth/src/verification-callback.ts`; a **bare** visit (bookmark, back button) is deliberately treated as *unverified*, not success, and `error` always wins over `ok`. Renders a confirmation (with a sign-in CTA; verification intentionally creates no session) or a pending/expired-link state with a resend form. Reachable signed-in or signed-out, so it carries no session guard. |

## Authenticated Routes

All require an active session (enforced by the `_auth` layout).

| Path | Description |
|------|-------------|
| `/{lang}/dashboard` | Main dashboard page |
| `/{lang}/settings` | Profile settings (name, email display) |
| `/{lang}/settings/security` | Two-factor authentication enable/disable |
| `/{lang}/settings/cli` | Command-line access — a freshly minted copy-paste install/update command for the companion CLI (macOS/Linux/WSL and PowerShell; the embedded token expires after 15 minutes) and API key management (create shows the key once; revoke is type-to-confirm). See [packages/api/src/routers/cli.ts](./packages/api/src/routers/cli.ts). |
| `/{lang}/device` | Approve or deny a `cockpit-chess login` device-flow request (`?user_code=` prefills the code; never auto-approved). Better-Auth's verification URL is the lang-less `/device`, which the `$lang` layout redirects here. |

## Admin Routes

Gated by the `admin` layout (`apps/web/src/routes/$lang/_app/admin.tsx`). Non-admins (and unauthenticated visitors) see a 404 instead of a redirect — the admin tree is hidden, not just protected.

| Path | Description |
|------|-------------|
| `/{lang}/admin` | Overview — backup status and shortcuts to users, jobs, and settings |
| `/{lang}/admin/users` | User management — invite (Dialog → reveals temp password once), search/filter (active/archived), per-row dropdown actions: promote/demote, archive/restore, delete (AlertDialog with type-to-confirm). Self-actions (demote/archive/delete on your own account) are blocked client- and server-side. |
| `/{lang}/admin/jobs` | Failed background jobs across all BullMQ queues — queue, job id, attempts, failure reason, timestamp. |
| `/{lang}/admin/settings` | Admin-only settings panel (e.g. force-2FA toggle) |

## Navigation

Navigation destinations are defined once in `apps/web/src/lib/nav-items.ts` and filtered by
audience (`public`, `authenticated`, `admin`) plus placement (`desktop`, `mobile`,
`userMenu`).

- **Desktop**: Header main nav shows Home to everyone. Signed-in users also see Dashboard and Settings. Admins also see Admin.
- **Mobile**: Bottom tab bar stays compact and task-focused, and renders the same set as desktop — Home for everyone, plus Dashboard and Settings when signed in, plus Admin for admins.
- **User menu**: Signed-out visitors get Sign In / Sign Up actions. Signed-in users get Settings; Admin appears only for admins.
- **Cookie banner**: global UI, not a page. Mounted once in `__root.tsx`, so it appears on every route (public and authenticated) until the visitor allows or rejects analytics. "Cookie preferences" brings it back — from the landing-page footer for anonymous visitors and from `/{lang}/settings` for signed-in users. See [apps/web/src/lib/analytics.ts](./apps/web/src/lib/analytics.ts).

## Notes

- Keep this file updated as new pages are added.
- The `_auth` layout also enforces mandatory 2FA setup when the role-scoped 2FA policy requires it.
- The `admin` layout returns 404 for non-admins; do not add admin links to navigation visible to all users.
- All client-side links should preserve the current locale segment — use `<Link to="/$lang/dashboard" params={{ lang }} />` rather than hardcoded `/dashboard` strings. See [apps/web/src/i18n/index.ts](./apps/web/src/i18n/index.ts).
