-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;
CREATE TABLE "runner_claim" (
  "id" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL,
  "proofDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "userId" TEXT,
  "sessionId" TEXT,
  "machineId" TEXT,
  CONSTRAINT "runner_claim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "runner_claim_tokenDigest_key" ON "runner_claim"("tokenDigest");
CREATE UNIQUE INDEX "runner_claim_machineId_key" ON "runner_claim"("machineId");
CREATE INDEX "runner_claim_expiresAt_id_idx" ON "runner_claim"("expiresAt", "id");
CREATE INDEX "runner_claim_userId_machineId_expiresAt_idx" ON "runner_claim"("userId", "machineId", "expiresAt");
CREATE INDEX "runner_claim_sessionId_idx" ON "runner_claim"("sessionId");
ALTER TABLE "runner_claim" ADD CONSTRAINT "runner_claim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "runner_claim" ADD CONSTRAINT "runner_claim_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "runner_claim" ADD CONSTRAINT "runner_claim_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "runner_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
