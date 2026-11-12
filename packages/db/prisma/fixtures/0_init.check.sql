-- Each statement returns zero rows; pinned to 0_init's nine application tables.
SELECT 'missing fixture table rows' AS violation
WHERE (SELECT count(*) FROM "user" WHERE id LIKE 'fx_user_%') <> 5
   OR (SELECT count(*) FROM "session" WHERE id LIKE 'fx_session_%') <> 2
   OR (SELECT count(*) FROM "account" WHERE id LIKE 'fx_account_%') <> 3
   OR (SELECT count(*) FROM "verification" WHERE id LIKE 'fx_verification_%') <> 3
   OR (SELECT count(*) FROM "two_factor" WHERE id LIKE 'fx_two_factor_%') <> 2
   OR (SELECT count(*) FROM "app_setting" WHERE key LIKE 'fx.%') <> 3
   OR (SELECT count(*) FROM "device_code" WHERE id LIKE 'fx_device_%') <> 2
   OR (SELECT count(*) FROM "apikey" WHERE id LIKE 'fx_apikey_%') <> 2
   OR (SELECT count(*) FROM "chess_match" WHERE id LIKE 'fx_match_%') <> 2;

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
