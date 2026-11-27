-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;

-- Additive durable turn contract; idle leaves existing automatic runners unchanged.
ALTER TABLE "chess_match"
ADD COLUMN "turnType" TEXT NOT NULL DEFAULT 'idle',
ADD COLUMN "turnId" TEXT,
ADD COLUMN "turnSide" TEXT,
ADD COLUMN "turnExpectedSeq" INTEGER,
ADD COLUMN "turnStartedAt" TIMESTAMP(3),
ADD COLUMN "turnDeadline" TIMESTAMP(3),
ADD COLUMN "pendingMove" JSONB;

-- A human think interval never owns a worker claim. An accepted input is a single
-- bounded object, not a queue. SQL NULL (not JSON null) means no pending move.
ALTER TABLE "chess_match" ADD CONSTRAINT "chess_match_turn_state_check" CHECK (COALESCE(
  CASE WHEN "turnType" = 'idle' THEN
    "turnId" IS NULL AND "turnSide" IS NULL AND "turnExpectedSeq" IS NULL
    AND "turnStartedAt" IS NULL AND "turnDeadline" IS NULL AND "pendingMove" IS NULL
  ELSE
    "status" = 'running' AND "turnType" IN ('model', 'human', 'human-move')
    AND "turnId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "turnSide" IN ('w', 'b') AND "turnExpectedSeq" >= 0
    AND "turnStartedAt" IS NOT NULL AND "turnDeadline" IS NOT NULL
    AND "turnDeadline" > "turnStartedAt"
    AND "turnDeadline" <= "turnStartedAt" + INTERVAL '300 seconds'
    AND CASE WHEN "turnType" = 'model' THEN "runToken" IS NOT NULL AND length("runToken") > 0
      ELSE "runToken" IS NULL END
    AND CASE WHEN "turnType" = 'human-move' THEN
      jsonb_typeof("pendingMove") = 'object'
      AND octet_length("pendingMove"::text) <= 160
      AND "pendingMove" - 'move' - 'receivedAt' = '{}'::jsonb
      AND jsonb_typeof("pendingMove"->'move') = 'string'
      AND "pendingMove"->>'move' ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'
      AND jsonb_typeof("pendingMove"->'receivedAt') = 'string'
      AND "pendingMove"->>'receivedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      AND ("pendingMove"->>'receivedAt')::timestamptz >= "turnStartedAt" AT TIME ZONE 'UTC'
      AND ("pendingMove"->>'receivedAt')::timestamptz < "turnDeadline" AT TIME ZONE 'UTC'
    ELSE "pendingMove" IS NULL END
  END, false
));

-- Bounded deadline repair uses keyset (turnType, turnDeadline, id).
CREATE INDEX "chess_match_turnType_turnDeadline_id_idx"
ON "chess_match"("turnType", "turnDeadline", "id");

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
