# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through GitHub private vulnerability reporting:

<https://github.com/FlyCockpit/chess/security/advisories/new>

Do not open public issues, discussions or pull requests for security problems. We aim to acknowledge reports within 72 hours.

In scope: the server and its API, the web app, the match worker, the companion CLI and its loopback local lab, the Stockfish subprocess integration, and the container images built from this repository. Authorization bypasses (see [the access matrix](./docs/access-matrix.md)), disclosure of unpublished match data or credentials, and unauthorized inference spending are especially important.

## Supported versions

Only the latest release on `main` receives fixes. Version 1.0.0, the first release, is not published yet.

## Security controls

- Authorization is enforced per procedure and checked in CI against the [access matrix](./docs/access-matrix.md) (`pnpm policy:access-matrix`).
- Hosted inference is off by default (`CHESS_HOSTED_ENABLED=false`); operators must explicitly enable it. Signup is disabled by default (`SIGNUP_ENABLED=false`).
- pnpm supply-chain hardening: 7-day release-age gate with reviewed, time-limited security-fix exceptions, exotic-subdependency blocking, build-script allowlist, integrity-pinned package manager (`pnpm-workspace.yaml`, `package.json#packageManager`).
- SHA-pinned GitHub Actions kept current by Dependabot (`.github/dependabot.yml`).
- TruffleHog secret scanning on every pull request, covering verified and unverified findings with a reviewed placeholder filter (`scripts/trufflehog-pr-scan.sh`).
- Trivy HIGH/CRITICAL image scanning in container build and release workflows, excluding vulnerabilities with no available fix.
- `pnpm audit --audit-level=high` in CI.
- Non-root `USER node` in the production server and worker images.
- Content-Security-Policy and secure headers (`apps/server/src/security-headers.ts`).
- Per-surface rate limiting, including separate credential, signup and recipient budgets (`apps/server/src/rate-limit.ts`).
- Password hashes are sealed under a key derived from `BETTER_AUTH_SECRET`; see [password pepper operations](./docs/auth-and-routing.md#password-pepper).
- Production boot guards in `packages/env/src/server.ts`: weak or placeholder `BETTER_AUTH_SECRET` values refuse to start, public origins must use HTTPS, and enabling signup requires SMTP configuration.
- No account-existence oracle on the anonymous auth endpoints: sign-up, resend-verification, password-reset request and wrong-password sign-in answer byte-identically for an unknown, an unverified and a verified address. Sign-up needs the after-hook in `packages/auth/src/signup-response.ts`: Better-Auth answers a registered address with a synthetic user whose admin-plugin `role` is `null` (a new one gets `"user"`), and with `SIGNUP_ENABLED=false` it answered 200 for a registered address where a free one got 422. Every sign-up success now has the body `{"token":null,"user":null}`, and while sign-up is disabled only a real `ADMIN_EMAILS` bootstrap of a new address keeps its 200; every duplicate, admin-listed or not, gets the same 422 (pinned against the real handler in `packages/auth/src/index.test.ts`). Intended differences: the right password on an unverified account answers 403 `EMAIL_NOT_VERIFIED` and re-sends the link; a sign-up of a free address creates the account and mails its owner, so it can reveal that the address *was* free (from that 403, the extra time, or a race on the unique email), never anything about an existing account.
- Users' own OpenRouter keys (opt-in, `CHESS_USER_MATCHES_ENABLED=false` by default): OAuth PKCE (S256) with a single-use 256-bit `state` bound to the signed-in user and to a short-lived `__Host-` cookie, a server-side verifier that expires after 10 minutes, and a server-side code exchange to the fixed OpenRouter origin. Keys are sealed with AES-256-GCM under `CHESS_PROVIDER_KEY_SECRET` with the user id as associated data, never returned to a browser or admin view, never logged, queued, archived or put in an error, and loaded by the worker by match owner only for that owner's matches, with no fallback to the operator key. The callback's query string is not logged. Rotation and incident steps: [docs/deployment.md § Rotating the provider key secret](./docs/deployment.md#rotating-the-provider-key-secret).
- Forced two-factor authentication for administrators by default, with a limited enrollment grace period (`packages/auth/src/two-factor-policy.ts`).

See `AGENTS.md` § "Agent Safety Rules" for the guardrails AI coding agents must respect in this repository.
