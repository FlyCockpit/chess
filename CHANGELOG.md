# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 — Unreleased

First public release.

- Hosted LLM-vs-LLM matches through OpenRouter, run by a background worker with the server as the authoritative chess.js referee.
- Live arena and replay, recording every illegal, unparseable or cut-off ("ran out of space") attempt with the end of the model's reply.
- No fixed reply cap: each request may use the model's own maximum output within its budgets, with an optional reply cap for experiments (rules `cockpit-v3`), named on every game's rules, share card and video title. Games recorded under the dropped `cockpit-v2` rules still list, marked "Played under old rules — replay unavailable".
- Leaderboard for published, rated hosted games, grouped by exact rules and wire protocol.
- Admin Studio to create, stop, publish, import and export matches.
- Users' own OpenRouter accounts (operator opt-in, `CHESS_USER_MATCHES_ENABLED`): verified users connect through OpenRouter's OAuth PKCE flow and run private hosted matches billed to their key, sealed at rest with AES-256-GCM (`CHESS_PROVIDER_KEY_SECRET`). One active match per user, daily and queue caps, unscored "account limit" and "credential revoked" endings, and admin-curated leaderboard standing ([deployment](./docs/deployment.md#hosted-chess-for-users)).
- Hosted capacity for hundreds of concurrent matches per worker (`CHESS_RUN_CONCURRENCY`, default 512) with one bounded, shared Stockfish pool (`CHESS_ENGINE_POOL_SIZE`), a batched heartbeat, bounded per-match memory and a live admin capacity view ([sizing](./docs/deployment.md#sizing-hosted-chess)).
- "Source code" link to the exact running commit (AGPL-3.0 section 13), configurable with `SOURCE_CODE_URL`.
- Configurable rules for memory, identity disclosure, board representation, legal-move help, time, token and cost budgets, and optional Stockfish assistance.
- Companion CLI with a loopback local lab for local or self-hosted models and a Stockfish opponent.
- GHCR container images for the server and worker, and Bun-compiled CLI binaries through GitHub Releases.
- Committed, reviewed Prisma migrations with per-checkout local/shadow databases, guarded startup admission and delayed seven-day contract deletions. `pnpm db:reset:local` only rebuilds databases that carry the disposable-local mark, and `pnpm db:migrate:apply` refuses while another session holds a migration lock ([schema migrations](./docs/schema-migrations.md)).
- Server-led migrations, external worker instance registration and heartbeat drain, and exact-commit deployment acceptance. `pnpm dokploy:config` builds every image from a pinned Git context ([deployment](./docs/deployment.md)).
- Verified PostgreSQL dump backups, opt-in daily scheduling, independent off-site freshness monitoring, previewed/pinned restore and seven-day deletion holds ([backup and restore](./docs/backup-restore.md)).
- Automatic pre-migration and pre-drop dumps are off unless `BACKUP_ENABLED=true`. With it set, a migrating start refuses without a usable destination or, for S3, without the writer key. The writer keys are held only while migrating and never reach the running app.
- Localized deletion notices for opted-in verified admins, retried every 15 minutes for up to 14 days.
