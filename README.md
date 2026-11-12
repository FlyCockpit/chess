<p align="center">
  <img src=".github/assets/logo.png" alt="" width="160" height="160">
</p>

<h1 align="center">Cockpit Chess</h1>

<p align="center">An arena for agents to play chess, with authoritative move validation, live replay, recorded illegal attempts, and shareable results.</p>

<p align="center">
  <a href="LICENSE"><img src="https://shieldcn.dev/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/FlyCockpit/chess/releases"><img src="https://shieldcn.dev/github/FlyCockpit/chess/release.svg" alt="GitHub release"></a>
  <a href="https://nodejs.org"><img src="https://shieldcn.dev/badge/Node.js-26.13.1%2B-339933.svg?logo=nodedotjs" alt="Node.js 26.13.1+"></a>
  <a href="https://github.com/FlyCockpit"><img src="https://shieldcn.dev/badge/part%20of-FlyCockpit-0ea5e9.svg" alt="Part of FlyCockpit"></a>
</p>

Cockpit Chess runs chess games between language models and records every decision. The server is the referee: it validates each move, and every illegal or unparseable attempt is kept in the record. Operators run hosted matches and publish them to a public arena; anyone can replay them, and the public site never spends inference tokens on spectators. A companion CLI runs local experiments against your own models.

## Features

- **Hosted matches.** LLM-vs-LLM games through OpenRouter, run by a background worker, with the server as the authoritative referee (chess.js).
- **Live arena and replay.** Watch games live or replay them, with every illegal or unparseable attempt recorded.
- **Leaderboard.** Model standings from published, rated hosted games, grouped by exact rules and wire protocol.
- **Studio.** An admin area to create, stop, publish and import matches, and to export PGN, JSON and result images.
- **Configurable rules.** Memory, identity disclosure, board representation, legal-move help, time, token and cost budgets, and optional Stockfish assistance.
- **Local companion.** A CLI with a loopback browser lab for local or self-hosted models (OpenAI-compatible endpoints), plus a Stockfish engine opponent.

## How it works

Cockpit Chess is a pnpm/Turborepo monorepo. A React 19 + TanStack Router PWA talks oRPC to a Hono server (Better-Auth, Prisma/PostgreSQL). A BullMQ worker on Valkey, embedded in the app or run as a separate container, plays matches through `packages/chess` (the chess.js referee and a Stockfish subprocess) and `packages/agent-runtime` (model provider adapters). The companion CLI in `apps/cli` serves the local lab and uploads games.

## Quick start

Use Node matching `package.json` and the pnpm version pinned in `packageManager`, then:

```sh
pnpm install
pnpm dev:docker 3417
```

This starts an isolated app, Postgres, Valkey and mail sink at `http://localhost:3417`. Docker testing does not deploy anything.

## Installation

### Prerequisites

- Node.js 26.13.1+ (26.x LTS, pinned in `.nvmrc`; the production Docker images build on `node:26.13.1-slim`, pinned by digest)
- pnpm 12.18.0, pinned with its checksum in `packageManager` (Node 26 no longer bundles Corepack: install it with `npm install -g corepack@0.36.0` and run `corepack enable`, or install pnpm 12.18.0 directly)
- Docker or Podman — required for local PostgreSQL 18, Valkey 9, and the mailpit mail sink
- `portless` installed globally (`npm install -g portless`) — `pnpm dev` uses it to expose local apps at stable `https://*.localhost` names without choosing ports
- PostgreSQL, Valkey (Redis-compatible), and local email — all three start with `pnpm dev:services` (uses `docker-compose.dev.yml` at repo root via docker or podman); the mailpit sink captures verification email locally so signup works with zero SMTP credentials

If pnpm fails with a path like `mkdir '/Users'` on Linux/WSL, your shell has a stale macOS `PNPM_HOME`. Run `unset PNPM_HOME`, remove the stale export from your shell profile, and rerun `pnpm install`.

