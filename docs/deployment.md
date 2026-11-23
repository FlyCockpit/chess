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

Every image builds from the pinned Git context `<repository URL>#<git-ref>`: the pasted Compose has no source tree, so the Dokploy server's Docker fetches that ref itself on each deploy. Those builds keep `.git` (`BUILDKIT_CONTEXT_KEEP_GIT_DIR`), so the server image still reads its commit from `.git/HEAD` when `BUILD_VERSION` is unset and `/ready` reports it for `pnpm deploy:check`. The URL defaults to the checkout's `origin` remote; pass `--git-url <URL>` for another (https://, ssh:// or `git@host:owner/repo.git`). It must be fetchable by Docker on the Dokploy server (a public repository, or an SSH URL whose key that Docker can use) and may not carry credentials: the generator refuses a token in the URL, because the file is stored in Dokploy. `--git-url local` writes `context: .`, only for plain `docker compose` in a checkout (see below).

Each invocation writes `docker-compose.dokploy.yml`, a gitignored deployment artifact, and prints a JSON checklist. Generate and keep the artifacts for each environment separately. The checklist is a reference for native Dokploy Applications, not an API/import payload. The command reads no credentials and makes no remote changes.

In Dokploy, create the environment's Compose deployment and paste its generated Compose file. Each deploy builds the images from the Git context in the file (the checklist's `compose.buildContext`), so the pasted Compose needs no repository connection. For development auto-deploy, add the compose's deploy webhook (its **Deployments** tab) to your Git host for pushes to `main`; confirm it on your Dokploy version with one push. Production stays manual: regenerate for the new `release/<full-commit-sha>` tag, paste the file and click **Deploy**. Supply the variables listed in the checklist's `compose` section through Dokploy's Environment settings. Secrets have no built-in defaults. Do not commit a filled environment file or enable Dockerfile `.env` creation.

The generated file includes:

- Server, PostgreSQL 18, Valkey 9 with `noeviction`, and an optional dedicated worker.
- The backup service (with `--backups true`) is created only after the server has started: both mount the fresh `backups` volume, and creating them concurrently races Docker's copy of the image's `/backups` into it.
- Project-specific networks, volumes and Traefik identifiers derived from environment and host; database/cache ports are private.
- TLS routing and response compression for the validated HTTPS origin.
- Start-first updates and rollbacks with a 30-second shutdown grace period.
- No backup storage or sidecar by default. Generate with `--backups true` to include a node-writable `/backups` volume and optional daily service.
- An explicit backup prefix such as `cockpit-chess/production/chess.example.com/database` shared by the writer and selected monitor runtime.

A minimal deployment needs only `POSTGRES_PASSWORD`, `REDIS_PASSWORD` and `BETTER_AUTH_SECRET`; the generated origin and role settings are already filled. Set `ADMIN_EMAILS` to bootstrap the first admin. SMTP is needed for email flows. No backup settings are required: migrations and health checks work with backups off, and startup logs one notice explaining how to enable them.

