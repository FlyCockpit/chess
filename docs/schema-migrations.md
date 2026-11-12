# Schema Migrations

> How a schema change gets from `packages/db/prisma/schema/` into every database, how deletions wait until no older release is running, and what to do when that goes wrong. For step-by-step change recipes (add a field, rename, backfill) see [schema-changes-recipe.md](./schema-changes-recipe.md).

## How it works

This repo uses **Prisma Migrate** with committed SQL files.

- `packages/db/prisma/schema/*.prisma` describes what the database should look like.
- `packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` is the exact SQL that gets it there, one folder per change. When the change deletes something, the same folder also holds a `contract.sql` that the deploy runner applies about 7 days later ([§ Expand and contract](#expand-and-contract)). Fresh Cockpit Chess databases start from `0_init`, generated from the current auth, chess and CLI schemas: nine application tables, with `pg_trgm` created before trigram indexes. It preserves the existing timestamp and BigInt cost types.
- Each database records the migrations it has applied in its `_prisma_migrations` table. `prisma migrate deploy` applies only the ones not recorded yet, in folder order, so it is safe to run on every start: with nothing pending it does nothing.

The SQL is committed and reviewed like code. That is what lets one PR backfill data: you edit the generated SQL before it is applied anywhere.

Three rules never bend:

1. **A migration on the default branch is immutable.** Never edit, rename, or delete it. Fix mistakes with a new migration. CI check 3 enforces this.
2. **Every schema change ships with its migration in the same PR.** A schema edit without SQL fails CI check 1.
3. **Agents never run `prisma migrate dev` or `prisma migrate reset`.** Agents also never run `prisma migrate deploy` directly: use the wrappers below or the image runner. The local wrappers are guarded to touch only this checkout's own local database.

## Local commands

| Command | What it does |
|---|---|
| `pnpm db:worktree` | Creates this checkout's local database and shadow database if missing, and writes `DATABASE_URL` into this checkout's `.env`. Run once per clone or git worktree. |
| `pnpm db:migrate <name>` | **Generates only.** Diffs what production ends up with (every `migration.sql`, then every `contract.sql`) against the schema, using the shadow database, and writes a new `migrations/<timestamp>_<name>/migration.sql`, plus `contract.sql` when something is deleted ([§ Expand and contract](#expand-and-contract)). Prints what changes now, what is deleted later, whether rollback stays possible, and anything CI will fail. Applies nothing; on a refusal it writes nothing. `--remap 'Enum.OLD=NEW'` removes an enum value, `--recover 'table.old=new'` gets a field back before its deletion runs. Add `--empty` for a hand-written migration (data fix, backfill) with no schema change, and `--empty --no-transaction` for statements that cannot run in a transaction. |
| `pnpm db:migrate:apply` | Runs `prisma migrate deploy` against this checkout's local database, then `prisma generate`. Run it after reviewing the generated SQL, and after every pull. If a local transactional migration failed, it marks it rolled back first (same rule as [automatic recovery](#automatic-recovery)) so you can fix the SQL and apply again. It never applies `contract.sql`; it prints how many scheduled deletions it skipped. |
| `pnpm db:migrate:rebase` | After rebasing onto the default branch: if your unmerged migration folders no longer sort after the base's latest one, re-timestamps them (SQL unchanged, except generated enum-remove blocks, which are regenerated for the new folder name) and re-checks consistency on a scratch database. If your local database has diverged it prints the `db:reset:local` command instead of running it. |
| `pnpm db:reset:local` | With owner approval, drops and recreates **this checkout's own local database** (exact name only), applies all migrations and then every `contract.sql`, and regenerates the client. Explicit; nothing calls it for you. |
| `pnpm db:check-migrations --base <git-ref>` | Runs the CI migration checks locally (see [schema-changes-recipe.md § What CI checks](./schema-changes-recipe.md#what-ci-checks)). Needs `CHECK_DATABASE_URL` pointing at a disposable Postgres superuser URL. |
| `pnpm db:studio` / `pnpm db:generate` / `pnpm db:validate` | Browse, regenerate the client, validate the schema. |

The everyday loop for an agent:

```bash
# 1. edit packages/db/prisma/schema/*.prisma
pnpm db:migrate add_phone_number     # 2. generate SQL
# 3. read packages/db/prisma/migrations/<timestamp>_add_phone_number/migration.sql
#    (and contract.sql, if any) and edit it if needed (use @map for renames, add a backfill UPDATE)
pnpm db:migrate:apply                # 4. apply locally + regenerate the client
# 5. commit schema + migration folder together
```

**Local databases are per checkout.** The main checkout uses `cockpit_chess` (or `$EXPECTED_DB`). A linked git worktree uses `cockpit_chess_wt_<10 hex chars>`, derived from its git directory, so parallel agents in separate worktrees never overwrite each other's schema. Each has a `<name>_shadow` database that `db:migrate` uses for diffing. Every wrapper runs `scripts/assert-local-database.sh`, which refuses anything but the exact names computed for this checkout on `localhost` / `127.0.0.1` / `::1`, and any `DATABASE_URL` query parameter that could redirect the connection (`host`, `hostaddr`, `port`, `dbname`, …; only `schema`, `sslmode`, timeouts and similar are allowed). If the guard refuses, it is working: never point a local command at a shared, staging, or production database.

## Migration file markers

Markers are plain SQL comments in `migration.sql` and `contract.sql`. They are reviewable text, not env vars.

| Marker | Meaning |
|---|---|
| `-- cockpit-chess:transactional` | Written by the generator. The body is wrapped in `BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; … COMMIT;` so a failure leaves no partial change and a stuck lock fails fast. Two generated blocks bracket your statements. `-- cockpit-chess:history-capture` (right after the `SET LOCAL` lines) records which table is Prisma's migration history; `-- cockpit-chess:commit-marker` (the last statement before `COMMIT;`) writes, inside the same transaction, that this attempt committed. Together they let the runner tell a committed-but-unrecorded attempt from a rolled-back one, whatever the body does to `search_path`. Both do nothing where there is no migration history (Prisma's shadow database). Keep every wrapper line byte-for-byte when you hand-edit, and put your statements between the two blocks. CI rejects a body that uses `RESET`, `DISCARD ALL`, or the `cockpit_chess.history` setting, since those would erase what the marker relies on. Statements that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`) go in their own migration without the wrapper and without this marker. |
| `contract.sql` (a file, not a marker) | Written by the generator when the change deletes something. The deploy runner applies it about 7 days after the deploy, once no older release is running ([§ Expand and contract](#expand-and-contract)). Generated `DROP` statements and the enum template only; never hand-write one. |
| `-- cockpit-chess:relax v1 "t"."x"` | Generated in `migration.sql` for a dropped NOT NULL column: a placeholder default (or `DROP NOT NULL`) so the old release's inserts keep working until the drop. |
| `-- cockpit-chess:enum-remove v1 …` | Generated by `--remap`, with the same header in both files: the sync trigger and row remap at deploy, the enum rebuild later ([§ Removing an enum value](#removing-an-enum-value)). |
| `-- cockpit-chess:recover v1 "t"."x" -> "y"` | Generated by `--recover`: copies a retired column into a new one while it still exists ([§ Getting a field back](#getting-a-field-back)). |
| `-- cockpit-chess:reviewed <reason>` | On the line directly above one `migration.sql` statement the analyzer cannot read (`DO`, `EXECUTE`, a dollar-quoted body, …). An attestation by the author that the running release is unaffected; CI passes the statement and lists it under "Reviewed by hand … attested by the author, not verified", and the release counts as not rollback-safe. Ignored for anything that drops, renames, truncates or changes a type. Never annotate to silence a failure you have not understood. Never allowed in `contract.sql`. |
| `-- intentional: drop and recreate` | Placed on the line immediately above a single statement (for a column drop, the `DROP` in `contract.sql`). Tells CI check 5 that a drop-and-add on the same table is deliberate, not an accidental rename. |

The generated templates carry a version token (`v1`); CI regenerates each block from its header and compares the exact text ([§ Generated block versions](#generated-block-versions)). CI check 5 fails anything in `migration.sql` that the release still running cannot tolerate, SQL the analyzer cannot read unless it is annotated, a migration whose wrapper (`BEGIN`, the commit marker, `COMMIT`) was broken by an edit, and a reused name an earlier deletion removes. The deploy runner refuses the same things ([§ What happens at deploy](#what-happens-at-deploy)), with no override ([§ No in-place breaking changes](#no-in-place-breaking-changes)).

## Test fixtures for migrations

CI check 4 applies migrations on top of realistic rows, not an empty database. Fixtures live in `packages/db/prisma/fixtures/`:

- `<migration_folder>.sql` — rows written against the schema **as of that migration**. It is loaded right after that migration is applied, so an old fixture never needs rewriting when later migrations change the table.
- `<migration_folder>.check.sql` — assertions run after all migrations. Each statement must return **zero rows** (write it as "select the rows that are wrong").

When you add a migration that changes a table with data (a type change via [schema-changes-recipe.md](./schema-changes-recipe.md) Recipe 5, a backfill, a new constraint, a deletion), add a fixture with edge cases for that table (nulls, near-duplicates, values that are hard to convert) and a `.check.sql` that proves the data survived.

## What happens at deploy

The same image runs migrations two ways:

- **Startup migration (Dokploy).** The server command checks migration state before starting. `MIGRATE_ON_START` defaults to `true` for the server command and `false` for everything else.
- **`migrate` image command (container platforms).** The infra workflow runs the image with command `migrate` as a one-shot job. It does the same checks, applies, and exits 0 or non-zero without starting the server. App replicas run with `MIGRATE_ON_START=false`. See [deployment.md](./deployment.md).

The runner (`scripts/db/migrate-runtime.mjs`) reads the database's migration history and decides one of these states:

| State | What it means | Leader does | Follower does |
|---|---|---|---|
| `up-to-date` | Every migration in the image is applied. | Registers, runs any due scheduled deletions ([§ Expand and contract](#expand-and-contract)), starts. | Registers, starts. |
| `pending` | The image has migrations the database lacks. | Refuses if one is unsafe for the running release (an in-place drop / rename / type change, unannotated SQL it cannot read, or the retired `-- requires: maintenance-deploy` marker) or reuses a name an earlier deletion removes, except on a brand-new database. Otherwise runs the pre-migration backup hook, then `prisma migrate deploy`, then continues as `up-to-date`. | Waits. |
| `db-ahead` | The database has applied migrations this image does not contain (a rollback or stale deploy). | Starts only if every newer migration is rollback-safe and none of their deletions has run ([§ Rollbacks](#rollbacks)); it then registers, which pauses deletions. Otherwise refuses. | Same rule. |
| `failed` | A migration is recorded as failed. | Tries [automatic recovery](#automatic-recovery); otherwise refuses. If another session is still applying it (Prisma's lock is held), waits, then refuses without touching it. | Waits while a runner is working on it; otherwise refuses. |
| `no-history-nonempty` | The application catalog is populated but has no valid applied migration history. | Refuses and points at [A database with tables but no migration history](#a-database-with-tables-but-no-migration-history). Never adopts an existing schema automatically. | Refuses. |
| `unreachable` | Cannot connect. | Refuses (the platform retries). | Keeps waiting until timeout. |

**Followers** are containers with `MIGRATE_ON_START=false`, including the dedicated worker in the supported `app-worker` topology. They run the runner in `wait` mode: read-only apart from registering in the instance registry, polling until the state is `up-to-date`, with a fixed 300-second timeout. Wait mode never runs scheduled deletions. On timeout or a persistent `failed` migration that no runner is working on, they refuse to start. A `db-ahead` follower must pass the same rollback proof as a leader. With the default embedded worker on Dokploy there is no second container.

**Pre-migration backup.** A genuinely empty application catalog is exempt, including fresh installs with several pending folders. Empty or rolled-back migration history alone does not prove freshness: unexpected application objects cause refusal. For an existing database in state `pending`, the runner first calls `scripts/backup/pre-migrate.sh`. If no backup is configured it logs a warning and continues. If a backup is configured and fails, the migration does not run. When a scheduled deletion is due and this run took no pre-migration backup, it takes one labelled `pre-drop` first; if that fails, nothing is deleted this run. See [backup-restore.md § Pre-migration backup](./backup-restore.md#pre-migration-backup-optional-encouraged).

**Locking.** Two locks keep concurrent runs apart:

- **The runner lock.** A leader (`apply` mode) holds a Postgres session advisory lock (key `72707370`, `MIGRATION_RUNNER_LOCK_KEY` in `scripts/db/lib/migration-state.mjs`) for its whole run: classify, recover, pre-migration backup, `migrate deploy`, final check. A second leader (two containers starting with `MIGRATE_ON_START=true` at once: a deploy or restart overlapping another, or a worker or extra replica configured to migrate) waits for it, re-reads the state, and normally finds the database already up to date. Scheduled deletion transactions run on the backend holding this lock, so losing that backend rolls back an in-flight deletion before an owner hold can be acknowledged. Losing lock ownership always fails admission, even during scheduled deletions. The lock belongs to the session, so a crashed runner never leaves it behind. Restore takes the same lock ([backup-restore.md § Restore](./backup-restore.md#restore)).
- **Prisma's lock** (key `72707369`) around `migrate deploy` itself. A leader that finds a migration recorded as started while Prisma's lock is held by someone else (an operator running `prisma migrate deploy` by hand) waits for it and then refuses rather than resolve a migration that is still running. After its own failed deploy, it re-checks the same way before any recovery.

Before applying, the runner revalidates history, catalog and contract facts after backup under its lock. Changed facts restart classification and safety checks. The shared `PREDEPLOY_CATALOG_TIMEOUT_MS` budget covers all pre/post-backup inspections and gate reads together; it is not a new allowance for each query.

The waiting leader uses the same 300-second timeout as followers. If the other leader's pre-migration backup plus `migrate deploy` takes longer, the waiting one exits non-zero and the platform restarts it; that is expected, and the restarted container finds the work done. **The timeout must cover the backup:** with a large database, either keep one leader (the default embedded worker on Dokploy, or the one-shot `migrate` job on container platforms) or make sure the platform keeps restarting a container that exits during a long migration. On container platforms only the one-shot job migrates, so app replicas never contend for the lock.

## Automatic recovery

A failed or interrupted migration is recorded as failed, and Prisma refuses every later migration until someone runs `migrate resolve`. The runner handles two safe cases by itself, both only for a migration that starts with `-- cockpit-chess:transactional` and whose wrapper is intact:

- **Interrupted after `COMMIT`** (the commit marker is recorded): the process stopped after the transaction committed but before Prisma recorded success. The changes are in the database, so the runner runs `prisma migrate resolve --applied <name>` and never runs the migration again.
- **Failed or interrupted before `COMMIT`** (no commit marker): PostgreSQL rolled the whole file back. The runner logs the migration name and the original error loudly, runs `prisma migrate resolve --rolled-back <name>`, and retries **once**. A second failure stops the deploy.
- Any other failed migration (no marker, or a broken wrapper) stops the deploy and points at the [Recovery runbook](#recovery-runbook). A person decides.

**Edited applied migrations are refused.** If a migration file in the image differs from the one recorded as applied (checksum mismatch), the runner refuses to start in both `apply` and `wait` mode: the database was never migrated for that edit. Restore the original file and put the change in a new migration.

Automatic recovery does not fix the cause. If a migration failed because of data (a duplicate, a null), it fails again; write a corrective migration.

## Expand and contract

Every deploy overlaps: on Dokploy the old container keeps serving while the new one starts (start-first), and on a container platform the `migrate` job runs while the old release serves. So every migration must be safe for the release that is still running, and anything that release reads can only be deleted once it is gone. The tooling does that split for you; nobody stops the app.

### Two files per folder

```
packages/db/prisma/migrations/<timestamp>_<name>/
  migration.sql   # applied at deploy by prisma migrate deploy (expand)
  contract.sql    # optional; applied by the deploy runner about 7 days later (contract)
```

Prisma reads only `migration.sql`; it never sees `contract.sql`. CI check 3 hashes every file in a merged folder, so a `contract.sql` is immutable once merged, like the migration. The runner records its checksum too.

`pnpm db:migrate` diffs the schema against what production ends up with (every `migration.sql`, then every `contract.sql`) and splits the result:

| Change | `migration.sql` (at deploy) | `contract.sql` (later) |
|---|---|---|
| Drop a column | `-- cockpit-chess:relax`: a NOT NULL column without a default gets a placeholder default (`''`, `0`, `false`, `'1970-01-01'`, `'{}'`, …) or loses NOT NULL, so the old release's inserts keep working. Losing NOT NULL (a foreign key, unique or checked column, or a type with no placeholder) makes the migration **not rollback-safe**, and the generator warns: older code can fail on the NULLs the new release writes | `DROP COLUMN` |
| Drop a table, an enum type, or an index / unique constraint of a dropped table or column | — | the `DROP` |
| A foreign key owned by, or pointing at, a dropped table or column | dropped at deploy, so it cannot block the old release's writes | dropped later when its delete action must keep working until then (`CASCADE` / `SET NULL` / `SET DEFAULT` owned by a dropped table, `SET NULL` owned by a dropped column) |
| Remove an enum value (`--remap 'E.OLD=NEW'`) | the `-- cockpit-chess:enum-remove` block: a sync trigger plus the row remap | the enum rebuild (below) |
| Everything else (add tables, columns, indexes, enum values, backfills) | as generated | — |

What it refuses, writing nothing: a primary-key change, a table / enum / enum value rename (use `@@map` / `@map`), an enum removal without `--remap`, values removed from more than one enum, and values added to the same enum. What CI check 5 fails: an in-place `RENAME COLUMN` or `ALTER … TYPE` (two PRs, [schema-changes-recipe.md](./schema-changes-recipe.md) Recipe 5), unreadable SQL without `-- cockpit-chess:reviewed`, and a name an earlier deletion removes. **A deleted name is never reused**: the generator, CI and the runner refuse it; use a new database name with `@map` / `@@map`.

Old code that reads rows written by new code sees NULLs or the placeholder for a dropped column. That happens only during the overlap, or after an admitted rollback.

### When a deletion runs

The deploy runner (`migrate-runtime.mjs apply`: the server at every start on Dokploy, the `migrate` job on container platforms) runs due contracts after the database is up to date, in folder order. A `contract.sql` is due when all of these hold:

1. a release whose image contains that migration folder first became ready at least seven elapsed days ago;
2. no release whose image lacks it was seen alive in the last seven elapsed days;
3. no hold is active (below);
4. it passes validation against the live database and this image's schema: its checksum matches, it holds only generated shapes (`DROP TABLE` / `COLUMN` / `INDEX` / `CONSTRAINT` / `TYPE` and the enum template), every column it drops is nullable or defaulted, nothing it drops is in this image's schema, and no live default names a removed enum value.

Holds and pruning use elapsed milliseconds and 86,400-second days, so daylight-saving changes do not shorten the window.

The first one that is not due, or fails, stops the rest; they wait for the next start. On a **brand-new database** every contract runs right after the deploy: no older release can exist.

"Contains" means the folder is in that image, not that the image's newest migration sorts after it. A folder merged out of order (CI check 2 refuses it, but nothing enforces CI on a repository without branch rules) sorts below the level of the older release that is still serving, yet that release lacks it. The runner logs `OUT-OF-ORDER MIGRATION` when it applies one, and the deletion waits for that release like any other.

**The instance registry.** Every server and external worker host started through the image entrypoint gets a fresh `COCKPIT_CHESS_INSTANCE_ID` (set by the entrypoint; never set it yourself), registers in `_cockpit_chess_instance` with its newest migration and the list of its folders that carry a `contract.sql`, and heartbeats every 60 s. Embedded consumers share the server’s registry identity. Readiness is marked only after the server listens and its required consumers run, or the external worker’s consumers run. Shutdown stops ticks and awaits the in-flight heartbeat before disconnecting Prisma. That is how the runner knows whether an older release is still alive. A crashed old release blocks deletions for 7 days after its last heartbeat; a forgotten old instance blocks them until it is stopped or updated, and the schedule log names it. One-shot operational commands do not register. Only entrypoint-launched processes are visible: anything else that runs old code against the database (a cron box, a script) is not.

**Every deploy logs the schedule.** One line per pending deletion, prefixed `[migrate] scheduled deletion`: `will delete … after <date>`, `waiting for: <role>@<host> on <level> (last seen …)`, `held until <date> (<reason>)`, `retrying (attempt n/3)`, `retrying (database busy: …)`, or `needs a person: …`.

**Time and safety budget.** Contracts are non-fatal: an error is logged, rolled back, and the app starts normally. Before the first due contract, the runner takes a backup (`pre-migrate.sh --label pre-drop --keep 5`) unless this run already took the pre-migration one; a configured backup that fails skips every deletion this run. The contracts get 30 s per start (a contract starts only with 20 s left, the enum template only with its full 15 s left) under `lock_timeout = 5s` and at most 15 s per statement; what does not fit continues on the next start. A deterministic failure counts as one of 3 tries per release; after 3 the schedule says "needs a person" and nothing more is tried until a release that adds a migration (which gets 3 fresh tries). A busy database (lock timeout, deadlock, lost connection) does not count; a statement that keeps timing out on a busy table counts after 3 shortened timeouts in a row. At the moment of deletion the runner logs `[migrate] DATA DELETED: <what> (retired by <folder>, released <date>; backup: <label|none configured>)` and records it in `_cockpit_chess_migration`.

With no deploy or restart after the 7 days, a deletion waits for the next start.

### Rollbacks

An older image may start against a newer database only when every migration it lacks is rollback-safe and none of their deletions has run. The runner decides, reading `_cockpit_chess_migration`: admitted, the older release registers and logs "older release running against a newer schema (rollback …); scheduled deletions are paused while it runs"; refused, it does not start and names the reason. An older SHA's container `migrate` job applies the same rule and exits 0 or 1. Rollback-safe is a positive allowlist (new tables, nullable or defaulted columns, non-unique indexes, `SET DEFAULT`, the generated templates, DML with a `WHERE`); anything else (`SET NOT NULL`, `ADD VALUE`, a unique index on an existing column, a type change, a relax that drops NOT NULL instead of setting a placeholder, unreadable SQL) makes the release a one-way door, and the CI summary says so.

### Removing an enum value

`--remap 'E.OLD=NEW'` writes the same `-- cockpit-chess:enum-remove v1 "E" "OLD"->"NEW" columns …` header into both files:

- **At deploy**, `migration.sql` creates a `BEFORE INSERT OR UPDATE` trigger per affected table that rewrites `OLD` to `NEW` (so the old release can keep writing `OLD`), then remaps existing rows. The trigger body works through `jsonb` (`to_jsonb(NEW)` / `jsonb_populate_record`) and holds no expression typed by the enum, so its cached plan survives the later rebuild in pooled connections. It adds a trigger to writes on affected tables during the overlap.
- **Later**, `contract.sql` drops the triggers, remaps any stragglers, and rebuilds the enum without `OLD` (new type, `ALTER COLUMN … TYPE`, swap names, restore defaults). Inside the same subtransaction it refreshes every plpgsql function and procedure in Prisma's schema, and every trigger function on an affected table, with a no-op `ALTER ROUTINE … SECURITY <same>`, which invalidates other sessions' cached plans.
- **The value is kept instead** when an affected table is larger than 64 MB, when something else uses the column (a view, policy, rule, `UPDATE OF` trigger, generated column, foreign key, `BEGIN ATOMIC` function), when a refresh fails (a function the migration role does not own), or when the rebuild times out after 15 s. The deletion still commits and logs `cockpit-chess:label-kept`. **A kept value is permanent and harmless**: no row holds it, no default names it, the app is never offered it, and the generator and CI ignore its drift. A lock timeout or an external cancel is retried instead.
- Two residuals, each needing a connection recycle after the deletion runs: (a) a plpgsql function in **another schema**, not a trigger on an affected table, that references the enum; (b) **named prepared statements** (`statementNameGenerator` on `PrismaPg`, or PgBouncer in prepared-statement mode) fail with "cached plan must not change result type". Cockpit Chess does not set `statementNameGenerator` (`packages/db/src/index.ts`); keep it that way.

One enum per migration; the generator explains how to split two.

### Generated block versions

The generated blocks (`cockpit-chess:enum-remove`, `cockpit-chess:relax`, `cockpit-chess:recover`) carry a version token, `v1`. The tooling regenerates a block from its header and compares the exact text, so a hand-edited block is "not analyzed" and fails CI. **Never edit a released template: add `v2` and keep every earlier version's generator.** An image that does not know a version refuses it ("template vN not known to this image: deploy a newer image").

### Getting a field back

Within the 7 days, `pnpm db:migrate <name> --recover 'table.old=new'` adds a `-- cockpit-chess:recover v1` block: it copies `old` into the new field `new` (same type, added in the same change) if `old` still exists, and warns otherwise. If the deletion already ran, the runner logs `RECOVERY TOO LATE: … (backup: <label>)`: restore that backup ([backup-restore.md](./backup-restore.md)), then ship the recover PR within 7 days. **After any restore, ship the `--recover` PR within 7 days**: that is how long the restore hold lasts. Rows created after the retirement hold the placeholder, or NULL.

### Holds

While any row in `_cockpit_chess_hold` has `until` in the future, no deletion runs. There are three sources:

- **`restore`**: the `restore` command writes a 7-day hold inside its restore transaction.
- **`cluster-changed`**: at each `apply`, under the runner lock, the runner compares the database's identity (system identifier, WAL timeline, database oid, and the oid of its own `_cockpit_chess_cluster` table) with the stored row. Any difference sets a 7-day hold and logs `[migrate] database was restored or moved (…)`, or, when the registry table was recreated, `database was restored from a logical backup (registry table recreated)`. The first identity check on an existing database also holds for 7 days ("deletion scheduling starts on this database"); that costs nothing, since nothing can be due earlier. Where the provider does not let the app role call `pg_control_system()` / `pg_walfile_name()`, the identity is stored as `unavailable`; a change between available and unavailable counts as a change. Any other read error skips the deletions for that run.
- **`owner`**: set by the owner with the `hold-deletions` image command ([§ Holding deletions by hand](#holding-deletions-by-hand)).

Every hold write keeps the later `until` (`greatest`), so two holds never shorten each other.

| Event | Detected? |
|---|---|
| Reboot, crash restart, OOM, crash loop, `VACUUM FULL` / `CLUSTER` / `REINDEX` | nothing changes: no hold |
| `restore` command (in place or into an empty target) | yes (`restore` and `cluster-changed`) |
| Dokploy database Backups → **Restore** button, any `pg_restore --clean` / `--if-exists`, a dump restored into a new database or another server | yes (the registry table's oid changes) |
| Provider point-in-time restore, HA failover with promotion | yes (timeline); a failover costs one false 7-day hold |
| RDS Blue/Green switchover, logical-replication cutover, `pg_upgrade`, provider move | yes (system identifier); one hold |
| Provider newly revokes or grants the identity functions | yes; one hold |
| Dokploy **Volume Backups** restore, storage snapshot restored with crash recovery only | **not detected** |
| `pg_restore --data-only` into the existing tables | **not detected** |
| Neon branch reset, Aurora restore, any provider whose restore identity behavior has not been verified | possibly not detected |

So a restore, PITR, HA failover or Blue/Green switchover delays deletions by 7 days; crashes, reboots and OOM restarts do not.

Dokploy's database Restore button and the `restore` command are detected automatically: scheduled deletions wait 7 days. Restart or redeploy the app afterwards. Restoring a Dokploy **Volume Backups** copy is not detected: start only the database, run the `hold-deletions` image command, then start the app.

### Runner-owned tables

`_cockpit_chess_instance`, `_cockpit_chess_migration`, `_cockpit_chess_hold` and `_cockpit_chess_cluster` live in Prisma's schema next to `_prisma_migrations`. The production runner creates them (`CREATE TABLE IF NOT EXISTS`, under its lock) and owns them; they are never created locally or in CI scratch databases, and the Prisma schema does not model them. Read them freely when diagnosing; never write to them by hand (the owner hold is written by `hold-deletions`).

### Locally and in CI

`pnpm db:migrate:apply` applies `migration.sql` only and prints how many scheduled deletions it skipped. `pnpm db:reset:local` applies every `contract.sql` right after the migrations (no 7-day wait), and so do the CI scratch databases. `pnpm db:test-migrations` runs the whole flow against a disposable Postgres 18, and runs nightly.

**Raw SQL is invisible to every check.** A `$queryRaw` that names a deleted column breaks when the deletion runs; grep for the name before merging a removal.

## Getting told when data is deleted

The CI summary lists every deletion before merge, and each start logs the schedule. At the moment of deletion the runner prints a loud `[migrate] DATA DELETED:` block and sets `contract_applied_at` in `_cockpit_chess_migration`.

**Deletion notices.** The job runs every 15 minutes and sends one email per deleted change to verified admins who opted into operational alerts, when SMTP is configured and delivery succeeds. In plain words it says what was deleted and when, that this was planned (not an error), and the name of the backup taken just before. If you need the data back, the email tells you to ask whoever maintains the app (or your AI coding agent) to copy just that data back from the backup, **not** to restore the whole backup, which would also undo everything changed since. It goes through the same email settings (`SMTP_*`) as every other operational alert.

- **No email configured, or no admin opted in:** nothing is sent and nothing is marked; the job tries again every 15 minutes. The deploy log still has the `DATA DELETED` block.
- **Only the last 14 days:** deletions older than that are never emailed. Turning this on never floods you with old history, and a notice nobody could receive stops retrying after two weeks.
- **Rarely, a duplicate:** if the app stops right after sending, the same email can arrive twice. That is on purpose: a duplicate is better than a missed notice.
- **Local dev, CI, a fresh database:** the runner's table does not exist yet, so the job does nothing.
- **Want a second channel?** Alert on the log prefix `[migrate] DATA DELETED:` in your platform (Dokploy log monitoring, CloudWatch / Azure Monitor log alerts).

How it works (for agents): the `notify-data-deletions` cron job (`apps/worker/src/handlers/notify-data-deletions.ts`, one BullMQ job scheduler every 15 min, consumer concurrency 1, in the embedded or external worker) calls `listUnnotifiedDataDeletions` (`packages/db/src/data-deletion-notices.ts`). That checks `information_schema` for `_cockpit_chess_migration.contract_notified_at` in the runner's schema (`DATABASE_URL`'s `?schema=`, else `public`), then reads (does not mark) at most 20 rows with `contract_applied_at` within `DATA_DELETION_NOTICE_WINDOW_DAYS` (14) and `contract_notified_at IS NULL`, oldest first. For each it calls `sendDataDeletedAlert`, which rejects unless at least one email actually went out (no admin, every SMTP send failed, or the Redis cooldown could not be reserved or is already held all count as failure, and the cooldown reservation is released so it cannot mute the retry). Only after a successful send does `markDataDeletionNotified` run `UPDATE … SET contract_notified_at = now() WHERE name = $1 AND contract_notified_at IS NULL`. Delivery is at least once: a crash or failed mark between send and mark re-sends that notice on a later run (after the per-deletion one-hour cooldown expires). Rows older than the window are left untouched, never marked. Every notice is logged before its send. `contract_notified_at` belongs to this job; the runner never writes it.

## No in-place breaking changes

Every schema change must keep working for the release that is still running. An in-place drop, rename or type change in `migration.sql`, unreadable SQL nobody attested, or the retired `-- requires: maintenance-deploy` marker fails CI check 5, and the deploy runner refuses it on any database that already has migrations applied: the old app keeps serving and nothing is applied. **There is no override.** Split the change instead ([schema-changes-recipe.md](./schema-changes-recipe.md)):

- **Delete a field or table:** remove it from the schema and run `pnpm db:migrate`; the deletion goes into `contract.sql` and runs about 7 days later ([§ Expand and contract](#expand-and-contract)).
- **Rename:** keep the database name with `@map` / `@@map` (Recipe 3).
- **Change a type:** two PRs ([Recipe 5](./schema-changes-recipe.md#recipe-5--backfill-or-change-a-type)).
- **Change a primary key:** unsupported in place. Add a new table with the new key, write to both and backfill, switch reads, then remove the old model so `contract.sql` drops it.
- **Anything else the tooling cannot split:** stop and ask the owner.

A brand-new database (nothing applied yet) applies every migration, since no earlier release can be running against it; the runner logs `new database: applying in-place breaking migration(s) …`.

## Recovering deleted data from a dump

A deletion notice names the pre-deletion dump when one was configured. Locate that exact verified file or S3 object and retain its ETag/version. If only a field or selected rows are needed, ask the owner to restore the dump into a separate empty recovery database inside the target network, inspect it, and prepare a reviewed copy of just the required data into a new compatible field/table. Preserve ownership and foreign keys; reconcile rows written since the dump. Restoring the whole production database would undo unrelated newer changes.

Use the image’s `restore` command for the isolated recovery target: preview first, then exact target confirmation, with the app and jobs disconnected from that target. Follow [backup and restore](./backup-restore.md#restore). If a full production restore is the owner’s chosen recovery, stop writers and follow the complete replacement/verification runbook. It creates a seven-day deletion hold; ship the `--recover` migration within that window. Never reuse a retired database name or edit an applied contract.

## Holding deletions by hand

After a restore the runner cannot detect (a Dokploy Volume Backups copy, a provider snapshot, `pg_restore --data-only`, any restore on a provider not marked verified), the owner pauses scheduled deletions before the app starts: start only the database, run the image's `hold-deletions` command once, then start the app. From a shell on the server, on the database's Docker network:

```bash
docker run --rm --network <db-network> -e DATABASE_URL=… <image> hold-deletions     # 7 days
docker run --rm --network <db-network> -e DATABASE_URL=… <image> hold-deletions 30  # 1 to 90 days
docker run --rm --network <db-network> -e DATABASE_URL=… <image> hold-deletions --clear
```

On a container platform, run the same command as a one-off job with the app's database secret. It writes the `owner` row in `_cockpit_chess_hold` (a longer existing hold is kept), prints until when deletions are paused, and never prints `DATABASE_URL`. `--clear` removes only the owner hold. It is not needed after the `restore` command, Dokploy's Restore button, any `pg_restore --clean`, PITR, or a dump into another server or database: those are detected.

## A database with tables but no migration history

The runner refuses `no-history-nonempty`: the application catalog is populated without trustworthy applied migration history, so it cannot know what schema it holds. An empty or wholly rolled-back `_prisma_migrations` table does not establish freshness either. It never adopts an existing schema automatically.

The usual cause is that `DATABASE_URL` points at the wrong database (another app's, or one created by hand or by another tool). Check it first. A fresh Cockpit Chess install needs an empty database; it starts from `0_init`.

Do not adopt an untracked schema or mark `0_init` applied to bypass this refusal. Stop and ask the owner to review the target. Agents never hold production database credentials.

## Recovery runbook

Use this when a deploy stops with `failed`, `db-ahead`, or a history mismatch, and automatic recovery did not apply, or when a scheduled deletion is stuck.

1. **Inspect.** From inside the target network:
   - `prisma migrate status` — which migrations are applied, pending, or failed.
   - The `_prisma_migrations` rows (`SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM _prisma_migrations ORDER BY started_at;`) — the `logs` column holds the original error.
   - The live schema, with read-only queries (`\d table_name` in `psql`), to see how much of a non-transactional migration actually ran.
2. **Repair.** Pick one:
   - The migration did nothing (rolled back): fix the cause with a **new** corrective migration or a data fix, then mark the failed one rolled back.
   - The migration partly ran (non-transactional): finish or undo its statements by hand so the database matches either "before" or "after", then mark it accordingly.
3. **Resolve.**
   - `prisma migrate resolve --rolled-back <migration_name>` — the database is in the "before" state; the migration will run again on the next deploy.
   - `prisma migrate resolve --applied <migration_name>` — the database is in the "after" state; Prisma will skip it.
4. **Deploy again.**

**`db-ahead`** means the image is older than the database, and the rollback was refused: a newer migration is not rollback-safe, or its deletion already ran. Deploy a release that contains every applied migration (usually the latest default-branch commit). Do not delete rows from `_prisma_migrations` or `_cockpit_chess_migration` to make an old image start.

**A stuck scheduled deletion.** Read the `[migrate] scheduled deletion` lines in the latest startup log; they say why each one waits. Inspect `_cockpit_chess_migration`, `_cockpit_chess_instance` and `_cockpit_chess_hold` read-only.

- `waiting for: <role>@<host> …`: an older release is still alive, or was seen in the last 7 days. Stop or update that instance; a crashed one stops blocking 7 days after its last heartbeat.
- `held until …`: a restore or a database move was detected, or the owner set a hold. Wait, or (owner only) remove the `owner` hold with `hold-deletions --clear` ([§ Holding deletions by hand](#holding-deletions-by-hand)).
- `needs a person: …`: the deletion failed 3 times in this release, and nothing was deleted. An agent writes a fix migration for the cause (for example something new that depends on the column) and ships it; the release that adds it gets 3 fresh tries. If the cause is unclear, stop and ask the owner. Never edit a merged `contract.sql`.
- **Getting a field back** before its deletion runs: ship a `--recover` PR ([§ Getting a field back](#getting-a-field-back)). **After any restore, ship the `--recover` PR within 7 days.**

Restores, PITR and dumps into another server or database are detected automatically and hold deletions for 7 days. Dokploy's database Restore button and the `restore` command are detected automatically: scheduled deletions wait 7 days. Restart or redeploy the app afterwards. Restoring a Dokploy **Volume Backups** copy is not detected: start only the database, run the `hold-deletions` image command, then start the app.

Never edit an applied migration, and never run `prisma migrate reset`, `prisma migrate dev`, or drop the database to "start over" in any shared environment. Restoring a backup is a last resort: [backup-restore.md § Restore](./backup-restore.md#restore).

## Keeping the Dockerfiles in sync

The repo ships two production Dockerfiles: `Dockerfile` (Hono server + SSR + web SPA) and `Dockerfile.worker` (BullMQ consumer). They share the `base` / `build-base` / `builder` / `prod-deps` stage structure and the `scripts/docker-entrypoint.sh` entrypoint. Both carry the Prisma CLI, the `migrations/` folder, and `postgresql-client`: the app image migrates and restores, and the worker image needs Prisma to check migration state before it starts.

**When you change one, open the other and check whether it needs a matching change.** Common cases:

- **Bumping the Node version** in `FROM node:*` — update both (and `Dockerfile.dev`). **pnpm** is installed through `scripts/install-pnpm.mjs` from the checksum-pinned `packageManager` value. Keep Node 26.13.1 and pnpm 12.18.0 aligned with the root pins.
- **Build context** — every image builds from the repo root with the root `.dockerignore` only. It must keep excluding `.docker-volumes/` (agent-stack secrets such as `prod-auth-secret`), and `backups/`; a `<Dockerfile>.dockerignore` or a compose `context:` other than `.` would bypass it. `pnpm docker:check-copy` checks the build context and sensitive-path exclusions.
- **Adding or removing a workspace package** — update the `COPY` lists in the builder and prod-deps stages of both files (`pnpm docker:check-copy` checks the builder lists).
- **Editing `scripts/docker-entrypoint.sh`** — both images use it. Keep the `migrate` and `restore` commands, the `MIGRATE_ON_START` default, and the follower wait working for each image.
- **Adding a system package** — include it in every runtime that uses it. With the default embedded worker, anything a job handler shells out to must also be in the server image.
- **Bumping `PG_MAJOR`** — both files, together ([backup-restore.md § The PG_MAJOR rule](./backup-restore.md#the-pg_major-rule-when-you-upgrade-postgres)).
