# Backup and Restore

> Daily backups, the backup taken right before migrations, restoring, and the restore drill. Mechanics of migrations: [schema-migrations.md](./schema-migrations.md).

**Choose and verify backups before storing real data.** Enable exactly one daily logical-backup schedule, or choose provider backups/PITR with retention and alerts. The app also snapshots before nonfresh migrations when a destination is configured. Restore and restore drills run inside the target network; agents prepare commands and the owner runs them.

## Daily backups

### Dokploy with the generated compose (the default) — recommended

The generated compose (`pnpm dokploy:config`, [deployment.md](./deployment.md#generated-compose)) ships a small `backup` service. It is **off** until you turn it on:

1. In Dokploy, enable the Compose **`backup` profile**, set `BACKUP_SCHEDULE=daily` in **Environment**, and deploy. Both are required. With plain Compose, use `docker compose --profile backup up -d backup` with the same schedule setting. Keep exactly one active daily scheduler for each database; do not combine this service with a second host cron or provider-managed logical schedule for the same purpose.
2. Optional but strongly recommended: also set `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` (and `BACKUP_S3_REGION` / `BACKUP_S3_ENDPOINT` for S3-compatible storage) so every backup also leaves the server. A backup that lives only on the server is lost with the server. Use a key that can read and write but not delete ([§ Bucket retention](#bucket-retention-versioning-and-incomplete-uploads)).
3. Run a [restore drill](#restore-drill) once it has taken its first backup.

What it does: a few minutes after it starts (when the last backup is missing or a day old) and then every day at `BACKUP_HOUR_UTC` (default 3, in UTC) it writes a verified `pg_dump` archive named `daily-<time>.dump` into the server's `backups` volume, keeps the newest dump from each of the newest `BACKUP_KEEP` UTC days that have dumps (default 14), and uploads each one when `BACKUP_S3_*` is set. It waits while a deploy is migrating the database and skips a database whose migration failed (that needs a person first). A failed backup is retried every hour; if only the upload failed, the retry uploads the same file again instead of taking another, so a broken bucket cannot fill the disk. A backup counts as done only once it is uploaded (when S3 is set). The service's Docker healthcheck turns **unhealthy** when the last backup failed or is more than 26 hours old, which Dokploy shows on the service. It is the same archive format as the pre-migration backup, so `restore` and the drill read it directly. Restoring one is detected automatically (scheduled deletions wait 7 days).

### Dokploy-managed Postgres

If Postgres is a Dokploy database instead of part of the compose, use Dokploy's built-in backups: database → **Backups** tab → add an S3 destination, a daily schedule, and a retention of at least 14 days ([deployment.md](./deployment.md#backups-before-real-data)). Dokploy writes gzip-wrapped `pg_dump` files; `restore` reads them directly, and Dokploy's database Restore button is detected automatically.

Avoid Dokploy's **Volume Backups** for the database: restoring such a copy is not detected. If you ever do, start only the database, run `bash app-db.sh hold-deletions` ([§ The server helper](#the-server-helper-app-dbsh)) or the image's `hold-deletions` command, then start the app ([schema-migrations.md § Holding deletions by hand](./schema-migrations.md#holding-deletions-by-hand)).

Record the chosen backup system, bucket prefix, retention, alerts and owner in your deployment records.

### Container platforms

Use the managed database's automated backups and point-in-time recovery (Azure Database for PostgreSQL, Amazon RDS). Set the retention window and an alert on backup failure in the provider console or the infra repo. See [deployment.md](./deployment.md).

## Pre-migration backup (optional, encouraged)

A genuinely empty fresh installation needs no backup, even with multiple pending migrations. The runner proves application-catalog emptiness; an empty history table alone is insufficient. When an existing database has migrations to apply, the migration runner first calls `scripts/backup/pre-migrate.sh`. This is the safety net for "the migration did something we didn't want".

- **Not configured** → a warning is logged and migrations run. Nothing fails.
- **Configured and it fails** → the migration does **not** run and the deploy stops. Fix the backup (disk full, bad S3 key) and redeploy.

**Dokploy:** mount a named volume at `/backups` on the app (`pnpm dokploy:config` emits one). When `/backups` is a real mounted volume and is writable, the app writes a `pg_dump` custom-format archive there before migrating. No object-store credentials are needed for a local volume destination. The bare image-created `/backups` directory is not a persistent destination. To also upload it off the server, set the optional `BACKUP_S3_*` variables (`BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION`, and if needed `BACKUP_S3_ENDPOINT`, `BACKUP_S3_PREFIX`, `BACKUP_S3_FORCE_PATH_STYLE`, `BACKUP_S3_SSE`). Use a key that can write but not delete. The app keeps the newest 5 pre-migration dumps in `/backups` and deletes older ones, plus any hidden `.pre-migrate-*.dump.partial` left by a dump that was killed more than 120 minutes ago; it never deletes anything in S3. The backup runs while the migration runner holds its lock, so a second migrating container waits for it; the 300-second wait must cover backup plus migration time, or that container exits and restarts (expected, see [schema-migrations.md § What happens at deploy](./schema-migrations.md#what-happens-at-deploy)).

**Container platforms:** the infra workflow takes a provider snapshot before the `migrate` job (RDS manual snapshot; Azure on-demand backup where the service supports it). The image's `/backups` hook is normally left unconfigured there.

`pnpm doctor` recommends configuring a destination. It is strongly encouraged before any migration that drops or rewrites data.

**Pre-drop backup.** The same hook also runs right before a scheduled deletion (`contract.sql`, [schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract)), labelled `pre-drop`, when a deletion is due and that run took no pre-migration backup. The runner passes `--keep 5` explicitly for `pre-drop`. Direct invocations with another label default to `--keep 0` (no local pruning). Not configured → a warning, and the deletion runs. Configured and it fails → no deletion runs that start (the app starts normally). The `[migrate] DATA DELETED:` log line names the backup it took.

## Storage identity and retention

Use an explicit prefix for each deployment, for example `cockpit-chess/production/chess.example.com/database`. The generator includes the environment and validated host. Objects live directly at `<BACKUP_S3_PREFIX>/<label>-<timestamp>.dump`; no database hash or fallback namespace is added. Two deployments sharing a bucket need different prefixes. A local-only volume does not protect against loss of the VPS.

The writer/restore identity needs `GetObject`, `GetObjectVersion`, `PutObject` and `AbortMultipartUpload` on that prefix, without object deletion. Use separate `BACKUP_MONITOR_S3_ACCESS_KEY_ID` / `BACKUP_MONITOR_S3_SECRET_ACCESS_KEY` credentials with **ListBucket only**, constrained to `<prefix>/`. Never copy writer credentials into the monitor identity. The running application has writer keys unset after admission; Docker container configuration still holds the startup credentials used by `host.sh` to launch operations.

| Operation | Default local retention |
|---|---|
| Pre-migration | Newest 5 `pre-migrate` dumps |
| Runner pre-drop | Newest 5 `pre-drop` dumps, passed explicitly |
| Direct other labels, manual and pre-restore | `--keep 0`: no pruning; choose explicit retention where needed |
| Daily scheduler | Newest dump per UTC day for the newest `BACKUP_KEEP` days containing dumps; default 14, range 1–365 |

S3 expiration is controlled by bucket lifecycle rules, never local pruning. A successful dump logs `[backup] Verified <path>`; when S3 is configured, also require upload success and record the object key, ETag and version ID. A warning-only no-destination exit is not evidence of a backup. `--required` makes a missing destination fail; image command `backup` already uses it.

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

Always preview first: run it **without** `--confirm`, read the preview, then run it with `--confirm` (or use `--guided`, which shows the preview and then asks). If anything fails, the whole restore rolls back and the target is left as it was. Afterwards, deploy an image that contains every migration the restored database has applied (the same or a newer commit).

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

It finds the app's containers, image, network and backups volume by itself (`--project <name>` picks one when the server runs several apps), and hands the database settings from the running app straight to a one-off container of the same image, so no secrets are written to a file. `<backup>` is a file name from `list`, or an `s3://<bucket>/<key>` object when `BACKUP_S3_*` is set.

#### Restoring

```bash
bash app-db.sh restore                       # the newest backup
bash app-db.sh restore daily-20261110T030000Z.dump
```

1. It asks before it stops the app (and worker and backup service). Postgres and Redis keep running. If Auto Deploy is on in Dokploy, don't merge anything until it finishes.
2. It shows the preview: which backup, how old, which database, whether that database is empty. Then it asks you to confirm. When the database holds data (the usual case), you must **type the database name** shown in the preview; anything else, or just Enter, cancels. Restoring into an empty database asks **[y/N]** instead. It then fills in `--confirm RESTORE:<database>` (and `--replace`, which snapshots the current data first) for you.
3. Its cleanup attempts to restart the app even when the restore fails; inspect the outcome before retrying or reopening traffic. The app applies any migrations newer than the backup as it starts. Check it with `pnpm deploy:check <url> --commit <sha>` ([deployment.md § Confirming a deploy is live](./deployment.md#confirming-a-deploy-is-live)) or by opening the site.

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

It starts a throwaway Postgres container next to the app (same image as the app's database, on its own private network), restores the backup into it with the app's own `restore` command, then checks that every table in the backup came back and that the migration history is complete. It prints each table's row count and the backup's age (a warning when the newest backup is over a day old), then **DRILL PASSED** or **DRILL FAILED**, and removes the throwaway database. Production is never touched: the drill only restores into an empty database named `restore_drill`, and it accepts no option but `--etag` / `--version-id` (for `s3://` backups).

Record the date, exact backup key/version, checked records and result in the deployment recovery log.

On a container platform, run the image's `restore-drill <source>` command as a one-shot job with `DATABASE_URL` pointing at a new, empty database named `restore_drill` (never production), then delete that database.

## Monitoring backups

`BACKUP_ENABLED` defaults to `true` and controls **freshness monitoring only**. Setting it to `false` never disables manual, pre-migration, pre-drop, restore-snapshot or scheduled writing. `BACKUP_SCHEDULE` controls the daily writer independently and defaults to `off`.

The worker checks off-site freshness every six hours using the dedicated ListBucket identity and `BACKUP_MAX_AGE_HOURS` (default 36). It considers complete `daily`, `manual`, `pre-migrate` and `pre-drop` dump objects under the explicit prefix; partials, `pre-restore` safety snapshots and unrelated objects do not count. Monitor misconfiguration means off-site health is unknown, not that backup writing is disabled. A local-only backup or a provider-native snapshot is not proof of a fresh object in this bucket.

- The generated compose's `backup` service reports its own freshness: its healthcheck is **unhealthy** when the last daily backup failed or is more than 26 hours old. Look at it in Dokploy, or alert on it with any Docker health monitor.
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
