-- Each statement returns zero rows. The 0_init fixture archives record no termination,
-- so the ending backfill must leave them unknown (NULL) rather than invent one.
SELECT 'fixture match ending invented' AS violation
WHERE EXISTS (SELECT FROM "chess_match" WHERE id LIKE 'fx_match_%' AND "ending" IS NOT NULL);

SELECT id || ' backfilled as ' || coalesce("ending"::text, 'NULL') AS violation
FROM "chess_match"
WHERE (id = 'fx_ending_stopped' AND "ending" IS DISTINCT FROM '{"kind":"cancelled"}'::jsonb)
   OR (id = 'fx_ending_error' AND "ending" IS DISTINCT FROM '{"kind":"interrupted"}'::jsonb)
   OR (id = 'fx_ending_forfeit'
       AND "ending" IS DISTINCT FROM '{"kind":"illegal-forfeit","side":"w","illegal":3}'::jsonb);
