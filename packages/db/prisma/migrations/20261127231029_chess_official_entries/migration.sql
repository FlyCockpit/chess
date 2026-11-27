-- cockpit-chess:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- cockpit-chess:history-capture (records the history table for the commit marker; keep it here)
DO $cockpit_chess$ BEGIN PERFORM set_config('cockpit_chess.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $cockpit_chess$;


ALTER TABLE "chess_match" ADD COLUMN "terminalCause" TEXT;

CREATE TABLE "chess_creation" (
  "id" TEXT NOT NULL,
  "configDigest" TEXT NOT NULL,
  "matchId" TEXT,
  CONSTRAINT "chess_creation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chess_creation_matchId_key" ON "chess_creation"("matchId");
ALTER TABLE "chess_creation" ADD CONSTRAINT "chess_creation_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "chess_match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "chess_official_entry" (
  "id" TEXT NOT NULL,
  "matchId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "promptVersion" TEXT NOT NULL,
  "promptHash" TEXT NOT NULL,
  "rulesKey" TEXT NOT NULL,
  "rules" JSONB NOT NULL,
  "initialFen" TEXT NOT NULL,
  "initialPositionHash" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "billingCohort" TEXT NOT NULL,
  "opponentType" TEXT NOT NULL,
  "whiteModel" TEXT NOT NULL,
  "whiteProtocol" TEXT NOT NULL,
  "blackModel" TEXT NOT NULL,
  "blackProtocol" TEXT NOT NULL,
  "moveFormat" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "cause" TEXT,
  "settledAt" TIMESTAMP(3),
  "result" TEXT,
  "finalFen" TEXT,
  "whiteIllegal" INTEGER,
  "blackIllegal" INTEGER,
  "whiteTruncated" INTEGER,
  "blackTruncated" INTEGER,
  "whiteCostMicros" BIGINT,
  "blackCostMicros" BIGINT,
  CONSTRAINT "chess_official_entry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chess_official_entry_matchId_key" ON "chess_official_entry"("matchId");
CREATE INDEX "chess_official_entry_startedAt_id_idx" ON "chess_official_entry"("startedAt" DESC, "id" DESC);
CREATE INDEX "chess_official_entry_promptVersion_rulesKey_initialPosition_idx"
  ON "chess_official_entry"("promptVersion", "rulesKey", "initialPositionHash", "billingCohort", "opponentType");
CREATE INDEX "chess_official_entry_scopeKey_idx" ON "chess_official_entry"("scopeKey");
ALTER TABLE "chess_official_entry" ADD CONSTRAINT "chess_official_entry_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "chess_match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- cockpit-chess:official-ledger v1
-- server-only enrollment guard binds immutable minimal fields to a hosted acceptance; no archive/free text is copied
CREATE FUNCTION chess_official_enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "chess_match"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO m FROM "chess_match" WHERE id = NEW."matchId";
    IF NOT FOUND OR m.source <> 'hosted' OR m.status <> 'queued'
      OR m.archive->>'source' IS DISTINCT FROM 'hosted'
      OR m."promptVersion" IS NULL OR m."promptHash" IS NULL
      OR NEW."promptVersion" IS DISTINCT FROM m."promptVersion"
      OR NEW."promptHash" IS DISTINCT FROM m."promptHash"
      OR NEW."promptVersion" IS DISTINCT FROM m.archive#>>'{config,prompt,version}'
      OR NEW."promptHash" IS DISTINCT FROM m.archive#>>'{config,prompt,hash}'
      OR m.archive#>'{config,prompt,promptApplied}' IS DISTINCT FROM 'true'::jsonb
      OR NEW."rulesKey" IS DISTINCT FROM m."rulesKey"
      OR NEW.rules IS DISTINCT FROM m.archive#>'{config,rules}'
      OR NEW."initialFen" IS DISTINCT FROM m.archive#>>'{config,initialFen}'
      OR NEW."whiteModel" IS DISTINCT FROM m.archive#>>'{config,white,model}'
      OR NEW."blackModel" IS DISTINCT FROM m.archive#>>'{config,black,model}'
      OR NEW."whiteProtocol" IS DISTINCT FROM m.archive#>>'{config,white,protocol}'
      OR NEW."blackProtocol" IS DISTINCT FROM m.archive#>>'{config,black,protocol}'
      OR NEW."whiteProtocol" NOT IN ('openai-chat','openai-responses','anthropic','random')
      OR NEW."blackProtocol" NOT IN ('openai-chat','openai-responses','anthropic','random')
      OR (NEW."whiteProtocol" = 'random' AND NEW."blackProtocol" = 'random')
      OR NEW."billingCohort" NOT IN ('operator','owner-openrouter')
      OR NEW."billingCohort" IS DISTINCT FROM m."credentialSource"
      OR NEW."moveFormat" IS DISTINCT FROM m.archive#>>'{config,rules,moveFormat}'
      OR NEW."opponentType" IS DISTINCT FROM
        (CASE WHEN 'random' IN (NEW."whiteProtocol",NEW."blackProtocol") THEN 'model-v-random' ELSE 'model-v-model' END)
      OR NEW.state <> 'pending' OR NEW."settledAt" IS NOT NULL
      OR NEW.result IS NOT NULL OR NEW.cause IS NOT NULL OR NEW."finalFen" IS NOT NULL
    THEN RAISE EXCEPTION 'Invalid official acceptance'; END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['matchId','state','cause','settledAt','result','finalFen','whiteIllegal','blackIllegal','whiteTruncated','blackTruncated','whiteCostMicros','blackCostMicros'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['matchId','state','cause','settledAt','result','finalFen','whiteIllegal','blackIllegal','whiteTruncated','blackTruncated','whiteCostMicros','blackCostMicros'])
      OR (NEW."matchId" IS DISTINCT FROM OLD."matchId" AND NEW."matchId" IS NOT NULL)
      OR (OLD.state <> 'pending' AND (to_jsonb(NEW) - 'matchId') IS DISTINCT FROM (to_jsonb(OLD) - 'matchId'))
    THEN RAISE EXCEPTION 'Official commitment is immutable'; END IF;
    IF NEW.state NOT IN ('pending','scored','withdrawal','provider-error','account-error','infrastructure-error')
    THEN RAISE EXCEPTION 'Invalid official settlement'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- guards only the new minimal ledger, without changing authentication or existing match writes
CREATE TRIGGER chess_official_enrollment_guard BEFORE INSERT OR UPDATE ON "chess_official_entry"
  FOR EACH ROW EXECUTE FUNCTION chess_official_enrollment_guard();

-- settles once in the existing match CAS transaction; deletion keeps the ledger and only detaches its match FK
CREATE FUNCTION chess_official_settle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "chess_match"%ROWTYPE; category text; why text; position text;
BEGIN
  IF TG_OP = 'DELETE' THEN m := OLD; ELSE m := NEW; END IF;
  IF TG_OP <> 'DELETE' AND m.status IN ('queued','running','draft') THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT FROM "chess_official_entry" WHERE "matchId" = m.id AND state = 'pending')
    THEN IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;

  why := coalesce(m."terminalCause", m.ending->>'kind', 'unknown-terminal');
  IF TG_OP = 'DELETE' AND m.status IN ('queued','running','draft') THEN why := 'owner-delete'; END IF;
  IF m.status = 'completed' AND m.result IN ('1-0','0-1','1/2-1/2')
    AND m.ending->>'kind' IN ('checkmate','draw','illegal-forfeit','timeout','move-timeout','token-budget','cost-budget','resignation')
  THEN category := 'scored';
  ELSIF why IN ('owner-stop','owner-disconnect','owner-reset','owner-delete','cancelled') THEN category := 'withdrawal';
  ELSIF why = 'provider-error' THEN category := 'provider-error';
  ELSIF why IN ('account-limit','credential-revoked') THEN category := 'account-error';
  ELSE category := 'infrastructure-error';
  END IF;
  -- Only bounded server cause codes, never provider text or arbitrary archive content.
  IF why NOT IN ('checkmate','draw','illegal-forfeit','timeout','move-timeout','token-budget','cost-budget','resignation',
    'owner-stop','owner-disconnect','owner-reset','owner-delete','cancelled','provider-error','account-limit',
    'credential-revoked','interrupted','engine-error','event-limit','worker-lost','queue-lost','archive-invalid','enqueue-failed')
    THEN why := 'unknown-terminal'; END IF;

  SELECT e.value->>'fen' INTO position
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.archive->'events') = 'array' THEN m.archive->'events' ELSE '[]'::jsonb END)
      WITH ORDINALITY e(value, seq)
    WHERE e.value->>'type' = 'attempt' AND e.value->'accepted' = 'true'::jsonb
      AND length(e.value->>'fen') BETWEEN 1 AND 160
    ORDER BY e.seq DESC LIMIT 1;
  UPDATE "chess_official_entry" SET
    state = category, cause = why, "settledAt" = CURRENT_TIMESTAMP,
    result = CASE WHEN category = 'scored' THEN m.result ELSE NULL END,
    "finalFen" = coalesce(position, "initialFen"),
    "whiteIllegal" = m."whiteIllegal", "blackIllegal" = m."blackIllegal",
    "whiteTruncated" = m."whiteTruncated", "blackTruncated" = m."blackTruncated",
    "whiteCostMicros" = m."whiteCostMicros", "blackCostMicros" = m."blackCostMicros"
    WHERE "matchId" = m.id AND state = 'pending';
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
-- terminal updates inherit status/runToken/heartbeat CAS ownership from the guarded match write
CREATE TRIGGER chess_official_terminal AFTER UPDATE OF status ON "chess_match"
  FOR EACH ROW EXECUTE FUNCTION chess_official_settle();
-- account cascade or explicit match deletion records pending withdrawal before SET NULL detaches the public entry
CREATE TRIGGER chess_official_delete BEFORE DELETE ON "chess_match"
  FOR EACH ROW EXECUTE FUNCTION chess_official_settle();
-- end cockpit-chess:official-ledger

-- cockpit-chess:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $cockpit_chess$ DECLARE history text := current_setting('cockpit_chess.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'cockpit-chess:committed', history::oid::regclass); END IF; END $cockpit_chess$;
COMMIT;
