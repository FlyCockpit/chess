# Deployment — Dokploy on a VPS

Cockpit Chess runs as long-lived Node processes with PostgreSQL 18 and Valkey 9. Dokploy builds directly from this Git repository. Development follows `main` automatically; production is manually deployed from the same immutable `release/<full-commit-sha>` tag for every role. Keep development and production databases, cache instances, secrets and backup prefixes separate.

The two supported topologies are:

| Topology | Background jobs | Migration admission |
|---|---|---|
| `app` | Embedded in the server (`WORKER_MODE=embedded`) | Server applies before HTTP startup |
| `app-worker` | Dedicated worker (`WORKER_MODE=external` on server) | Server applies; worker waits and registers |

Omitting a worker container keeps background jobs in the server. Both topologies require PostgreSQL and Valkey. Hosted inference remains off until `CHESS_HOSTED_ENABLED=true` and the selected worker runtime has an OpenRouter key. Read [SECURITY.md](../SECURITY.md) and [the environment inventory](./environment.md) before exposing an instance.

## Generated Compose

Generate the Compose artifact and reviewable settings checklist from the selected Git ref:

```sh
pnpm dokploy:config --environment development --git-ref main --url https://dev.chess.example.com
pnpm dokploy:config --environment production --git-ref release/<full-commit-sha> --topology app-worker --url https://chess.example.com
```

Each invocation writes `docker-compose.dokploy.yml`, a gitignored deployment artifact, and prints a JSON checklist. Generate and keep the artifacts for each environment separately. The checklist is a reference for native Dokploy Applications, not an API/import payload. The command reads no credentials and makes no remote changes.

In Dokploy, create the environment's Compose deployment, connect this repository at the chosen ref, and import its generated Compose file. Supply the variables listed in the checklist's `compose` section through Dokploy's Environment settings. Secrets have no built-in defaults. Do not commit a filled environment file or enable Dockerfile `.env` creation.

The generated file includes:

- Server, PostgreSQL 18, Valkey 9 with `noeviction`, and an optional dedicated worker.
- Project-specific networks, volumes and Traefik identifiers derived from environment and host; database/cache ports are private.
- TLS routing and response compression for the validated HTTPS origin.
- Start-first updates and rollbacks with a 30-second shutdown grace period.
- A node-writable named `/backups` volume for startup snapshots and the optional daily backup service.
- An explicit backup prefix such as `cockpit-chess/production/chess.example.com/database` shared by the writer and selected monitor runtime.

