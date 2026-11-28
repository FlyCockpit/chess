/** Real worker/SDK/PG deletion races; called only by the owned disposable harness. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export async function accountDeletionActiveCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "account-deletion");
  const [
    { default: prisma },
    chess,
    { officialCommitment, chessDigest },
    { usersRouter },
    { settingsRouter },
    { handleChessRunJob },
    keyRuntime,
    { saveOpenRouterConnection },
    { dispatchForActiveOwner },
    queues,
    { loadPg },
    orpc,
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
        "@orpc/server",
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
  const person = async (role = "user") => {
    const user = await prisma.user.create({
      data: {
        name: "Active deletion fixture",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
        role,
        twoFactorEnabled: true,
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
  const failures = [];
  try {
    await keyRuntime.startChessKeyRevocations(subscriber, queues.redisConnection);
    const admin = await person("admin");
    for (const kind of ["admin", "self", "early-exit"]) {
      const owner = await person();
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
          slug: `active-deletion-${randomUUID()}`,
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
        connectionStarted = true;
        await blocker.connect();
        await blocker.query("BEGIN");
        inTransaction = true;
        // Hold only the actor row. A real lock wait proves deletion's Serializable
        // snapshot is open before the slow provider's accepted move reaches PG.
        const actor = kind === "admin" ? admin : owner;
        await blocker.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [actor.user.id]);
        const router = kind === "admin" ? usersRouter : settingsRouter;
        const client = orpc.createRouterClient(router, { context: actor.context });
        removing = (
          kind === "admin"
            ? client.remove({ userId: owner.user.id })
            : client.deleteAccount({ confirmation: "DELETE" })
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await bounded(`${kind} Serializable authority read waiting`, async () => {
          const result = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))",
            [blocker.processID],
          );
          return result.rowCount > 0;
        });
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
        await bounded(`${kind} real worker accepted move persisted during deletion`, async () => {
          const current = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
          return current.archive.events.some((event) => event.type === "attempt" && event.accepted);
        });
        await blocker.query("COMMIT");
        inTransaction = false;
        const answer = await removing;
        if (answer.error) {
          console.log(
            `${kind} active deletion rejected: ${answer.error.data?.reason ?? answer.error.code}`,
          );
          failures.push(answer.error);
          continue;
        }
        assert.equal(answer.value.status, "pending");
        assert.equal(answer.value.complete, false);
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
          `${kind}: actual worker move crossed Serializable snapshot; deletion fenced spending and retained one official withdrawal`,
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
    assert.equal(
      failures.length,
      0,
      "active admin and self deletion must both commit despite concurrent worker writes",
    );
  } finally {
    keyRuntime.stopChessKeyRevocations();
    subscriber.disconnect();
    globalThis.fetch = originalFetch;
    await prisma.chessMatch.deleteMany({ where: { ownerId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await observer.end();
  }
}
