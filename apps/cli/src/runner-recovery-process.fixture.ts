/** Real-process fixture: uses isolated paths passed by the named regression tests only. */
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { boardAt, createMatch, matchStats, submitMove } from "@cockpit-chess/chess";
import {
  type RunnerServerMessage,
  runnerConfigDigest,
  runnerMatchConfigSchema,
} from "@cockpit-chess/chess/runner-protocol";
import { RunnerGameLoop } from "./runner-game";
import { openRunnerJournal } from "./runner-journal";
import { runnerLimitFileStore } from "./runner-limits";
import { RunnerLock } from "./runner-lock";
import { RunnerPolicy } from "./runner-policy";
import { recoverRunner } from "./runner-recovery";
import { openRunnerSpend, spendingAuthorityId } from "./runner-spend";

const [mode, root] = process.argv.slice(2);
if (!root) throw new Error("fixture path required");
const authorityId = spendingAuthorityId("local-inference");
const spendFile = join(root, ".cockpit-chess", "spend-v1", `${authorityId}.json`);
const journalRoot = join(root, ".cockpit-chess");
const matchId = "match-1";
const config = runnerMatchConfigSchema.parse({
  white: { name: "Human", model: "human", protocol: "human" },
  black: { name: "Random", model: "random", protocol: "random" },
  rules: { context: "fresh", engineEvaluation: "off" },
  promptVersion: "1",
});
const hold = () => {
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
};
async function open() {
  const spend = await openRunnerSpend({ authorityId });
  const journal = await openRunnerJournal("local-spending-authority", authorityId, journalRoot);
  return { spend, journal };
}
try {
  if (mode === "startup") {
    const { initializeRunnerExecution } = await import("./runner-start");
    const execution = await initializeRunnerExecution(
      { providerUrl: "http://127.0.0.1:8765/v1", allowModel: ["local/model"] },
      new AbortController().signal,
    );
    await execution.close();
    process.stdout.write("INITIALIZED\n");
  } else if (mode === "inspect" || mode === "resolve") {
    globalThis.fetch = async () => {
      throw new Error("unexpected network request");
    };
    const { buildProgram } = await import("./program");
    await buildProgram().parseAsync([
      "node",
      "cockpit-chess",
      "runner-recover",
      "--provider-url",
      "http://127.0.0.1:8765/v1",
      "--json",
      ...(mode === "resolve" ? ["--resolve-as-spent"] : []),
    ]);
  } else if (mode === "lock") {
    await RunnerLock.acquire(join(root, "test.lock"));
    hold();
  } else if (mode === "limits") {
    await runnerLimitFileStore("https://example.test", "machine-1", root);
    hold();
  } else if (mode === "publication" || mode === "pre-publication" || mode === "candidate-open") {
    await RunnerLock.acquire(join(root, "test.lock"), {
      [mode === "publication" ? "published" : mode === "candidate-open" ? "opened" : "initialized"]:
        async () => {
          process.kill(process.pid, "SIGKILL");
        },
    });
  } else if (mode === "spend") {
    await openRunnerSpend({ authorityId });
    hold();
  } else if (mode === "journal") {
    await openRunnerJournal("local-spending-authority", authorityId, journalRoot);
    hold();
  } else if (mode?.startsWith("financial-")) {
    let armed = false;
    const spend = await openRunnerSpend({
      authorityId,
      afterCapture: async () => {
        if (!armed) return;
        if (mode === "financial-capture-crash") process.kill(process.pid, "SIGKILL");
        if (mode !== "financial-settled") await chmod(dirname(spendFile), 0o500);
      },
    });
    await spend.reserve({
      matchId,
      requestId: "request-1",
      micros: 100,
      matchLimitMicros: 100,
      dayLimitMicros: 100,
      context: { kind: "usage", protocol: "openai-chat", tariff: { model: "test/model" } },
    });
    if (mode === "financial-lower" || mode === "financial-higher")
      await spend.captureUsage({
        requestId: "request-1",
        usage: { cost: mode === "financial-lower" ? "0.000040" : "0.000030" },
      });
    armed = true;
    if (mode === "financial-rejected") await chmod(dirname(spendFile), 0o500);
    try {
      await spend.captureUsage({
        requestId: "request-1",
        usage: {
          cost:
            mode === "financial-first" || mode === "financial-rejected"
              ? "0.000101"
              : mode === "financial-lower"
                ? "0.000030"
                : mode === "financial-higher"
                  ? "0.000040"
                  : "0.000010",
        },
      });
      if (mode !== "financial-settled") throw new Error("fault did not reject");
    } catch (error) {
      if (
        mode === "financial-settled" ||
        !(error instanceof Error) ||
        error.message !== "RUNNER_SPEND_STORAGE"
      )
        throw error;
    }
    hold();
  } else if (mode === "recover-crash") {
    await recoverRunner({
      authorityId,
      spendFile,
      journalRoot,
      resolve: true,
      afterAbandon: async () => {
        process.kill(process.pid, "SIGKILL");
      },
    });
  } else if (mode === "offer-accepted") {
    const { spend, journal } = await open();
    const policy = await RunnerPolicy.open(
      { baseUrl: "http://127.0.0.1:8765/v1", allowModels: ["local/model"] },
      { spend, env: {} },
    );
    let accepted = false;
    const loop = new RunnerGameLoop({
      policy,
      journal,
      engine: false,
      send: (message) => {
        if (message.type === "accept") accepted = true;
        return true;
      },
      advance: async () => {
        throw new Error("unexpected inference");
      },
    });
    await loop.handle(
      {
        type: "offer",
        matchId,
        version: 1,
        generation: 1,
        id: "offer-1",
        seq: 1,
        ack: 0,
        payload: { commandId: "offer-1", config, configDigest: runnerConfigDigest(config) },
      },
      new AbortController().signal,
    );
    if (!accepted || (await journal.load(matchId))?.phase !== "ready")
      throw new Error("accept not durable");
    hold();
  } else if (mode === "resume") {
    const { spend, journal } = await open();
    const policy = await RunnerPolicy.open(
      { baseUrl: "http://127.0.0.1:8765/v1", allowModels: ["local/model"] },
      { spend, env: {} },
    );
    let calls = 0;
    const sent: unknown[] = [];
    const loop = new RunnerGameLoop({
      policy,
      journal,
      engine: false,
      send: (value) => {
        sent.push(value);
        return true;
      },
      advance: async () => {
        calls++;
        throw new Error("unexpected inference");
      },
    });
    const record = await journal.load(matchId);
    if (!record || record.phase === "cancelled") throw new Error("missing game");
    const controller = new AbortController();
    let seq = 0;
    const message = (type: string, payload: unknown) =>
      ({
        type,
        payload,
        matchId,
        version: 1,
        generation: 1,
        id: `message-${++seq}`,
        seq,
        ack: 0,
      }) as Exclude<RunnerServerMessage, { type: "welcome" | "heartbeat" | "pong" }>;
    await loop.handle(
      message("offer", {
        commandId: "offer-again",
        config,
        configDigest: runnerConfigDigest(config),
      }),
      controller.signal,
    );
    const ply = matchStats(record.archive).moves;
    await loop.handle(
      message("resume", {
        commandId: "resume-again",
        acceptedSeq: ply,
        ply,
        fen: boardAt(record.archive).fen(),
      }),
      controller.signal,
    );
    await loop.handle(
      message("start", { commandId: "start-again", expectedSeq: ply }),
      controller.signal,
    );
    await loop.handle(
      message("human-move", { commandId: "human-move", uci: "g1f3", expectedSeq: ply }),
      controller.signal,
    );
    const saved = await journal.load(matchId);
    process.stdout.write(JSON.stringify({ calls, sent, record: saved }) + "\n");
    await loop.close();
  } else {
    const { spend, journal } = await open();
    const archive = createMatch(config);
    if (mode === "ready") {
      submitMove(archive, boardAt(archive), "e2e4");
      submitMove(archive, boardAt(archive), "e7e5");
    }
    await journal.save(matchId, {
      digest: runnerConfigDigest(config),
      phase: mode === "ready" ? "ready" : "uncertain",
      archive,
      confirmedPly: mode === "ready" ? 2 : 0,
    });
    if (mode === "paid" || mode === "blocked")
      await spend.reserve({
        matchId,
        requestId: "request-1",
        micros: 70,
        matchLimitMicros: 100,
        dayLimitMicros: 100,
      });
    if (mode === "blocked") {
      try {
        await spend.settle({ requestId: "request-1", micros: 71 });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "RUNNER_SPEND_SETTLEMENT") throw error;
      }
    }
    hold();
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "error" }) + "\n",
  );
  process.exitCode = 1;
}