### Local setup

```bash
npm install -g corepack@0.36.0
corepack enable
pnpm install
pnpm run setup
pnpm dev
```

`pnpm run setup` is the one-command path from a fresh clone to runnable, and is idempotent (re-run any time without harm). Use the explicit `run` form — `setup` is also a pnpm builtin, and on some pnpm versions the bare `pnpm setup` invokes the builtin (which edits your shell profile) instead of this script. It:

- creates the root `.env` from `.env.example` if missing,
- creates `apps/web/.env` from `apps/web/.env.example` if missing,
- generates a `BETTER_AUTH_SECRET` if it is empty,
- asks for your email and writes it to `ADMIN_EMAILS` in `.env` (if not already set), so your first local sign-up becomes the admin — non-interactive shells can pass `--admin-email <you@example.com>` or set `ADMIN_EMAIL`,
- points `SMTP_*` at the local mailpit sink (if `SMTP_HOST` is unset), so the signup verification email has somewhere to land,
- starts local PostgreSQL, Valkey, **and** the mailpit sink (`pnpm dev:services`),
- waits for all three to accept connections,
- applies committed migrations to the configured local database (`pnpm db:migrate:apply`).

For separate linked worktrees, use the [manual setup](#manual-setup) sequence to provision that checkout’s local/shadow databases before applying migrations.

If something looks wrong, run `pnpm doctor` to validate environment, database, Valkey/Redis, and (optionally) SMTP connectivity. It exits non-zero with actionable hints if any required check fails.

Run the test suite with `pnpm test`.

### First login

Signup is disabled by default (`SIGNUP_ENABLED=false`) and no admin user exists yet, but `pnpm run setup` already did the two things first login needs: it wrote your email to `ADMIN_EMAILS` (the signup allowlist) and pointed `SMTP_*` at the mailpit sink. So with `pnpm dev` running:

1. Open [https://cockpit-chess.localhost](https://cockpit-chess.localhost) and sign up with the exact email from `ADMIN_EMAILS` — that address is the only one signup accepts, and the account it creates carries the admin role.
2. Open [http://localhost:8025](http://localhost:8025) (the mailpit sink), find the "Verify your email" message, and click the link. You're in — email verification is enforced, so this step can't be skipped.

If you skipped the setup email prompt, stop `pnpm dev`, set `ADMIN_EMAILS=you@example.com` in `.env`, and restart. If you pointed `SMTP_*` at a real provider instead of the sink, the verification email lands there.

In production the mail sink is replaced by a real SMTP provider; see [Deployment](#deployment) below.

### Manual setup

To set up by hand instead of with `pnpm run setup`:

```bash
pnpm install
```

All server-side environment variables live in a single `.env` file **at the repo root**. Copy the example and edit it:

```bash
cp .env.example .env
```

The web app has its own small env file for Vite-public variables:

```bash
cp apps/web/.env.example apps/web/.env
```

Start PostgreSQL and Valkey with docker or podman:

```bash
pnpm dev:services
```

Then provision this checkout’s local and shadow databases and apply committed migrations:

```bash
pnpm db:worktree
pnpm db:migrate:apply
```

> **Adding or changing a model?** Edit the relevant file in `packages/db/prisma/schema/`, run `pnpm db:migrate <name>`, review its SQL, then run `pnpm db:migrate:apply`. Commit schema and migration together. Merged migration folders are immutable. Deletions go into generated `contract.sql` and wait at least seven elapsed days after a containing release becomes ready and after older releases disappear. Use `@map` for renames and two PRs for type changes; see [the recipes](./docs/schema-changes-recipe.md).

Then run the development server:

```bash
pnpm run dev
```

- Web app: [https://cockpit-chess.localhost](https://cockpit-chess.localhost)
- API server: [https://api.cockpit-chess.localhost](https://api.cockpit-chess.localhost)

`pnpm dev` runs through the globally installed `portless` CLI. Portless assigns process ports automatically, registers the local HTTPS hostnames from `portless.json`, and lets Vite proxy `/api`, `/rpc`, `/sw`, and `/ws` to the API server. Leave `VITE_SERVER_URL`, `VITE_DEV_PORT`, `VITE_DEV_SERVER_URL`, `SERVER_PORT`, and `CORS_ORIGIN` unset unless you intentionally want the raw fallback flow.

## Configuration

Hosted inference is off by default. An operator enables `CHESS_HOSTED_ENABLED`
and configures `OPENROUTER_API_KEY` in the server/worker environment. The first
admin is set through `ADMIN_EMAILS`; `SIGNUP_ENABLED` defaults to `false`.

### Server (`.env` at repo root)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | **Yes** | — | Auth secret, min 32 characters |
| `BETTER_AUTH_URL` | **Yes** | — | Public app origin used by auth callbacks (default local dev: `https://cockpit-chess.localhost`). Do not include a path, query, hash, or credentials. |
| `CORS_ORIGIN` | No | — | Exact browser origin allowed to call the API directly. Do not include a path, query, hash, or credentials. |
| `SERVER_PORT` | No | `3000` | Raw local/container API listen override. Leave unset with portless. |
| `PORT` | No | — | Injected by portless and production platforms; used when `SERVER_PORT` is unset |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `SSO_ENABLED` | No | `false` | Enable enterprise SSO login |
| `SSO_CLIENT_ID` | No | — | SSO OAuth client ID |
| `SSO_CLIENT_SECRET` | No | — | SSO OAuth client secret |
| `SSO_ISSUER` | No | — | SSO issuer URL (e.g. `https://your-org.okta.com`) |
| `SSO_PROVIDER_NAME` | No | `SSO` | Display name for the SSO provider |
| `FORCE_SSO` | No | `false` | Redirect all logins through SSO |

### Web (`apps/web/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_SERVER_URL` | No | `window.location.origin` | Server API origin; leave unset for the default portless/Vite proxy flow. Do not include a path, query, hash, or credentials. |
| `VITE_DEV_PORT` | No | `3001` | Raw Vite dev-server listen port. Leave unset with portless. |
| `VITE_DEV_SERVER_URL` | No | `http://localhost:3000` or the `apps/server` hostname from `portless.json` under portless | API origin for the Vite dev proxy. Do not include a path, query, hash, or credentials. |
| `VITE_APP_NAME` | No | `Cockpit Chess` | App-shell name used in the header, document title, and PWA manifest. Inlined at build time — changing it needs a rebuild, not a restart. |

Environment variables are validated at startup by `packages/env` using [t3-env](https://env.t3.gg/) and Zod. The app will fail to start if required variables are missing or malformed.

## Usage

### Hosted matches

Configure `ADMIN_EMAILS`, sign in through the normal verified-account flow, and use Studio.
Create starts a private match in the worker; publish makes it visible in the arena.
Stopping a match preserves its last durable events. Imports are private, explicitly
local experiments; they do not count toward official model standings.

### Local browser companion

Once the first release is published, download the `cockpit-chess` binary for your platform from [GitHub Releases](https://github.com/FlyCockpit/chess/releases) (each release lists SHA256SUMS) and run:

```sh
cockpit-chess serve
```

Release binaries embed the lab's web client. From a source checkout, build the client once and run the CLI with pnpm instead:

```sh
pnpm --filter web build:local
pnpm --filter @cockpit-chess/cli dev serve
```

The command prints a loopback URL on an available port. Open it to play against a
model or simulate games. Supply `OPENROUTER_API_KEY` in the **local terminal**;
credentials stay in that process and are absent from browser state and exports.
There is no login, database or Valkey requirement for local games. The public
website's Local lab also offers a free random-move baseline without a key.

For a direct provider, pass `--base-url`, `--input-price` and `--output-price`
(USD per million tokens). Keys are routed by host: `OPENAI_API_KEY` is sent only
to `api.openai.com`, `ANTHROPIC_API_KEY` only to `api.anthropic.com`, and every
other endpoint (including loopback) uses `COCKPIT_CHESS_PROVIDER_KEY`.
Examples of API prefixes are `https://api.openai.com/v1` and
`https://api.anthropic.com`. Loopback inference endpoints can run without a key.
Chat Completions, Responses and Anthropic Messages are separate protocol options.

Compiled binaries embed the lab web client but do not contain Stockfish. They reject engine-assisted matches; run those from source and ensure Stockfish is available. Interactive terminal play remains future work. See the [CLI README](./apps/cli/README.md) for all commands.

### Run and export experiments

Save a configuration such as:

```json
{
  "title": "Fresh context, hidden identity",
  "white": { "name": "Model A", "model": "openai/gpt-4.1-mini", "protocol": "openai-chat" },
  "black": { "name": "Model B", "model": "openai/gpt-4.1-mini", "protocol": "openai-responses" },
  "rules": {
    "context": "fresh",
    "opponentIdentity": "hidden",
    "legalMoves": "tool",
    "representation": "ascii",
    "maxPlies": 20,
    "tokenAccounting": "cl100k_base",
    "tokenBudget": 12000,
    "trashTalk": true,
    "engineEvaluation": "both",
    "costBudgetMicros": 100000
  }
}
```

```sh
pnpm --filter @cockpit-chess/cli dev run --config match.json --out ./games --games 2 --swap-colors --json
pnpm --filter @cockpit-chess/cli dev replay ./games/<game-id>.json --event 0
pnpm --filter @cockpit-chess/cli dev --server https://your-domain.example login
pnpm --filter @cockpit-chess/cli dev --server https://your-domain.example upload ./games/<game-id>.json
```

Upload requires an admin device-flow login, and creates a private draft. API keys
cannot access admin procedures. Alternatively import the JSON in Studio. Review
and publish it there. Archive imports replay every move rather than trusting saved
board snapshots. Export PGN or the full JSON decision log from any replay. Studio
can generate a PNG with the actual result, termination, sample size and replay URL.

Archives have one interchange limit: 2 MB (2,000,000 bytes of the pretty-printed
JSON file, `MAX_ARCHIVE_BYTES` in `packages/chess/src/index.ts`). The runner ends a
match as unscored `event-limit` before the next event would leave less than its
terminal headroom below that limit, so every archive it writes is accepted by
`replay`, `upload`, Studio import and the server. Larger files are rejected with
"Game archive exceeds 2 MB".

Rules include fresh/persistent memory, hidden/disclosed identities, FEN/ASCII/piece
representations, hidden/tool/provided legal moves, optional commentary in either
identity mode, attempt limits, per-turn and per-player time, tokens and costs.
Anonymous commentary redacts configured model names/IDs but may still reveal clues;
it is entertainment, not a guarantee of anonymity.

Choose `tokenAccounting: "provider"` for conservative native-token reservations,
or `"cl100k_base"` for the same benchmark tokenizer across models. Shared accounting
encodes canonical JSON containing system text, visible messages and tool definitions.
Inputs include tool results and are charged on every logical dispatch. Streamed
outputs include visible text and tool calls. Transport IDs, timestamps and hidden
reasoning are excluded. A chunk that crosses the allowance is recorded and ends
the game before that response can submit a move. This is a reproducible benchmark
measurement, not a provider invoice or a cap on hidden reasoning tokens.

Cost reservations and native usage remain separate in both modes. Inference
reserves conservative cost bounds before each dispatch, including retry capacity.
Unused reservations are not released; small allowances can end a game early.
Set a provider-side key budget as well: catalog quotes cannot guarantee invoiced cost.

Stockfish assistance has four modes: `off`, `tool`, `after-move`, and `both`.
The `engine_eval` tool evaluates the current authoritative position; post-move
mode records feedback after each accepted move and supplies it to the agents.
Defaults are 10,000 nodes per evaluation and two engine tool calls per turn;
configurable bounds, a five-second timeout and cancellation limit engine work.
Scores always use White's perspective. Assisted games form separate ranking cohorts.
Stockfish runs as an isolated local subprocess and is GPL-3.0; see
[third-party notices](./THIRD-PARTY-LICENSES.md) before redistribution.

### Leaderboard

Leaderboard scores are provisional win/draw percentages, grouped by exact rules
and wire protocol across the latest 500 eligible hosted games. They are not human
Elo or a general intelligence ranking. Random baselines, demos, interrupted games
and imports are excluded. Interactive terminal play, paid public matchmaking,
and community connectors are future work.

## Deployment

The repo ships two production Dockerfiles:

- `Dockerfile` — Hono API, SSR, static web app and embedded background consumers by default.
- `Dockerfile.worker` — optional dedicated BullMQ consumers with a private health endpoint.

`pnpm dokploy:config --environment development --git-ref main --url https://dev.chess.example.com` generates a Dokploy Compose file and settings checklist. Select `app` (default) or `--topology app-worker`. Development follows `main` automatically; production requires `--environment production --git-ref release/<full-commit-sha>` and manual deployment of that same immutable tag for every role. PostgreSQL 18 and Valkey 9 remain required in both topologies.

The server defaults to `MIGRATE_ON_START=true`: it applies committed migrations before HTTP startup. The external worker uses `false` and waits up to 300 seconds for compatible history, writing its instance registration. Without a worker container, the server uses `WORKER_MODE=embedded`; a dedicated worker requires `external`. Preserve both images’ 510-second startup allowance. See [deployment](./docs/deployment.md) and [schema migrations](./docs/schema-migrations.md).

#### Build

```bash
docker build --build-arg BUILD_VERSION="$(git rev-parse HEAD)" -t cockpit-chess-server -f Dockerfile .
docker build --build-arg BUILD_VERSION="$(git rev-parse HEAD)" -t cockpit-chess-worker -f Dockerfile.worker .
```

#### Run

Import the generated Compose file into Dokploy, fill the environment settings listed in its checklist, and deploy. On a host already configured with that file, a deploy-gated one-shot migration uses the same server image:

```bash
docker compose run --rm server migrate
```

For external orchestration, run `migrate` successfully before rolling out the same SHA with `MIGRATE_ON_START=false` on app replicas and worker. Other image commands are `backup`, `backup-schedule`, `restore`, `restore-drill` and `hold-deletions`; production restore is owner-run inside the target network after preview and explicit confirmation.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** (both runtimes) | Environment-specific PostgreSQL connection string |
| `REDIS_URL` | **Yes** (both runtimes) | Valkey/Redis for jobs and rate limiting; one-shot migration/backup commands do not require it |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | **Yes** (server) | Strong unique auth secret and public app origin; absent from worker admission requirements |
| `WORKER_MODE` | No (server) | `embedded` by default; `external` when a dedicated worker is deployed |
| `MIGRATE_ON_START` | Per role | Server defaults `true`; external worker uses `false`; followers wait and register |
| `BACKUP_SCHEDULE` | No | Daily writer: `off` by default; choose `daily` and enable Compose profile `backup` |
| `BACKUP_HOUR_UTC`, `BACKUP_KEEP` | No | Daily hour 0–23 (default 3); newest-day local retention 1–365 (default 14) |
| `BACKUP_S3_*` | For off-site dumps | Writer/restore transport and an explicit deployment prefix, e.g. `cockpit-chess/production/chess.example.com/database` |
| `BACKUP_ENABLED` | No | Defaults `true`; freshness monitoring only, never disables backup writes |
| `BACKUP_MONITOR_S3_*`, `BACKUP_MAX_AGE_HOURS` | For bucket monitoring | Separate ListBucket-only credentials and age threshold (default 36 hours) |
| `BUILD_VERSION` | Build argument | Full Git SHA baked into the server’s `BUILD_COMMIT` file and reported by `/ready`; no runtime `BUILD_COMMIT` variable |

The long-running app has writer keys unset after admission; Docker container configuration still retains startup settings for one-off operations. Give the selected monitor runtime only its separate monitoring identity. Runtime and build-time settings are listed in [the environment inventory](./docs/environment.md). Same-origin deployments normally leave `CORS_ORIGIN` and `VITE_SERVER_URL` unset.

### Deploying to production

Read [the deployment guide](./docs/deployment.md) and [SECURITY.md](./SECURITY.md) before exposing the instance.

#### Required environment variables

Both runtimes need the intended `DATABASE_URL` and `REDIS_URL`. The server additionally needs `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Configure `ADMIN_EMAILS` for the first admin and `SMTP_*` for verification; the selected worker runtime also needs SMTP for operational alerts. Signup stays disabled by default. Enable hosted inference deliberately with `CHESS_HOSTED_ENABLED` and an OpenRouter key on the runtime that runs matches.

#### Backups and restore

Before real data, choose provider backups/PITR or enable exactly one daily service using both the `backup` profile and `BACKUP_SCHEDULE=daily`. Mount `/backups`, configure an off-site destination with a distinct per-deployment prefix, and run a restore drill. Local-only dumps are lost with the VPS.

A genuinely empty fresh install needs no snapshot. On existing databases, a missing destination warns and continues; a configured backup failure blocks migrations. Manual `backup` requires a destination. Pre-migration dumps keep 5 locally, runner pre-drop dumps explicitly keep 5, and manual/pre-restore dumps default to no pruning; daily retention defaults to 14 UTC days containing dumps. S3 expiration belongs in bucket lifecycle rules.

`restore` verifies and previews before mutation, pins S3 objects by ETag/version, requires exact target confirmation and `--replace` for populated targets, and snapshots before replacement unless the owner explicitly uses a provider snapshot. Restore and its seven-day deletion hold commit together. See [backup and restore](./docs/backup-restore.md) for commands, recovery and monitoring.

#### Quick sanity checks

- [ ] The selected server/worker roles use the same immutable Git ref and intended database/cache.
- [ ] `ADMIN_EMAILS`, verified sign-in, forced admin 2FA and SMTP work; the auth secret is unique.
- [ ] Schema admission passed and `/ready` reports database, cache and consumer availability.
- [ ] `pnpm deploy:check <origin> --commit <full-commit-sha>` passes for the expected release; an optional `pnpm dokploy:verify` checks runtime tasks on the host.
- [ ] A new off-site backup or provider recovery point exists, retention/alerts are configured, and a restore drill passed.

## Development

```sh
pnpm verify:fast
pnpm docker:check-copy
pnpm test
```

Never put provider credentials in a committed configuration, archive or browser input.

### Scripts

The scripts most sessions need:

- `pnpm run setup`: First-run onboarding — see [Installation](#installation) (idempotent; creates `.env`, generates secret, starts local services, applies committed migrations)
- `pnpm doctor`: Validate environment variables and test database, Valkey/Redis, and SMTP connectivity
- `pnpm dev`: Start all applications through portless at `https://*.localhost`
- `pnpm dev:services`: Start Postgres, Valkey, and the mailpit mail sink via Docker Compose
- `pnpm test`: Run the full test suite (Vitest, server-side unit tests)
- `pnpm check-types`: Check TypeScript types across all apps
- `pnpm db:migrate <name>`: Generate migration SQL for review
- `pnpm db:migrate:apply`: Apply committed migrations locally and regenerate the client
- `pnpm db:worktree`: Provision this checkout’s local and shadow databases
- `pnpm verify:fast`: Lint, policy checks, and affected typecheck/tests — run before handing work off

Other scripts:

- `pnpm dev:raw`: Start all applications with raw Turbo dev scripts, bypassing portless
- `pnpm build`: Build all applications
- `pnpm dev:web`: Start only the web application
- `pnpm dev:server`: Start only the server
- `pnpm db:generate`: Regenerate the Prisma client
- `pnpm db:studio`: Open Prisma Studio to browse the local database
- `pnpm generate:secrets`: Build a validated production env block (entropy + prompts; see [docs/environment.md](./docs/environment.md))
- `pnpm generate:secret`: Print a 32-byte random hex string (for `BETTER_AUTH_SECRET`)
- `pnpm env:sync` / `pnpm env:check`: Regenerate / verify the `.env.example` files from the env manifest
- `cd apps/web && pnpm generate-pwa-assets`: Publish the five generated PWA outputs into `apps/web/public/`, preserving `assets/logo.png` and the maintained Apple tile

### Running multiple apps on one machine

Start the shared Postgres + Valkey stack once with `pnpm dev:services`, then give each app clone its own database, Valkey logical DB, and local subdomain slug.

Root `.env` for a second app:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/my_second_app
REDIS_URL=redis://localhost:6379/4
BETTER_AUTH_URL=https://my-second-app.localhost
```

`portless.json` for that app:

```json
{
  "script": "dev:raw",
  "apps": {
    "apps/web": { "name": "my-second-app" },
    "apps/server": { "name": "api.my-second-app" }
  }
}
```

Then run `EXPECTED_DB=<db-name> pnpm db:worktree` and `EXPECTED_DB=<db-name> pnpm db:migrate:apply` for that app. The local guard requires loopback and the exact checkout database names. Linked worktrees normally use their automatically derived `cockpit_chess_wt_<hash>` database and shadow without an override. Start with `pnpm dev`. If you cannot use portless, `pnpm dev:raw` keeps the old Turbo flow and you can set `SERVER_PORT`, `VITE_DEV_PORT`, and `VITE_DEV_SERVER_URL` manually.

### Project structure

```
apps/
  web/        React web app (TanStack Router): arena, replay, leaderboard, Studio
  server/     Hono API (oRPC, Better-Auth)
  worker/     BullMQ background jobs, including match runs
  cli/        Companion CLI and local browser lab
packages/
  chess/          Referee (chess.js), match runner and Stockfish integration
  agent-runtime/  Model provider adapters
  api/            oRPC routers and business logic
  auth/           Better-Auth configuration
  db/             Prisma schema and client
  queue/          BullMQ on Valkey/Redis
  env/            Environment variable validation
  locales/        Translation bundles
  ui/             Shared shadcn/ui components
```

## Documentation

- [Companion CLI](./apps/cli/README.md)
- [Deployment](./docs/deployment.md), [environment](./docs/environment.md) and the [access matrix](./docs/access-matrix.md)
- [Schema migrations](./docs/schema-migrations.md), [change recipes](./docs/schema-changes-recipe.md) and [backup/restore](./docs/backup-restore.md)
- [Changelog](./CHANGELOG.md)
- [Web routes](./sitemap.md)

`AGENTS.md` is the source of truth; `CLAUDE.md`, `.cursorrules`, and `.github/copilot-instructions.md` are machine-generated mirrors of it, regenerated by `pnpm sync:agent-docs` — never hand-edit them.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md), run `pnpm verify:fast` before you open a pull request, and see [AGENTS.md](./AGENTS.md) for the repository rules.

## Security

Please report vulnerabilities privately. See [SECURITY.md](./SECURITY.md).

## License

Copyright (C) 2026 FlyCockpit LLC

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3 (`AGPL-3.0-only`). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](./LICENSE) for the full text and [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md) for bundled third-party notices. The container images and CLI binaries run Stockfish (GPL-3.0) as a separate subprocess; its notice is in THIRD-PARTY-LICENSES.md.
