-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;

-- AlterTable
ALTER TABLE "chess_match" ADD COLUMN     "ending" JSONB;

-- Backfill: the short ending of every match that has one, normalized the way
-- chess.get / chess.inspect read it (the row status is authoritative): a stopped row
-- is cancelled, an error row over a still-running snapshot was interrupted, otherwise
-- the archive's own termination. `side` is the side to move at the end (the mated,
-- forfeiting or resigning side), which for a decisive result is the loser. A forfeit
-- ends after exactly maxAttempts rejections. The draw kind needs the board, so it stays
-- unknown here (cards say "Draw"); new terminal writes carry it.
UPDATE "chess_match" AS m
SET "ending" = jsonb_strip_nulls(jsonb_build_object(
  'kind', n.kind,
  'side', CASE
    WHEN n.kind IN ('checkmate', 'illegal-forfeit', 'timeout', 'token-budget', 'cost-budget', 'resignation')
      THEN CASE n."archive"->>'result' WHEN '1-0' THEN 'b' WHEN '0-1' THEN 'w' END
  END,
  'illegal', CASE
    WHEN n.kind = 'illegal-forfeit'
      THEN (n."archive"->'config'->'rules'->>'maxAttempts')::int
  END
))
FROM (
  SELECT "id", "archive",
    CASE
      WHEN "status" = 'stopped' THEN 'cancelled'
      WHEN "status" = 'error' AND "archive"->>'status' = 'running' THEN 'interrupted'
      ELSE "archive"->>'termination'
    END AS kind
  FROM "chess_match"
  WHERE "ending" IS NULL
) AS n
WHERE m."id" = n."id"
  AND n.kind IN ('checkmate', 'draw', 'illegal-forfeit', 'timeout', 'token-budget', 'cost-budget', 'resignation', 'ply-limit', 'cancelled', 'interrupted', 'provider-error', 'engine-error', 'event-limit');

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
