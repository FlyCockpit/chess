import { RUNNER_WS_PATH } from "@cockpit-chess/chess/runner-protocol";
import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import { resolveClientIp } from "./client-ip.js";
import type { createRunnerTransport } from "./runner-ws.js";
import type { RunnerAuthority } from "./runner-ws-authority.js";

type Transport = ReturnType<typeof createRunnerTransport>;
type Reservation = NonNullable<Awaited<ReturnType<Transport["reserve"]>>>;

/** HTTP/WS authentication boundary. Browser credentials never enter the resolver. */
export function mountRunnerWsRoutes<E extends Env>(
  app: Hono<E>,
  options: {
    ipBudget: MiddlewareHandler;
    machineBudget: (machineId: string, context: Context) => Promise<Response | undefined>;
    /** null deliberately disables live upgrades until D2a supplies the deletion fence. */
    runtime: null | {
      transport: Transport;
      authority: RunnerAuthority;
      isAvailable: () => boolean;
      upgrade: (reservation: Reservation) => MiddlewareHandler;
    };
    clientIp?: (context: Context) => string;
  },
) {
  app.use(RUNNER_WS_PATH, options.ipBudget);
  app.get(RUNNER_WS_PATH, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (
      new URL(c.req.url).search ||
      c.req.header("cookie") !== undefined ||
      c.req.header("origin") !== undefined ||
      c.req.header("sec-websocket-protocol") !== undefined
    )
      return c.json({ error: "UNAUTHORIZED" }, 401);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.json({ error: "UPGRADE_REQUIRED" }, 426);
    const runtime = options.runtime;
    if (!runtime?.isAvailable()) return c.json({ error: "UNAVAILABLE" }, 503);
    const authorization = c.req.header("authorization");
    if (!authorization || authorization.length > 128) return c.json({ error: "UNAUTHORIZED" }, 401);
    let reservation: Reservation | null = null;
    try {
      const identity = await runtime.transport.admit(() =>
        runtime.authority.resolve(authorization),
      );
      if (!identity) return c.json({ error: "UNAUTHORIZED" }, 401);
      try {
        const response = await runtime.transport.admit(() =>
          options.machineBudget(identity.machineId, c),
        );
        if (response) return response;
      } catch {
        return c.json({ error: "UNAVAILABLE" }, 503);
      }
      reservation = await runtime.transport.reserve(
        authorization,
        (options.clientIp ?? resolveClientIp)(c),
      );
      if (!reservation) return c.json({ error: "UNAVAILABLE" }, 503);
      return await runtime.upgrade(reservation)(c, next);
    } catch {
      await reservation?.release();
      return c.json({ error: "UNAVAILABLE" }, 503);
    }
  });
  return app;
}
