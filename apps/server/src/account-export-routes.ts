import {
  AccountExportError,
  assertAccountExportAuthority,
  streamAccountExport,
} from "@cockpit-chess/api/lib/account-export";
import type { Session } from "@cockpit-chess/auth";
import type { Context, Env, Hono, MiddlewareHandler } from "hono";

export const ACCOUNT_EXPORT_PATH = "/api/account/export";
const sessionOf = (c: Context) => c.get("session") as Session | null | undefined;

/** Node's adapter supplies a stream even for a POST with no body. Read zero
 * payload bytes, with a deadline, instead of mistaking that stream for data. */
async function hasEmptyBody(c: Context): Promise<boolean> {
  const length = c.req.header("content-length");
  if (length !== undefined && length !== "0") return false;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 5000);
  });
  try {
    for (let count = 0; count < 16; count++) {
      const result = await Promise.race([reader.read(), deadline]);
      if (!result) return false;
      if (result.done) return true;
      if (result.value.byteLength) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Mounted behind cookie session and expected-identity checks. Charge the
 * dedicated fail-closed budget only after CSRF and request shape validation. */
export function mountAccountExportRoutes<E extends Env>(
  app: Hono<E>,
  options: { budget: MiddlewareHandler },
) {
  app.post(ACCOUNT_EXPORT_PATH, async (c) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("Vary", "Cookie, X-Expected-User");
    c.header("X-Content-Type-Options", "nosniff");
    const session = sessionOf(c);
    if (!session?.user?.id || !session.session?.id) return c.json({ code: "UNAUTHORIZED" }, 401);
    if (c.req.header("x-csrf-token") !== "orpc") return c.json({ code: "FORBIDDEN" }, 403);

    const query = new URL(c.req.url).searchParams;
    const format = query.get("format");
    if (
      (format !== "json" && format !== "pgn") ||
      query.getAll("format").length !== 1 ||
      [...query.keys()].some((key) => key !== "format")
    )
      return c.json({ code: "BAD_REQUEST" }, 400);
    const budgetResponse = await options.budget(c, async () => {});
    if (budgetResponse) return budgetResponse;
    if (!(await hasEmptyBody(c))) return c.json({ code: "BAD_REQUEST" }, 400);

    const cancelled = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, cancelled.signal]);
    const authority = { userId: session.user.id, sessionId: session.session.id };
    let iterator: AsyncGenerator<string>;
    let first: IteratorResult<string>;
    try {
      await assertAccountExportAuthority(authority, { signal });
      iterator = streamAccountExport(authority, format, { signal });
      first = await iterator.next();
    } catch (error) {
      if (error instanceof AccountExportError) {
        switch (error.code) {
          case "UNAUTHORIZED":
            return c.json({ code: error.code }, 401);
          case "REAUTH_REQUIRED":
            return c.json({ code: error.code }, 412);
          case "FORBIDDEN":
            return c.json({ code: error.code }, 403);
          case "LIMIT_EXCEEDED":
            return c.json({ code: error.code }, 413);
          case "ABORTED":
            return c.json({ code: error.code }, 408);
        }
      }
      console.warn("[account-export] preflight unavailable");
      return c.json({ code: "UNAVAILABLE" }, 503);
    }

    const encoder = new TextEncoder();
    let pending: IteratorResult<string> | undefined = first;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const next = pending ?? (await iterator.next());
            pending = undefined;
            signal.throwIfAborted();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(next.value));
          } catch {
            cancelled.abort();
            // A partial download must fail, never become a valid completed export.
            controller.error(new Error("Account export interrupted"));
            await iterator.return(undefined);
          }
        },
        async cancel() {
          cancelled.abort();
          await iterator.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
    c.header(
      "Content-Type",
      format === "json"
        ? "application/json; charset=utf-8"
        : "application/x-chess-pgn; charset=utf-8",
    );
    c.header("Content-Disposition", `attachment; filename="cockpit-chess-account.${format}"`);
    return c.body(stream);
  });
}
