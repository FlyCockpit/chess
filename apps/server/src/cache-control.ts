import type { Env, Hono } from "hono";

// Five minutes bounds stale public files across deploys; stale copies must be
// revalidated, including when the origin is unavailable.
export const PUBLIC_FILE_CACHE_CONTROL = "public, max-age=300, must-revalidate";

function privateNoStore(existing: string | null): string {
  // Retain stricter route directives (e.g. no-cache, max-age=0) while removing
  // conflicting permissions to cache. Never retain a shared-cache override.
  const directives = (existing ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => {
      const name = directive.split("=", 1)[0]?.toLowerCase();
      return (
        name !== "public" &&
        name !== "immutable" &&
        name !== "s-maxage" &&
        name !== "stale-while-revalidate" &&
        name !== "stale-if-error" &&
        (name !== "max-age" || /^max-age\s*=\s*"?0"?$/i.test(directive))
      );
    });
  if (!directives.some((directive) => directive.toLowerCase() === "private")) {
    directives.unshift("private");
  }
  if (!directives.some((directive) => directive.toLowerCase() === "no-store")) {
    directives.push("no-store");
  }
  return directives.join(", ");
}

/** Mount before all routes, so early errors and downstream headers are covered. */
export function mountCacheControl<E extends Env>(app: Hono<E>): void {
  app.use("/*", async (c, next) => {
    await next();
    const existing = c.res.headers.get("Cache-Control");
    const path = c.req.path;
    const isDynamic =
      /^\/(?:api|rpc)(?:\/|$)/i.test(path) ||
      /^\/(?:ready|health)\/?$/i.test(path) ||
      path === "/version.json" ||
      /(?:text\/html|application\/xhtml\+xml)/i.test(c.res.headers.get("Content-Type") ?? "");
    const isPublicFileResponse =
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      (c.res.status === 200 || c.res.status === 206 || c.res.status === 304);
    if (
      isDynamic ||
      c.res.headers.has("Set-Cookie") ||
      !isPublicFileResponse ||
      !existing ||
      /(?:^|,)\s*(?:private|no-store)(?:\s|,|=|$)/i.test(existing)
    ) {
      c.header("Cache-Control", privateNoStore(existing));
    }
  });
}
