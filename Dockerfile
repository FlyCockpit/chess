FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base

# Runtime base:
#   - openssl: required by Prisma query engine
#   - postgresql-client-${PG_MAJOR}: provides psql, used
#     by the migration runner, and pg_dump/pg_restore for backups.
# The client comes from the upstream PostgreSQL apt repository (PGDG), pinned to
# PG_MAJOR, not from Debian's default repo whose `postgresql-client` major can be
# older than your Postgres server. PG_MAJOR must match your Postgres server's
# major version (and the same ARG in Dockerfile.worker). The COPY checker fails
# on drift. A newer client can dump/connect to an older server; the reverse is not supported, so
# bump PG_MAJOR when you upgrade the database. The PGDG repo is enabled by the
# script bundled with Debian's own postgresql-common (it carries the signing key,
# so no curl/gnupg is needed) and the codename comes from /etc/os-release.
# `apt-get upgrade` pulls the latest Debian security patches for packages
# already in node:26-slim (glibc, libcap2, systemd libs, etc.) — the base image
# lags the Debian point release, so Trivy fails on fixable HIGH CVEs without it.
# APT_CACHE_DATE exists only to break the buildx layer cache: CI passes the
# current UTC date so this layer is rebuilt (and re-upgraded) at most daily —
# a warm cache would otherwise freeze the upgrade at whenever the layer was
# first built and Trivy would fail on patches Debian shipped since. Local
# builds keep the constant default and stay fully cached. Keep this block in
# both runtime Dockerfiles (AGENTS.md § keep in sync).
ARG APT_CACHE_DATE=static
ARG PG_MAJOR=18
RUN echo "apt-cache-date: ${APT_CACHE_DATE}" \
  && apt-get update -y && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
  && . /etc/os-release \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y "${VERSION_CODENAME:-}" \
  && apt-get install -y \
  bash \
  openssl \
  postgresql-client-${PG_MAJOR} \
  tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/private/ssl-cert-snakeoil.pem

# --- Build-time base ---
# Adds git + pnpm. Not inherited by the final runtime image.
FROM base AS build-base

RUN apt-get update -y && apt-get install -y \
  git \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Node 25+ no longer bundles corepack. Install the pnpm pinned in package.json
# `packageManager`, verified against its SHA-512 (scripts/install-pnpm.mjs).
COPY package.json scripts/install-pnpm.mjs /tmp/pnpm-bootstrap/
RUN node /tmp/pnpm-bootstrap/install-pnpm.mjs /tmp/pnpm-bootstrap/package.json && rm -rf /tmp/pnpm-bootstrap

# --- Builder stage ---
# pnpm install runs here with source files present so workspace symlinks resolve correctly
FROM build-base AS builder

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/chess/package.json packages/chess/
COPY packages/api/package.json packages/api/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/i18n-translate/package.json packages/i18n-translate/
COPY packages/locales/package.json packages/locales/
COPY packages/mailer/package.json packages/mailer/
COPY packages/queue/package.json packages/queue/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/

# Prisma schema + config must be present before install (postinstall runs prisma generate)
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma

# Strip the root `postinstall` (which only runs `lefthook install`, a dev-only
# git hook installer that errors without a real repo). The real package.json is
# restored by the subsequent `COPY . .`, so this only affects the install step.
RUN node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# Resolve the build targets and root tooling against the frozen lockfile.
RUN pnpm install --frozen-lockfile --filter=server... --filter=web... --include-workspace-root

COPY . .

# Keep the restored root package.json from reintroducing the dev-only lefthook
# installer in later Docker build steps after the full source tree is copied.
RUN node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# Remove any stale .js files next to .tsx route files (breaks TanStack Router)
RUN find apps/web/src/routes -name '*.js' -delete 2>/dev/null || true

# Build-time client env. Vite inlines VITE_* into the SPA bundle during the
# build below — they are NOT read at runtime, so they must be present here.
# Platforms that forward env vars into the Docker build inject them as build
# args with matching keys. Both are
# optional; an empty value falls back to the app default (VITE_APP_NAME -> "App",
# VITE_SERVER_URL -> window.location.origin). Changing either requires a REBUILD,
# not just a restart.
# Worker note: Dockerfile.worker does NOT build the web SPA, so it needs no
# matching ARG block — this is the one build-arg surface that legitimately
# differs between the two Dockerfiles.
ARG VITE_APP_NAME=""
ARG VITE_SERVER_URL=""
ENV VITE_APP_NAME=$VITE_APP_NAME \
    VITE_SERVER_URL=$VITE_SERVER_URL

