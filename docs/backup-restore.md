# Backup and Restore

> Daily backups, the backup taken right before migrations, restoring, and the restore drill. Mechanics of migrations: [schema-migrations.md](./schema-migrations.md).

**Backups are opt-in and default off.** New deployments need no backup settings, storage or sidecar; migrations and readiness work normally. Startup logs one notice with enablement instructions. To opt in, enable exactly one daily logical-backup schedule, or choose provider backups/PITR with retention and alerts. Set `BACKUP_ENABLED=true` for automatic snapshots before migrations and freshness monitoring. Restore and restore drills run inside the target network; agents prepare commands and the owner runs them.

Back up `BETTER_AUTH_SECRET` separately from the database and retain the keys needed for older backups. A restored database may need its original key for [password pepper rotation or recovery](./auth-and-routing.md#password-pepper).

## Daily backups

### Dokploy with the generated compose (the default) — recommended

The generated compose (`pnpm dokploy:config`, [deployment.md](./deployment.md#generated-compose)) includes no backup storage or service by default. To turn them on:

1. Regenerate with `pnpm dokploy:config` using the same deployment arguments plus `--backups true`. This adds the shared `/backups` volume and optional service. In Dokploy, enable the Compose **`backup` profile**, set `BACKUP_SCHEDULE=daily` in **Environment**, and deploy. Both are required. With plain Compose, use `docker compose --profile backup up -d backup` with the same schedule setting. Keep exactly one active daily scheduler for each database; do not combine this service with a second host cron or provider-managed logical schedule for the same purpose.
2. Optional but strongly recommended: also set `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` (and `BACKUP_S3_REGION` / `BACKUP_S3_ENDPOINT` for S3-compatible storage) so every backup also leaves the server. A backup that lives only on the server is lost with the server. Use a key that can read and write but not delete ([§ Bucket retention](#bucket-retention-versioning-and-incomplete-uploads)).
3. Run a [restore drill](#restore-drill) once it has taken its first backup.

What it does: a few minutes after it starts (when the last backup is missing or a day old) and then every day at `BACKUP_HOUR_UTC` (default 3, in UTC) it writes a verified `pg_dump` archive named `daily-<time>.dump` into the server's `backups` volume, keeps the newest dump from each of the newest `BACKUP_KEEP` UTC days that have dumps (default 14), and uploads each one when `BACKUP_S3_*` is set. It waits while a deploy is migrating the database and skips a database whose migration failed (that needs a person first). A failed backup is retried every hour; if only the upload failed, the retry uploads the same file again instead of taking another, so a broken bucket cannot fill the disk. A backup counts as done only once it is uploaded (when S3 is set). The service's Docker healthcheck (`schedule.mjs health`, every 5 minutes) turns **unhealthy** when the last backup failed, is more than 26 hours old, or none has succeeded within an hour of the service starting, and when the scheduler has recorded no valid status; Dokploy shows it on the service. With `BACKUP_SCHEDULE=off` it stays healthy. Unhealthy only reports: Compose does not restart the service for it. It is the same archive format as the pre-migration backup, so `restore` and the drill read it directly. Restoring one is detected automatically (scheduled deletions wait 7 days).

### Dokploy-managed Postgres

If Postgres is a Dokploy database instead of part of the compose, use Dokploy's built-in backups: database → **Backups** tab → add an S3 destination, a daily schedule, and a retention of at least 14 days ([deployment.md](./deployment.md#backups-before-real-data)). Dokploy writes gzip-wrapped `pg_dump` files; `restore` reads them directly, and Dokploy's database Restore button is detected automatically.

Avoid Dokploy's **Volume Backups** for the database: restoring such a copy is not detected. If you ever do, start only the database, run `bash app-db.sh hold-deletions` ([§ The server helper](#the-server-helper-app-dbsh)) or the image's `hold-deletions` command, then start the app ([schema-migrations.md § Holding deletions by hand](./schema-migrations.md#holding-deletions-by-hand)).

Record the chosen backup system, bucket prefix, retention, alerts and owner in your deployment records.

### Container platforms

Use the managed database's automated backups and point-in-time recovery (Azure Database for PostgreSQL, Amazon RDS). Set the retention window and an alert on backup failure in the provider console or the infra repo. See [deployment.md](./deployment.md).

## Pre-migration backup (optional, encouraged)

`BACKUP_ENABLED` (strict `true`/`false`, default `false`; any other value refuses to start) is the backup switch. A configured destination alone does not turn the automatic dumps on. When a database has migrations to apply and `BACKUP_ENABLED=true`, the migration runner first calls `scripts/backup/pre-migrate.sh --required`. This is the safety net for "the migration did something we didn't want".

- **`BACKUP_ENABLED` unset/`false`** → no backup hook runs and migrations run without one. The entrypoint prints one startup notice saying backups are off (and a warning when a destination is configured anyway). Nothing refuses.
- **`BACKUP_ENABLED=true`, no usable destination** (no writable mounted `/backups`, no valid `BACKUP_S3_*`) → a container that migrates (`MIGRATE_ON_START=true`, or the `migrate` job) fails at startup with `BACKUP_ENABLED=true but no backup destination is configured`, before migrating, on a brand-new database too (no exemption: the first start reports the missing destination before any data exists). A server that only waits (`MIGRATE_ON_START=false`) starts normally.
- **`BACKUP_ENABLED=true`, `BACKUP_S3_BUCKET` set, but no writer key** (`BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` missing, for example only the `BACKUP_MONITOR_S3_*` pair was given) → a migrating start fails the same way, before migrating. Add the writer key to the server or `migrate` job, or set `BACKUP_ENABLED=false` on it. `pnpm doctor:app` warns about this.
- **`BACKUP_ENABLED=true` but the image has no backup hook** (`scripts/backup/pre-migrate.sh` missing) → the migration is refused (`refusing to migrate without a backup`); a due scheduled deletion is skipped for that start instead.
- **`BACKUP_ENABLED=true` and the dump fails** → the migration does **not** run and the deploy stops. Fix the backup (disk full, bad S3 key) and redeploy, or set `BACKUP_ENABLED=false` deliberately.

The destination and writer-key checks run on every migrating start, even when no migration is pending.

Explicit operations work whatever the switch says: the `backup` command, the daily service (`BACKUP_SCHEDULE=daily`) and the pre-restore snapshot always use `--required`.

**Dokploy:** mount a named volume at `/backups` on the app (`pnpm dokploy:config --backups true` with the other deployment arguments emits one). With `BACKUP_ENABLED=true`, when `/backups` is a real mounted volume and is writable, the app writes a `pg_dump` custom-format archive there before migrating. No object-store credentials are needed for a local volume destination. The bare image-created `/backups` directory is not a persistent destination. To also upload it off the server, set the optional `BACKUP_S3_*` variables (`BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION`, and if needed `BACKUP_S3_ENDPOINT`, `BACKUP_S3_PREFIX`, `BACKUP_S3_FORCE_PATH_STYLE`, `BACKUP_S3_SSE`). Use a key that can write but not delete. The app keeps the newest 5 pre-migration dumps in `/backups` and deletes older ones, plus any hidden `.pre-migrate-*.dump.partial` left by a dump that was killed more than 120 minutes ago; it never deletes anything in S3. The backup runs while the migration runner holds its lock, so a second migrating container waits for it; the 300-second wait must cover backup plus migration time, or that container exits and restarts (expected, see [schema-migrations.md § What happens at deploy](./schema-migrations.md#what-happens-at-deploy)).

**Container platforms:** the infra workflow takes a provider snapshot before the `migrate` job (RDS manual snapshot; Azure on-demand backup where the service supports it). `BACKUP_ENABLED` is normally left `false` there; set it (with `BACKUP_S3_*`) on the `migrate` job only if that job should dump too.

`pnpm doctor:app` reports the switch and recommends turning it on with a destination. It is strongly encouraged before any migration that drops or rewrites data.

**Pre-drop backup.** With `BACKUP_ENABLED=true`, the same hook also runs right before a scheduled deletion (`contract.sql`, [schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract)), labelled `pre-drop`, when a deletion is due and that run took no pre-migration backup. The runner passes `--keep 5` explicitly for `pre-drop`. Direct invocations with another label default to `--keep 0` (no local pruning). The runner passes `--required` here too: a dump that fails → no deletion runs that start (the app starts normally) and the next start tries again. (With no destination at all, a migrating start already stops at the entrypoint's startup check; a start that only waits never runs deletions.) The `[migrate] DATA DELETED:` log line names the backup it took.

## Storage identity and retention

Use an explicit prefix for each deployment, for example `cockpit-chess/production/chess.example.com/database`. The generator includes the environment and validated host. Objects live directly at `<BACKUP_S3_PREFIX>/<label>-<timestamp>.dump`; no database hash or fallback namespace is added. Two deployments sharing a bucket need different prefixes. A local-only volume does not protect against loss of the VPS.

The writer/restore identity needs `GetObject`, `GetObjectVersion`, `PutObject` and `AbortMultipartUpload` on that prefix, without object deletion. Use separate `BACKUP_MONITOR_S3_ACCESS_KEY_ID` / `BACKUP_MONITOR_S3_SECRET_ACCESS_KEY` credentials with **ListBucket only**, constrained to `<prefix>/`. Never copy writer credentials into the monitor identity. The writer keys never reach the running application: the entrypoint runs as PID 1, keeps `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` only while the migration runner (and its dumps) runs as its child, then unsets them and `exec`s `tini` with the server or worker, so neither `/proc/1/environ` nor the app process carries them. The non-secret location settings (`BACKUP_S3_BUCKET`, region, endpoint, prefix) stay for the monitor. The `migrate` job has the same shape; the explicit `backup`, `backup-schedule`, `restore` and `restore-drill` commands keep their keys. Docker container configuration (`docker inspect`) still holds the startup credentials, which `host.sh` uses to launch operations; anyone with Docker access on the host can read them.

| Operation | Default local retention |
|---|---|
| Pre-migration | Newest 5 `pre-migrate` dumps |
| Runner pre-drop | Newest 5 `pre-drop` dumps, passed explicitly |
| Direct other labels, manual and pre-restore | `--keep 0`: no pruning; choose explicit retention where needed |
| Daily scheduler | Newest dump per UTC day for the newest `BACKUP_KEEP` days containing dumps; default 14, range 1–365 |

S3 expiration is controlled by bucket lifecycle rules, never local pruning. A successful dump logs `[backup] Verified <path>`; when S3 is configured, also require upload success and record the object key, ETag and version ID. A silent no-destination exit (without `--required`) is not evidence of a backup. `--required` makes a missing destination fail; image command `backup` already uses it.

## Restore

Restore is a command in the app image: `restore <source> [options]`. It runs **inside the target network** (a one-off container on the Dokploy server, or a one-shot job on a container platform) using that environment's `DATABASE_URL`. Agents prepare the exact command; **the owner runs it**. On Dokploy, [the server helper](#the-server-helper-app-dbsh) can guide the operation.

```text
restore <source> [--confirm RESTORE:<target-database>] [options]
restore --list                    list the backups in /backups, newest first

<source>   latest                 the newest backup in /backups (daily, manual or
                                  pre-migration; never a pre-restore snapshot)
           /backups/<file>        a file inside the container (raw pg_dump -Fc/-Ft,
                                  or gzip-wrapped such as Dokploy's .sql.gz)
           s3://<bucket>/<key>    an object in BACKUP_S3_BUCKET (needs BACKUP_S3_*)

--confirm RESTORE:<db>       required to change anything; <db> is the database named
                             in DATABASE_URL. Without it: verify the source and preview only.
--replace                    allow restoring over a non-empty database (snapshot first,
                             then drop app schemas and restore, in one transaction)
--etag <etag>                S3 only, required: the exact object ETag
--version-id <id>            S3 only: pin an object version
--allow-active-connections   proceed although other sessions are connected
--skip-snapshot              with --replace: skip the pre-restore snapshot
                             (only when a provider snapshot exists)
--guided                     after the preview, ask and fill in --confirm / --replace /
                             --etag: y/N for an empty database; replacing one that
                             holds data needs its name typed (needs docker run -it)
```

What it does for you: verifies the archive before touching anything, checks the target, refuses while other sessions are connected, snapshots the current database (to `/backups` and/or S3, so one must be configured) before replacing it, and holds the same locks as migrations (Prisma's and the migration runner's) so a deploy cannot migrate halfway through a restore; it refuses while a migration runner is working. It re-checks whether the target is empty after taking the locks and refuses if that changed. One database session takes those locks before the checks and keeps it through the snapshot and the restore transaction itself, so no migration or second restore can run at any point in between.

Always preview first: run it **without** `--confirm`, read the preview, then run it with `--confirm` (or use `--guided`, which shows the preview and then asks). A refusal or failure before the restore transaction starts (a failed check, the archive verification, the pre-restore snapshot) changes nothing and exits `3`. If anything fails after the restore transaction started but before COMMIT is sent, it rolls back and the target is left as it was (exit `4`). After COMMIT was sent, `restore` reports "rolled back" only when that is provable: psql (run with `ON_ERROR_STOP`) stopped on an SQL error before printing the confirmation that follows COMMIT (a client-side `\echo`, so nothing after COMMIT can raise an SQL error and the failing statement came at or before COMMIT); or the server's `pg_xact_status()` for the restore transaction (its id is printed right after `BEGIN`, so this needs PostgreSQL 13 or newer) says aborted. Otherwise it is uncertain (exit `1`, or `129`/`130`/`143` for a signal): inspect the target before making any unchanged claim or retrying. Callers treat `0`, `3` and `4` as definite; any other status means "inspect the target".

Exit status of `restore`:

| Exit | Meaning |
|---|---|
| `0` | Restored (also when a signal arrived after COMMIT succeeded, cutting the summary short: "Restore completed; then interrupted"). |
| `3` | Refused or cancelled **before anything changed**: a usage error, preview only, a cancelled prompt (including Ctrl-C / Ctrl-D at the prompt), a stop signal before the restore transaction started (also while scanning `/backups` for `--list` or `latest`), a failed check, an archive with large objects, a failed pre-restore snapshot, or any other error before the restore transaction starts (an S3 source the checks reject, a failed download). |
| `4` | The restore transaction started, failed and **provably rolled back**: the target is unchanged (`ROLLED BACK: …`). Only when COMMIT was never sent (including a signal or an error before it), when psql stopped on an SQL error before confirming COMMIT, or when the server reports the transaction aborted (it waits up to 15 s while the server still says "in progress"). |
| `1` | Failed with the outcome **uncertain**: COMMIT was sent and neither the session nor the server could confirm what happened (the server's status is unknown, still in progress, or could not be read). Also a restore that committed and then failed (the session confirmed COMMIT, or the server reports it committed: "is restored … but the session did not end cleanly"; or "the restore was committed, then: …"). The output says which; the helper treats every `1` as uncertain. |
| `129` / `130` / `143` | Interrupted by a signal after COMMIT was sent, before it was confirmed: **uncertain**. (A signal before COMMIT was sent is a rollback: `4`.) |

Afterwards, deploy an image that contains every migration the restored database has applied (the same or a newer commit).

### On Dokploy

#### The server helper (app-db.sh)

The app image ships a small script for the Dokploy server that needs only bash and Docker. Copy it out of the running app once (SSH into the server first):

```bash
docker exec "$(docker ps -q -f label=com.docker.compose.service=server | head -n1)" \
  cat /app/scripts/backup/host.sh > app-db.sh
```

| Command | What it does |
|---|---|
| `bash app-db.sh list` | Lists the backups in the server's `backups` volume, newest first. |
| `bash app-db.sh backup` | Takes a verified backup now (`manual-<time>.dump`). |
| `bash app-db.sh restore [<backup>]` | Guided restore. Default: the newest backup. |
| `bash app-db.sh drill [<backup>]` | [Restore drill](#restore-drill) into a throwaway database. |
| `bash app-db.sh hold-deletions [days\|--clear]` | Pauses scheduled deletions after a restore the app cannot detect. |

It finds the app's containers, image, network and backups volume by itself (`--project <name>` picks one when the server runs several apps), and hands the database settings from the running app straight to a one-off container of the same image, so no secrets are written to a file. "Same image" means the running server's image ID, never its tag: if a redeploy rebuilt an identical image and Docker dropped the old ID while the server still runs it (Docker 29's containerd image store), every helper command stops with exit `1` and `the server container's image … is no longer on this machine` before it runs or stops anything, and prints the fix: `cd <the compose's directory> && docker compose -p <project> up -d --no-build --force-recreate server` (it restarts the app; add the same `--profile` flags the deploy uses, e.g. `--profile backup`). Then re-run the helper. `<backup>` is a file name from `list`, or an `s3://<bucket>/<key>` object when `BACKUP_S3_*` is set.

#### Restoring

```bash
bash app-db.sh restore                       # the newest backup
bash app-db.sh restore daily-20261110T030000Z.dump
```

1. It asks before it stops the app (and worker and backup service). Postgres and Redis keep running. Only `y` or `yes` goes on: anything else, just Enter, Ctrl-D, or Ctrl-C while it waits (or a TERM or HUP signal then) cancels with exit `3`, and nothing is stopped or started. If Auto Deploy is on in Dokploy, don't merge anything until it finishes. `host.sh` and `pre-migrate.sh` are Linux-only (`host.sh` runs on the Dokploy server, `pre-migrate.sh` inside the Debian app image; both use GNU `find`/`mktemp`/`mountpoint`). `host.sh` needs a terminal on stdin; `bash app-db.sh restore | tee restore.log` works and still prompts.
2. It shows the preview: which backup, how old, which database, whether that database is empty. Then it asks you to confirm. When the database holds data (the usual case), you must **type the database name** shown in the preview; anything else, or just Enter, cancels. Restoring into an empty database asks **[y/N]** instead. It then fills in `--confirm RESTORE:<database>` (and `--replace`, which snapshots the current data first) for you.
3. After a completed restore (exit `0`) it starts the app again; the app applies any migrations newer than the backup as it starts. Check it with `pnpm deploy:check <url> --commit <sha>` ([deployment.md § Confirming a deploy is live](./deployment.md#confirming-a-deploy-is-live)) or by opening the site.
4. If restore exits `3` (you cancelled at the prompt or during the checks, or it refused before changing anything), the helper prints `Cancelled or refused; nothing was changed.` and **starts the original writers again**. If it exits `4` (the restore started, then failed and provably did not commit), the helper prints `Restore failed and was rolled back; the database is unchanged` and **starts the original writers again** on the unchanged data; the restore output says why it failed. Any other exit (a failure after COMMIT was sent whose outcome nobody could confirm, a restore that committed and then failed, an interruption after COMMIT was sent, or a `docker run` failure such as `125`, which Docker also returns when waiting on a started container fails) does not prove nothing changed: the helper reports `Restore failed and its outcome is uncertain, or it committed and a later step failed` (the restore output says which), **leaves the writers stopped** and prints the `docker start` command to use once you have inspected the database. It reports its outcome on stderr, so a dead `| tee` reader cannot stop it from starting the writers after a refusal or a rollback.

Exit status of `bash app-db.sh restore`:

| Exit | Meaning |
|---|---|
| `0` | Restored; the helper starts the app again. |
| `3` | Nothing changed: you declined or pressed Ctrl-C at "Stop the app and continue?", or the helper got TERM or HUP while it waited (the app was never stopped), or `restore` cancelled or refused (the helper starts the original writers again). |
| `4` | The restore started, failed and rolled back: the database is unchanged; the helper starts the app again. |
| other | The helper refused before stopping anything (`1`: no terminal, database container not running, the server's image is gone, wrong arguments; the error says which); stopping a writer failed before the restore began (that status; the helper tries to start the writers again); or the restore's outcome is uncertain, or it committed and a later step failed (the restore's status, or `docker run`'s; the restore output says which): the app **stays stopped**. |

Restarts are best effort (a failed `docker start` does not change the exit status): confirm with `docker ps`. A Ctrl-C, TERM or HUP after that prompt is not a cancel: the helper exits `130`, `143` or `129`; before the restore was invoked it first tries to start the writers again; once it was invoked, the last case of the `other` row applies. Under `| tee` the pipeline reports `tee`'s status: use `set -o pipefail` or `${PIPESTATUS[0]}` to see the helper's. Ctrl-C in the terminal also stops `tee` (its last lines, such as the cancel message, may not reach the log), so `pipefail` then reports `tee`'s `130`: read `${PIPESTATUS[0]}`, or log with `tee -i`, which ignores Ctrl-C.

A restore by `restore` is detected automatically: scheduled deletions wait 7 days. Dokploy's database Restore button is detected too. Restoring a Dokploy **Volume Backups** copy is not: start only the database, run `bash app-db.sh hold-deletions`, then start the app ([schema-migrations.md § Holding deletions by hand](./schema-migrations.md#holding-deletions-by-hand)).

Dokploy-managed Postgres (no `postgres` service in the compose): the helper does not apply; run the same `restore` image command by hand as a one-off container on `dokploy-network` with the app's `DATABASE_URL` (agents prepare it). Dokploy's own S3 backups restore via `s3://` when `BACKUP_S3_*` points at that bucket, or download the `.sql.gz` into the backups volume first.

### On a container platform

Prefer the provider's own restore (point-in-time recovery into a new server, then switch `DATABASE_URL`) for whole-database recovery. To load a logical dump, the infra workflow runs the app image as a one-shot job (Azure Container Apps job / ECS RunTask) with command `restore <source> …`, the environment's secrets, and app + worker scaled to zero. Same two runs: preview, then `--confirm`. Then deploy the current SHA as usual so the `migrate` job brings the schema forward.

If the restored database is **newer** than the image (its history has migrations the image lacks), the app starts only when every one of those is rollback-safe and none of their deletions has run; otherwise it refuses with `db-ahead` and you deploy a newer SHA. If it reports `failed`, follow [schema-migrations.md § Recovery runbook](./schema-migrations.md#recovery-runbook).

### Restores and scheduled deletions

A restore can bring back data a scheduled deletion already removed, and the matching `contract.sql` would delete it again on the next start. So every restore holds scheduled deletions for 7 days:

- the `restore` command writes the hold itself, and a point-in-time restore, any `pg_restore --clean`, and a dump restored into another server or database are detected by the runner at the next start;
- a provider snapshot restore, a Dokploy Volume Backups copy, a `pg_restore --data-only`, or any provider restore whose identity behavior has not been verified may not be detected: start only the database, run the image's `hold-deletions` command ([schema-migrations.md § Holding deletions by hand](./schema-migrations.md#holding-deletions-by-hand)), then start the app.

If you restored to get a deleted field's data back, ship the `--recover` PR within those 7 days ([schema-migrations.md § Getting a field back](./schema-migrations.md#getting-a-field-back)).

## Restore drill

Run a restore drill before relying on backups, every quarter, and after any backup change. On the Dokploy server:

```bash
bash app-db.sh drill            # the newest backup; or name one from `bash app-db.sh list`
bash app-db.sh drill s3://<bucket>/<key> --etag <etag>   # a copy in the bucket (ETag from the upload log)
```

It starts a throwaway Postgres container next to the app (same image as the app's database, on its own private network), restores the backup into it with the app's own `restore` command, then checks that every table in the backup came back and that the migration history is complete. The table list is read for every source kind: a raw archive directly, a gzip-wrapped one after unwrapping it, and an `s3://` object after downloading the same pinned object again. `latest` is resolved once, so the restore and the check read the same file. A drill that cannot read the list, or whose archive holds no table data, **FAILS**; it never reports PASSED without the comparison. It prints each table's row count and the backup's age (a warning when the newest backup is over a day old), then **DRILL PASSED** or **DRILL FAILED**, and removes the throwaway database. Production is never touched: the drill only restores into an empty database named `restore_drill`, and it accepts no option but `--etag` / `--version-id` (for `s3://` backups).

Record the date, exact backup key/version, checked records and result in the deployment recovery log.

On a container platform, run the image's `restore-drill <source>` command as a one-shot job with `DATABASE_URL` pointing at a new, empty database named `restore_drill` (never production), then delete that database.

## Monitoring backups

`BACKUP_ENABLED` (default `false`) also turns on **freshness monitoring**: with it `false` the worker removes its freshness job. It never disables the explicit writers (manual `backup`, the restore snapshot, the daily service); `BACKUP_SCHEDULE` controls the daily writer independently and defaults to `off`. With `BACKUP_ENABLED=true` but no `BACKUP_S3_BUCKET` (a `/backups`-only destination), dumps are taken but the monitor reports setup-missing.

The worker checks off-site freshness every six hours using the dedicated ListBucket identity and `BACKUP_MAX_AGE_HOURS` (default 36). It considers complete `daily`, `manual`, `pre-migrate` and `pre-drop` dump objects under the explicit prefix; partials, `pre-restore` safety snapshots and unrelated objects do not count. Monitor misconfiguration means off-site health is unknown, not that backup writing is disabled. A local-only backup or a provider-native snapshot is not proof of a fresh object in this bucket. The admin overview shows the verdict the monitor last recorded, including `misconfigured`; the server never re-checks the `BACKUP_MONITOR_S3_*` pair itself, because with a dedicated worker only the worker receives it. The server does re-age a recorded `fresh` or `stale` verdict as time passes, using its own `BACKUP_MAX_AGE_HOURS`, so the generator gives the server that non-secret limit in both topologies; set the same value for the server and the monitor. Until the first check has run, the card shows the status as unknown.

- The generated compose's `backup` service reports its own freshness: its healthcheck is **unhealthy** when the last daily backup failed, is more than 26 hours old, none has succeeded within an hour of the service starting, or the scheduler has recorded no valid status. Look at it in Dokploy, or alert on it with any Docker health monitor.
- Otherwise turn on the platform's failure notification (Dokploy notifications for backup failures; provider alerts on Azure/AWS).
- Optionally add an external alert on the bucket (for example, "no new object in 26 hours").
- Run the restore drill above on a schedule. It is the only proof that backups work.

## The PG_MAJOR rule when you upgrade Postgres

`pg_dump` can dump a database **older** than itself, never a newer one. `Dockerfile` and `Dockerfile.worker` pin the Postgres client major with `ARG PG_MAJOR`. **When you upgrade the database's major version, bump `PG_MAJOR` in both files and rebuild.** `pnpm docker:check-copy` fails if they disagree. A client older than the server makes `pg_dump` fail, which stops a configured pre-migration backup — and with it the migration — until you rebuild.

## Bucket retention, versioning, and incomplete uploads

The app only ever adds objects to the bucket; it never deletes them. That is safety, not retention. Decide these with the owner and record them with the deployment configuration:

1. **Retention window.** Long enough to cover the longest time a bad change could go unnoticed. Use the bucket's lifecycle expiration rule on the backup prefix, not a script.
2. **Enable versioning.** The writer uses conditional no-overwrite uploads. Bucket versioning provides additional recovery protection against other writers or mistakes and lets a restore pin `--version-id`. Add a noncurrent-version expiration alongside the retention window.
3. **Incomplete multipart uploads.** Add a lifecycle rule that aborts them (7 days is a good start). A killed upload can leave parts that cost money forever.
4. **Object Lock is optional and irreversible.** Do not enable it until the owner has chosen retention and legal requirements.
