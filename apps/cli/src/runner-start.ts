import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { RUNNER_WS_PATH } from "@cockpit-chess/chess/runner-protocol";
import { z } from "zod";

import { t } from "./chess-i18n";
import { loadConfig, resolveServer } from "./config";
import { CliError, ExitCode } from "./exit";
import { withNetworkDeadline } from "./network";
import { configDir } from "./paths";
import { RunnerConnection, type RunnerConnectionOptions } from "./runner-connection";
import { probeRunnerEngine } from "./runner-engine";
import { RunnerGameLoop } from "./runner-game";
import { openRunnerJournal, type RunnerJournal } from "./runner-journal";
import {
  RunnerLimitController,
  type RunnerLimitPolicy,
  type RunnerLimitStore,
  runnerLimitFileStore,
} from "./runner-limits";
import { createNodeRunnerSocket } from "./runner-node-socket";
import { RunnerPolicy, RunnerPolicyError, readLocalRunnerOptions } from "./runner-policy";

const CLAIM_MS = 600_000;
const REQUEST_MS = 10_000;
const BODY_BYTES = 16_384;
const MAX_ATTEMPTS = 300;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const proof = z.string().regex(/^[a-f0-9]{64}$/);
const expiresAt = z.iso.datetime({ offset: true });
const claimant = z.object({ email: z.string().min(1).max(320) }).strict();
const controlPath = z.literal("/en-US/settings/cli");
const beginSchema = z
  .object({ claimId: id, claimToken: proof, expiresAt, pollIntervalMs: z.literal(2000) })
  .strict();
const pollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("claimed"), claimant, controlPath }).strict(),
]);
const exchangeSchema = z
  .object({
    machineId: id,
    credential: z.string().regex(/^[\x21-\x7e]{1,4096}$/),
    expiresAt,
    claimant,
    controlPath,
  })
  .strict();
const pendingSchema = z
  .object({ origin: z.url(), proof, deadline: z.number().int().positive(), claimId: id.optional() })
  .strict();
const credentialSchema = exchangeSchema.extend({ origin: z.url() }).strict();
export type PendingRunnerClaim = z.infer<typeof pendingSchema>;
type RunnerCredential = z.infer<typeof exchangeSchema>;

export type RunnerStartupFlags = {
  server?: string;
  resume?: string;
  maxMatchUsd?: string;
  maxDayUsd?: string;
  maxConcurrency?: string;
  providerUrl?: string;
  allowModel?: string[];
};
export type RunnerCeilings = Readonly<{
  matchMicros: number;
  dayMicros: number;
  concurrency: number;
}>;
export interface RunnerStore {
  savePending(run: PendingRunnerClaim): Promise<void>;
  saveCredential(origin: string, value: RunnerCredential): Promise<void>;
  loadCredential(origin: string, machineId: string): Promise<RunnerCredential | undefined>;
  removePending(run: PendingRunnerClaim): Promise<void>;
}
export interface RunnerExecution {
  hardLimits: RunnerCeilings;
  limitPolicy: RunnerLimitPolicy;
  settleLimits(): Promise<void>;
  startupNotice(): string;
  open(
    origin: string,
    machineId: string,
    send: ConstructorParameters<typeof RunnerGameLoop>[0]["send"],
    signal: AbortSignal,
  ): Promise<Pick<RunnerGameLoop, "hello" | "handle">>;
  close(): Promise<void>;
}

/** Initialization is separate from pairing so tests never read provider keys or local state. */
export interface RunnerStartupIO {
  initialize(flags: RunnerStartupFlags, signal: AbortSignal): Promise<RunnerExecution>;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  makeProof(): string;
  /** Must be a private terminal, never stdout or a general logger. */
  terminal(message: string): void;
  store: RunnerStore;
  connect(options: RunnerConnectionOptions): Pick<RunnerConnection, "start" | "stop" | "send">;
  signal: AbortSignal;
  /** Tests use private stores; production persists per-origin/machine receipts. */
  limitsStore?: (origin: string, machineId: string) => Promise<RunnerLimitStore>;
}

function message(key: string, defaultValue: string, values: Record<string, string | number> = {}) {
  return t(`cli:runner.${key}`, { defaultValue, ...values });
}
function failure() {
  return new CliError(
    message(
      "failed",
      "Runner startup failed. Retry with a new run, or explicitly resume an existing machine.",
    ),
  );
}

