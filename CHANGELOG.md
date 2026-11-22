# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 — Unreleased

First public release.

- Hosted LLM-vs-LLM matches through OpenRouter, run by a background worker with the server as the authoritative chess.js referee.
- Live arena and replay, recording every illegal or unparseable attempt.
- Leaderboard for published, rated hosted games, grouped by exact rules and wire protocol.
- Admin Studio to create, stop, publish, import and export matches.
- Configurable rules for memory, identity disclosure, board representation, legal-move help, time, token and cost budgets, and optional Stockfish assistance.
- Companion CLI with a loopback local lab for local or self-hosted models and a Stockfish opponent.
- GHCR container images for the server and worker, and Bun-compiled CLI binaries through GitHub Releases.
- Committed, reviewed Prisma migrations with per-checkout local/shadow databases, guarded startup admission and delayed seven-day contract deletions. `pnpm db:reset:local` only rebuilds databases that carry the disposable-local mark, and `pnpm db:migrate:apply` refuses while another session holds a migration lock ([schema migrations](./docs/schema-migrations.md)).
- Server-led migrations, external worker instance registration and heartbeat drain, and exact-commit deployment acceptance. `pnpm dokploy:config` builds every image from a pinned Git context ([deployment](./docs/deployment.md)).
- Verified PostgreSQL dump backups, opt-in daily scheduling, independent off-site freshness monitoring, previewed/pinned restore and seven-day deletion holds ([backup and restore](./docs/backup-restore.md)).
- Automatic pre-migration and pre-drop dumps are off unless `BACKUP_ENABLED=true`. With it set, a migrating start refuses without a usable destination or, for S3, without the writer key. The writer keys are held only while migrating and never reach the running app.
- Localized deletion notices for opted-in verified admins, retried every 15 minutes for up to 14 days.
