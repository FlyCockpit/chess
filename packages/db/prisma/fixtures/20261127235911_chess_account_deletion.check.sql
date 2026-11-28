SELECT id AS invented_authentication_proof FROM "session" WHERE "authenticatedAt" IS NOT NULL;
SELECT id AS invented_deletion FROM "user"
WHERE "deletionRequestedAt" IS NOT NULL OR "deletionState" <> 'active'
  OR "deletionCursor" IS NOT NULL OR "deletionAttempts" <> 0;
SELECT id AS missing_public_identity FROM "chess_match"
WHERE "publicId" IS NULL OR "publicId" = id;
SELECT 'missing public replay index' AS violation WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_indexes WHERE schemaname = 'public'
  AND indexname = 'chess_match_published_createdAt_publicId_idx'
);
DO $deletion_fixture$
BEGIN
  IF NOT EXISTS (SELECT FROM "user" WHERE id = 'fx_user_plain') THEN RETURN; END IF;
  BEGIN
    UPDATE "user" SET "deletionState" = 'pending' WHERE id = 'fx_user_plain';
    RAISE EXCEPTION 'pending deletion without timestamp accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE "user" SET "deletionRequestedAt" = now(), "deletionState" = 'pending'
    WHERE id = 'fx_user_plain';
    UPDATE "user" SET "deletionState" = 'cleaning', "deletionCursor" = 'cursor', "deletionAttempts" = 1
    WHERE id = 'fx_user_plain';
    RAISE EXCEPTION USING ERRCODE = 'ZX002', MESSAGE = 'rollback deletion lifecycle fixture';
  EXCEPTION WHEN SQLSTATE 'ZX002' THEN NULL; END;
END $deletion_fixture$;
