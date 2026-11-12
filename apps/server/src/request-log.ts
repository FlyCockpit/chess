import type { Context, Next } from "hono";

/** Route labels must never contain query credentials or auth path tokens. */
export function sanitizedRequestPath(url: string): string {
  return new URL(url).pathname.replace(/^(\/api\/auth\/reset-password\/)[^/]+/i, "$1[redacted]");
}

export async function requestLog(c: Context, next: Next) {
  const started = performance.now();
  await next();
  const duration = Math.round(performance.now() - started);
  const requestId = c.get("requestId") ?? "-";
  console.log(
    `[${requestId}] ${c.req.method} ${sanitizedRequestPath(c.req.url)} ${c.res.status} ${duration}ms`,
  );
}