The daily backup service also requires the **`backup` Compose profile** and `BACKUP_SCHEDULE=daily`. Neither is enabled by default. Choose backups before storing real data; see [Backups before real data](#backups-before-real-data).

For Dokploy-managed PostgreSQL or Valkey, use the native Application checklist with the actual internal hostnames and complete connection strings. Project/environment variables are reference stores: map each value explicitly into each Application. Never nest `${{project.*}}` references inside an environment connection string. Keep `MIGRATE_ON_START` and `WORKER_MODE` on their specific roles.

## Environment and image identity

| Setting | Where it belongs |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Server and external worker; the same environment-specific targets |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAILS` | Server only; unique strong auth secret and exact public origin |
| `SMTP_*` | Server for verification; selected worker runtime for operational alerts |
| `MIGRATE_ON_START` | Server `true`; external worker `false`; app replicas `false` when using a prior one-shot migration job |
| `WORKER_MODE` | Server: `embedded` or `external` according to topology |
| `TRUST_PROXY_HOPS` | Server; exact count of trusted reverse proxies for the client-IP rate-limit key. Generated config sets `1` (Traefik). See [Client IP and reverse proxies](#client-ip-and-reverse-proxies). |
| `BACKUP_S3_*` writer keys | Server admission and backup/restore operations |
| `BACKUP_MONITOR_S3_*` | Selected embedded or external worker runtime; ListBucket only |
| `BACKUP_ENABLED` | Monitor intent only, default `true`; never controls backup writing |
| `BACKUP_SCHEDULE`, `BACKUP_HOUR_UTC`, `BACKUP_KEEP` | Daily service: `off`/`daily`, hour 0–23 (default 3), retention 1–365 (default 14) |
| `BUILD_VERSION` | Docker build argument containing the full lowercase Git SHA |

`VITE_*` values are compiled into the web bundle; changing them requires a rebuild. Leave `VITE_SERVER_URL` unset for a same-origin deployment. `VITE_APP_NAME` defaults to Cockpit Chess. Set `CORS_ORIGIN` only for an intentional cross-origin browser deployment, using an exact origin.

The server image bakes a `BUILD_COMMIT` file beside its bundle outside the Turbo cache, using `BUILD_VERSION` or readable minimal Git metadata. This is not a runtime environment variable. A checkout/worktree without either usable source reports `commit: null`; deployment acceptance cannot establish its identity. CI should always pass the full SHA:

```sh
docker build --build-arg BUILD_VERSION="$(git rev-parse HEAD)" -t cockpit-chess-server -f Dockerfile .
docker build --build-arg BUILD_VERSION="$(git rev-parse HEAD)" -t cockpit-chess-worker -f Dockerfile.worker .
```

Both images retain Node 26.13.1, checksum-pinned pnpm 12.18.0, PostgreSQL 18 clients and the migration/backup runtime closure. Build from the repository root. No `.env` files belong in image layers.

## Client IP and reverse proxies

Anonymous rate limits (sign-in, OTP, CLI, anonymous budgets) key on the client IP. Better-Auth's stored session `ipAddress` uses its own resolution, not this setting; it is informational and never used for limits. The server never trusts `X-Forwarded-For` by itself; `TRUST_PROXY_HOPS` is the exact number of proxies you run between the client and the server, and the client is the address the outermost of them appended:

| Topology | `TRUST_PROXY_HOPS` |
| --- | --- |
| Generated Dokploy Compose or checklist (client → Traefik → server) | `1` (set by the generator) |
| Cloudflare → Traefik → server, with Traefik trusting Cloudflare (below) | `2` |
| No proxy: the server port is reached directly (LAN, bare host, local dev) | `0` (default) |

With `0` the server keys on the TCP socket peer and ignores `X-Forwarded-For`. If a proxy is in front but the value stays `0`, every client is keyed on the proxy's address and shares **one** rate-limit bucket: a single noisy client can exhaust sign-in or CLI budgets for everyone. That fails safe (nobody can pick their own bucket) but is wrong for production; set the hop count. When the value is `0` and a private-network peer sends `X-Forwarded-For` (an uncounted proxy), the server logs one `[client-ip]` warning per process.

With a value above `0`, the server must be reachable only through those proxies (the generated Compose publishes no host port); a caller that can reach the port directly could otherwise forge the trusted entries. A request whose chain is shorter than the hop count, or whose trusted entry is not an IP address, is keyed on the socket peer, never on a client-supplied entry. Set the value higher than your real proxy count and clients choose their own key again, so count exactly.

A proxy only counts if the next one keeps what it wrote. Dokploy's Traefik does not trust incoming `X-Forwarded-For` by default: behind Cloudflare it replaces the header with Cloudflare's edge address, so `2` finds a one-entry chain and every visitor shares the socket bucket, and `1` keys visitors per Cloudflare edge. Use `2` only after setting Traefik's `entryPoints.<name>.forwardedHeaders.trustedIPs` to Cloudflare's published ranges and firewalling the origin to Cloudflare; otherwise keep `1`.

The proxy network is shared: other Dokploy applications on `dokploy-network` can reach the server container directly and set their own forwarded entry. Treat co-tenants on that network as trusted, or give Traefik and this server a dedicated network.

## Migration startup and instance admission

The server defaults to `MIGRATE_ON_START=true`. Before HTTP startup, `scripts/db/migrate-runtime.mjs` inspects committed migration history, acquires the runner lock, recovers only provably transactional interrupted attempts, snapshots when configured, applies pending SQL and evaluates due scheduled deletions. A fresh empty application catalog starts from `0_init`; populated catalogs without valid migration history are refused. It never adopts an untracked schema.

The external worker uses `MIGRATE_ON_START=false` and the same image history. It waits up to **300 seconds** for admission. Wait mode reads schema/history but **writes instance registration**; it never runs scheduled deletions. A failed migration or checksum mismatch refuses startup. An older image can start against a newer database only if every missing migration is rollback-safe and no corresponding deletion has run. There is no breaking-change override.

Each server or external worker host gets one fresh `COCKPIT_CHESS_INSTANCE_ID` per start. Embedded consumers share the server identity. Heartbeats mark readiness only after the server listens and required consumers run, or the external worker's consumers run; shutdown awaits heartbeat drain before database disconnect. Operational command paths do not register serving instances; `backup-schedule` runs its own daily loop.

The runner lock (`72707370`) serializes migration runners and restores; Prisma's lock (`72707369`) protects migration execution. Do not hold an outer copy of these locks around the runner. Backup/catalog facts are rechecked before applying; one shared predeploy inspection budget covers all pre/post-backup gate reads. Cancellation must drain owned native children, and an uncertain result still requires inspection before retry.

Preserve the images' **510-second startup allowance**: admission can spend up to 300 seconds waiting, followed by bounded backup, migration, catalog and contract work. A second runner can time out while a long first migration is still working; the platform should restart that waiting container. A successful build alone does not prove admission or readiness.

Schema deletions go into `contract.sql`. They wait at least seven elapsed days after a containing release becomes ready and after the last older release was seen; holds can delay them further. Contracts run on a later startup, not on a daily timer. See [schema migrations](./schema-migrations.md) and [change recipes](./schema-changes-recipe.md). Show the destructive-SQL summary to the owner before merge.

## Operational image commands

Run these inside the target network using the same immutable app image and the intended environment's settings. The operator runs production operations; agents prepare reviewable commands.

| Image command | Purpose |
|---|---|
| `migrate` | Apply/admit committed history and exit, without starting HTTP or requiring Redis/auth configuration |
| `backup [--keep <n>]` | Verified manual dump; missing destination fails |
| `backup-schedule` | Daily service loop; requires `BACKUP_SCHEDULE=daily` |
| `restore <source> [options]` | Verify and preview; explicit confirmation required to change the target |
| `restore-drill <source> [--etag …] [--version-id …]` | Restore only into an empty disposable database named `restore_drill` |
| `hold-deletions [days\|--clear]` | Owner deletion hold, default 7 days, range 1–90; clear removes only the owner hold |

With the generated Compose configuration, an explicit migration run is:

```sh
docker compose run --rm server migrate
```

For an external platform, take the chosen provider snapshot, run `migrate` as a deploy-gated one-shot job, then roll out the same SHA with `MIGRATE_ON_START=false` on app replicas and worker. Abort rollout if the job fails. This is the same app image, not a separate schema image.

## Confirming a deploy is live

Development Git builds may complete in different orders. For production, disable automatic deployment, select the same immutable release tag for all roles, deploy the server leader first, then the optional worker. Accept the expected commit and readiness from outside the server:

```sh
pnpm deploy:check https://chess.example.com --commit <full-commit-sha>
```

The check polls `/ready` and requires two consecutive ready responses from that exact commit. Old traffic, unknown identity, draining state or missing database/cache/consumer readiness cannot pass. The default timeout is 20 minutes; `--timeout <seconds>` can accommodate slower builds. Check sign-in and representative private/public reads separately.

The optional development workflow uses repository variables `DEPLOY_CHECK_URL` and `DEPLOY_CHECK_TIMEOUT`; these are CI settings, not application env declarations. It follows `main`, so target the development origin rather than a manually pinned production release.

On the VPS, an optional deeper read-only check inspects current Swarm task generations and container health:

```sh
pnpm dokploy:verify --server <actual-server-service> --url https://chess.example.com --worker <actual-worker-service> --commit <full-commit-sha>
```

Omit `--worker` for embedded jobs. A rollback, changed service generation, failed task, missing healthcheck or readiness mismatch fails verification. Dokploy's build-success notification cannot replace these checks.

## Backups before real data

Choose provider backups/PITR with retention and failure alerts, or enable exactly one logical daily backup service with the `backup` profile and `BACKUP_SCHEDULE=daily`. Add an off-site versioned S3 destination, a distinct per-deployment prefix, lifecycle retention and separate ListBucket-only monitoring credentials. Mount `/backups` on the server and daily service. A VPS-local dump is lost with the VPS.

A truly fresh install needs no pre-migration snapshot. Existing databases without a destination warn and continue; a configured backup failure blocks migrations. A configured pre-drop failure skips deletions while allowing the app to start. Manual `backup` and populated-target restore snapshots require a destination. `BACKUP_ENABLED=false` disables only freshness monitoring; it suppresses none of these writes.

Writer keys are unset before the long-running app executes. Docker container configuration still contains startup credentials; the server helper passes them directly into one-off operations. Do not treat process unsetting as removal from container metadata.

Follow [backup and restore](./backup-restore.md) for exact retention, confirmation/pinning, host helper, drills and seven-day deletion holds. Run and record a drill before relying on a backup and after backup changes. Provider-native backups need provider recovery-point monitoring; they do not appear as canonical logical dumps in the app's bucket freshness card.

## Restore and replacement-database handoff

Freeze deployments, stop ingress and all write/job producers, and record the current Git SHA and every consumer's target. Preview the archive inside the target network. Populated targets require `--replace`, exact `RESTORE:<database>` confirmation, and a pre-restore snapshot unless the owner explicitly supplies `--skip-snapshot` after taking a provider snapshot. S3 sources require exact ETag and optional version pins. Follow [the restore runbook](./backup-restore.md#restore).

For a replacement database, change and recreate **every** consumer: server/embedded jobs, external worker, daily service or external scheduler, monitoring, provider policies and other clients. Updating a shared reference does not change existing containers. Keep old consumers stopped. Use an isolated replacement backup prefix and update the writer and monitor consistently; an old-prefix object must not establish replacement backup health.

Run the chosen compatible release's `migrate` command before followers. Resume runtimes from that same immutable ref, then require `deploy:check`, controlled sign-in and restored record checks. Take a new verified backup of the replacement, confirm its off-site object or provider recovery point, and drill it into an empty isolated target. Confirm the next scheduled backup and a fresh monitor verdict; a cached old-target card is insufficient. Keep recovery pending until these pass.

Restore writes a seven-day deletion hold atomically with restored history. Provider restore detection is best effort: a volume copy, data-only restore or unverified provider snapshot requires `hold-deletions` before restarting the app. If recovering a deleted field, ship its `--recover` migration within seven elapsed days. Keep the original database and backups until the owner approves retirement.

After the replacement accepts writes or emits job effects, switching targets back can lose data or repeat effects. Stop and reconcile before any reversal; do not keep old and replacement consumers active together.

## Uncertain outcomes

After a timeout, lost connection or cancellation, keep rollout gated. Inspect the runner/restore process, advisory locks, `_prisma_migrations`, `_cockpit_chess_migration` and the actual target catalog using read-only queries. Process exit alone does not prove a backend effect finished. Establish whether it committed or rolled back before retrying or resolving history. Never edit history rows to force admission; use [the recovery runbook](./schema-migrations.md#recovery-runbook).

## Response compression

Attach a Traefik compress middleware to the server router. The generated Compose file already sets `traefik.http.middlewares.<name>.compress` and `traefik.http.routers.<name>.middlewares` labels. Verify a full public page returns `Content-Encoding: br` or `gzip`; small responses can remain uncompressed. The Dokploy verifier reports a non-fatal warning if compression cannot be confirmed.

## Troubleshooting

- **Migration refusal:** inspect the named state and original migration logs; follow the recovery runbook. Never bypass admission or reset a shared database.
- **Worker unavailable:** confirm both roles use the intended database/cache and immutable ref, the worker wait passed, and server `WORKER_MODE=external` matches the deployed worker. With no worker, select `embedded`.
- **Backup failure:** inspect mount ownership, disk space, bucket prefix, transport settings and credential grants. Align `PG_MAJOR=18` in both Dockerfiles with the database server; an older `pg_dump` cannot dump a newer server.
- **Unknown commit:** rebuild with full-SHA `BUILD_VERSION`; missing Git metadata in a worktree context can produce `commit: null`.
- **Database connection failure:** use its internal Docker hostname in production, not `localhost`; local host wrappers deliberately require loopback and this checkout's exact database names.
