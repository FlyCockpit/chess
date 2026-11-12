import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchConfigSchema } from "@cockpit-chess/chess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "./chess-storage";
import {
  directoryAssetSource,
  getEmbeddedLocalAssets,
  registerEmbeddedLocalAssets,
} from "./local-assets";
import { startLocalChess } from "./local-server";

const html = '<html><script type="module" src="/assets/lab.js"></script></html>';
const script = 'console.log("local lab");';
const running: Awaited<ReturnType<typeof startLocalChess>>[] = [];
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cockpit-local-server-"));
  // Exercise real HTTP request/response objects without opening TCP sockets.
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    const callback = args.at(-1);
    if (typeof callback === "function") callback();
    return this;
  });
  vi.spyOn(Server.prototype, "address").mockReturnValue({
    address: "127.0.0.1",
    family: "IPv4",
    port: 43210,
  });
  vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback) {
    callback?.();
    return this;
  });
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((local) => local.close()));
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function start(options: Partial<Parameters<typeof startLocalChess>[0]> = {}) {
  const local = await startLocalChess({ port: 0, dataDir: directory, ...options });
  running.push(local);
  expect(local.server.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
  return local;
}

function request(
  server: Server,
  url: string,
  options: { method?: string; headers?: Record<string, string>; chunks?: string[] } = {},
): Promise<{ status: number; body: string; response: ServerResponse }> {
  const incoming = new IncomingMessage(new Socket());
  incoming.url = url;
  incoming.method = options.method ?? "GET";
  incoming.headers = { host: "127.0.0.1:43210", ...options.headers };
  for (const chunk of options.chunks ?? []) incoming.push(Buffer.from(chunk));
  incoming.push(null);
  const response = new ServerResponse(incoming);
  return new Promise((resolve) => {
    vi.spyOn(response, "end").mockImplementation((...args: unknown[]) => {
      const chunk = args[0];
      const body =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : "";
      resolve({ status: response.statusCode, body, response });
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") callback();
      return response;
    });
    server.emit("request", incoming, response);
  });
}

async function embeddedSource() {
  // The compile wrapper registers the same map, with loaders reading Bun's
  // embedded paths. These loaders use bytes so the tests need no Bun runtime.
  registerEmbeddedLocalAssets(
    new Map([
      ["local.html", async () => Buffer.from(html)],
      ["assets/lab.js", async () => Buffer.from(script)],
      ["assets/lab.css", async () => Buffer.from("body {}")],
      ["assets/font.woff2", async () => Buffer.from([0, 1, 2, 3])],
    ]),
  );
  const source = getEmbeddedLocalAssets();
  if (!source) throw new Error("Expected registered embedded assets");
  return source;
}

async function directorySource() {
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "local.html"), html);
  await writeFile(path.join(directory, "assets/lab.js"), script);
  await writeFile(path.join(directory, "assets/lab.css"), "body {}");
  await writeFile(path.join(directory, "assets/font.woff2"), Buffer.from([0, 1, 2, 3]));
  return directoryAssetSource(directory);
}

