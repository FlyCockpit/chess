import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  boardAt,
  createMatch,
  finishMatch,
  type MatchArchive,
  matchConfigSchema,
  submitMove,
} from "@cockpit-chess/chess";
import type { LocalState } from "@cockpit-chess/chess/local-contract";
import {
  endAtArchiveLimit,
  evaluateAfterMove,
  type MatchRunnerOptions,
  runMatch,
} from "@cockpit-chess/chess/runner";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { z } from "zod";
import { t } from "./chess-i18n";
import {
  assertEngineSupported,
  type LocalProviderOptions,
  localCredentials,
  ProviderConfigError,
  providerReady,
} from "./chess-provider";
import { writeGame } from "./chess-storage";
import {
  directoryAssetSource,
  getEmbeddedLocalAssets,
  isLocalAssetPath,
  type LocalAssetSource,
} from "./local-assets";

const MAX_BODY_BYTES = 64000;
class BodyTooLargeError extends Error {}
async function requestBody(request: IncomingMessage) {
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES)
    throw new BodyTooLargeError(t("cli.message34"));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError(t("cli.message34"));
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
// The bundle (apps/web/dist-local) is same-origin module scripts and
// stylesheets with no inline scripts; styles stay inline-permissive because
// React and Motion set element styles at runtime.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
export async function startLocalChess(
  options: LocalProviderOptions & {
    port: number;
    dataDir: string;
    assetsDir?: string;
    assetSource?: LocalAssetSource;
    onError?: (message: string) => void;
  },
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  let assets: LocalAssetSource;
  try {
    assets =
      options.assetSource ??
      (options.assetsDir
        ? await directoryAssetSource(options.assetsDir)
        : (getEmbeddedLocalAssets() ??
          (await directoryAssetSource(
            fileURLToPath(new URL("../../web/dist-local", import.meta.url)),
          ))));
    if (!(await assets.read("local.html"))) throw new Error(t("cli.assetUnavailable"));
  } catch {
    throw new Error(t("cli.assetUnavailable"));
  }
  let match = createMatch({
    title: t("lab.baseline"),
    white: { name: t("lab.human"), model: "human", protocol: "human" },
    black: { name: t("lab.random"), model: "random", protocol: "random" },
    rules: {},
  });
  let busy = false;
  let controller = new AbortController();
  let active: Promise<void> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const requests = new Set<Promise<unknown>>();
  let memory: MatchRunnerOptions["memory"] = {};
  const state = (): LocalState => ({
    match,
    busy,
    providerReady: providerReady(options.baseUrl),
  });
  const persist = (record: MatchArchive) =>
    writeGame(path.join(options.dataDir, `${record.id}.json`), record);
  async function advance() {
    if (busy || match.status !== "running") return;
    busy = true;
    try {
      const credentials = await localCredentials(match, options, controller.signal);
      await runMatch(match, { credentials, memory, signal: controller.signal, onUpdate: persist });
    } catch (error) {
      // A user Stop already finished the match; keep its result and stay quiet.
      if (match.status === "running") {
        finishMatch(match, "*", "provider-error", "error");
        options.onError?.(
          error instanceof ProviderConfigError ? error.message : t("cli.inferenceFailed"),
        );
      }
    } finally {
      busy = false;
      await persist(match);
    }
  }
  function schedule() {
    if (closing) return;
    active = advance();
    void active.catch(() => options.onError?.(t("cli.persistFailed")));
  }
  const router = {
    state: os.handler(() => state()),
    create: os.input(matchConfigSchema).handler(async ({ input }) => {
      if (closing || busy) throw new ORPCError("CONFLICT");
      try {
        assertEngineSupported(input);
      } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
          message: error instanceof Error ? error.message : t("cli.engineUnavailable"),
        });
      }
      const next = createMatch(input);
      busy = true;
      controller = new AbortController();
      memory = {};
      match = next;
      try {
        await persist(match);
      } finally {
        busy = false;
      }
      schedule();
      return state();
    }),
    move: os
      .input(z.object({ move: z.string().max(256), expectedSeq: z.number().int().nonnegative() }))
      .handler(async ({ input }) => {
        if (
          closing ||
          busy ||
          match.status !== "running" ||
          input.expectedSeq !== match.events.length
        )
          throw new ORPCError("CONFLICT");
        const chess = boardAt(match);
        const player = chess.turn() === "w" ? match.config.white : match.config.black;
        if (player.protocol !== "human") throw new ORPCError("CONFLICT");
        busy = true;
        try {
          // Human moves bypass the runner, so apply the same archive limit here.
          if (!endAtArchiveLimit(match)) {
            const event = submitMove(match, chess, input.move);
            if (event.accepted) await evaluateAfterMove(match, { signal: controller.signal });
          }
          await persist(match);
        } finally {
          busy = false;
        }
        schedule();
        return state();
      }),
    stop: os.handler(async () => {
      if (closing) throw new ORPCError("CONFLICT");
      controller.abort();
      if (match.status === "running") finishMatch(match, "*", "cancelled", "stopped");
      await persist(match);
      return state();
    }),
  };
  const handler = new RPCHandler(router, { plugins: [new SimpleCsrfProtectionHandlerPlugin()] });
  let port = options.port;
  const server = createServer(async (request, response) => {
    try {
      if (closing) {
        response.writeHead(503, { Connection: "close" });
        response.end();
        return;
      }
      const host = request.headers.host;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (
        !host ||
        !origins.includes(`http://${host}`) ||
        (request.headers.origin && !origins.includes(request.headers.origin))
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
      // Check before URL normalizes dot segments, including encoded ones.
      const rawPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      if (!isLocalAssetPath(rawPath.replace(/^\/+/, "").replace(/\/$/, "") || "local.html")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/rpc/")) {
        let body: Buffer | undefined;
        try {
          body =
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await requestBody(request);
        } catch (error) {
          if (!(error instanceof BodyTooLargeError)) throw error;
          response.writeHead(413, { Connection: "close" });
          response.end(error.message, () => request.destroy());
          return;
        }
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers))
            if (typeof value === "string") headers.set(key, value);
          const incoming = new Request(url, { method: request.method, headers, body });
          if (closing) {
            response.writeHead(503, { Connection: "close" });
            response.end();
            return;
          }
          const pending = handler.handle(incoming, { prefix: "/rpc", context: {} });
          requests.add(pending);
          const result = await pending.finally(() => requests.delete(pending));
          if (!result.matched) {
            response.writeHead(404);
            response.end();
            return;
          }
          response.writeHead(result.response.status, Object.fromEntries(result.response.headers));
          response.end(Buffer.from(await result.response.arrayBuffer()));
        } catch {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
        return;
      }
      if (url.pathname === "/archive") {
        response.setHeader("Content-Type", "application/json");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="cockpit-${match.id}.json"`,
        );
        response.end(JSON.stringify(match));
        return;
      }
      const relative =
        url.pathname === "/" || /^\/(en-US|es-MX)\/?$/.test(url.pathname)
          ? "local.html"
          : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const asset = await assets.read(relative);
      if (!asset) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader(
        "Content-Type",
        MIME_TYPES[path.extname(relative)] ?? "application/octet-stream",
      );
      response.end(asset);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end(t("cli.assetUnavailable"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(t("cli.message35"));
  port = address.port;
  return {
    server,
    url: `http://127.0.0.1:${port}/en-US/`,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        // Stop admission before draining: a failed write must never skip close.
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        controller.abort();
        server.closeAllConnections();
        const results = await Promise.allSettled([closed, active, ...requests]);
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors);
      })();
      return closePromise;
    },
  };
}