/** Legacy E1L parser retained for its tests; startup authority comes only from RunnerPolicy. */
export function parseRunnerCeilings(flags: RunnerStartupFlags): RunnerCeilings {
  const money = (value: string) => {
    if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(value)) throw new Error();
    const [whole = "", fraction = ""] = value.split(".");
    const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
    if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error();
    return micros;
  };
  try {
    const concurrency = flags.maxConcurrency ?? "8";
    if (!/^\d{1,2}$/.test(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 64)
      throw new Error();
    return Object.freeze({
      matchMicros: money(flags.maxMatchUsd ?? "25"),
      dayMicros: money(flags.maxDayUsd ?? "100"),
      concurrency: Number(concurrency),
    });
  } catch {
    throw new CliError(
      message(
        "invalidLimits",
        "Use positive USD amounts with at most six decimal places and concurrency from 1 to 64.",
      ),
      ExitCode.Usage,
    );
  }
}

/** Strip C0/C1, OSC/CSI payloads and bidi formatting before writing untrusted identity to a terminal. */
export function terminalClaimant(email: string): string {
  return Array.from(stripVTControlCharacters(email))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code >= 32 &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      );
    })
    .join("");
}

class RetryRequest extends Error {}
async function request<T>(
  origin: string,
  action: "begin" | "poll" | "exchange",
  body: unknown,
  schema: z.ZodType<T>,
  deadline: number,
  io: RunnerStartupIO,
): Promise<T> {
  const remaining = deadline - io.now();
  if (remaining <= 0) throw failure();
  try {
    return await withNetworkDeadline(
      async (signal) => {
        const response = await io.fetch(`${origin}/api/cli/runner/${action}`, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (response.status === 429 || response.status >= 500) {
          void response.body?.cancel().catch(() => {});
          throw new RetryRequest();
        }
        if (
          !response.ok ||
          response.redirected ||
          (response.url && response.url !== `${origin}/api/cli/runner/${action}`)
        ) {
          void response.body?.cancel().catch(() => {});
          throw failure();
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
          void response.body?.cancel().catch(() => {});
          throw failure();
        }
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > BODY_BYTES)) {
          void response.body?.cancel().catch(() => {});
          throw failure();
        }
        if (!response.body) throw failure();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > BODY_BYTES) throw failure();
            chunks.push(chunk.value);
          }
          let data: unknown;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw failure();
          }
          const parsed = schema.safeParse(data);
          if (!parsed.success) throw failure();
          return parsed.data;
        } catch (error) {
          cancel();
          if (error instanceof CliError) throw error;
          signal.throwIfAborted();
          throw new RetryRequest();
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      },
      Math.min(REQUEST_MS, remaining),
      io.signal,
    );
  } catch (error) {
    if (io.signal.aborted || error instanceof CliError) throw failure();
    // Transport errors never escape: they may contain the proof-bearing request body.
    throw new RetryRequest();
  }
}

/** Same proof and claim are used for every retry, including a lost exchange response. */
export async function completeRunnerClaim(
  run: PendingRunnerClaim,
  io: RunnerStartupIO,
): Promise<RunnerCredential> {
  if (
    !pendingSchema.safeParse(run).success ||
    !run.claimId ||
    run.deadline > io.now() + CLAIM_MS ||
    resolveServer({}, run.origin) !== run.origin
  )
    throw failure();
  let claimed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && io.now() < run.deadline; attempt++) {
    io.signal.throwIfAborted();
    try {
      if (!claimed) {
        const status = await request(
          run.origin,
          "poll",
          { claimId: run.claimId, proof: run.proof },
          pollSchema,
          run.deadline,
          io,
        );
        claimed = status.status === "claimed";
      }
      if (claimed) {
        const credential = await request(
          run.origin,
          "exchange",
          { claimId: run.claimId, proof: run.proof },
          exchangeSchema,
          run.deadline,
          io,
        );
        if (Date.parse(credential.expiresAt) <= io.now()) throw failure();
        await io.store.saveCredential(run.origin, credential);
        await io.store.removePending(run);
        return credential;
      }
    } catch (error) {
      if (!(error instanceof RetryRequest)) throw failure();
    }
    await io.sleep(Math.min(2000, Math.max(0, run.deadline - io.now())));
  }
  throw new CliError(
    message("expired", "Runner claim expired or could not be completed. Start a new run."),
  );
}

