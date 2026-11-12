#!/bin/sh
# Docker entrypoint — runs before the container CMD (app and worker images).
#
# Image commands:
#   migrate              run the migration runner once and exit with its status
#                        (container platforms: a one-shot job before rollout).
#   restore <args...>    exec scripts/backup/restore.sh (one-shot restore job).
#   backup [--keep <n>]  take a verified pg_dump now (label `manual`).
#   backup-schedule      the optional daily-backup service (scripts/backup/schedule.mjs).
#   restore-drill <src>  restore into a throwaway empty database and verify it.
#   hold-deletions [days|--clear]
#                        pause scheduled deletions for `days` (default 7,
#                        1..90) with the owner hold, or remove it (one-shot;
#                        after a restore the runner cannot detect).
#   anything else        the normal CMD (server or worker), after:
#     1. required env validation;
#     2. migrations — MIGRATE_ON_START=true (default for the server command):
#        `node scripts/db/migrate-runtime.mjs apply` (classify the DB, admit or
#        refuse db-ahead, refuse failed / no-history / in-place breaking
#        changes on a served database, optional pre-migration backup,
#        the committed migration deploy, then the scheduled deletions phase).
#        Concurrent leaders (Dokploy app + worker both migrating) serialize on
#        the runner's advisory lock; the second normally finds nothing to do.
#        MIGRATE_ON_START=false (default for every other command, e.g. the
#        worker): `migrate-runtime.mjs wait` — schema-read-only wait (fixed 300 s) for
#        the database to be up to date; it also writes instance registration.
#        Both register this process in the instance registry under a fresh
#        COCKPIT_CHESS_INSTANCE_ID (exported here, so the CMD's heartbeat,
#        @cockpit-chess/db/instance-heartbeat, keeps the same row alive). The
#        one-shot commands (`migrate`, `restore`, `hold-deletions`, `backup*`,
#        `restore-drill`) get no id and register nothing;
#     3. exec the CMD.
#
# See docs/schema-migrations.md and docs/deployment.md.

set -e

# One-shot jobs never inherit a running application instance registration.
unset COCKPIT_CHESS_INSTANCE_ID

# --- One-shot image commands ---
case "${1:-}" in
  migrate)
    if [ -z "$DATABASE_URL" ]; then
      echo "FATAL: Missing required environment variable(s): DATABASE_URL" >&2
      exit 1
    fi
    exec node /app/scripts/db/migrate-runtime.mjs apply
    ;;
  restore)
    shift
    exec bash /app/scripts/backup/restore.sh "$@"
    ;;
  hold-deletions)
    shift
    if [ -z "$DATABASE_URL" ]; then
      echo "FATAL: Missing required environment variable(s): DATABASE_URL" >&2
      exit 1
    fi
    exec node /app/scripts/db/migrate-runtime.mjs hold "$@"
    ;;
  backup)
    # Back up now: the same pg_dump archive as the pre-migration backup.
    shift
    exec bash /app/scripts/backup/pre-migrate.sh --label manual --required "$@"
    ;;
  backup-schedule)
    # The optional daily-backup service (BACKUP_SCHEDULE=daily; idles when off).
    exec node /app/scripts/backup/schedule.mjs run
    ;;
  restore-drill)
    # Restore into a THROWAWAY empty database and check it (host.sh drill).
    shift
    exec node /app/scripts/backup/drill.mjs "$@"
    ;;
esac

# --- 1. Required env vars ---
missing=""
required_vars="DATABASE_URL REDIS_URL"
is_server=false
case " $* " in
  *" apps/server/dist/index.mjs"*|*" apps/server/"*|*"/apps/server/dist/index.mjs"*)
    required_vars="$required_vars BETTER_AUTH_SECRET"
    is_server=true
    ;;
esac

for var in $required_vars; do
  eval val=\$$var
  if [ -z "$val" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "FATAL: Missing required environment variable(s):$missing" >&2
  echo "       Set them in your orchestrator (e.g. Dokploy)." >&2
  # Deliberate: this check reads the process environment only. The Node bundle
  # CAN read a repo-root .env (see @cockpit-chess/env/load-dotenv), so a mounted
  # /app/.env would satisfy the app but not this gate — and that asymmetry is
  # confusing enough to name here. The container contract is injected env: the
  # image ships no .env, and this check plus the migration runner both depend
  # on the values being in the environment.
  echo "       A mounted /app/.env does not satisfy this check — the container" >&2
  echo "       contract is injected environment variables, not an env file." >&2
  exit 1
fi

# Server only: the worker never reads ADMIN_EMAILS or SIGNUP_ENABLED.
if [ "$is_server" = true ] && [ "$NODE_ENV" = "production" ] && [ -z "$ADMIN_EMAILS" ]; then
  if [ "$SIGNUP_ENABLED" = "true" ]; then
    echo "WARNING: ADMIN_EMAILS is empty. No users will be granted admin privileges." >&2
    echo "         Set ADMIN_EMAILS to a comma-separated list of email addresses." >&2
  else
    # Matches the Node env-layer boot guard in packages/env/src/server.ts:
    # signup disabled + empty allowlist means no NEW admin can be bootstrapped.
    # The server keeps booting (provisioned installs hold their admins in the
    # database) — this is the best-effort early signal for the fresh-install
    # case. If no admin exists yet, set ADMIN_EMAILS before the first signup.
    echo "WARNING: ADMIN_EMAILS is empty and SIGNUP_ENABLED is not \"true\" —" >&2
    echo "         no new admin can be bootstrapped. If no admin exists yet," >&2
    echo "         set ADMIN_EMAILS to a comma-separated list of operator emails." >&2
  fi
fi

# --- 2. Migrations ---
if [ "$is_server" = true ]; then
  MIGRATE_ON_START="${MIGRATE_ON_START:-true}"
  role=server
else
  MIGRATE_ON_START="${MIGRATE_ON_START:-false}"
  role=worker
fi
# One id per container start, never reused: scheduled deletions wait for every
# registered instance of an older release (scripts/db/lib/contracts.mjs).
COCKPIT_CHESS_INSTANCE_ID="$(node -p 'require("node:crypto").randomUUID()')"
export COCKPIT_CHESS_INSTANCE_ID
# Keep PID 1 alive while the runner drains its owned native children. Forward
# shutdown to admission and wait for it before the container exits.
stop_admission() {
  trap '' TERM INT HUP
  kill -TERM "$admission_pid" 2>/dev/null || :
  wait "$admission_pid" || :
  exit 143
}
case "$MIGRATE_ON_START" in
  true) mode=apply ;;
  false) mode=wait ;;
  *)
    echo "FATAL: MIGRATE_ON_START must be true or false (got \"$MIGRATE_ON_START\")." >&2
    exit 1
    ;;
esac
node /app/scripts/db/migrate-runtime.mjs "$mode" --role "$role" &
admission_pid=$!
trap stop_admission TERM INT HUP
if wait "$admission_pid"; then
  admission_status=0
else
  admission_status=$?
fi
trap - TERM INT HUP
[ "$admission_status" -eq 0 ] || exit "$admission_status"

# Writer credentials are startup-only. The running app uses the separate
# ListBucket-only monitor credentials; explicit backup/restore commands keep theirs.
unset BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

# --- 3. Hand off to the container CMD ---
exec "$@"
