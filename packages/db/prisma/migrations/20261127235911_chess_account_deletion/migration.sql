-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;
ALTER TABLE "session" ADD COLUMN "authenticatedAt" TIMESTAMP(3);

ALTER TABLE "user"
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "deletionState" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "deletionCursor" TEXT,
  ADD COLUMN "deletionAttempts" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "user_deletionState_id_idx" ON "user"("deletionState", "id");
ALTER TABLE "user" ADD CONSTRAINT "user_deletion_lifecycle_check" CHECK (
  ("deletionState" = 'active' AND "deletionRequestedAt" IS NULL AND "deletionCursor" IS NULL AND "deletionAttempts" = 0)
  OR ("deletionState" IN ('pending', 'cleaning') AND "deletionRequestedAt" IS NOT NULL AND "deletionAttempts" >= 0)
);

ALTER TABLE "chess_match" DROP CONSTRAINT "chess_match_ownerId_fkey";
ALTER TABLE "chess_match" ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "chess_match" ADD COLUMN "publicId" TEXT DEFAULT gen_random_uuid()::text;
UPDATE "chess_match" SET "publicId" = gen_random_uuid()::text WHERE "publicId" IS NULL;
ALTER TABLE "chess_match" ALTER COLUMN "publicId" SET NOT NULL;
CREATE UNIQUE INDEX "chess_match_publicId_key" ON "chess_match"("publicId");
CREATE INDEX "chess_match_published_createdAt_publicId_idx" ON "chess_match"("published", "createdAt" DESC, "publicId" DESC);
ALTER TABLE "chess_match" ADD CONSTRAINT "chess_match_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
