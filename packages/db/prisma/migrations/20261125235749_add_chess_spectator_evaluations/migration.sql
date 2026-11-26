-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;

-- AlterTable
ALTER TABLE "chess_match" ADD COLUMN     "spectatorEvaluations" JSONB;

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
