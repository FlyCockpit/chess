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
- Committed, reviewed Prisma migrations with per-checkout local/shadow databases, guarded startup admission and delayed seven-day contract deletions.
- Server-led migrations, external worker instance registration and heartbeat drain, and exact-commit deployment acceptance.
- Verified PostgreSQL dump backups, opt-in daily scheduling, independent off-site freshness monitoring, previewed/pinned restore and seven-day deletion holds.
- Automatic pre-migration and pre-drop dumps now require `BACKUP_ENABLED=true`; previously a `/backups` mount or bucket alone enabled them. Set `BACKUP_ENABLED=true` to keep them. With `BACKUP_ENABLED=true` and no destination (no writable `/backups` mount, no `BACKUP_S3_BUCKET`), the migration now stops with `no backup destination` instead of warning and migrating, and due scheduled deletions are skipped for that start.
- `BACKUP_ENABLED=true` with no usable destination now stops every migrating start (server with `MIGRATE_ON_START=true`, or the `migrate` job) before it migrates, on a brand-new database too and even when nothing is pending; a missing backup hook in the image refuses as well. A server or `migrate` job with `BACKUP_ENABLED=true` and `BACKUP_S3_BUCKET` but only the `BACKUP_MONITOR_S3_*` key (no writer key) now fails its migrating start: add the writer key there or set `BACKUP_ENABLED=false` on it (`pnpm doctor` warns). The backup writer keys are held only by the entrypoint (PID 1) while migrating, then dropped before it execs tini with the CMD, so `/proc/1/environ` and the app's environment never carry them.
- `restore` exits 3 for every refusal or cancel before the restore transaction (usage errors, preview, Ctrl-C/Ctrl-D at the prompt or a stop signal during the checks), and 4 when the restore transaction started and provably rolled back (COMMIT never sent, psql stopped on an SQL error before confirming COMMIT, or the server's `pg_xact_status()` reports it aborted); any other failure once COMMIT was sent is reported as uncertain. `app-db.sh restore | tee log` prompts, restarts the app after a completed, refused or rolled-back restore (also when `tee` died), and leaves it stopped when the outcome is uncertain. `host.sh` and `pre-migrate.sh` are Linux-only.
- `app-db.sh` stops with the `docker compose … up -d --no-build --force-recreate server` fix when the running server's image ID is no longer on the machine, instead of falling back to the image tag.
- `pnpm dokploy:config` builds every image from the pinned Git context `<repository URL>#<git-ref>` (`--git-url`, default the `origin` remote; `--git-url local` for plain `docker compose` in a checkout), so a pasted Dokploy Compose needs no source tree; Git-context builds keep `.git` so the image still reports its commit. The generated server gets `BACKUP_ENABLED` in both topologies (a dedicated-worker deployment took no migration snapshots), and the backup service starts after the server that shares its fresh `backups` volume.
- The admin backup card shows the monitor's recorded verdict instead of re-checking the monitor key pair on the server, which a dedicated worker's server never receives (a false "misconfigured").
- Local reset guard: `pnpm db:reset:local` refuses databases without the disposable-local mark (`pnpm db:worktree` and the dev compose volume set it; a person adopts older ones with `pnpm db:worktree --adopt`) and any differing `EXPECTED_DB`. `pnpm db:migrate:apply` refuses while another session holds a migration lock. The Claude Code hook denies raw `prisma migrate resolve` and adoption/marking.
- Admin authority is one function, `checkAdminAuthority` (`packages/api/src/index.ts`), used by `requireAdmin`, `requireAdminOr404` and the server's admin session gate.
- Localized deletion notices for opted-in verified admins, retried every 15 minutes for up to 14 days.
