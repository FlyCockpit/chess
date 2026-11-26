/**
 * Shared plumbing of the browser checks (`test:hero`, `test:replay`): builds a harness
 * page (a directory with index.html + a module) with the app's aliases and Tailwind,
 * serves it on loopback, drives a headless Chromium over CDP with Node's own WebSocket
 * (no browser-automation dependency), and cleans everything up. The harness page sets
 * `document.title = "ready"` once its window API is installed.
 *
 * Needs a Chromium (CHROME_PATH, or Playwright's headless shell in ~/.cache/ms-playwright).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { build } from "vite";

const webRoot = path.resolve(import.meta.dirname, "../..");

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const shell of shells) {
      const binary = path.join(cache, shell, "chrome-headless-shell-linux64/chrome-headless-shell");
      if (existsSync(binary)) return binary;
    }
  }
  throw new Error("No Chromium found: set CHROME_PATH or install Playwright's headless shell.");
}

export type HarnessPage = {
  /** A raw CDP call on the page's session. */
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  evaluate: <T>(expression: string) => Promise<T>;
  viewport: (width: number, height: number) => Promise<void>;
  /** Emulated media features, e.g. [{ name: "prefers-reduced-motion", value: "reduce" }]. */
  media: (features: Array<{ name: string; value: string }>) => Promise<void>;
  /** Sends one key press (keydown + keyup) to the focused element. */
  key: (key: string) => Promise<void>;
  /** Clicks the page at a point, like a user. */
  click: (x: number, y: number) => Promise<void>;
  screenshot: (
    file: string,
    clip: { x: number; y: number; width: number; height: number },
  ) => Promise<void>;
};

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
};
const KEY_CODES: Record<string, number> = {
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  Enter: 13,
};

export async function withHarness<T>(
  harness: string,
  run: (page: HarnessPage) => Promise<T>,
): Promise<T> {
  const base = path.join(webRoot, "node_modules/.cache");
  await mkdir(base, { recursive: true });
  const workDir = await mkdtemp(path.join(base, `${path.basename(harness)}-`));
  const outDir = path.join(workDir, "site");
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = path.join(
      outDir,
      path.normalize(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!file.startsWith(outDir) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" })
      .end(await readFile(file));
  });
  try {
    const { default: tailwind } = await import("@tailwindcss/vite");
    await build({
      configFile: false,
      root: harness,
      logLevel: "warn",
      plugins: [tailwind()],
      resolve: {
        alias: {
          "@": path.join(webRoot, "src"),
          "@locales": path.resolve(webRoot, "../../packages/locales/src"),
        },
      },
      build: { outDir, emptyOutDir: true, target: "es2022" },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    child = spawn(
      findChrome(),
      [
        "--headless",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-port=0",
        `--user-data-dir=${path.join(workDir, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const browser = child;
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`Chromium did not start:\n${output}`)),
        20_000,
      );
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match?.[1]) {
          clearTimeout(timer);
          browser.stderr?.off("data", onData);
          browser.stderr?.resume();
          resolve(match[1]);
        }
      };
      browser.stderr?.on("data", onData);
      browser.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${output}`)));
    });
    const ws = new WebSocket(wsUrl);
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    let next = 1;
    const pending = new Map<
      number,
      (message: { result?: unknown; error?: { message: string } }) => void
    >();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) pending.get(message.id)?.(message);
    });
    const raw = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = next++;
        pending.set(id, (message) => {
          pending.delete(id);
          if (message.error) reject(new Error(`${method}: ${message.error.message}`));
          else resolve((message.result ?? {}) as Record<string, unknown>);
        });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = (await raw("Target.createTarget", { url: `${origin}/` })) as {
      targetId: string;
    };
    const { sessionId } = (await raw("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      raw(method, params, sessionId);
    const evaluate = async <V>(expression: string): Promise<V> => {
      const response = (await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as {
        result: { value: V };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };
      if (response.exceptionDetails)
        throw new Error(
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
        );
      return response.result.value;
    };
    for (let i = 0; (await evaluate<string>("document.title")) !== "ready"; i++) {
      if (i > 100) throw new Error("harness page did not load");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const page: HarnessPage = {
      send,
      evaluate,
      viewport: async (width, height) => {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width < 600,
        });
      },
      media: async (features) => {
        await send("Emulation.setEmulatedMedia", { features });
      },
      key: async (key) => {
        const code = KEY_CODES[key] ?? 0;
        for (const type of ["keyDown", "keyUp"])
          await send("Input.dispatchKeyEvent", {
            type,
            key,
            code: key,
            windowsVirtualKeyCode: code,
          });
      },
      click: async (x, y) => {
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      },
      screenshot: async (file, clip) => {
        const shot = (await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { ...clip, scale: 1 },
        })) as { data: string };
        writeFileSync(file, Buffer.from(shot.data, "base64"));
      },
    };
    return await run(page);
  } finally {
    socket?.close();
    // Wait for Chromium to exit before removing its profile directory.
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child?.once("exit", resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.close();
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