describe.each([
  ["embedded map", embeddedSource],
  ["directory", directorySource],
] as const)("local server with %s assets", (_name, source) => {
  it("serves entry pages and assets with content types and security headers", async () => {
    const local = await start({ assetSource: await source() });
    for (const url of ["/", "/en-US/", "/es-MX/", "/local.html"]) {
      const result = await request(local.server, url);
      expect(result.status).toBe(200);
      expect(result.body).toBe(html);
      expect(result.response.getHeader("Content-Type")).toBe("text/html; charset=utf-8");
      expect(result.response.getHeader("Cache-Control")).toBe("no-store");
      expect(result.response.getHeader("X-Content-Type-Options")).toBe("nosniff");
      expect(result.response.getHeader("X-Frame-Options")).toBe("DENY");
      expect(result.response.getHeader("Content-Security-Policy")).toContain("script-src 'self'");
    }
    const js = await request(local.server, "/assets/lab.js?v=1");
    expect(js.status).toBe(200);
    expect(js.body).toBe(script);
    expect(js.response.getHeader("Content-Type")).toBe("text/javascript");
    for (const [file, type] of [
      ["lab.css", "text/css"],
      ["font.woff2", "font/woff2"],
    ]) {
      const result = await request(local.server, `/assets/${file}`);
      expect(result.status).toBe(200);
      expect(result.response.getHeader("Content-Type")).toBe(type);
    }
    expect((await request(local.server, "/missing.js")).status).toBe(404);
  });

  it("rejects traversal before URL normalization and rejects malformed escapes", async () => {
    const assets = await source();
    const read = vi.spyOn(assets, "read");
    const local = await start({ assetSource: assets });
    read.mockClear();
    for (const url of [
      "/../local.html",
      "/%2e%2e/local.html",
      "/assets/%2e%2e/local.html",
      "/assets/..%5clocal.html",
      "/%00local.html",
      "/%ZZ",
    ]) {
      expect((await request(local.server, url)).status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
    expect(await assets.read("../local.html")).toBeUndefined();
  });

  it("rejects a wrong Host and cross-origin POST", async () => {
    const local = await start({ assetSource: await source() });
    for (const host of ["attacker.test:43210", "127.0.0.1:9999"]) {
      expect((await request(local.server, "/", { headers: { host } })).status).toBe(403);
    }
    expect(
      (
        await request(local.server, "/rpc/create", {
          method: "POST",
          headers: { origin: "https://attacker.test" },
          chunks: ["{}"],
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(local.server, "/", { headers: { host: "localhost:43210" } })).status,
    ).toBe(200);
  });

  it("rejects oversize RPC bodies from Content-Length and streamed chunks", async () => {
    const local = await start({ assetSource: await source() });
    for (const options of [
      { headers: { "content-length": "64001" }, chunks: [] },
      { chunks: ["x".repeat(32000), "x".repeat(32001)] },
    ]) {
      const result = await request(local.server, "/rpc/create", { method: "POST", ...options });
      expect(result.status).toBe(413);
      expect(result.response.getHeader("Connection")).toBe("close");
    }
  });

  it("preserves the CSRF requirement for RPC POSTs", async () => {
    const local = await start({ assetSource: await source() });
    const result = await request(local.server, "/rpc/state", { method: "POST", chunks: ["{}"] });
    expect(result.status).toBe(403);
  });
});

it("uses embedded assets by default and honors an explicit directory override", async () => {
  await embeddedSource();
  const embedded = await start();
  expect((await request(embedded.server, "/")).body).toBe(html);
  await writeFile(path.join(directory, "local.html"), "directory override");
  const disk = await start({ assetsDir: directory });
  expect((await request(disk.server, "/")).body).toBe("directory override");
  await expect(start({ assetsDir: path.join(directory, "missing") })).rejects.toThrow(
    "Local asset unavailable",
  );
});

it("fails before listening when the source has no entry page", async () => {
  await expect(start({ assetSource: { read: async () => undefined } })).rejects.toThrow(
    "Local asset unavailable",
  );
  await expect(start({ assetsDir: directory })).rejects.toThrow("Local asset unavailable");
  expect(Server.prototype.listen).not.toHaveBeenCalled();
});

const humanConfig = matchConfigSchema.parse({
  white: { name: "White", model: "human", protocol: "human" },
  black: { name: "Black", model: "human", protocol: "human" },
  rules: { engineEvaluation: "off" },
});

function createGame(server: Server) {
  return request(server, "/rpc/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "orpc" },
    chunks: [JSON.stringify({ json: humanConfig })],
  });
}

it("closes the listener after a background write rejects and shares the failed close promise", async () => {
  const failure = new Error("disk full");
  const failed = Promise.withResolvers<void>();
  vi.spyOn(storage, "writeGame").mockResolvedValueOnce(undefined).mockRejectedValue(failure);
  const local = await start({
    assetSource: await embeddedSource(),
    onError: () => failed.resolve(),
  });
  try {
    expect((await createGame(local.server)).status).toBe(200);
    await failed.promise;
    const closing = local.close();
    expect(local.close()).toBe(closing);
    expect(local.server.close).toHaveBeenCalledTimes(1);
    await expect(closing).rejects.toBe(failure);
    await expect(local.close()).rejects.toBe(failure);
    expect((await createGame(local.server)).status).toBe(503);
    expect(storage.writeGame).toHaveBeenCalledTimes(2);
  } finally {
    // The asserted rejection is retained by the idempotent close promise.
    running.splice(running.indexOf(local), 1);
    await local.close().catch(() => {});
  }
});

it("stops admission immediately, drains an admitted write and never schedules more work", async () => {
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.spyOn(storage, "writeGame").mockImplementation(async () => {
    writing.resolve();
    await release.promise;
  });
  const local = await start({ assetSource: await embeddedSource() });
  const creating = createGame(local.server);
  await writing.promise;
  const closed = vi.fn();
  const closing = local.close().then(closed);
  expect(local.server.close).toHaveBeenCalledTimes(1);
  expect((await createGame(local.server)).status).toBe(503);
  expect(closed).not.toHaveBeenCalled();
  release.resolve();
  expect((await creating).status).toBe(200);
  await closing;
  expect(closed).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledOnce();
});

it("reports both background persistence and listener close failures after cleanup", async () => {
  const failure = new Error("disk full");
  const closeFailure = new Error("close failed");
  const failed = Promise.withResolvers<void>();
  vi.spyOn(storage, "writeGame").mockResolvedValueOnce(undefined).mockRejectedValue(failure);
  const local = await start({
    assetSource: await embeddedSource(),
    onError: () => failed.resolve(),
  });
  try {
    expect((await createGame(local.server)).status).toBe(200);
    await failed.promise;
    vi.mocked(local.server.close).mockImplementation(function (this: Server, callback) {
      callback?.(closeFailure);
      return this;
    });
    const error = await local.close().catch((reason: unknown) => reason);
    expect(local.server.close).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([closeFailure, failure]);
  } finally {
    running.splice(running.indexOf(local), 1);
    await local.close().catch(() => {});
  }
});

it.skipIf(process.platform === "win32")(
  "rejects directory symlinks escaping the assets root",
  async () => {
    const root = path.join(directory, "web");
    await mkdir(root);
    await writeFile(path.join(root, "local.html"), html);
    const outside = path.join(directory, "private.txt");
    await writeFile(outside, "private");
    await symlink(outside, path.join(root, "leak.txt"));
    const local = await start({ assetsDir: root });
    expect((await request(local.server, "/leak.txt")).status).toBe(404);
    expect(await readFile(outside, "utf8")).toBe("private");
  },
);
