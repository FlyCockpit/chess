-- Each statement returns zero rows: the backfill copies each archive's ruleset version
-- and leaves archives without one NULL.
SELECT id || ' backfilled as ' || coalesce("rulesVersion", 'NULL') AS violation
FROM "chess_match"
WHERE (id = 'fx_rules_v1' AND "rulesVersion" IS DISTINCT FROM 'cockpit-v1')
   OR (id = 'fx_rules_v2' AND "rulesVersion" IS DISTINCT FROM 'cockpit-v2')
   OR (id = 'fx_rules_v3' AND "rulesVersion" IS DISTINCT FROM 'cockpit-v3')
   OR (id IN ('fx_match_draft', 'fx_match_public') AND "rulesVersion" IS NOT NULL);
