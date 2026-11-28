import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono } from "hono";
import { PUBLIC_FILE_CACHE_CONTROL } from "./cache-control.js";

/**
 * Production static file routes for the built web client (`apps/web/dist/client`).
 * Mounted by index.ts ahead of the SSR catch-all; everything they do not serve
 * falls through to it.
 */
export function mountStaticClient<E extends Env>(app: Hono<E>, clientDir: string): void {
  const serveClientFile = serveStatic<E>({ root: clientDir });
  const immutableAssets = new Set<string>();
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(clientDir, ".vite/manifest.json"), "utf8"),
    );
    if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)) {
      for (const chunk of Object.values(manifest)) {
        if (typeof chunk !== "object" || chunk === null) continue;
        for (const field of ["file", "css", "assets"]) {
          const value: unknown = Reflect.get(chunk, field);
          const files: unknown[] = Array.isArray(value) ? value : [value];
          for (const file of files) {
            // Public-directory copies are not in Vite's emitted-file manifest.
            // Only build-emitted, fingerprint-shaped URLs are immutable.
            if (typeof file === "string" && /^assets\/[^?#]+-[\w-]{8,}\.[^./]+$/.test(file)) {
              immutableAssets.add(`/${file}`);
            }
          }
        }
      }
    }
  } catch {
    // An incomplete/missing manifest degrades safely to short public caching.
  }
  // Only successful content-fingerprinted assets get a year. Unfingerprinted
  // files revalidate after five minutes; missing assets never get cached.
  app.use("/assets/*", async (c, next) => {
    const response = await serveClientFile(c, next);
    if (response instanceof Response) {
      response.headers.set(
        "Cache-Control",
        immutableAssets.has(c.req.path)
          ? "public, max-age=31536000, immutable"
          : PUBLIC_FILE_CACHE_CONTROL,
      );
      return response;
    }
  });
  // A file under /assets that does not exist (a chunk from another build, a
  // typo, a probe) is a plain 404. Without this it would fall through to the
  // SSR catch-all, whose locale redirect answers 307 → /<lang>/assets/... and
  // then renders the app's 404 page as HTML — a module script loader then
  // reports a MIME error instead of a missing file, and the
  // redirect could be cached instead of the file. Not cached:
  // the file may exist on the next deploy.
  app.all("/assets/*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("Not Found", 404);
  });

  // `build.manifest: true` (apps/web/vite.config.ts) writes the client Vite
  // manifest INTO the static root at `.vite/manifest.json`, and Hono's
  // serveStatic happily serves dotfile directories. That file maps every source
  // path to its hashed asset — including admin-only route chunks — and its
  // node_modules keys leak the exact installed version of every dependency,
  // which is free reconnaissance for anyone probing for a known CVE. The server
  // reads it from disk at startup; nothing needs it over HTTP. Deny it before
  // the catch-all static handler can find it. See locale-modulepreload.ts.
  app.all("/.vite/*", (c) => c.text("Not Found", 404));

  app.use("/*", async (c, next) => {
    const response = await serveClientFile(c, next);
    if (response instanceof Response) {
      // The shell and deploy version must never outlive their build. The
      // outer middleware also protects HTML, API paths and Set-Cookie.
      response.headers.set(
        "Cache-Control",
        /\/(?:index\.html|version\.json)$/.test(c.req.path) ||
          response.headers.get("Content-Type")?.startsWith("text/html")
          ? "private, no-store"
          : PUBLIC_FILE_CACHE_CONTROL,
      );
      return response;
    }
  });
}
