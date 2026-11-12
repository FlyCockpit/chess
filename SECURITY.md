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
- Production boot guards in `packages/env/src/server.ts`: weak or placeholder `BETTER_AUTH_SECRET` values refuse to start, public origins must use HTTPS, and enabling signup requires SMTP configuration.
- Forced two-factor authentication for administrators by default, with a limited enrollment grace period (`packages/auth/src/two-factor-policy.ts`).

See `AGENTS.md` § "Agent Safety Rules" for the guardrails AI coding agents must respect in this repository.
