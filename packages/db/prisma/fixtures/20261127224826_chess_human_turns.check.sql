-- Existing prelaunch rows remain idle; no invented in-progress turn or queued input.
SELECT id AS invented_turn FROM "chess_match"
WHERE "turnType" <> 'idle' OR "turnId" IS NOT NULL OR "turnSide" IS NOT NULL
  OR "turnExpectedSeq" IS NOT NULL OR "turnStartedAt" IS NOT NULL
  OR "turnDeadline" IS NOT NULL OR "pendingMove" IS NOT NULL;

SELECT 'missing turn deadline index' AS violation
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public' AND indexname = 'chess_match_turnType_turnDeadline_id_idx');

-- Exercise the real row constraint, status/turn/sequence/claim CAS and rollback.
-- The inner subtransaction rolls every test write back, preserving fixture data.
DO $turn_test$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT FROM "chess_match" WHERE id = 'fx_match_draft') THEN RETURN; END IF;
  BEGIN
    UPDATE "chess_match" SET status = 'running', "turnType" = 'model',
      "turnId" = '11111111-1111-4111-8111-111111111111', "turnSide" = 'w',
      "turnExpectedSeq" = 0, "turnStartedAt" = '2026-11-27 00:00:00',
      "turnDeadline" = '2026-11-27 00:01:00', "runToken" = 'fixture-claim'
    WHERE id = 'fx_match_draft' AND "turnType" = 'idle';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'model claim failed'; END IF;

    UPDATE "chess_match" SET "turnType" = 'human', "runToken" = NULL
    WHERE id = 'fx_match_draft' AND status = 'running' AND "turnType" = 'model'
      AND "turnId" = '11111111-1111-4111-8111-111111111111'
      AND "turnExpectedSeq" = 0 AND "runToken" = 'wrong-claim';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'stale claim changed a turn'; END IF;

    UPDATE "chess_match" SET "turnType" = 'human', "runToken" = NULL
    WHERE id = 'fx_match_draft' AND status = 'running' AND "turnType" = 'model'
      AND "turnId" = '11111111-1111-4111-8111-111111111111'
      AND "turnExpectedSeq" = 0 AND "runToken" = 'fixture-claim';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'park did not release claim'; END IF;

    BEGIN
      UPDATE "chess_match" SET "runToken" = 'leaked-claim' WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'human retained worker claim';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
      UPDATE "chess_match" SET "turnDeadline" = '2026-11-27 00:05:00.001' WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'unbounded deadline accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
      UPDATE "chess_match" SET "turnId" = NULL WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'partial turn accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
      UPDATE "chess_match" SET "turnType" = 'human-move', "pendingMove" =
        '{"move":"e2e4","receivedAt":"2026-11-27T00:01:00.000Z"}' WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'deadline move accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
      UPDATE "chess_match" SET "turnType" = 'human-move', "pendingMove" =
        '{"move":"e2e4","receivedAt":"2026-11-27T00:00:01.000Z","extra":"unbounded"}' WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'unknown pending input accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
      UPDATE "chess_match" SET "turnType" = 'human-move', "pendingMove" = '[]' WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'input queue accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;

    UPDATE "chess_match" SET "turnType" = 'human-move', "pendingMove" =
      '{"move":"e2e4","receivedAt":"2026-11-27T00:00:01.000Z"}'
    WHERE id = 'fx_match_draft' AND status = 'running' AND "turnType" = 'human'
      AND "turnId" = '11111111-1111-4111-8111-111111111111' AND "turnExpectedSeq" = 0
      AND "turnDeadline" > '2026-11-27 00:00:01';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'human move not accepted'; END IF;
    UPDATE "chess_match" SET "pendingMove" =
      '{"move":"d2d4","receivedAt":"2026-11-27T00:00:02.000Z"}'
    WHERE id = 'fx_match_draft' AND status = 'running' AND "turnType" = 'human'
      AND "turnId" = '11111111-1111-4111-8111-111111111111' AND "turnExpectedSeq" = 0;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'duplicate move overwrote accepted input'; END IF;
    BEGIN
      UPDATE "chess_match" SET status = 'stopped' WHERE id = 'fx_match_draft';
      RAISE EXCEPTION 'terminal row kept active input';
    EXCEPTION WHEN check_violation THEN NULL; END;

    UPDATE "chess_match" SET status = 'stopped', "turnType" = 'idle',
      "turnId" = NULL, "turnSide" = NULL, "turnExpectedSeq" = NULL,
      "turnStartedAt" = NULL, "turnDeadline" = NULL, "pendingMove" = NULL
    WHERE id = 'fx_match_draft' AND status = 'running' AND "turnType" = 'human-move'
      AND "turnId" = '11111111-1111-4111-8111-111111111111' AND "turnExpectedSeq" = 0;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'terminal turn cleanup failed'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZX001', MESSAGE = 'rollback turn fixture';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
  IF EXISTS (SELECT FROM "chess_match" WHERE id = 'fx_match_draft' AND (status <> 'draft' OR "turnType" <> 'idle'))
    THEN RAISE EXCEPTION 'turn fixture rollback failed'; END IF;
END $turn_test$;