export async function startRunner(origin: string, flags: RunnerStartupFlags, io: RunnerStartupIO) {
  let execution: RunnerExecution | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    io.signal.throwIfAborted();
    if (resolveServer({}, origin) !== origin) throw failure();
    execution = await io.initialize(flags, io.signal);
    io.signal.throwIfAborted();
    const startupNotice = execution.startupNotice();
    io.terminal(startupNotice);
    let credential: RunnerCredential;
    if (flags.resume !== undefined) {
      if (!id.safeParse(flags.resume).success) throw failure();
      const stored = await io.store.loadCredential(origin, flags.resume);
      if (
        !stored ||
        !exchangeSchema.safeParse(stored).success ||
        stored.machineId !== flags.resume ||
        Date.parse(stored.expiresAt) <= io.now()
      ) {
        throw new CliError(
          message(
            "missing",
            "No unexpired runner credential for this machine at this server. Start a new run.",
          ),
          ExitCode.Unauthenticated,
        );
      }
      credential = stored;
    } else {
      const run: PendingRunnerClaim = {
        origin,
        proof: proof.parse(io.makeProof()),
        deadline: io.now() + CLAIM_MS,
      };
      await io.store.savePending(run);
      // Begin is deliberately single-shot. Never create a second claim after an ambiguous response.
      const started = await request(
        origin,
        "begin",
        { proof: run.proof },
        beginSchema,
        run.deadline,
        io,
      );
      const expiry = Date.parse(started.expiresAt);
      if (expiry <= io.now() || expiry > io.now() + CLAIM_MS) throw failure();
      run.claimId = started.claimId;
      run.deadline = Math.min(run.deadline, expiry);
      await io.store.savePending(run);
      io.terminal(
        message("claim", "Claim this run within 10 minutes:\n{{url}}", {
          url: `${origin}/en-US/runner/claim#runner-claim=${started.claimToken}`,
        }),
      );
      credential = await completeRunnerClaim(run, io);
    }
    io.terminal(
      message("claimed", "Claimed by {{email}}. Controls: {{url}}", {
        email: terminalClaimant(credential.claimant.email),
        url: `${origin}${credential.controlPath}`,
      }),
    );
    io.signal.throwIfAborted();
    const limits = await RunnerLimitController.open({
      hard: execution.hardLimits,
      store: await (io.limitsStore ?? runnerLimitFileStore)(origin, credential.machineId),
      terminal: io.terminal,
      policy: execution.limitPolicy,
    });
    const restoredNotice = execution.startupNotice();
    if (restoredNotice !== startupNotice) io.terminal(restoredNotice);
    // Construction cannot invoke send: E2 begins callbacks only after start().
    let connection: ReturnType<RunnerStartupIO["connect"]> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let pendingLimits: Promise<void> = Promise.resolve();
    let stopped = false;
    let released = false;
    let transportFailed = false;
    let initialized = () => {};
    const initialization = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    let resolveClosed = () => {};
    let rejectClosed: (error: CliError) => void = () => {};
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    void closed.catch(() => {});
    const localExecution = execution;
    const detach = () => {
      released = true;
      clearTimeout(expiryTimer);
      io.signal.removeEventListener("abort", stop);
    };
    const finish = (): Promise<void> => {
      if (closing) return closing;
      stopped = true;
      clearTimeout(expiryTimer);
      // Yield until setup has either acquired all its handles or failed. In
      // particular, never close a journal while execution.open is acquiring it.
      closing = (async () => {
        await initialization;
        let limitFailure = false;
        try {
          await pendingLimits;
        } catch {
          limitFailure = true;
        }
        // Limits may still be applying to policy until the preceding work ends.
        await localExecution.close();
        if (limitFailure) throw failure();
        await cancellation;
        // Keep local cancellation installed through game writes AND release
        // preparation. The store invokes detach synchronously after unlocking.
        await limits.close(detach);
        // A stop queued during close must settle before lifetime completion.
        await cancellation;
        await limits.close(detach);
      })().catch(() => {
        throw failure();
      });
      void closing.then(
        () => (transportFailed ? rejectClosed(failure()) : resolveClosed()),
        () => rejectClosed(failure()),
      );
      return closing;
    };
    function stop() {
      if (released) return;
      // Mark durable stop intent and abort policy synchronously, even when
      // transport-terminal cleanup already started and is awaiting a write.
      cancellation ??= limits.stop();
      void cancellation.catch(() => {});
      if (!stopped) {
        stopped = true;
        connection?.stop();
      }
      void finish().catch(() => {});
    }
    const terminal = () => {
      if (!stopped) {
        transportFailed = true;
        stopped = true;
        connection?.stop();
      }
      return finish();
    };
    cleanup = async () => {
      stop();
      await finish();
    };
    io.signal.addEventListener("abort", stop);
    try {
      if (io.signal.aborted) stop();
      io.signal.throwIfAborted();
      const game = await execution.open(
        origin,
        credential.machineId,
        (action, signal) => connection?.send(action, signal) ?? false,
        io.signal,
      );
      io.signal.throwIfAborted();
      io.terminal(
        message("waiting", "Connecting runner transport. Local match execution is ready."),
      );
      const url = new URL(RUNNER_WS_PATH, origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      connection = io.connect({
        url: url.href,
        credential: credential.credential,
        allowLocalhostWs: url.protocol === "ws:",
        socketFactory: createNodeRunnerSocket,
        hello: () => ({ ...game.hello, ...limits.snapshot() }),
        onTerminal: terminal,
        onMessage: async (incoming, signal) => {
          if (stopped || signal.aborted || io.signal.aborted) return;
          if (incoming.type === "limits") {
            const task = (async () => {
              const result = await limits.apply(incoming.payload);
              await localExecution.settleLimits();
              if (!stopped && !signal.aborted && !io.signal.aborted)
                connection?.send({ type: "limits-result", payload: result }, signal);
            })();
            pendingLimits = Promise.allSettled([pendingLimits, task]).then((results) => {
              if (results.some((result) => result.status === "rejected")) throw failure();
            });
            void pendingLimits.catch(() => {});
            try {
              await task;
            } catch {
              throw failure();
            }
            return;
          }
          // Provider work remains background work owned by the game loop.
          await game.handle(incoming, signal);
        },
        onState: (state) => {
          if (state === "stopped") void terminal().catch(() => {});
        },
      });
      const armExpiry = () => {
        const remaining = Date.parse(credential.expiresAt) - io.now();
        if (remaining <= 0) stop();
        else {
          expiryTimer = setTimeout(armExpiry, Math.min(2_147_483_647, remaining));
          expiryTimer.unref();
        }
      };
      armExpiry();
      if (!stopped) connection.start();
    } finally {
      initialized();
    }
    return { stop, closed };
  } catch (error) {
    try {
      if (cleanup) await cleanup();
      else await execution?.close();
    } catch {
      throw failure();
    }
    if (error instanceof CliError) throw error;
    if (error instanceof RunnerPolicyError) throw new CliError(error.message);
    throw failure();
  }
}

