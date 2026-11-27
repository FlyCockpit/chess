-- Each statement returns zero rows; pinned to 0_init's ten application tables.
SELECT 'missing fixture table rows' AS violation
WHERE (SELECT count(*) FROM "user" WHERE id LIKE 'fx_user_%') <> 5
   OR (SELECT count(*) FROM "session" WHERE id LIKE 'fx_session_%') <> 2
   OR (SELECT count(*) FROM "account" WHERE id LIKE 'fx_account_%') <> 3
   OR (SELECT count(*) FROM "verification" WHERE id LIKE 'fx_verification_%') <> 3
   OR (SELECT count(*) FROM "two_factor" WHERE id LIKE 'fx_two_factor_%') <> 2
   OR (SELECT count(*) FROM "app_setting" WHERE key LIKE 'fx.%') <> 3
   OR (SELECT count(*) FROM "device_code" WHERE id LIKE 'fx_device_%') <> 2
   OR (SELECT count(*) FROM "apikey" WHERE id LIKE 'fx_apikey_%') <> 2
   OR (SELECT count(*) FROM "chess_match" WHERE id LIKE 'fx_match_%') <> 2
   OR (SELECT count(*) FROM "openrouter_connection" WHERE id LIKE 'fx_connection_%') <> 1;

SELECT 'broken fixture ownership' AS violation
WHERE EXISTS (SELECT FROM "session" s LEFT JOIN "user" u ON u.id = s."userId" WHERE u.id IS NULL)
   OR EXISTS (SELECT FROM "account" a LEFT JOIN "user" u ON u.id = a."userId" WHERE u.id IS NULL)
   OR EXISTS (SELECT FROM "two_factor" t LEFT JOIN "user" u ON u.id = t."userId" WHERE u.id IS NULL)
   OR EXISTS (SELECT FROM "device_code" d LEFT JOIN "user" u ON u.id = d."userId" WHERE d."userId" IS NOT NULL AND u.id IS NULL)
   OR EXISTS (SELECT FROM "apikey" a LEFT JOIN "user" u ON u.id = a."referenceId" WHERE u.id IS NULL)
   OR EXISTS (SELECT FROM "chess_match" c LEFT JOIN "user" u ON u.id = c."ownerId" WHERE u.id IS NULL);

SELECT 'changed fixture boundaries' AS violation
WHERE NOT EXISTS (SELECT FROM "user" WHERE id='fx_user_unicode' AND name='Zoë Ångström 😀')
   OR NOT EXISTS (SELECT FROM "verification" WHERE id='fx_verification_boundary' AND "expiresAt"="createdAt" AND value='')
   OR NOT EXISTS (SELECT FROM "chess_match" WHERE id='fx_match_draft' AND NOT published AND "runToken" IS NULL AND "heartbeatAt" IS NULL AND result IS NULL AND "whiteCostMicros" IS NULL AND archive->'moves'='[]'::jsonb)
   OR NOT EXISTS (SELECT FROM "chess_match" WHERE id='fx_match_public' AND published AND "whiteCostMicros"=0 AND "blackCostMicros"=9223372036854775807 AND "blackIllegal"=2147483647 AND archive->'nested'->>'text'='quotes and Unicode Å');

SELECT required.name AS missing_index FROM (VALUES
  ('user_email_key'), ('user_role_idx'), ('user_email_idx'), ('user_name_idx'),
  ('session_token_key'), ('session_userId_idx'), ('session_expiresAt_idx'),
  ('account_issuer_accountId_key'), ('account_userId_idx'),
  ('verification_identifier_idx'), ('verification_expiresAt_idx'), ('two_factor_userId_key'),
  ('device_code_deviceCode_key'), ('device_code_userCode_key'), ('device_code_userId_idx'), ('device_code_expiresAt_idx'),
  ('apikey_key_idx'), ('apikey_configId_idx'), ('apikey_referenceId_idx'), ('apikey_expiresAt_idx'),
  ('chess_match_slug_key'), ('chess_match_published_createdAt_id_idx'), ('chess_match_ownerId_createdAt_idx'), ('chess_match_status_heartbeatAt_idx')
) required(name)
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_indexes i WHERE i.schemaname='public' AND i.indexname=required.name);

-- Each statement returns zero rows. The 0_init fixture archives record no termination,
-- so unknown endings stay NULL.
SELECT 'fixture match ending invented' AS violation
WHERE EXISTS (SELECT FROM "chess_match" WHERE id LIKE 'fx_match_%' AND "ending" IS NOT NULL);

SELECT id || ' stored as ' || coalesce("ending"::text, 'NULL') AS violation
FROM "chess_match"
WHERE (id = 'fx_ending_stopped' AND "ending" IS DISTINCT FROM '{"kind":"cancelled"}'::jsonb)
   OR (id = 'fx_ending_error' AND "ending" IS DISTINCT FROM '{"kind":"interrupted"}'::jsonb)
   OR (id = 'fx_ending_forfeit'
       AND "ending" IS DISTINCT FROM '{"kind":"illegal-forfeit","side":"w","illegal":3}'::jsonb);

-- Omitting credentialSource must retain the operator default.
SELECT id || ' has credentialSource ' || "credentialSource" AS violation
FROM "chess_match"
WHERE "credentialSource" IS DISTINCT FROM 'operator';

-- Stored ruleset versions match their archives; unknown versions remain NULL.
SELECT id || ' stored as ' || coalesce("rulesVersion", 'NULL') AS violation
FROM "chess_match"
WHERE (id = 'fx_rules_v1' AND "rulesVersion" IS DISTINCT FROM 'cockpit-v1')
   OR (id = 'fx_rules_v2' AND "rulesVersion" IS DISTINCT FROM 'cockpit-v2')
   OR (id = 'fx_rules_v3' AND "rulesVersion" IS DISTINCT FROM 'cockpit-v3')
   OR (id IN ('fx_match_draft', 'fx_match_public') AND "rulesVersion" IS NOT NULL);

SELECT 'lost folded column defaults or nullability' AS violation
WHERE EXISTS (SELECT FROM "chess_match" WHERE "spectatorEvaluations" IS NOT NULL OR "whiteTruncated" IS NOT NULL OR "blackTruncated" IS NOT NULL)
   OR NOT EXISTS (SELECT FROM "openrouter_connection" WHERE id='fx_connection_1' AND status='active' AND "label" IS NULL AND "expiresAt" IS NULL AND "limitMicros"=9223372036854775807 AND "createdAt" IS NOT NULL AND "updatedAt" IS NOT NULL AND "lastCheckedAt" IS NOT NULL);

SELECT 'missing folded index' AS violation
WHERE NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname='public' AND indexname='openrouter_connection_userId_key' AND indexdef='CREATE UNIQUE INDEX "openrouter_connection_userId_key" ON public.openrouter_connection USING btree ("userId")')
   OR NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname='public' AND indexname='chess_match_status_createdAt_idx' AND indexdef='CREATE INDEX "chess_match_status_createdAt_idx" ON public.chess_match USING btree (status, "createdAt")');

SELECT 'missing connection ownership cascade' AS violation
WHERE NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='openrouter_connection'::regclass AND conname='openrouter_connection_userId_fkey' AND contype='f' AND confrelid='"user"'::regclass AND confdeltype='c' AND confupdtype='c' AND pg_get_constraintdef(oid)='FOREIGN KEY ("userId") REFERENCES "user"(id) ON UPDATE CASCADE ON DELETE CASCADE');
