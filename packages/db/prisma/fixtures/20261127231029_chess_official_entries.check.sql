-- No historic curated game can be retroactively enrolled by this migration.
SELECT id AS retroactive_official_entry FROM "chess_official_entry";

SELECT 'missing atomic ledger trigger' AS violation
WHERE (SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal
  AND tgname IN ('chess_official_enrollment_guard','chess_official_terminal','chess_official_delete')) <> 3;

SELECT 'mutable official flag remains after contract' AS violation
WHERE EXISTS (SELECT FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'chess_match' AND column_name = 'official');