/** Unique files avoid config read/modify/write races with companion commands and other runs. */
export function runnerFileStore(root = configDir()): RunnerStore {
  const directory = (origin: string) =>
    join(root, "runner-runs", createHash("sha256").update(origin).digest("hex"));
  const pendingPath = (run: PendingRunnerClaim) =>
    join(
      directory(run.origin),
      `pending-${createHash("sha256").update(run.proof).digest("hex")}.json`,
    );
  const atomic = async (path: string, origin: string, value: unknown) => {
    await mkdir(directory(origin), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
      await file.close();
      await rename(tmp, path);
      if (process.platform !== "win32") await chmod(path, 0o600);
    } catch {
      await file.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw failure();
    }
  };
  return {
    savePending: (run) => atomic(pendingPath(run), run.origin, pendingSchema.parse(run)),
    saveCredential: (origin, value) =>
      atomic(
        join(directory(origin), `${id.parse(value.machineId)}.json`),
        origin,
        credentialSchema.parse({ ...value, origin }),
      ),
    loadCredential: async (origin, machineId) => {
      const path = join(directory(origin), `${id.parse(machineId)}.json`);
      try {
        if ((await stat(path)).size > BODY_BYTES) throw failure();
        const value = credentialSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (value.origin !== origin || value.machineId !== machineId) throw failure();
        const { origin: _origin, ...credential } = value;
        return credential;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw failure();
      }
    },
    removePending: (run) => unlink(pendingPath(run)),
  };
}

/** Only explicitly supplied flags participate in the local file merge. */
export function localRunnerOverrides(flags: RunnerStartupFlags) {
  const overrides: Parameters<typeof readLocalRunnerOptions>[0] = {};
  if (flags.providerUrl !== undefined) overrides.baseUrl = flags.providerUrl;
  if (flags.allowModel !== undefined) overrides.allowModels = flags.allowModel;
  if (flags.maxMatchUsd !== undefined) overrides.maxMatchUsd = flags.maxMatchUsd;
  if (flags.maxDayUsd !== undefined) overrides.maxDayUsd = flags.maxDayUsd;
  if (flags.maxConcurrency !== undefined) {
    if (!/^\d+$/.test(flags.maxConcurrency) || !Number.isSafeInteger(Number(flags.maxConcurrency)))
      throw new CliError(t("cli:runnerConfig"), ExitCode.Usage);
    overrides.maxConcurrent = Number(flags.maxConcurrency);
  }
  return overrides;
}

