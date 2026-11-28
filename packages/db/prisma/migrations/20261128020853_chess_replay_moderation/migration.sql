-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;


CREATE TYPE "ChessModerationReason" AS ENUM ('privacy', 'harassment', 'illegal_content', 'spam', 'other', 'no_violation');

ALTER TABLE "chess_match"
  ADD COLUMN "hiddenAt" TIMESTAMP(3),
  ADD COLUMN "moderationReason" "ChessModerationReason",
  ADD COLUMN "moderationNote" TEXT,
  ADD COLUMN "moderationVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "chess_replay_report" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "matchId" TEXT NOT NULL,
  "reporterId" TEXT,
  "dedupKey" TEXT NOT NULL,
  "reason" "ChessModerationReason" NOT NULL,
  "note" TEXT,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "chess_replay_report_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chess_replay_report_note_bound" CHECK ("note" IS NULL OR char_length("note") <= 1000),
  CONSTRAINT "chess_replay_report_reason" CHECK ("reason" <> 'no_violation'),
  CONSTRAINT "chess_replay_report_digest" CHECK ("dedupKey" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "chess_moderation_action" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "matchId" TEXT NOT NULL,
  "actorId" TEXT,
  "hidden" BOOLEAN NOT NULL,
  "reason" "ChessModerationReason" NOT NULL,
  "note" TEXT NOT NULL,
  CONSTRAINT "chess_moderation_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chess_moderation_action_note_bound" CHECK (char_length(btrim("note")) BETWEEN 1 AND 1000),
  CONSTRAINT "chess_moderation_action_hide_reason" CHECK (NOT "hidden" OR "reason" <> 'no_violation')
);

CREATE INDEX "chess_match_hiddenAt_createdAt_id_idx" ON "chess_match"("hiddenAt", "createdAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "chess_replay_report_dedupKey_key" ON "chess_replay_report"("dedupKey");
CREATE INDEX "chess_replay_report_matchId_createdAt_id_idx" ON "chess_replay_report"("matchId", "createdAt" DESC, "id" DESC);
CREATE INDEX "chess_replay_report_reporterId_id_idx" ON "chess_replay_report"("reporterId", "id");
CREATE INDEX "chess_replay_report_reviewedAt_createdAt_id_idx" ON "chess_replay_report"("reviewedAt", "createdAt" DESC, "id" DESC);
CREATE INDEX "chess_moderation_action_matchId_createdAt_id_idx" ON "chess_moderation_action"("matchId", "createdAt" DESC, "id" DESC);
CREATE INDEX "chess_moderation_action_actorId_id_idx" ON "chess_moderation_action"("actorId", "id");

ALTER TABLE "chess_replay_report" ADD CONSTRAINT "chess_replay_report_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "chess_match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chess_replay_report" ADD CONSTRAINT "chess_replay_report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chess_moderation_action" ADD CONSTRAINT "chess_moderation_action_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "chess_match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chess_moderation_action" ADD CONSTRAINT "chess_moderation_action_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
