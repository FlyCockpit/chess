# Sitemap

Current routes for the web app (`apps/web/src/routes/`).

> Every URL is prefixed with a locale segment — `/{lang}/...` where `{lang}` is one of the supported BCP 47 tags (currently `en-US`, `es-MX`). Visiting an unprefixed path or an unknown locale 302s to `/${DEFAULT_LOCALE}/...`. See [apps/web/src/i18n/index.ts](./apps/web/src/i18n/index.ts) for the routing contract.

## Public Routes

The public footer links localized review drafts at `/{lang}/terms`, `/{lang}/privacy`
and `/{lang}/licenses`. They share the arena shell, remain accessible signed in or
out, and are included in `PUBLIC_PATHS`, `/sitemap.xml` and `/llms.txt`. Signup
links to terms/privacy; published-replay reporting includes the single contact
`contact@flycockpit.app`. Owner/counsel approval and deployment verification remain
required before launch. The licences page links the exact corresponding Stockfish
source and GPL text without requiring an account.

Only indexable content pages belong in `apps/server/src/seo.ts` `PUBLIC_PATHS` for `/sitemap.xml` and `/llms.txt`. Auth, demo, and restricted/watch utility routes below are public routes in the router sense, but intentionally excluded from SEO discovery.

| Path | Description |
|------|-------------|
| `/{lang}/` | Cockpit Chess arena, published live/historical replay (`?game=<slug>`), leaderboard (`?tab=leaderboard`), local baseline lab (`?tab=lab`) and methodology (`?tab=methodology`). Copy lives in the `chess` locale namespace. Studio (`?tab=studio`) exposes operator controls after admin authentication; when the operator enables user matches, signed-in verified users get their own Studio billed to their connected OpenRouter key (without a connection it links to `/{lang}/settings/openrouter`); all writes enforce server permissions. Only the canonical arena is in `PUBLIC_PATHS`. This is also the signed-in home (`APP_HOME` in [apps/web/src/lib/app-home.ts](./apps/web/src/lib/app-home.ts)): signing in without a `redirectTo` lands here, and the header shows a signed-in visitor an account link to `/{lang}/settings` (session-cookie hint, [apps/web/src/lib/session-hint.ts](./apps/web/src/lib/session-hint.ts)). |
| `/{lang}/dashboard` | Redirect only (no page): forwards old bookmarks to `/{lang}/` |
| `/{lang}/login` | Sign in page with SSO, email/password, and 2FA support. Shows a "Sign Up" link to `/{lang}/signup` when `SIGNUP_ENABLED=true` |
| `/{lang}/signup` | Create-account page (email/password). Gated on `SIGNUP_ENABLED`; redirects to `/{lang}/login` when signup is disabled or the visitor is already signed in |
| `/{lang}/forgot-password` | Request a password-reset link (email/password). Always shows the same "check your email" success state (no account enumeration); deflects to `/{lang}/login` when `FORCE_SSO` or SMTP is unconfigured |
| `/{lang}/reset-password` | Complete a password reset from the emailed link — reads `?token=`/`?error=` from Better-Auth's `/api/auth/reset-password/:token` redirect. Renders an invalid/expired state with a link back to `/{lang}/forgot-password`; on success toasts and redirects to `/{lang}/login` |
| `/{lang}/verify-email` | Landing page for the emailed account-verification link. Better-Auth's `/api/auth/verify-email` validates the token first and redirects here — with `?ok=1` on success, or `?ok=1&error=TOKEN_EXPIRED\|INVALID_TOKEN\|USER_NOT_FOUND` when the token fails. `?ok=1` is set by `packages/auth/src/verification-callback.ts`; a **bare** visit (bookmark, back button) is deliberately treated as *unverified*, not success, and `error` always wins over `ok`. Renders a confirmation (with a sign-in CTA; verification intentionally creates no session) or a pending/expired-link state with a resend form. Reachable signed-in or signed-out, so it carries no session guard. |

## Authenticated Routes

All require an active session (enforced by the `_auth` layout).

