import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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
import { createNodeRunnerSocket } from "./runner-node-socket";

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
export interface RunnerStartupIO {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  makeProof(): string;
  /** Must be a private terminal, never stdout or a general logger. */
  terminal(message: string): void;
  store: RunnerStore;
  connect(options: RunnerConnectionOptions): Pick<RunnerConnection, "start" | "stop" | "send">;
  signal: AbortSignal;
}

function message(key: string, defaultValue: string, values: Record<string, string | number> = {}) {
  return t(`cli.runner.${key}`, { defaultValue, ...values });
}
function failure() {
  return new CliError(
    message(
      "failed",
      "Runner startup failed. Retry with a new run, or explicitly resume an existing machine.",
    ),
  );
}

/** Integer micros, without accepting exponent syntax, Infinity, negatives or fractional micros. */
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
  try {
    io.signal.throwIfAborted();
    if (resolveServer({}, origin) !== origin) throw failure();
    const ceilings = parseRunnerCeilings(flags);
    io.terminal(
      message(
        "ceilings",
        "Local ceilings: {{match}}/match, {{day}}/day, concurrency {{concurrency}}.",
        {
          match: `$${ceilings.matchMicros / 1_000_000}`,
          day: `$${ceilings.dayMicros / 1_000_000}`,
          concurrency: ceilings.concurrency,
        },
      ),
    );
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
    io.terminal(
      message(
        "waiting",
        "Connecting runner transport. Match execution is not available in this build.",
      ),
    );
    const operatingLimits = Object.freeze({
      matchMicros: Math.min(1_000_000, ceilings.matchMicros),
      dayMicros: Math.min(10_000_000, ceilings.dayMicros),
      concurrency: Math.min(2, ceilings.concurrency),
      revision: 0,
    });
    const url = new URL(RUNNER_WS_PATH, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const connection = io.connect({
      url: url.href,
      credential: credential.credential,
      allowLocalhostWs: url.protocol === "ws:",
      socketFactory: createNodeRunnerSocket,
      hello: { models: [], engine: false, operatingLimits },
      onMessage: (incoming, signal) => {
        if (incoming.type === "offer")
          connection.send(
            {
              type: "reject",
              matchId: incoming.matchId,
              payload: { commandId: incoming.payload.commandId, reason: "unsupported" },
            },
            signal,
          );
        else if (!["ack", "error"].includes(incoming.type)) {
          if (incoming.type === "limits")
            io.terminal(
              message(
                "limitsRejected",
                "Operating limit revision {{revision}} rejected: updates are unavailable in this build.",
                { revision: incoming.payload.revision },
              ),
            );
          connection.send({ type: "error", payload: { code: "UNSUPPORTED" } }, signal);
        }
      },
    });
    const stop = () => {
      clearTimeout(expiryTimer);
      io.signal.removeEventListener("abort", stop);
      connection.stop();
    };
    const expiryTimer = setTimeout(
      stop,
      Math.min(2_147_483_647, Date.parse(credential.expiresAt) - io.now()),
    );
    expiryTimer.unref();
    io.signal.addEventListener("abort", stop, { once: true });
    if (io.signal.aborted) stop();
    else connection.start();
    return connection;
  } catch (error) {
    if (error instanceof CliError) throw error;
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

export async function runRunnerStartup(flags: RunnerStartupFlags): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const cleanup = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  try {
    if (!process.stderr.isTTY)
      throw new CliError(
        message(
          "terminal",
          "Start the runner from a private terminal so claim links and account details are not written to logs.",
        ),
        ExitCode.Usage,
      );
    const config = await loadConfig();
    const origin = resolveServer(config, flags.server);
    const store = runnerFileStore();
    await startRunner(origin, flags, {
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
      store,
      connect: (options) =>
        new RunnerConnection({
          ...options,
          onState: (state) => {
            if (state === "stopped") cleanup();
          },
        }),
    });
  } catch (error) {
    cleanup();
    if (error instanceof CliError) throw error;
    throw failure();
  }
}
