-- Existing prelaunch rows are deliberately unversioned, never backfilled with guessed provenance.
SELECT id AS invented_prompt_provenance
FROM "chess_match"
WHERE id IN ('fx_match_draft', 'fx_match_public', 'fx_rules_v1', 'fx_ending_stopped', 'fx_ending_error', 'fx_ending_forfeit') AND ("promptVersion" IS NOT NULL OR "promptHash" IS NOT NULL);

SELECT 'missing prompt filter index' AS violation
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND indexname = 'chess_match_promptVersion_createdAt_id_idx'
);