| Path | Description |
|------|-------------|
| `/{lang}/settings` | Profile settings (name, email display) |
| `/{lang}/settings/security` | Two-factor authentication enable/disable |
| `/{lang}/settings/cli` | Command-line access — a freshly minted copy-paste install/update command for the companion CLI (macOS/Linux/WSL and PowerShell; the embedded token expires after 15 minutes) and API key management (create shows the key once; revoke is type-to-confirm). See [packages/api/src/routers/cli.ts](./packages/api/src/routers/cli.ts). |
| `/{lang}/settings/openrouter` | Connect your own OpenRouter account (OAuth PKCE; only when the operator enables user matches): suggested spend limit and expiry, OpenRouter's live limit/usage numbers, manage and activity links on OpenRouter, disconnect (type-to-confirm). The OAuth callback is the server route `/api/openrouter/callback`, which redirects back here. |
| `/{lang}/device` | Approve or deny a `cockpit-chess login` device-flow request (`?user_code=` prefills the code; never auto-approved). Better-Auth's verification URL is the lang-less `/device`, which the `$lang` layout redirects here. |
| `/{lang}/runner/claim` | Claim one local `npx @flycockpit/chess` run after sign-in and required two-factor setup. The single-use secret stays in the fragment through sign-in; a protected CSRF POST claims only after identity settles. No indexing, referrers or browser credential storage. Return to the terminal to verify the claiming account and active local ceilings. |

## Admin Routes

Gated by the `admin` layout (`apps/web/src/routes/$lang/_app/admin.tsx`). Non-admins (and unauthenticated visitors) see a 404 instead of a redirect — the admin tree is hidden, not just protected.

| Path | Description |
|------|-------------|
| `/{lang}/admin` | Overview — backup status, live hosted-match capacity (running vs limit, queued vs cap, engine pool busy/total; polled every 5 s), and shortcuts to users, jobs, and settings |
| `/{lang}/admin/users` | User management — invite (Dialog with Email language; emails a one-time set-password link, which is shown once, closed only by Done, only if it couldn't be emailed), search/filter (active/archived), per-row dropdown actions: resend invite (pending invites only), promote/demote, archive (toast with Undo)/restore, delete (AlertDialog with type-to-confirm). Self-actions (demote/archive/delete on your own account) are blocked client- and server-side. |
| `/{lang}/admin/jobs` | Failed background jobs across all BullMQ queues — queue, job id, attempts, failure reason, timestamp. |
| `/{lang}/admin/settings` | Admin-only settings panel (e.g. force-2FA toggle) |
| `/{lang}/admin/moderation` | Cursor-bounded replay reports and moderation history; hide or restore with a reason visible to the uploader. Admin-only and excluded from public SEO discovery. |

## Navigation

Navigation destinations are defined once in `apps/web/src/lib/nav-items.ts` and filtered by
audience (`public`, `authenticated`, `admin`) plus placement (`desktop`, `mobile`,
`userMenu`).

- **Desktop**: Header main nav shows Home (the arena) to everyone. Signed-in users also see Settings. Admins also see Admin.
- **Mobile**: Bottom tab bar stays compact and task-focused, and renders the same set as desktop — Home for everyone, plus Settings when signed in, plus Admin for admins.
- **User menu**: Signed-out visitors get Sign In, and Sign Up while sign-up or the first-admin bootstrap is open (44px icons below `sm`). Signed-in users get a menu headed by My Account, their name and email, then Settings, Admin (admins only) and Sign Out; its trigger is a 44px icon below `md` and the name from `md`.
- **Arena header** (public pages and the 404): the arena tabs, Language, theme and Studio for everyone, plus the account link (to Settings) for a signed-in visitor. It never shows Sign In.
- **Cookie banner**: global UI, not a page, and off: it appears only when analytics is configured (`ANALYTICS_PROVIDER`), and the app ships none; strictly necessary cookies need no consent. When on, it is mounted once in `__root.tsx`, so it appears on every route (public and authenticated) until the visitor allows or rejects analytics. It never covers the page: `#main-content` reserves its height at the bottom. "Cookie preferences" brings it back — from the public footer for anonymous visitors and from `/{lang}/settings` for signed-in users. See [apps/web/src/lib/analytics.ts](./apps/web/src/lib/analytics.ts).

## Notes

- Keep this file updated as new pages are added.
- The `_auth` layout also enforces mandatory 2FA setup when the role-scoped 2FA policy requires it.
- The `admin` layout returns 404 for non-admins; do not add admin links to navigation visible to all users.
- All client-side links should preserve the current locale segment — use `<Link to="/$lang/settings" params={{ lang }} />` rather than hardcoded `/settings` strings. See [apps/web/src/i18n/index.ts](./apps/web/src/i18n/index.ts).