# Deterministic build version. The web build (vite.config.ts → getBuildVersion())
# prefers process.env.BUILD_VERSION over `git rev-parse`. The context includes
# minimal git metadata; without a known commit the web build uses a random UUID
# per build (a fresh "version" on every rebuild of the SAME commit). Pass a
# stable value (the git SHA) so identical content keeps the same version across
# rebuilds. Empty = falls back to the random UUID. Pass it as a build arg
# (wired to the commit SHA) to make it stable.
# Worker note: Dockerfile.worker does NOT build the web SPA, so it needs no
# matching ARG — same as the VITE_* block above.
ARG BUILD_VERSION=""
ENV BUILD_VERSION=$BUILD_VERSION

# --- Turborepo Remote Cache (turbo.json) ---
# Shipped present-but-inert: with both empty (the default on a fresh clone),
# turbo reports NotLinked and the build runs normally with local cache only —
# no error, no behavior change ("just skips"). Set TURBO_TOKEN + TURBO_TEAM
# (BOTH required; a token alone is ignored) to make `turbo build` replay cached
# app outputs from Vercel's free remote cache ("just works"). Platforms that
# forward env vars into the Docker build as build args
# populate these automatically; everywhere else pass them explicitly, e.g.
# `docker build --build-arg TURBO_TOKEN=… --build-arg TURBO_TEAM=…`. Self-host
# instead? add a matching `ARG TURBO_API=""` here and point it at your cache
# (see the pattern doc). Builder stage ONLY — the final runner stage is
# FROM base and never inherits these ENVs, so the token never ships in the
# image. Keep this block in BOTH Dockerfiles (AGENTS.md § keep in sync).
ARG TURBO_TOKEN=""
ARG TURBO_TEAM=""
ENV TURBO_TOKEN=$TURBO_TOKEN \
    TURBO_TEAM=$TURBO_TEAM

# Give the Vite/rolldown + turbo build heap headroom. Builder stage ONLY — the
# runner stage is FROM base and sets its own (much lower) runtime default below.
# Keep this line identical in BOTH Dockerfiles (AGENTS.md § keep in sync).
ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN pnpm turbo build --filter=server --filter=web

# Outside Turbo cache: the running server reports this exact image identity.
RUN node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT

# Verify build outputs exist
RUN test -f apps/server/dist/index.mjs && test -d apps/web/dist/client && test -d apps/web/dist/server

# --- Production deps stage ---
FROM build-base AS prod-deps

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/chess/package.json packages/chess/
COPY packages/api/package.json packages/api/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/i18n-translate/package.json packages/i18n-translate/
COPY packages/locales/package.json packages/locales/
COPY packages/mailer/package.json packages/mailer/
COPY packages/queue/package.json packages/queue/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/

# Prisma schema + config needed for postinstall
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma

# Install prod deps for BOTH the server and the web app. The server bundle
# imports the built web SSR handler (apps/web/dist/server), which leaves `react`
# external — so web's runtime deps must be present in the image for SSR to load.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter=server... --filter=web... --include-workspace-root

# Strip the TypeScript compiler from the prod tree. It lands here only because
# pnpm materializes it as a resolved (optional, types-only) peer of runtime deps
# like @prisma/client, i18next, and @t3-oss/env-core — nothing imports it at
# runtime. The Prisma CLI's sole reference is a try/catch version probe that
# falls back to "unknown" (the CLI and config smoke checks below work without it).
# TS 7 ships a platform-native Go binary whose embedded stdlib Trivy flags for
# fixable CVEs we cannot patch via pnpm — removing it eliminates that class and
# shrinks the image. Keep this block in BOTH Dockerfiles (AGENTS.md § keep in sync).
RUN rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@typescript+typescript-* node_modules/typescript

# --- Runner stage ---
# Both images ship the migration runner and canonical backup/restore commands.
# The server applies by default; external workers wait for migration admission.
# No .env files are COPYed into the image — production env values are injected
# at runtime by the orchestrator (e.g. Dokploy).
FROM base AS runner

ENV NODE_ENV=production
# Default Node heap cap so the server behaves predictably on small hosts.
# Deploy-time env always wins (`docker run -e NODE_OPTIONS=…` / the
# orchestrator's env panel). SSR + Prisma + request handling live on the V8
# heap, so 512 MB is the safe floor for the server. Size the container's memory
# LIMIT ~25–50% above this cap to leave room for native allocations when using
# an external worker.
#
# Do not lower this from plan arithmetic alone. The tempting argument is a
# small plan with a 512 MB TOTAL memory limit, where a 512 MB heap cap lets
# V8 grow to the whole container before collecting hard and
# native allocations then push RSS into a platform OOM-kill instead of
# V8 back-pressure. True as far as it goes — but a lower cap does not lower
# actual demand. If SSR + Prisma + request handling genuinely need more than the
# lower number under load, the trade is a guaranteed heap OOM for a possible one.
# Measure the heap high-water mark under real SSR traffic first; if it does not
# sit comfortably under the proposed cap, the answer is a larger plan.
ENV NODE_OPTIONS="--max-old-space-size=512"
WORKDIR /app