Backups are optional. Generate with `--backups true`, then enable the **`backup` Compose profile** and `BACKUP_SCHEDULE=daily` for one daily service. Set `BACKUP_ENABLED=true` for migration snapshots and off-site freshness monitoring; see [Backups before real data](#backups-before-real-data).

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
| `BACKUP_ENABLED` | Server (its migration snapshots) and the selected monitor runtime. Backup switch, strict `true`/`false`, default `false`: `true` takes the pre-migration and pre-drop dumps (a migrating start fails without a destination) and turns on freshness monitoring; explicit backup commands and the daily service work either way |
| `BACKUP_MAX_AGE_HOURS` | Server and the selected monitor runtime, the same value (default 36): the monitor records stale beyond it, and the server re-ages that recorded verdict with its own copy for the admin card |
| `BACKUP_SCHEDULE`, `BACKUP_HOUR_UTC`, `BACKUP_KEEP` | Daily service: `off`/`daily`, hour 0–23 (default 3), retention 1–365 (default 14) |
| `BUILD_VERSION` | Docker build argument containing the full lowercase Git SHA |

`VITE_*` values are compiled into the web bundle; changing them requires a rebuild. Leave `VITE_SERVER_URL` unset for a same-origin deployment. `VITE_APP_NAME` defaults to Cockpit Chess. Set `CORS_ORIGIN` only for an intentional cross-origin browser deployment, using an exact origin.

The server and worker images bake a `BUILD_COMMIT` file beside their bundles outside the Turbo cache, using `BUILD_VERSION` or readable minimal Git metadata. This is not a runtime environment variable; the server reports it on `/ready`, and `pnpm dokploy:verify` reads it from each container. A checkout/worktree without either usable source reports `commit: null`; deployment acceptance cannot establish its identity. CI should always pass the full SHA:

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
| Cloudflare Tunnel: `cloudflared` → server ([home server](#home-server-behind-a-cloudflare-tunnel)) | `1` |
| Cloudflare Tunnel: `cloudflared` → Traefik → server, with Traefik trusting `cloudflared` | `2` |
| No proxy: the server port is reached directly (LAN, bare host, local dev) | `0` (default) |

With `0` the server keys on the TCP socket peer and ignores `X-Forwarded-For`. If a proxy is in front but the value stays `0`, every client is keyed on the proxy's address and shares **one** rate-limit bucket: a single noisy client can exhaust sign-in or CLI budgets for everyone. That fails safe (nobody can pick their own bucket) but is wrong for production; set the hop count. When the value is `0` and a private-network peer sends `X-Forwarded-For` (an uncounted proxy), the server logs one `[client-ip]` warning per process.

With a value above `0`, the server must be reachable only through those proxies (the generated Compose publishes no host port); a caller that can reach the port directly could otherwise forge the trusted entries. A proxy that appends the client's port (`1.2.3.4:5678` or `[2001:db8::1]:5678`, Azure Application Gateway's default) needs no change: the server strips the port from the selected entry before validating it. A request whose chain is shorter than the hop count, or whose trusted entry is still not an IP address, is keyed on the socket peer, never on a client-supplied entry. Set the value higher than your real proxy count and clients choose their own key again, so count exactly.

A proxy only counts if the next one keeps what it wrote. Dokploy's Traefik does not trust incoming `X-Forwarded-For` by default: behind Cloudflare it replaces the header with Cloudflare's edge address, so `2` finds a one-entry chain and every visitor shares the socket bucket, and `1` keys visitors per Cloudflare edge. Use `2` only after setting Traefik's `entryPoints.<name>.forwardedHeaders.trustedIPs` to Cloudflare's published ranges and firewalling the origin to Cloudflare; otherwise keep `1`.

The proxy network is shared: other Dokploy applications on `dokploy-network` can reach the server container directly and set their own forwarded entry. Treat co-tenants on that network as trusted, or give Traefik and this server a dedicated network.

## Migration startup and instance admission

The server defaults to `MIGRATE_ON_START=true`. Before HTTP startup, `scripts/db/migrate-runtime.mjs` inspects committed migration history, acquires the runner lock, recovers only provably transactional interrupted attempts, snapshots when `BACKUP_ENABLED=true` and configured, applies pending SQL and evaluates due scheduled deletions. A fresh empty application catalog starts from `0_init`; populated catalogs without valid migration history are refused. It never adopts an untracked schema.

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

For plain `docker compose` from a clean checkout (no Dokploy), generate with `--git-url local` so the images build that checkout (`context: .`), and set `BUILD_VERSION="$(git rev-parse HEAD)"`. That SHA is right only for a local context: with a Git context the build fetches the ref from the repository, so leave `BUILD_VERSION` unset and the image reads the commit it actually built from its kept `.git`.

For an external platform, optionally take a provider snapshot, run `migrate` as a deploy-gated one-shot job, then roll out the same SHA with `MIGRATE_ON_START=false` on app replicas and worker. Abort rollout if the job fails. This is the same app image, not a separate schema image.

## Confirming a deploy is live

Development Git builds may complete in different orders. For production, disable automatic deployment, select the same immutable release tag for all roles, deploy the server leader first, then the optional worker. Accept the expected commit and readiness from outside the server:

```sh
pnpm deploy:check https://chess.example.com --commit <full-commit-sha>
```

The check polls `/ready` and requires two consecutive ready responses from that exact commit. Old traffic, unknown identity, draining state or missing database/cache/consumer readiness cannot pass. The default timeout is 20 minutes; `--timeout <seconds>` can accommodate slower builds. Check sign-in and representative private/public reads separately.

The optional development workflow uses repository variables `DEPLOY_CHECK_URL` and `DEPLOY_CHECK_TIMEOUT`; these are CI settings, not application env declarations. It follows `main`, so target the development origin rather than a manually pinned production release.

On the VPS, from a checkout, an optional deeper read-only check waits (up to `--timeout-seconds`, default 600) until the server (and worker) containers are healthy, every runtime container (a live `backup` service included) was built from the expected commit (the `BUILD_COMMIT` file each image bakes), and `/ready` passes and reports the same commit, so an earlier release a failed redeploy left running never passes. `--commit` is required. Choose the mode that matches how you deployed.

For the generated Compose, pass its Compose project and the topology it was generated with (`app` by default):

```sh
pnpm dokploy:verify --mode compose --project <compose project> --topology app-worker --url https://chess.example.com --commit <full-commit-sha>
```

Dokploy's Compose project name is the compose's app name (shown in its settings); for plain `docker compose` it is the file's `name:`. `docker ps --filter label=com.docker.compose.service=server --format '{{.Label "com.docker.compose.project"}}'` lists the candidates. The check requires exactly one `server` container, and in `app-worker` exactly one `worker` (`docker compose run` one-offs such as `run --rm server migrate` do not count). It fails on a missing or second one, an unhealthy, exited or restarting one, one replaced or restarted while it watches, or one built from another commit. In `app` a live `worker` container fails (it would consume the server's queues a second time); pass `--topology app-worker` if the deployment has one. A live `backup` service must also run the expected commit and must not restart; its own health reports backup freshness rather than startup, so an unhealthy backup service is a warning. Stopped `backup` or leftover `worker` containers are ignored.

For native Dokploy Applications (Swarm services), name each role's actual service; omit `--worker` for embedded jobs:

```sh
pnpm dokploy:verify --mode applications --server <actual-server-service> --worker <actual-worker-service> --url https://chess.example.com --commit <full-commit-sha>
```

It inspects the current Swarm task generation of each service. A rollback, changed service generation, failed task, missing healthcheck, selected container built from another commit, or readiness mismatch fails verification.

Both modes read only container labels and state, Swarm service and task state, and the commit file; never environment or logs. Dokploy's build-success notification cannot replace these checks.

## Backups before real data

Backups are opt-in. To enable them, choose provider backups/PITR with retention and failure alerts, or regenerate with `--backups true` and enable exactly one logical daily service with the `backup` profile and `BACKUP_SCHEDULE=daily`. Add an off-site versioned S3 destination, a distinct per-deployment prefix, lifecycle retention and separate ListBucket-only monitoring credentials. Mount `/backups` on the server and daily service. A VPS-local dump is lost with the VPS.

With `BACKUP_ENABLED` unset or `false`, automatic migration/pre-drop snapshots and freshness monitoring are skipped, even if storage settings remain. Migrations and readiness proceed normally. With `BACKUP_ENABLED=true` the runner requires both dumps, on a brand-new database too (no exemption): no usable destination fails a migrating start (`MIGRATE_ON_START=true` or the `migrate` job) before it migrates, a failed pre-migration dump blocks migrations, and a pre-drop dump that fails later (the destination checked at startup but the dump itself failing) skips deletions while allowing startup. Explicit manual `backup` and populated-target restore snapshots still require a destination. The daily writer is independently opt-in through `BACKUP_SCHEDULE=daily`.

Writer keys are unset before the long-running app executes: the entrypoint is PID 1 while the runner (its child) holds them, then drops them and execs `tini` with the app, so `/proc/1/environ` and the app's environment are clean. Docker container configuration still contains startup credentials; the server helper passes them directly into one-off operations. Do not treat process unsetting as removal from container metadata.

Follow [backup and restore](./backup-restore.md) for exact retention, confirmation/pinning, host helper, drills and seven-day deletion holds. Run and record a drill before relying on a backup and after backup changes. Provider-native backups need provider recovery-point monitoring; they do not appear as canonical logical dumps in the app's bucket freshness card.

## Restore and replacement-database handoff

Freeze deployments, stop ingress and all write/job producers, and record the current Git SHA and every consumer's target. Preview the archive inside the target network. Populated targets require `--replace`, exact `RESTORE:<database>` confirmation, and a pre-restore snapshot unless the owner explicitly supplies `--skip-snapshot` after taking a provider snapshot. S3 sources require exact ETag and optional version pins. Follow [the restore runbook](./backup-restore.md#restore).

If restore was invoked and its outcome is ambiguous (timeout, interruption, transport failure or a nonzero exit other than `3` or `4`), leave writers stopped for inspection: such an exit does not prove the database unchanged. Exit `3` is restore's own "refused or cancelled before anything changed" status and exit `4` its "started, failed and provably rolled back; the target is unchanged" status ([backup-restore.md § Restore](./backup-restore.md#restore)): nothing was restored, so the host helper starts the original writers again, as it does after a completed restore (exit `0`).

For a replacement database, change and recreate **every** consumer: server/embedded jobs, external worker, daily service or external scheduler, monitoring, provider policies and other clients. Updating a shared reference does not change existing containers. Keep old consumers stopped. Use an isolated replacement backup prefix and update the writer and monitor consistently; an old-prefix object must not establish replacement backup health.

Run the chosen compatible release's `migrate` command before followers. Resume runtimes from that same immutable ref, then require `deploy:check`, controlled sign-in and restored record checks. Take a new verified backup of the replacement, confirm its off-site object or provider recovery point, and drill it into an empty isolated target. Confirm the next scheduled backup and a fresh monitor verdict; a cached old-target card is insufficient. Keep recovery pending until these pass.

Restore writes a seven-day deletion hold atomically with restored history. Provider restore detection is best effort: a volume copy, data-only restore or unverified provider snapshot requires `hold-deletions` before restarting the app. If recovering a deleted field, ship its `--recover` migration within seven elapsed days. Keep the original database and backups until the owner approves retirement.

After the replacement accepts writes or emits job effects, switching targets back can lose data or repeat effects. Stop and reconcile before any reversal; do not keep old and replacement consumers active together.

## Uncertain outcomes

After a timeout, lost connection or cancellation, keep rollout gated. Inspect the runner/restore process, advisory locks, `_prisma_migrations`, `_cockpit_chess_migration` and the actual target catalog using read-only queries. Process exit alone does not prove a backend effect finished. Establish whether it committed or rolled back before retrying or resolving history. Never edit history rows to force admission; use [the recovery runbook](./schema-migrations.md#recovery-runbook).

## Response compression

Attach a Traefik compress middleware to the server router. The generated Compose file already sets `traefik.http.middlewares.<name>.compress` and `traefik.http.routers.<name>.middlewares` labels. Verify a full public page returns `Content-Encoding: br` or `gzip`; small responses can remain uncompressed. The Dokploy verifier reports a non-fatal warning if compression cannot be confirmed.

## Home server behind a Cloudflare Tunnel

A machine at home with no public IP can serve the app through a named Cloudflare Tunnel (Free or Pro plan). `cloudflared` runs next to the app and dials out to Cloudflare; nothing listens on the internet and no router port is forwarded. The app runs unchanged behind it: it speaks plain HTTP, the web client polls running matches every 2 seconds rather than holding a socket, and nothing uses WebSockets or Server-Sent Events.

Topology, recommended first:

1. **Visitor → Cloudflare edge → `cloudflared` → server.** `cloudflared` is a service in the same Compose project and reaches the server at `http://server:3000` on the project network. Traefik is not in the path. `TRUST_PROXY_HOPS=1`, which the generated config already sets.
2. **Visitor → Cloudflare edge → `cloudflared` → Traefik → server**, when Dokploy's Traefik on the same machine also routes other applications. `TRUST_PROXY_HOPS=2`, and only after Traefik trusts `cloudflared`'s address for forwarded headers (`entryPoints.<name>.forwardedHeaders.trustedIPs`): otherwise Traefik replaces the chain with `cloudflared`'s address, the chain is too short, and every visitor shares one bucket. Keep `1` until that is set. The generated router listens only on `websecure` and names the `letsencrypt` resolver; Dokploy's resolver uses the HTTP challenge, which needs Let's Encrypt to reach Traefik's `web` entrypoint, and the ingress below routes no such path. Point `cloudflared` at Traefik over HTTPS with `originRequest.originServerName: chess.example.com`, and give Traefik a certificate `cloudflared` can verify: a DNS-01 resolver (no inbound ports needed) or a private CA passed to `cloudflared` as `originRequest.caPool`. Skipping verification on that private hop (`noTLSVerify: true`) is a last resort. Topology 1 avoids all of this.

A locally managed tunnel's `config.yml` for topology 1 (create the tunnel and its DNS route with `cloudflared tunnel create` and `cloudflared tunnel route dns`; a dashboard-managed tunnel takes the same hostname → service rule in its Public Hostname settings and runs with `TUNNEL_TOKEN`):

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: chess.example.com
    service: http://server:3000
  - service: http_status:404
```

Run `cloudflared` (a pinned `cloudflare/cloudflared` image, `tunnel --no-autoupdate run`) as an extra service on the Compose project's `default` network with that file and the credentials JSON mounted read-only. Validate the rules with `cloudflared tunnel ingress validate`. Without Dokploy on the machine, plain `docker compose` (generate with `--git-url local`, see [Operational image commands](#operational-image-commands)) also needs the external network the generated file names to exist once: `docker network create dokploy-network`.

**Only the tunnel reaches the server.** The generated Compose publishes no host port for the server, PostgreSQL or Valkey; keep it that way. If `cloudflared` runs on the host instead of in Compose, publish the server on a free loopback port, for example `127.0.0.1:13000:3000` (the host side must not be `3000`, which Dokploy's own panel uses), and set `service: http://127.0.0.1:13000`. Do this only on Docker Engine 28.0 or later: older engines let other hosts on the same LAN reach ports published to `127.0.0.1`. A bare `3000:3000` listens on every interface (Docker's published ports bypass host firewalls such as `ufw`), and with `TRUST_PROXY_HOPS` above `0` a LAN caller could then send its own `X-Forwarded-For` and choose its rate-limit key. The co-tenant caveat under [Client IP and reverse proxies](#client-ip-and-reverse-proxies) applies to anything else on the server's networks.

**Client IP.** The Cloudflare edge appends the visitor's address to any `X-Forwarded-For` the visitor sent, and `cloudflared` forwards the header unchanged, so it counts as one hop. The server ignores `CF-Connecting-IP`: it is trustworthy only while the tunnel is the sole way in, gives the same address as `TRUST_PROXY_HOPS=1` when it is, and a second header-trust mode would let a misconfigured origin accept a forged value. Left at `0`, every visitor is keyed on `cloudflared`'s address (one shared bucket) and the server logs one `[client-ip]` warning.

**Environment.** Generate the Compose with the tunnel hostname, `pnpm dokploy:config … --url https://chess.example.com`; that sets `BETTER_AUTH_URL`, the only origin Better-Auth trusts for a same-origin deployment. Leave `CORS_ORIGIN` and `VITE_SERVER_URL` unset; if you set the optional `PUBLIC_APP_URL`, use the same `https://` origin. Home ISPs commonly block outbound port 25, so send email through an authenticated relay on `SMTP_PORT=587` (the generated default) or `465`. The rest of this guide is unchanged: `pnpm deploy:check https://chess.example.com` reads `/ready` through the tunnel. Dokploy's own panel and its deploy webhook are not reachable from your Git host without their own route; deploy manually or expose the panel behind Cloudflare Access.

**Cloudflare limits and what they touch here.**

| Limit | This app |
| --- | --- |
| Request bodies over 100 MB (Free/Pro) are refused with `413` at the edge | No valid request comes near it: the server refuses bodies over 10 MiB (`apps/server/src/index.ts`) and match archives over 2,000,000 bytes (`MAX_ARCHIVE_BYTES` in `packages/chess/src/index.ts`). An oversized body gets a `413`; an oversized archive gets a `400` or `413`, depending on which check catches it. The limit is on uploads only; CLI downloads are redirects to the release host in any case. |
| `524` when the origin sends no response for about 100 s (Cloudflare currently documents 125 s; only Enterprise can raise it) | Hosted matches run as background jobs whose state the browser polls, and the CLI's device sign-in polls every few seconds. The slowest synchronous requests send email (verification, password reset and 2FA codes, admin invitations, the transport check before a code is sent); the mailer bounds connection setup to 10 s and socket idle to 20 s, starts a retry only within 25 s, and abandons a send after 60 s and the transport check after 20 s (`packages/mailer/src/index.ts`), so SMTP waits end well before Cloudflare's timeout; each caller decides how a failed send is reported (an invitation returns `emailSent: false`, the one-time-code endpoint relies on the transport check). |
| WebSockets drop when Cloudflare restarts an edge or `cloudflared` reconnects | Not used. A polling request that fails during a tunnel reconnect is retried by the query's own retry and refetch schedule (a running match's details poll every 2 seconds, the match lists every few seconds). |

**What does not apply.** The generated Traefik labels' TLS and ACME settings (`websecure`, `tls.certresolver=letsencrypt`) are not in the path in topology 1: Cloudflare terminates the visitor's TLS with its edge certificate, and with this ingress Dokploy's HTTP challenge cannot reach Traefik anyway. Traefik's compress middleware is out of the path in topology 1; Cloudflare compresses text responses at the edge. Cloudflare's ranges and `trustedIPs` for Cloudflare itself are not needed: the server's peer is `cloudflared`, never the edge.

## Troubleshooting

- **Migration refusal:** inspect the named state and original migration logs; follow the recovery runbook. Never bypass admission or reset a shared database.
- **Worker unavailable:** confirm both roles use the intended database/cache and immutable ref, the worker wait passed, and server `WORKER_MODE=external` matches the deployed worker. With no worker, select `embedded`.
- **Backup failure:** inspect mount ownership, disk space, bucket prefix, transport settings and credential grants. Align `PG_MAJOR=18` in both Dockerfiles with the database server; an older `pg_dump` cannot dump a newer server.
- **Unknown commit:** rebuild with full-SHA `BUILD_VERSION`; missing Git metadata in a worktree context can produce `commit: null`.
- **Database connection failure:** use its internal Docker hostname in production, not `localhost`; local host wrappers deliberately require loopback and this checkout's exact database names.