/** The real local executor, kept behind the startup IO seam. */
export async function initializeRunnerExecution(
  flags: RunnerStartupFlags,
  signal: AbortSignal,
): Promise<RunnerExecution> {
  const options = await readLocalRunnerOptions(localRunnerOverrides(flags));
  signal.throwIfAborted();
  const policy = await RunnerPolicy.open(options, { signal });
  let journal: RunnerJournal | undefined;
  let game: RunnerGameLoop | undefined;
  let closing: Promise<void> | undefined;
  let settlement: Promise<void> = Promise.resolve();
  const stopActive = () => {
    if (!game) return;
    // stopActive aborts immediately, then joins the serialized journal fence.
    settlement = Promise.allSettled([settlement, game.stopActive()]).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw failure();
    });
    void settlement.catch(() => {});
  };
  return {
    hardLimits: Object.freeze(policy.capabilities().hard),
    limitPolicy: {
      restoreOperatingLimits: (limits) => policy.restoreOperatingLimits(limits),
      applyOperatingLimits: (limits, revision) => {
        const previous = policy.capabilities().operating;
        policy.applyOperatingLimits(limits, revision);
        if (
          limits.matchMicros < previous.matchMicros ||
          limits.dayMicros < previous.dayMicros ||
          limits.concurrency < previous.concurrency
        )
          stopActive();
      },
      stopOperatingLimits: () => {
        policy.stopOperatingLimits();
        stopActive();
      },
    },
    settleLimits: () => settlement,
    startupNotice: () => policy.startupNotice(),
    open: async (_origin, _machineId, send, sessionSignal) => {
      sessionSignal.throwIfAborted();
      // New claims, websites and config directories cannot erase a prior uncertain turn.
      journal = await openRunnerJournal(
        "local-spending-authority",
        policy.journalScope(),
        join(homedir(), ".cockpit-chess"),
      );
      sessionSignal.throwIfAborted();
      const engine = await probeRunnerEngine(sessionSignal);
      sessionSignal.throwIfAborted();
      game = new RunnerGameLoop({ policy, journal, engine, send });
      return game;
    },
    close: () =>
      (closing ??= (async () => {
        if (game) {
          // The loop owns both handles once constructed, including failed shutdown.
          try {
            const results = await Promise.allSettled([settlement, game.close()]);
            if (results.some((result) => result.status === "rejected")) throw failure();
          } catch {
            throw failure();
          }
          return;
        }
        const results = await Promise.allSettled([policy.close(), journal?.close()]);
        if (results.some((result) => result.status === "rejected")) throw failure();
      })()),
  };
}

export interface RunnerStartupEnvironment {
  isPrivateTerminal(): boolean;
  origin(flags: RunnerStartupFlags): Promise<string>;
  io: Omit<RunnerStartupIO, "signal">;
}

export async function runRunnerStartup(
  flags: RunnerStartupFlags,
  environment?: RunnerStartupEnvironment,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Repeated signals remain handled until durable local release completes.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const cleanup = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  let releasePending = false;
  try {
    if (!(environment ? environment.isPrivateTerminal() : process.stderr.isTTY))
      throw new CliError(
        message(
          "terminal",
          "Start the runner from a private terminal so claim links and account details are not written to logs.",
        ),
        ExitCode.Usage,
      );
    const origin = environment
      ? await environment.origin(flags)
      : resolveServer(await loadConfig(), flags.server);
    const io: RunnerStartupIO = environment
      ? { ...environment.io, signal: controller.signal }
      : {
          initialize: initializeRunnerExecution,
          fetch: (...args) => fetch(...args),
          now: Date.now,
          makeProof: () => randomBytes(32).toString("hex"),
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, ms);
              controller.signal.addEventListener("abort", done, { once: true });
              if (controller.signal.aborted) done();
            }),
          signal: controller.signal,
          terminal: (value) => {
            process.stderr.write(`${value}\n`);
          },
          store: runnerFileStore(),
          connect: (options) => new RunnerConnection(options),
        };
    const openLimitsStore = io.limitsStore ?? runnerLimitFileStore;
    io.limitsStore = async (origin, machineId) => {
      const store = await openLimitsStore(origin, machineId);
      releasePending = true;
      return {
        ...store,
        close: (beforeRelease, afterRelease) =>
          store.close(beforeRelease, () => {
            afterRelease?.();
            releasePending = false;
            cleanup();
          }),
      };
    };
    const runner = await startRunner(origin, flags, io);
    await runner.closed;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof RunnerPolicyError) throw new CliError(error.message);
    throw failure();
  } finally {
    if (!releasePending) cleanup();
  }
}