# Copy workspace config (needed for pnpm --filter at runtime)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/

# Copy production node_modules. The two Prisma-bearing trees are
# --chown=node:node: The Prisma CLI runs at runtime as USER node and
# materializes its schema engine into node_modules, so uid 1000 must own
# them. Done at COPY time (not a RUN chown) to avoid duplicating the layer.
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --chown=node:node --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
# web's node_modules: the server bundle dynamically imports apps/web/dist/server,
# whose SSR chunks resolve `react` (left external by the web build) from here.
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules

# Schema, committed migrations, config and generated client for runtime admission.
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY --from=builder /app/packages/db/prisma/generated ./packages/db/prisma/generated
# Retain the generated CLI shim alongside the direct production dependency.
COPY --chown=node:node --from=builder /app/packages/db/node_modules/.bin/prisma ./packages/db/node_modules/.bin/prisma
# Prisma is a direct production dependency of @cockpit-chess/db. Prove its CLI
# and config resolve as the runtime user without opening a database connection.
RUN su node -s /bin/sh -c 'cd packages/db && export CHECKPOINT_DISABLE=1 && \
    node node_modules/prisma/build/index.js --version && \
    node node_modules/prisma/build/index.js validate' >/dev/null

# Copy built server and web SPA
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# One-shot commands and their runtime closure (including owned Prisma children).
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/db/migrate-runtime.mjs ./scripts/db/
COPY scripts/db/lib/contracts.mjs scripts/db/lib/migration-state.mjs scripts/db/lib/prisma.mjs scripts/db/lib/sql.mjs scripts/db/lib/prisma-owner.mjs ./scripts/db/lib/
COPY scripts/lib/bounded-child.mjs ./scripts/lib/
COPY scripts/backup/pre-migrate.sh \
     scripts/backup/restore.sh \
     scripts/backup/restore.mjs \
     scripts/backup/lib.mjs \
     scripts/backup/s3.mjs \
     scripts/backup/schedule.mjs \
     scripts/backup/drill.mjs \
     scripts/backup/host.sh \
     ./scripts/backup/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  ./scripts/backup/pre-migrate.sh \
  ./scripts/backup/restore.sh

# Strip the global npm CLI from the runtime image. The server runs `node`
# directly (CMD) and the entrypoint invokes the COPY'd prisma binary by path
# (not `npx`), so npm is never used at runtime. node:slim's bundled npm
# vendors its own dependency tree (e.g. picomatch) that Trivy flags as
# fixable HIGH CVEs we cannot patch via pnpm overrides — removing npm
# eliminates that whole class, shrinks the image, and cuts attack surface.
# Build stages keep npm; this only affects the final runner image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Drop privileges. The `node` user (uid 1000) ships in node:26-slim. The
# server only reads /app at runtime; the entrypoint's writes go to /tmp
# (mktemp), to the node-owned /backups mount point, and to
# Postgres over the network, so no chown of /app is needed.
RUN mkdir -p /backups && chown node:node /backups
USER node
# Import-only runtime closure check: no credentials or database connection.
# restore.mjs is a CLI (it parses argv on import), so it is exercised via --help;
# its import-pure helpers are imported directly.
RUN node --input-type=module -e 'const {loadPg}=await import("./scripts/db/lib/prisma.mjs");loadPg();await import("./scripts/db/migrate-runtime.mjs");await import("./scripts/backup/lib.mjs");await import("./scripts/backup/s3.mjs");await import("@aws-sdk/client-s3");' \
 && node scripts/backup/restore.mjs --help >/dev/null

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]

EXPOSE 3000

# Dokploy uses the Docker healthcheck for rolling updates.
# Use Node's built-in fetch; node:slim does not ship curl or wget.
HEALTHCHECK --interval=10s --timeout=5s --start-period=510s --retries=3 \
  CMD node -e "const port=process.env.SERVER_PORT||process.env.PORT||3000;fetch('http://localhost:'+port+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the server. Migration admission runs inside the
# ENTRYPOINT before this CMD executes. See scripts/docker-entrypoint.sh.
CMD ["node", "apps/server/dist/index.mjs"]
