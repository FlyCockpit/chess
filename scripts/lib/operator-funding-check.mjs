/** Live role authority at the real worker/SDK HTTP seam on owned disposable PG. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export async function operatorFundingCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "operator-funding");
  assert.equal(process.env.DATABASE_POOL_MAX, "3");
  const [
    { default: prisma },
    chess,
    { officialCommitment, chessDigest },
    { usersRouter },
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
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await inspect()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const person = async (role = "admin") => {
    const user = await prisma.user.create({
      data: {
        name: "Operator funding fixture",
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
    const client = orpc.createRouterClient(usersRouter, {
      context: { session: { user, session } },
    });
    return { user, session, client };
  };
  const caught = (promise) =>
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const chunk = (model, move) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: randomUUID(),
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: JSON.stringify({ move }) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0 },
      })}\n\ndata: [DONE]\n\n`,
    );
  const ownKey = "synthetic-owner-funding-key";
  try {
    await keyRuntime.startChessKeyRevocations(subscriber, queues.redisConnection);
    const admin = await person();
    await person(); // Keep the last-admin invariant independent of each test owner.
    for (const scenario of [
      "catalog",
      "between-turns",
      "request-first",
      "admin-positive",
      "own-key-positive",
    ]) {
      const owner = await person(scenario === "own-key-positive" ? "user" : "admin");
      const source = scenario === "own-key-positive" ? "owner-openrouter" : "operator";
      if (source === "owner-openrouter")
        await saveOpenRouterConnection(owner.user.id, ownKey, {
          label: "Fixture",
          limitMicros: null,
          limitRemainingMicros: null,
          usageMicros: null,
          usageDailyMicros: null,
          expiresAt: null,
        });
      const model = `fixture/funding-${randomUUID()}`;
      const game = chess.createMatch(
        {
          white: { name: "Model", model, protocol: "openai-chat" },
          black: { name: "Model", model, protocol: "openai-chat" },
          initialFen: "7k/8/8/8/8/8/8/R6K w - - 98 80",
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
          slug: `operator-funding-${randomUUID()}`,
          title: "Fixture",
          whiteName: "Model",
          blackName: "Model",
          source: "hosted",
          status: "queued",
          rulesKey: chessDigest(game.config.rules).slice(0, 16),
          rulesVersion: game.config.rules.version,
          promptVersion: game.config.prompt.version,
          promptHash: game.config.prompt.hash,
          contextMode: game.config.rules.context,
          identityMode: game.config.rules.opponentIdentity,
          credentialSource: source,
          archive: game,
          OfficialEntry: { create: officialCommitment(game, source) },
        },
      });
      const catalogReady = deferred();
      const catalogRelease = deferred();
      const requestReady = deferred();
      const headersRelease = deferred();
      const bodyRelease = deferred();
      let sends = 0;
      let committed = false;
      let afterCommit = 0;
      let fixtureError;
      globalThis.fetch = async (input, init) => {
        try {
          // Privacy/cache adapters can pass a Request with a rewritten body in init.
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, "https://openrouter.example.test", "synthetic origin only");
          if (url.pathname === "/api/v1/models") {
            catalogReady.resolve();
            if (scenario === "catalog") await catalogRelease.promise;
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
          }
          assert.equal(url.pathname, "/api/v1/chat/completions");
          assert.equal(
            request.headers.get("authorization"),
            `Bearer ${source === "operator" ? "synthetic-fixture-only" : ownKey}`,
          );
          assert.equal((await request.clone().json()).provider.data_collection, "deny");
          sends++;
          if (committed) afterCommit++;
          const move = sends === 1 ? "a1a2" : "h8g8";
          requestReady.resolve();
          if (scenario === "request-first" && sends === 1) await headersRelease.promise;
          return new Response(
            new ReadableStream({
              async start(controller) {
                if (["between-turns", "request-first"].includes(scenario) && sends === 1)
                  await bodyRelease.promise;
                controller.enqueue(chunk(model, move));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        } catch (error) {
          // SDKs wrap fetch failures as connection errors; retain the assertion
          // for the outer fixture so a bad synthetic wire cannot hide its cause.
          fixtureError ??= error;
          throw error;
        }
      };
      const stop = new AbortController();
      const running = handleChessRunJob({ data: { matchId: row.id } }, stop.signal);
      const waitForBoundary = (ready) =>
        Promise.race([
          ready,
          running.then(() => {
            if (fixtureError) throw fixtureError;
            throw new Error(`${scenario}: worker ended before scheduled boundary`);
          }),
        ]);
      let mutation;
      try {
        if (scenario === "catalog") {
          await waitForBoundary(catalogReady.promise);
          await admin.client.setRole({ userId: owner.user.id, role: "user" });
          committed = true;
          catalogRelease.resolve();
        } else if (["between-turns", "request-first"].includes(scenario)) {
          await waitForBoundary(requestReady.promise);
          if (scenario === "request-first") {
            mutation = caught(admin.client.setRole({ userId: owner.user.id, role: "user" }));
            await bounded("demotion UPDATE blocked by actual operator HTTP admission", async () => {
              const { rows } = await observer.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%user%' AND cardinality(pg_blocking_pids(pid)) > 0",
              );
              return rows.length > 0;
            });
            assert.equal(
              (await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).role,
              "admin",
            );
            headersRelease.resolve();
            const result = await mutation;
            assert.ok(!result.error, `request-first demotion must commit: ${result.error?.code}`);
          } else await admin.client.setRole({ userId: owner.user.id, role: "user" });
          committed = true;
          bodyRelease.resolve();
        }
        const result = await running;
        if (fixtureError) throw fixtureError;
        const stored = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
        const entry = await prisma.chessOfficialEntry.findUniqueOrThrow({
          where: { matchId: row.id },
        });
        if (scenario.endsWith("positive")) {
          assert.equal(sends, 2, `${scenario}: both ordinary turns continue`);
          assert.equal(stored.status, "completed");
          assert.equal(result.termination, "draw");
          assert.equal(entry.state, "scored");
        } else {
          assert.equal(afterCommit, 0, `${scenario}: zero inference starts after demotion commits`);
          assert.equal(sends, scenario === "catalog" ? 0 : 1);
          assert.equal(stored.status, "error");
          assert.equal(stored.terminalCause, "interrupted");
          assert.equal(stored.runToken, null);
          assert.equal(result.termination, "interrupted");
          assert.equal(entry.state, "infrastructure-error");
          assert.equal(entry.cause, "interrupted");
          assert.equal(
            stored.archive.events.filter((event) => event.type === "attempt" && event.accepted)
              .length,
            scenario === "catalog" ? 0 : 1,
          );
          await handleChessRunJob({ data: { matchId: row.id } });
          assert.equal(
            sends,
            scenario === "catalog" ? 0 : 1,
            "redelivery cannot restart terminal game",
          );
        }
        console.log(
          `operator-funding ${scenario}: sends=${sends} after-demotion=${afterCommit} pool=3`,
        );
      } finally {
        stop.abort();
        catalogRelease.resolve();
        headersRelease.resolve();
        bodyRelease.resolve();
        await mutation;
        await running;
      }
    }

    // Reciprocal role/deletion requests must not add a credential-lock cycle.
    // Both seam holders pin pool connections; deletion reserves both lock slots
    // in memory, while role UPDATE can use the third connection and wait on SHARE.
    const first = await person();
    const second = await person();
    const admitted = [deferred(), deferred()];
    const release = deferred();
    const dispatches = [first, second].map((owner, index) =>
      dispatchForActiveOwner(
        owner.user.id,
        async () => {
          admitted[index].resolve();
          await release.promise;
          return new Response();
        },
        "operator",
      ),
    );
    let changes;
    try {
      await Promise.all(admitted.map((item) => item.promise));
      changes = Promise.all([
        caught(first.client.setRole({ userId: second.user.id, role: "user" })),
        caught(second.client.remove({ userId: first.user.id })),
      ]);
      await bounded("reciprocal role write waits on operator SHARE", async () => {
        const { rows } = await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%user%' AND cardinality(pg_blocking_pids(pid)) > 0",
        );
        return rows.length > 0;
      });
      release.resolve();
      await Promise.all(dispatches);
      const results = await changes;
      assert.ok(
        results.some((result) => !result.error),
        "one reciprocal mutation must make progress",
      );
      for (const result of results)
        if (result.error)
          assert.ok(
            ["NOT_FOUND", "CONFLICT", "UNAUTHORIZED"].includes(result.error.code),
            `unexpected reciprocal refusal ${result.error.code}`,
          );
      console.log(
        "operator-funding reciprocal role/deletion writes completed without pool3 lock cycle",
      );
    } finally {
      release.resolve();
      await Promise.allSettled(dispatches);
      await changes;
    }
  } finally {
    keyRuntime.stopChessKeyRevocations();
    subscriber.disconnect();
    globalThis.fetch = originalFetch;
    await prisma.chessMatch.deleteMany({ where: { ownerId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await observer.end();
  }
}
