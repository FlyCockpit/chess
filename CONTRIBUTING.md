# Contributing to Cockpit Chess

Thanks for your interest in improving Cockpit Chess. Please open an issue to discuss larger changes before you start on them.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting security issues

Do not open public issues or pull requests for security problems. Report them privately as described in [SECURITY.md](./SECURITY.md).

## Licensing

Cockpit Chess is copyright 2026 FlyCockpit LLC and licensed under `AGPL-3.0-only` (see [LICENSE](./LICENSE)). Contributions are accepted under the same license: by submitting a contribution you agree that it is licensed to the project and its users under `AGPL-3.0-only` (inbound = outbound). There is no separate contributor license agreement.

Stockfish is distributed as a subprocess engine in the container images and companion CLI under `GPL-3.0`. See [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md) for third-party notices.

## Development setup

The [README](./README.md) covers requirements and local setup: Node.js and pnpm versions, PostgreSQL 18 and Valkey 9, the container quick start, and host development with `pnpm dev`. `pnpm doctor` diagnoses common local setup problems.

Releases distribute server and worker container images through GHCR, and Bun-compiled companion CLI binaries through [GitHub Releases](https://github.com/FlyCockpit/cockpit-chess/releases).

## Database changes

Each checkout has its own guarded local database and shadow: run `pnpm db:worktree` after cloning or creating a linked worktree, then `pnpm db:migrate:apply` after pulling changes. To change the schema, edit `packages/db/prisma/schema/`, run `pnpm db:migrate <name>`, review the generated SQL, and apply it locally. Commit schema and migration folder together; merged migration folders are immutable. After rebasing unmerged migrations, use `pnpm db:migrate:rebase`.

The generator schedules removals in `contract.sql`; they run after the seven-day overlap proof, not at deploy. Use `@map` for renames and two PRs for type changes. Add migration fixtures/checks when changing existing data, and show the CI destructive-SQL summary before merge. `pnpm db:reset:local` explicitly rebuilds only this checkout's exact local database; it requires owner approval and is never an automatic repair. See [the recipes](./docs/schema-changes-recipe.md), [migration recovery](./docs/schema-migrations.md) and [backup/restore](./docs/backup-restore.md).

## Repository rules

[AGENTS.md](./AGENTS.md) is the rulebook for this repository, for people and coding agents alike. Read it before your first change. In particular:

- [docs/access-matrix.md](./docs/access-matrix.md) is the authorization contract. A pull request that adds or changes an oRPC procedure, route gate or schema field updates it in the same change; `pnpm policy:access-matrix` enforces this.
- The server is the authoritative chess referee. Preserve move validation and the record of every illegal or unparseable attempt.
- Keep the diff to the task. Unrelated refactors, reformatting or dependency bumps belong in their own pull request, and a new dependency should be discussed first.
- User-facing strings go through `t()`, with keys in both `packages/locales/src/en-US/` and `packages/locales/src/es-MX/`. New environment variables follow the schema and manifest rules in `AGENTS.md`.

## Checks

Before opening a pull request, run:

```sh
pnpm verify:fast
```

It runs Biome, the policy checks, and the typecheck and tests affected by your change. CI runs the full gate (`pnpm verify`). Unit tests use mocks and fake providers. Migration/backup integration harnesses require an explicitly disposable PostgreSQL instance; never point them at development, shared or production data. CI runs those dedicated harnesses separately. Do not skip hooks with `git commit --no-verify`; fix the failing check instead.

## Pull requests

- Keep each pull request focused on one change, and describe what it does and why.
- Fill in the pull request template, including the checks you ran.
- Target the default branch, `main`.
- Update the relevant docs, the access matrix and `sitemap.md` when your change affects them.
