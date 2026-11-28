-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;
ALTER TABLE "chess_match"
  ADD COLUMN "runnerMachineId" TEXT,
  ADD COLUMN "runnerGeneration" INTEGER,
  ADD COLUMN "runnerState" TEXT,
  ADD COLUMN "runnerRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "runnerAcceptedSeq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "runnerLastContactAt" TIMESTAMP(3),
  ADD COLUMN "runnerResumeDeadline" TIMESTAMP(3);

ALTER TABLE "chess_match" ADD CONSTRAINT "chess_match_runnerMachineId_fkey"
  FOREIGN KEY ("runnerMachineId") REFERENCES "runner_machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "chess_match_runnerMachineId_runnerState_id_idx" ON "chess_match"("runnerMachineId", "runnerState", "id");
CREATE INDEX "chess_match_source_status_createdAt_idx" ON "chess_match"("source", "status", "createdAt");
CREATE INDEX "chess_match_source_runnerResumeDeadline_id_idx" ON "chess_match"("source", "runnerResumeDeadline", "id");

CREATE TABLE "runner_command" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "ackedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "runner_command_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "runner_command_matchId_revision_key" ON "runner_command"("matchId", "revision");
CREATE INDEX "runner_command_matchId_ackedAt_cancelledAt_expiresAt_idx" ON "runner_command"("matchId", "ackedAt", "cancelledAt", "expiresAt");
CREATE INDEX "runner_command_expiresAt_id_idx" ON "runner_command"("expiresAt", "id");
ALTER TABLE "runner_command" ADD CONSTRAINT "runner_command_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "chess_match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "runner_event" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runner_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "runner_event_createdAt_id_idx" ON "runner_event"("createdAt", "id");
CREATE INDEX "runner_event_matchId_idx" ON "runner_event"("matchId");
ALTER TABLE "runner_event" ADD CONSTRAINT "runner_event_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "chess_match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Runner source fences validate the local archive and local billing partition.
ALTER TABLE "chess_match" ADD CONSTRAINT "chess_match_runner_partition" CHECK (
  ("source" = 'runner' AND "runnerState" IS NOT NULL AND "runnerState" IN ('offered', 'accepted', 'starting', 'running', 'stopped', 'rejected', 'abandoned', 'completed', 'error')
    AND "credentialSource" = 'runner-local' AND ("archive"->>'source') IS NOT DISTINCT FROM 'local')
  OR ("source" <> 'runner' AND "runnerState" IS NULL AND "runnerMachineId" IS NULL AND "runnerGeneration" IS NULL)
);
ALTER TABLE "chess_match" ADD CONSTRAINT "chess_match_runner_sequence" CHECK (
  "runnerRevision" >= 0 AND "runnerAcceptedSeq" >= 0 AND ("runnerGeneration" IS NULL OR "runnerGeneration" > 0)
);
ALTER TABLE "runner_command" ADD CONSTRAINT "runner_command_bounds" CHECK (
  "kind" IN ('offer', 'start', 'stop', 'resume', 'human-move') AND "revision" > 0 AND octet_length("payload"::text) <= 65536
  AND "expiresAt" > "createdAt"
);
ALTER TABLE "runner_event" ADD CONSTRAINT "runner_event_digest" CHECK ("payloadDigest" ~ '^[0-9a-f]{64}$');

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
