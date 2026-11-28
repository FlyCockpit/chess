/** Real worker/SDK/PG deletion races; called only by the owned disposable harness. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export async function accountDeletionActiveCheck(trialCount = 20) {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.ok(["account-deletion", "account-deletion-pool3"].includes(process.argv[3]));
  const [
    { default: prisma },
    chess,
    { officialCommitment, chessDigest },
    { usersRouter },
    { settingsRouter },
    { handleChessRunJob, handleChessReconcileJob },
    keyRuntime,
    { saveOpenRouterConnection },
    { dispatchForActiveOwner },
    queues,
    { loadPg },
    { RPCHandler },
  ] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/chess/src/index.ts"),
    import("../../packages/api/src/lib/chess-official.ts"),
    import("../../packages/api/src/routers/users.ts"),
    import("../../packages/api/src/routers/settings.ts"),
    import("../../apps/worker/src/handlers/chess-run.ts"),
    import("../../apps/worker/src/chess-key-revocations.ts"),
    import("../../packages/api/src/lib/openrouter-account.ts"),
    import("../../packages/auth/src/account-deletion.ts"),
    import("../../packages/queue/src/index.ts"),
    import("../db/lib/prisma.mjs"),
    import(
      createRequire(new URL("../../packages/api/package.json", import.meta.url)).resolve(
        "@orpc/server/fetch",
      )
    ),
  ]);
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  const owners = [];
  const originalFetch = globalThis.fetch;
  const subscriber = queues.createRedisConnection();
  const bounded = async (label, inspect) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await inspect()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const person = async (role = "user", overrides = {}) => {
    const user = await prisma.user.create({
      data: {
        id: `active-deletion-${randomUUID()}`,
        name: "Active deletion fixture",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
        role,
        twoFactorEnabled: true,
        ...overrides,
      },
    });
    owners.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: randomUUID(),
        origin: "sign-in",
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, session, context: { session: { user, session } } };
  };
  // Fixture-only latency at the marker write gives EVERY Serializable attempt
  // a full real heartbeat interval. The former three retries therefore cannot
  // hide the hot-row conflict. This trigger exists only in owned disposable PG.
  await observer.query(`CREATE FUNCTION runtime_deletion_slow_fence() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id LIKE 'active-deletion-%' AND OLD."deletionRequestedAt" IS NULL
         AND NEW."deletionRequestedAt" IS NOT NULL THEN
        PERFORM pg_sleep(2.2);
      END IF;
      RETURN NEW;
    END $$`);
  await observer.query(`CREATE TRIGGER runtime_deletion_slow_fence
    BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION runtime_deletion_slow_fence()`);
  await observer.query("CREATE SEQUENCE runtime_deletion_stop_failures");
  await observer.query(`CREATE FUNCTION runtime_deletion_stop_failure() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.slug LIKE 'active-deletion-crash-%' AND NEW."terminalCause" = 'owner-delete' THEN
        -- A separate IF keeps the volatile counter out of a reordered boolean
        -- expression: ordinary stress rows must never consume this fault.
        IF nextval('runtime_deletion_stop_failures') = 1 THEN
          RAISE EXCEPTION 'synthetic stop write failure after durable marker';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await observer.query(`CREATE TRIGGER runtime_deletion_stop_failure
    BEFORE UPDATE ON chess_match FOR EACH ROW EXECUTE FUNCTION runtime_deletion_stop_failure()`);
  const trials = [
    ...Array.from({ length: trialCount }, (_, trial) => ({ kind: "admin", trial: trial + 1 })),
    ...Array.from({ length: trialCount }, (_, trial) => ({ kind: "self", trial: trial + 1 })),
    { kind: "post-fence-failure", trial: 1 },
    { kind: "early-exit", trial: 1 },
  ];
  try {
    await keyRuntime.startChessKeyRevocations(subscriber, queues.redisConnection);
    const admin = await person("admin");
    const [policy, { invalidateForceTwoFactorSettingsCache }, { cliCredentialLockKey }] =
      await Promise.all([
        import("../../packages/auth/src/two-factor-policy.ts"),
        import("../../packages/api/src/lib/two-factor-policy.ts"),
        import("../../packages/auth/src/device-redemption-lock.ts"),
      ]);
    const policyKey = policy.FORCE_2FA_PUBLIC_USERS_SETTING_KEY;
    const priorPolicy = await prisma.appSetting.findUnique({ where: { key: policyKey } });
    try {
      await prisma.appSetting.upsert({
        where: { key: policyKey },
        create: { key: policyKey, value: "true" },
        update: { value: "true" },
      });
      invalidateForceTwoFactorSettingsCache();
      const graceEnds = Date.now() + 5000;
      const owner = await person("user", {
        twoFactorEnabled: false,
        createdAt: new Date(graceEnds - policy.TWO_FACTOR_ENROLLMENT_GRACE_MS),
      });
      const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      let removing;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          cliCredentialLockKey(owner.user.id),
        ]);
        removing = new RPCHandler({ settings: settingsRouter }).handle(
          new Request("http://runtime.example.test/rpc/settings/deleteAccount", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { confirmation: "DELETE" } }),
          }),
          { prefix: "/rpc", context: owner.context },
        );
        await bounded(
          "self deletion reached credential wait inside valid enrollment grace",
          async () => {
            const result = await observer.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",
              [blocker.processID],
            );
            return result.rowCount > 0;
          },
        );
        await bounded(
          "real enrollment grace expires while credential lock is held",
          async () => Date.now() > graceEnds,
        );
        await blocker.query("COMMIT");
        const answer = await removing;
        assert.equal(
          answer.response.status,
          403,
          "self policy must be current after credential wait",
        );
        assert.equal(
          (await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } }))
            .deletionRequestedAt,
          null,
        );
        assert.equal(await prisma.session.count({ where: { userId: owner.user.id } }), 1);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        await removing;
      }
      const eligible = await person("user", { twoFactorEnabled: false });
      const allowed = await new RPCHandler({ settings: settingsRouter }).handle(
        new Request("http://runtime.example.test/rpc/settings/deleteAccount", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { confirmation: "DELETE" } }),
        }),
        { prefix: "/rpc", context: eligible.context },
      );
      assert.equal(
        allowed.response.status,
        200,
        "existing forced-2FA enrollment grace remains valid",
      );
      console.log(
        "Self deletion: real credential wait crosses forced-2FA grace expiry;403/no marker/revocation; positive in-grace200 retained",
      );
    } finally {
      if (priorPolicy)
        await prisma.appSetting.update({
          where: { key: policyKey },
          data: { value: priorPolicy.value },
        });
      else await prisma.appSetting.deleteMany({ where: { key: policyKey } });
      invalidateForceTwoFactorSettingsCache();
    }
    {
      const { openrouterRouter: statusRouter, resetOpenRouterStatusCache } = await import(
        "../../packages/api/src/routers/openrouter.ts"
      );
      const owner = await person();
      await saveOpenRouterConnection(owner.user.id, "synthetic-status-deletion-key", {
        label: "Status fixture",
        limitMicros: null,
        limitRemainingMicros: null,
        usageMicros: null,
        usageDailyMicros: null,
        expiresAt: null,
      });
      resetOpenRouterStatusCache();
      const findConnection = prisma.openRouterConnection.findUnique.bind(
        prisma.openRouterConnection,
      );
      let announceLoaded;
      let releaseLoaded;
      const loaded = new Promise((resolve) => {
        announceLoaded = resolve;
      });
      const released = new Promise((resolve) => {
        releaseLoaded = resolve;
      });
      let statusRead;
      let sends = 0;
      const previousFetch = globalThis.fetch;
      try {
        // Keep actual PG SELECT/result and actual key loader. Pause only promise
        // delivery after SELECT, as a delayed process can cross another replica's
        // committed deletion while retaining an already-read encrypted row.
        prisma.openRouterConnection.findUnique = async (args) => {
          const row = await findConnection(args);
          if (args.where?.userId === owner.user.id && args.select?.keyCiphertext) {
            announceLoaded();
            await released;
          }
          return row;
        };
        globalThis.fetch = async (input) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          assert.equal(url.pathname, "/api/v1/key");
          sends++;
          return Response.json({ data: { label: "Status fixture" } });
        };
        statusRead = new RPCHandler({ openrouter: statusRouter }).handle(
          new Request("http://runtime.example.test/rpc/openrouter/status", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: {} }),
          }),
          { prefix: "/rpc", context: owner.context },
        );
        await Promise.race([
          loaded,
          statusRead.then(() => {
            throw new Error("Status ended before captured-key pause");
          }),
          delay(10_000).then(() => {
            throw new Error("Status did not reach actual key SELECT");
          }),
        ]);
        const deletion = await new RPCHandler({ users: usersRouter }).handle(
          new Request("http://runtime.example.test/rpc/users/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: { userId: owner.user.id } }),
          }),
          { prefix: "/rpc", context: admin.context },
        );
        assert.equal(deletion.response.status, 200);
        assert.ok(
          (await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } }))
            .deletionRequestedAt,
        );
        assert.equal(
          await prisma.openRouterConnection.count({ where: { userId: owner.user.id } }),
          0,
        );
        releaseLoaded();
        assert.equal((await statusRead).response.status, 200);
        assert.equal(sends, 0, "key introspection must not start after durable deletion fence");
        console.log(
          "Status key read paused across committed deletion: zero post-fence introspection HTTP, captured key refused",
        );
      } finally {
        releaseLoaded();
        prisma.openRouterConnection.findUnique = findConnection;
        await statusRead;
        globalThis.fetch = previousFetch;
        resetOpenRouterStatusCache();
      }
    }
    for (const handoff of [false, true]) {
      const owner = await person();
      await saveOpenRouterConnection(owner.user.id, "synthetic-human-clock-key", {
        label: "Human clock fixture",
        limitMicros: null,
        limitRemainingMicros: null,
        usageMicros: null,
        usageDailyMicros: null,
        expiresAt: null,
      });
      const model = `fixture/clock-${randomUUID()}`;
      const human = { name: "Human", model: "human", protocol: "human" };
      const automatic = { name: "Model", model, protocol: "openai-chat" };
      const interval = handoff ? 5000 : 1000;
      const archive = chess.createMatch(
        {
          white: handoff ? automatic : human,
          black: handoff ? human : automatic,
          rules: {
            context: "fresh",
            engineEvaluation: "off",
            remarks: "off",
            turnTimeoutMs: interval,
          },
        },
        "hosted",
      );
      const row = await prisma.chessMatch.create({
        data: {
          ownerId: owner.user.id,
          slug: `active-human-clock-${randomUUID()}`,
          title: "Human clock fixture",
          whiteName: archive.config.white.name,
          blackName: archive.config.black.name,
          source: "hosted",
          status: "queued",
          credentialSource: "owner-openrouter",
          rulesKey: chessDigest(archive.config.rules).slice(0, 16),
          rulesVersion: archive.config.rules.version,
          promptVersion: archive.config.prompt.version,
          promptHash: archive.config.prompt.hash,
          contextMode: archive.config.rules.context,
          identityMode: archive.config.rules.opponentIdentity,
          archive,
        },
      });
      const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      const previousFetch = globalThis.fetch;
      const abort = new AbortController();
      let body;
      let ready;
      const dispatched = new Promise((resolve) => {
        ready = resolve;
      });
      let running;
      try {
        await blocker.query("BEGIN");
        if (!handoff)
          await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            cliCredentialLockKey(owner.user.id),
          ]);
        globalThis.fetch = async (input) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          if (url.pathname === "/api/v1/models")
            return Response.json({
              data: [
                {
                  id: model,
                  pricing: { prompt: "0", completion: "0" },
                  supported_parameters: [],
                  context_length: 32768,
                  top_provider: { max_completion_tokens: 256 },
                },
              ],
            });
          assert.equal(url.pathname, "/api/v1/chat/completions");
          return new Response(
            new ReadableStream({
              start(controller) {
                body = controller;
                ready();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        };
        running = handleChessRunJob({ data: { matchId: row.id } }, abort.signal);
        if (handoff) {
          await Promise.race([
            dispatched,
            running.then(() => {
              throw new Error("Model ended before handoff fixture dispatch");
            }),
          ]);
          await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            cliCredentialLockKey(owner.user.id),
          ]);
          body.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                id: randomUUID(),
                object: "chat.completion.chunk",
                created: 0,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: JSON.stringify({ move: "e2e4" }) },
                    finish_reason: "stop",
                  },
                ],
              })}\n\ndata: [DONE]\n\n`,
            ),
          );
          body.close();
        }
        await bounded(
          `human ${handoff ? "handoff" : "initial"} publication waits at real credential lock`,
          async () => {
            const result = await observer.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",
              [blocker.processID],
            );
            return result.rowCount > 0;
          },
        );
        await delay(interval + 500);
        const releasedAt = Date.now();
        await blocker.query("COMMIT");
        await running;
        const parked = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(parked.status, "running");
        assert.equal(parked.turnType, "human");
        assert.ok(
          parked.turnStartedAt.getTime() >= releasedAt - 50,
          "new human interval must start after real credential wait",
        );
        assert.equal(parked.turnDeadline.getTime() - parked.turnStartedAt.getTime(), interval);
        const { chessRouter } = await import("../../packages/api/src/routers/chess.ts");
        const moved = await new RPCHandler({ chess: chessRouter }).handle(
          new Request("http://runtime.example.test/rpc/chess/move", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              json: {
                slug: row.slug,
                turnId: parked.turnId,
                expectedSeq: parked.turnExpectedSeq,
                move: handoff ? "e7e5" : "e2e4",
              },
            }),
          }),
          { prefix: "/rpc", context: owner.context },
        );
        assert.equal(
          moved.response.status,
          200,
          "immediate legal human move retains its full published interval",
        );
        const { chessRunJobId } = await import("../../packages/api/src/lib/chess-human.ts");
        const continued = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
        await (
          await queues.chessRunQueue.getJob(chessRunJobId(row.id, continued.archive))
        )?.remove();
        await prisma.chessMatch.update({
          where: { id: row.id },
          data: { status: "stopped", terminalCause: "owner-stop" },
        });
        console.log(
          `Human ${handoff ? "handoff" : "initial"}: actual credential lock exceeded turn interval; full new interval and immediate legal RPC move retained`,
        );
      } finally {
        abort.abort();
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        await running;
        globalThis.fetch = previousFetch;
      }
    }
    for (const { kind, trial } of trials) {
      const owner = await person();
      const adminRequest = kind === "admin" || kind === "post-fence-failure";
      await saveOpenRouterConnection(owner.user.id, "synthetic-active-deletion-key", {
        label: "Fixture",
        limitMicros: null,
        limitRemainingMicros: null,
        usageMicros: null,
        usageDailyMicros: null,
        expiresAt: null,
      });
      const model = `fixture/deletion-${randomUUID()}`;
      const game = chess.createMatch(
        {
          white: { name: "Model", model, protocol: "openai-chat" },
          black: { name: "Random", model: "random", protocol: "random" },
          rules: {
            context: "fresh",
            engineEvaluation: "off",
            remarks: "off",
            legalMoves: "hidden",
          },
        },
        "hosted",
      );
      const row = await prisma.chessMatch.create({
        data: {
          ownerId: owner.user.id,
          slug: `active-deletion-${kind === "post-fence-failure" ? "crash-" : ""}${randomUUID()}`,
          title: "Fixture",
          whiteName: "Model",
          blackName: "Random",
          source: "hosted",
          status: "queued",
          rulesKey: chessDigest(game.config.rules).slice(0, 16),
          rulesVersion: game.config.rules.version,
          promptVersion: game.config.prompt.version,
          promptHash: game.config.prompt.hash,
          contextMode: game.config.rules.context,
          identityMode: game.config.rules.opponentIdentity,
          credentialSource: "owner-openrouter",
          archive: game,
          OfficialEntry: { create: officialCommitment(game, "owner-openrouter") },
        },
      });
      let body;
      let sends = 0;
      let fenceSeen = false;
      let sendMove;
      const moveReady = new Promise((resolve) => {
        sendMove = resolve;
      });
      // Headers return immediately, but the first move waits in the real SDK's
      // stream parser. This leaves worker heartbeat/persist free to write PG.
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        assert.equal(url.origin, "https://openrouter.example.test");
        if (url.pathname === "/api/v1/models")
          return Response.json({
            data: [
              {
                id: model,
                pricing: { prompt: "0", completion: "0" },
                supported_parameters: [],
                context_length: 32768,
                top_provider: { max_completion_tokens: 256 },
              },
            ],
          });
        assert.equal(url.pathname, "/api/v1/chat/completions");
        const active = await prisma.user.findUniqueOrThrow({
          where: { id: owner.user.id },
          select: { deletionRequestedAt: true },
        });
        assert.equal(
          active.deletionRequestedAt,
          null,
          "no provider HTTP may start after fence commit",
        );
        assert.equal(fenceSeen, false, "no send after independently observed fence commit");
        sends++;
        assert.equal(sends, 1, "no second paid dispatch while deletion holds the credential lock");
        const request = JSON.parse(
          typeof init?.body === "string" ? init.body : await input.clone().text(),
        );
        assert.equal(request.provider.data_collection, "deny");
        return new Response(
          new ReadableStream({
            start(controller) {
              body = controller;
              sendMove();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      // Also prove that a worker ending before the synthetic response does not
      // queue cleanup SQL forever on a PostgreSQL client never connected.
      if (kind === "early-exit")
        await prisma.chessMatch.update({
          where: { id: row.id },
          data: { status: "stopped", terminalCause: "owner-stop" },
        });
      const stop = new AbortController();
      const running = handleChessRunJob({ data: { matchId: row.id } }, stop.signal);
      const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
      let removing;
      let connectionStarted = false;
      let inTransaction = false;
      let earlyFailure;
      try {
        await Promise.race([
          moveReady,
          running.then(() => {
            throw new Error("Worker ended before dispatch");
          }),
        ]);
        const beforeHeartbeat = await prisma.chessMatch.findUniqueOrThrow({
          where: { id: row.id },
        });
        await bounded(`${kind}/${trial} real 2s heartbeat before deletion`, async () => {
          const current = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
          return current.heartbeatAt > beforeHeartbeat.heartbeatAt;
        });
        connectionStarted = true;
        await blocker.connect();
        await blocker.query("BEGIN");
        inTransaction = true;
        // Establish a real authority snapshot while the actual shared heartbeat
        // keeps writing the same game. The marker fence must never write it.
        // The slow marker trigger also spans a tick on EACH old retry.
        const actor = adminRequest ? admin : owner;
        await blocker.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [actor.user.id]);
        const handler = new RPCHandler({ users: usersRouter, settings: settingsRouter });
        removing = handler.handle(
          new Request(
            `http://runtime.example.test/rpc/${adminRequest ? "users/remove" : "settings/deleteAccount"}`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "x-csrf-token": "orpc" },
              body: JSON.stringify({
                json: adminRequest ? { userId: owner.user.id } : { confirmation: "DELETE" },
              }),
            },
          ),
          { prefix: "/rpc", context: actor.context },
        );
        await bounded(`${kind} Serializable authority read waiting`, async () => {
          const result = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))",
            [blocker.processID],
          );
          return result.rowCount > 0;
        });
        // Observe the real 2s heartbeat UPDATE crossing this exact authority
        // snapshot, rather than replacing its production timer with a mock.
        const atSnapshot = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
        await bounded(
          `${kind}/${trial} real heartbeat writes across authority snapshot`,
          async () => {
            const current = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
            return current.heartbeatAt > atSnapshot.heartbeatAt;
          },
        );
        const chunk = {
          id: randomUUID(),
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: JSON.stringify({ move: "e2e4" }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0 },
        };
        body.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`),
        );
        body.close();
        await blocker.query("COMMIT");
        inTransaction = false;
        await bounded(`${kind}/${trial} durable fence commit`, async () => {
          const result = await observer.query(
            'SELECT "deletionRequestedAt" FROM "user" WHERE id = $1',
            [owner.user.id],
          );
          if (result.rows[0]?.deletionRequestedAt) {
            fenceSeen = true;
            return true;
          }
          // Old code returns 409 with no marker: surface that assertion promptly.
          const raced = await Promise.race([
            removing.then((value) => ({ value })),
            delay(0).then(() => ({})),
          ]);
          if (raced.value && kind !== "post-fence-failure") {
            assert.equal(
              raced.value.response?.status,
              200,
              `${kind}/${trial} first deletion request must be HTTP 200`,
            );
          }
          return false;
        });
        const answer = await removing;
        assert.equal(answer.matched, true);
        if (kind === "post-fence-failure") {
          assert.equal(answer.response.status, 500, "outer stop failed after durable fence commit");
          // Recovery must happen without another authenticated deletion request.
          await running;
          const recovered = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
          assert.equal(recovered.status, "stopped");
          assert.equal(recovered.terminalCause, "owner-delete");
          const retry = await new RPCHandler({ users: usersRouter }).handle(
            new Request("http://runtime.example.test/rpc/users/remove", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ json: { userId: owner.user.id } }),
            }),
            { prefix: "/rpc", context: admin.context },
          );
          assert.equal(retry.response.status, 200);
          const payload = await retry.response.json();
          assert.equal(payload.json.status, "pending");
          assert.equal(payload.json.complete, false);
        } else {
          assert.equal(answer.response.status, 200, `${kind}/${trial} first deletion request`);
          const payload = await answer.response.json();
          assert.equal(payload.json.status, "pending");
          assert.equal(payload.json.complete, false);
        }
        await running;
        const fenced = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(fenced.status, "stopped");
        assert.equal(fenced.runToken, null);
        assert.equal(fenced.terminalCause, "owner-delete");
        assert.equal(fenced.turnType, "idle");
        assert.equal(await prisma.session.count({ where: { userId: owner.user.id } }), 0);
        assert.equal(
          await prisma.openRouterConnection.count({ where: { userId: owner.user.id } }),
          0,
        );
        const entry = await prisma.chessOfficialEntry.findUniqueOrThrow({
          where: { matchId: row.id },
        });
        assert.equal(entry.state, "withdrawal");
        assert.equal(entry.cause, "owner-delete");
        assert.equal(entry.result, null);
        assert.ok(entry.settledAt);
        assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: row.id } }), 1);
        let lateSend = false;
        await assert.rejects(
          dispatchForActiveOwner(owner.user.id, async () => {
            lateSend = true;
            return new Response();
          }),
        );
        assert.equal(lateSend, false);
        assert.equal(sends, 1);
        // Neither redelivery nor a late claim CAS may overwrite settled deletion.
        await handleChessRunJob({ data: { matchId: row.id } });
        assert.equal(sends, 1);
        assert.equal(
          (await prisma.chessOfficialEntry.findUniqueOrThrow({ where: { id: entry.id } })).cause,
          "owner-delete",
        );
        console.log(
          kind === "post-fence-failure"
            ? "Post-fence stop failure: durable pending/revocations survived rollback; worker/retry recovered owner-delete withdrawal"
            : `${kind}/${trial}: first HTTP 200 pending; real worker/2s heartbeat fenced; zero post-commit sends; one official withdrawal`,
        );
      } catch (error) {
        if (kind !== "early-exit") throw error;
        earlyFailure = error;
      } finally {
        stop.abort();
        if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
        if (connectionStarted) await blocker.end().catch(() => {});
        await removing;
        await running;
      }
      if (kind === "early-exit") {
        assert.equal(earlyFailure?.message, "Worker ended before dispatch");
        assert.equal(connectionStarted, false);
        assert.equal(sends, 0);
        console.log(
          "Early worker exit preserved its error and completed cleanup without unopened-client SQL",
        );
      }
    }
    // Exercise the independent durable-fence/crash boundary with no live
    // gameplay writer and no second deletion request to perform the cleanup.
    const [{ chessRouter }, { openrouterRouter }] = await Promise.all([
      import("../../packages/api/src/routers/chess.ts"),
      import("../../packages/api/src/routers/openrouter.ts"),
    ]);
    for (const recovery of [
      "queued-human",
      "invalid-archive",
      "redis-unavailable",
      "runner",
      "runner-success",
      "stale-stop",
      "stale-disconnect",
      "stale-reset",
    ]) {
      const owner = await person();
      const automatic = ["stale-stop", "stale-disconnect", "stale-reset"].includes(recovery);
      const runner = recovery.startsWith("runner");
      const success = recovery === "runner-success";
      const archive = chess.createMatch(
        {
          white: automatic
            ? { name: "Model", model: "fixture/recovery", protocol: "openai-chat" }
            : { name: "Human", model: "human", protocol: "human" },
          black: automatic
            ? { name: "Random", model: "random", protocol: "random" }
            : { name: "Model", model: "fixture/recovery", protocol: "openai-chat" },
          rules: { context: "fresh", engineEvaluation: "off" },
        },
        runner ? "local" : "hosted",
      );
      if (!automatic) {
        chess.beginHostedTurn(archive);
        chess.playHostedHumanTurn(
          archive,
          new Date(Date.parse(archive.turn.startedAt) + 1),
          "e2e4",
        );
      }
      assert.equal(archive.turn.type, "idle");
      const credentialSource = runner
        ? "runner-local"
        : recovery === "stale-disconnect"
          ? "owner-openrouter"
          : "operator";
      const originalArchive = recovery === "invalid-archive" ? {} : archive;
      const row = await prisma.chessMatch.create({
        data: {
          ownerId: owner.user.id,
          slug: `active-deletion-${success ? "runner-success" : "crash"}-${randomUUID()}`,
          title: "Recovery fixture",
          whiteName: "Human",
          blackName: "Model",
          source: runner ? "runner" : "hosted",
          status: "queued",
          rulesKey: chessDigest(archive.config.rules).slice(0, 16),
          rulesVersion: archive.config.rules.version,
          promptVersion: archive.config.prompt.version,
          promptHash: archive.config.prompt.hash,
          credentialSource,
          ...(runner
            ? {
                runnerState: "accepted",
                runnerGeneration: 1,
                runnerResumeDeadline: new Date(Date.now() + 120_000),
              }
            : {}),
          ...(automatic
            ? { OfficialEntry: { create: officialCommitment(archive, credentialSource) } }
            : {}),
          contextMode: archive.config.rules.context,
          identityMode: archive.config.rules.opponentIdentity,
          archive: originalArchive,
        },
      });
      if (runner)
        await prisma.runnerCommand.create({
          data: {
            id: randomUUID(),
            matchId: row.id,
            kind: "start",
            revision: 1,
            payload: {},
            expiresAt: new Date(Date.now() + 120_000),
          },
        });
      await observer.query("ALTER SEQUENCE runtime_deletion_stop_failures RESTART WITH 1");
      const answer = await new RPCHandler({ users: usersRouter }).handle(
        new Request("http://runtime.example.test/rpc/users/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { userId: owner.user.id } }),
        }),
        { prefix: "/rpc", context: admin.context },
      );
      assert.equal(answer.response.status, success ? 200 : 500, `${recovery}: request outcome`);
      assert.ok(
        (await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).deletionRequestedAt,
        `${recovery}: marker remains committed after failed outer stop`,
      );
      assert.equal(await prisma.session.count({ where: { userId: owner.user.id } }), 0);
      assert.equal(
        (await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } })).status,
        success ? "stopped" : "queued",
        `${recovery}: request-side settlement or active row for production recovery`,
      );
      const priorGetJob = queues.chessRunQueue.getJob;
      try {
        if (success) {
          // Request-side runner settlement must already be complete before response.
        } else if (recovery === "stale-stop" || recovery === "stale-disconnect") {
          const path = recovery === "stale-stop" ? "chess/stop" : "openrouter/disconnect";
          const stale = await new RPCHandler({
            chess: chessRouter,
            openrouter: openrouterRouter,
          }).handle(
            new Request(`http://runtime.example.test/rpc/${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ json: recovery === "stale-stop" ? { slug: row.slug } : {} }),
            }),
            // Captured pre-fence identity simulates an already-admitted request.
            { prefix: "/rpc", context: owner.context },
          );
          assert.equal(
            stale.response.status,
            200,
            `${recovery}: admitted request settles deletion`,
          );
        } else if (recovery === "stale-reset") {
          const { revokeCredentialsAfterPasswordReset } = await import(
            "../../packages/auth/src/credential-revocation.ts"
          );
          await revokeCredentialsAfterPasswordReset(owner.user.id);
        } else {
          if (recovery === "redis-unavailable")
            queues.chessRunQueue.getJob = async () => {
              throw new Error("Synthetic Redis lookup outage during pending recovery");
            };
          if (recovery === "queued-human") await handleChessRunJob({ data: { matchId: row.id } });
          await handleChessReconcileJob({ data: { reason: "cron" } });
          await handleChessReconcileJob({ data: { reason: "cron" } });
        }
      } finally {
        queues.chessRunQueue.getJob = priorGetJob;
      }
      const recovered = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(recovered.status, "stopped", `${recovery}: autonomous terminal recovery`);
      assert.equal(recovered.terminalCause, "owner-delete", `${recovery}: deletion dominates`);
      assert.equal(recovered.runToken, null);
      assert.equal(recovered.turnType, "idle");
      assert.deepEqual(recovered.archive, originalArchive, `${recovery}: no stale archive write`);
      if (runner) {
        assert.equal(recovered.runnerState, "stopped");
        assert.equal(recovered.runnerGeneration, null);
        assert.equal(recovered.runnerResumeDeadline, null);
        assert.equal(recovered.runnerRevision, 1);
        assert.equal(
          await prisma.runnerCommand.count({ where: { matchId: row.id, cancelledAt: null } }),
          0,
        );
      }
      if (automatic) {
        const entry = await prisma.chessOfficialEntry.findUniqueOrThrow({
          where: { matchId: row.id },
        });
        assert.equal(entry.state, "withdrawal");
        assert.equal(entry.cause, "owner-delete");
      }
      console.log(
        `Post-fence ${recovery}: no deletion retry, preserved archive, stopped owner-delete`,
      );
    }
    console.log(
      `Active deletion stress: ${trialCount}/${trialCount} admin and ${trialCount}/${trialCount} self first-request HTTP 200 pending with real worker and real 2s heartbeat; pool=${process.env.DATABASE_POOL_MAX}`,
    );
  } finally {
    await observer.query("DROP TRIGGER runtime_deletion_stop_failure ON chess_match");
    await observer.query("DROP FUNCTION runtime_deletion_stop_failure()");
    await observer.query("DROP SEQUENCE runtime_deletion_stop_failures");
    await observer.query('DROP TRIGGER runtime_deletion_slow_fence ON "user"');
    await observer.query("DROP FUNCTION runtime_deletion_slow_fence()");
    keyRuntime.stopChessKeyRevocations();
    subscriber.disconnect();
    globalThis.fetch = originalFetch;
    await prisma.chessMatch.deleteMany({ where: { ownerId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await observer.end();
  }
}
