import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountCacheControl } from "./cache-control.js";
import { mountStaticClient } from "./static-client.js";

// The real static routes, then a stand-in for the SSR catch-all that behaves
// like the router does for any unknown, locale-less path: 307 to /en-US/...
let clientDir: string;

function buildApp() {
  const app = new Hono();
  mountCacheControl(app);
  mountStaticClient(app, clientDir);
  app.all("/*", (c) => c.redirect(`/en-US${c.req.path}`, 307));
  return app;
}

beforeAll(() => {
  clientDir = mkdtempSync(join(tmpdir(), "static-client-"));
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  mkdirSync(join(clientDir, ".vite"), { recursive: true });
  writeFileSync(join(clientDir, "assets", "app-AbCd1234.js"), "export const ok = 1;\n");
  writeFileSync(
    join(clientDir, ".vite", "manifest.json"),
    JSON.stringify({
      "app.ts": {
        file: "assets/app-AbCd1234.js",
        css: ["assets/style-AbCd1234.css"],
        assets: ["assets/font-AbCd1234.woff2", "assets/image-AbCd1234.webp"],
      },
    }),
  );
  writeFileSync(join(clientDir, "robots-static.txt"), "ok\n");
  writeFileSync(join(clientDir, "index.html"), "<html>shell</html>");
  writeFileSync(join(clientDir, "version.json"), "{}");
  writeFileSync(join(clientDir, "assets", "app.js"), "export const plain = 1;\n");
  writeFileSync(join(clientDir, "assets", "license-information.txt"), "unhashed public notice");
  writeFileSync(join(clientDir, "assets", "other-Zz999999.js"), "not emitted by this build");
  for (const name of ["style-AbCd1234.css", "font-AbCd1234.woff2", "image-AbCd1234.webp"]) {
    writeFileSync(join(clientDir, "assets", name), "asset");
  }
  mkdirSync(join(clientDir, "third-party", "stockfish"), { recursive: true });
  for (const name of ["stockfish-19.0.1-source.tar.gz", "Copying.txt", "AUTHORS", "SHA256SUMS"]) {
    writeFileSync(join(clientDir, "third-party", "stockfish", name), "public source fixture");
  }
});

afterAll(() => {
  rmSync(clientDir, { recursive: true, force: true });
});

describe("static client routes", () => {
  it("serves a hashed asset with the immutable cache header", async () => {
    const res = await buildApp().request("/assets/app-AbCd1234.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toContain("export const ok");
  });

  it("answers a missing /assets file with a plain, uncached 404 — no locale redirect", async () => {
    for (const path of [
      "/assets/missing-Zz999999.js",
      "/assets/missing.css",
      "/assets/nested/missing.js",
    ]) {
      const res = await buildApp().request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
      expect(res.headers.get("content-type"), path).toMatch(/^text\/plain/);
      expect(await res.text(), path).toBe("Not Found");
    }
    const head = await buildApp().request("/assets/missing.js", { method: "HEAD" });
    expect(head.status).toBe(404);
  });

  it.each(["style-AbCd1234.css", "font-AbCd1234.woff2", "image-AbCd1234.webp"])(
    "keeps fingerprinted %s immutable for GET and HEAD",
    async (name) => {
      for (const method of ["GET", "HEAD"]) {
        const res = await buildApp().request(`/assets/${name}`, { method });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      }
    },
  );

  it.each([
    "/assets/app.js",
    "/assets/license-information.txt",
    "/assets/other-Zz999999.js",
    "/robots-static.txt",
    "/third-party/stockfish/stockfish-19.0.1-source.tar.gz",
    "/third-party/stockfish/Copying.txt",
    "/third-party/stockfish/AUTHORS",
    "/third-party/stockfish/SHA256SUMS",
  ])("revalidates non-fingerprinted public file %s after five minutes", async (path) => {
    const res = await buildApp().request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  it.each(["/", "/index.html", "/version.json"])(
    "never caches the built shell/version at %s",
    async (path) => {
      const res = await buildApp().request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  it.each([undefined, "invalid JSON", "null", "[]"])(
    "falls back to short caching for a missing or malformed manifest (%s)",
    async (manifest) => {
      const incompleteDir = mkdtempSync(join(tmpdir(), "static-client-incomplete-"));
      try {
        mkdirSync(join(incompleteDir, "assets"));
        writeFileSync(join(incompleteDir, "assets/app-AbCd1234.js"), "asset");
        if (manifest !== undefined) {
          mkdirSync(join(incompleteDir, ".vite"));
          writeFileSync(join(incompleteDir, ".vite/manifest.json"), manifest);
        }
        const app = new Hono();
        mountCacheControl(app);
        mountStaticClient(app, incompleteDir);
        const res = await app.request("/assets/app-AbCd1234.js");
        expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
        expect(await res.text()).toBe("asset");
      } finally {
        rmSync(incompleteDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps partial asset downloads immutable but never caches invalid ranges", async () => {
    const partial = await buildApp().request("/assets/app-AbCd1234.js", {
      headers: { range: "bytes=0-3" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await partial.text()).toBe("expo");
    const invalid = await buildApp().request("/assets/app-AbCd1234.js", {
      headers: { range: "bytes=9999-" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("cache-control")).toBe("private, no-store");
  });

  it("denies the .vite manifest and leaves other paths to the SSR catch-all", async () => {
    const app = buildApp();
    expect((await app.request("/.vite/manifest.json")).status).toBe(404);
    expect((await app.request("/robots-static.txt")).status).toBe(200);
    const page = await app.request("/pricing");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("/en-US/pricing");
  });
});
