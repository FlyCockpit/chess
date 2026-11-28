import {
  RunnerClaimNotFoundError,
  runnerClaimBeginSchema,
  runnerClaimProofSchema,
  runnerClaimService,
} from "@cockpit-chess/auth/runner-claim";
import {
  RunnerMachineInputError,
  RunnerMachineLimitError,
} from "@cockpit-chess/auth/runner-machine";
import type { Context, Env, Hono, MiddlewareHandler } from "hono";

export const RUNNER_CLAIM_BODY_MAX_BYTES = 1024;
const BODY_TIMEOUT_MS = 5000;
const basePath = "/api/cli/runner";
type Service = Pick<typeof runnerClaimService, "begin" | "poll" | "exchange">;

class BodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super("BAD_REQUEST");
  }
}

/** Count actual stream bytes, even with a false Content-Length. Bound read time
 * before JSON parsing; never buffer a general archive-sized request here.
 */
async function readBody(c: Context): Promise<unknown> {
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new BodyError(400);
  const length = c.req.header("content-length");
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > RUNNER_CLAIM_BODY_MAX_BYTES)
  )
    throw new BodyError(413);
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new BodyError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyError(408)), BODY_TIMEOUT_MS);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > RUNNER_CLAIM_BODY_MAX_BYTES) throw new BodyError(413);
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new BodyError(400);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Dedicated CLI proof surface. Each budget MUST be independently keyed,
 * distributed and fail closed (no insurance limiter). No cookie/bearer fallback.
 */
export function mountRunnerClaimRoutes<E extends Env>(
  app: Hono<E>,
  options: {
    budgets: { begin: MiddlewareHandler; poll: MiddlewareHandler; exchange: MiddlewareHandler };
    service?: Service;
  },
) {
  const service = options.service ?? runnerClaimService;
  for (const action of ["begin", "poll", "exchange"] as const) {
    const path = `${basePath}/${action}`;
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      c.header("Referrer-Policy", "no-referrer");
      try {
        return await options.budgets[action](c, next);
      } catch {
        return c.json({ error: "UNAVAILABLE" }, 503);
      }
    });
    app.all(path, async (c) => {
      if (c.req.method !== "POST")
        return c.json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
      if (
        new URL(c.req.url).search ||
        c.req.header("cookie") !== undefined ||
        c.req.header("origin") !== undefined ||
        c.req.header("authorization") !== undefined
      )
        return c.json({ error: "UNAUTHORIZED" }, 401);
      try {
        const body = await readBody(c);
        if (action === "begin") {
          const parsed = runnerClaimBeginSchema.safeParse(body);
          if (!parsed.success) return c.json({ error: "BAD_REQUEST" }, 400);
          return c.json(await service.begin(parsed.data));
        }
        const parsed = runnerClaimProofSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: "BAD_REQUEST" }, 400);
        return c.json(await service[action](parsed.data));
      } catch (error) {
        if (error instanceof BodyError) return c.json({ error: "BAD_REQUEST" }, error.status);
        if (error instanceof RunnerClaimNotFoundError) return c.json({ error: "NOT_FOUND" }, 404);
        if (error instanceof RunnerMachineInputError) return c.json({ error: "BAD_REQUEST" }, 400);
        if (error instanceof RunnerMachineLimitError)
          return c.json({ error: "TOO_MANY_REQUESTS" }, 429, { "Retry-After": "2" });
        // No SQL error object reaches logging or a client: it could contain proof.
        return c.json({ error: "UNAVAILABLE" }, 503);
      }
    });
  }
  return app;
}
