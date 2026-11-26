/**
 * MP4 export integration test: encodes the fixture game in headless Chromium
 * with the real worker (WebCodecs H.264 + Mediabunny), then checks each file
 * with the host's ffprobe: codec avc1/H.264, profile, yuv420p, frame size,
 * 30 fps, frame count and duration from the plan, size under X's limit, and
 * the moov box before mdat (fast start). Also checks that cancelling stops
 * the encode.
 *
 *   pnpm -F web test:video
 *   pnpm -F web test:video -- --archive game.json --aspect square --out sample.mp4
 *   (--dir <base> picks where the run's own temporary directory goes; --keep keeps it)
 *
 * Needs a Chromium (CHROME_PATH, or Playwright's headless shell in
 * ~/.cache/ms-playwright) and ffprobe on PATH. Not part of `pnpm test`: it
 * drives a real browser.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";

const webRoot = path.resolve(import.meta.dirname, "..");
const harness = path.join(webRoot, "scripts/video-export-harness");
const X_MAX_BYTES = 512 * 1024 * 1024;

const { values: args } = parseArgs({
  options: {
    archive: { type: "string" },
    aspect: { type: "string", default: "square" },
    out: { type: "string" },
    dir: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
// Each run makes its own fresh directory (mkdtemp) inside the base and removes
// only that one afterwards (unless --keep), never anything it did not create.
const baseDir = path.resolve(
  args.dir ?? process.env.VIDEO_E2E_DIR ?? path.join(webRoot, "node_modules/.cache"),
);
let workDir = "";

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

type CdpMessage = { id?: number; result?: unknown; error?: { message: string } };

/** Minimal CDP client over Node's built-in WebSocket. */
async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 1;
  const pending = new Map<number, (message: CdpMessage) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      pending.set(id, (message) => {
        pending.delete(id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve((message.result ?? {}) as Record<string, unknown>);
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => socket.close() };
}

async function launch(chrome: string, url: string) {
  const child = spawn(
    chrome,
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
  // Any failure before the harness is ready must not leave Chromium running.
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  try {
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
          // Keep draining stderr without holding it in memory.
          child.stderr?.off("data", onData);
          child.stderr?.resume();
          resolve(match[1]);
        }
      };
      child.stderr?.on("data", onData);
      child.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${output}`)));
    });
    const connection = await connect(wsUrl);
    cdp = connection;
    const { targetId } = (await connection.send("Target.createTarget", { url })) as {
      targetId: string;
    };
    const { sessionId } = (await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = (await connection.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )) as {
        result: { value: T };
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
    return { child, cdp: connection, evaluate };
  } catch (error) {
    cdp?.close();
    child.kill();
    throw error;
  }
}

/** Top-level ISO-BMFF box types in file order. */
function topLevelBoxes(file: Buffer): string[] {
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= file.length) {
    let size = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    if (size === 1) size = Number(file.readBigUInt64BE(offset + 8));
    if (size === 0) size = file.length - offset;
    if (size < 8) throw new Error(`bad box at ${offset}`);
    boxes.push(type);
    offset += size;
  }
  return boxes;
}

type RunResult = {
  error?: string;
  codec: string;
  fileName: string;
  bytes: number;
  totalFrames: number;
  seconds: number;
  width: number;
  height: number;
  progressEvents: number;
  encodeMs: number;
};

const failures: string[] = [];
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures.push(label);
}

function probe(file: string, result: RunResult, label: string) {
  const json = execFileSync(
    "ffprobe",
    ["-v", "error", "-count_frames", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf8" },
  );
  writeFileSync(`${file}.ffprobe.json`, json);
  const info = JSON.parse(json) as {
    format: { duration: string; size: string; format_name: string; nb_streams: number };
    streams: Array<Record<string, string | number>>;
  };
  const video = info.streams[0] ?? {};
  const duration = Number(info.format.duration);
  const boxes = topLevelBoxes(readFileSync(file));
  check(`${label} container`, info.format.format_name.includes("mp4"), info.format.format_name);
  check(`${label} streams`, info.streams.length === 1, `${info.streams.length} (video only)`);
  check(
    `${label} codec`,
    video.codec_name === "h264" && video.codec_tag_string === "avc1",
    `${video.codec_name}/${video.codec_tag_string} ${video.profile} (${result.codec})`,
  );
  check(
    `${label} profile`,
    ["Main", "Constrained Baseline", "Baseline"].includes(String(video.profile)),
    String(video.profile),
  );
  check(`${label} pixel format`, video.pix_fmt === "yuv420p", String(video.pix_fmt));
  check(
    `${label} frame size`,
    video.width === result.width && video.height === result.height,
    `${video.width}×${video.height}`,
  );
  check(`${label} frame rate`, video.r_frame_rate === "30/1", String(video.r_frame_rate));
  check(
    `${label} frames`,
    Number(video.nb_read_frames) === result.totalFrames,
    `${video.nb_read_frames} of ${result.totalFrames}`,
  );
  check(
    `${label} duration`,
    Math.abs(duration - result.seconds) < 0.05 && duration <= 140,
    `${duration}s (plan ${result.seconds}s, X max 140s)`,
  );
  check(
    `${label} size`,
    Number(info.format.size) === result.bytes && result.bytes < X_MAX_BYTES,
    `${(result.bytes / 1e6).toFixed(2)} MB`,
  );
  const moov = boxes.indexOf("moov");
  const mdat = boxes.indexOf("mdat");
  check(`${label} fast start`, moov >= 0 && moov < mdat, boxes.join(" "));
  check(`${label} progress`, result.progressEvents > 0, `${result.progressEvents} events`);
}

async function main() {
  await mkdir(baseDir, { recursive: true });
  workDir = await mkdtemp(path.join(baseDir, "video-export-e2e-"));
  const outDir = path.join(workDir, "site");
  await build({
    configFile: false,
    root: harness,
    logLevel: "warn",
    resolve: {
      alias: {
        "@": path.join(webRoot, "src"),
        "@locales": path.resolve(webRoot, "../../packages/locales/src"),
      },
    },
    worker: { format: "es" },
    build: { outDir, emptyOutDir: true },
  });
  const uploads = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname.startsWith("/upload/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      uploads.set(url.pathname.slice("/upload/".length), Buffer.concat(chunks));
      response.writeHead(204).end();
      return;
    }
    const file = path.join(
      outDir,
      path.normalize(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!file.startsWith(outDir) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".html")
        ? "text/html"
        : "application/octet-stream";
    response.writeHead(200, { "content-type": type }).end(await readFile(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let child: ChildProcess | undefined;
  try {
    const browser = await launch(findChrome(), `${origin}/`);
    child = browser.child;
    const runs: Array<{ label: string; aspect: string; archive?: unknown }> = args.archive
      ? [
          {
            label: "sample",
            aspect: args.aspect ?? "square",
            archive: JSON.parse(await readFile(args.archive, "utf8")),
          },
        ]
      : [
          { label: "square", aspect: "square" },
          { label: "landscape", aspect: "landscape" },
        ];
    for (const run of runs) {
      const result = await browser.evaluate<RunResult>(
        `window.videoExport.run(${JSON.stringify({ aspect: run.aspect, archive: run.archive, upload: `/upload/${run.label}` })})`,
      );
      if (result.error) {
        check(run.label, false, result.error);
        continue;
      }
      const bytes = uploads.get(run.label);
      if (!bytes) {
        check(run.label, false, "no upload");
        continue;
      }
      const file = path.resolve(
        args.out && args.archive ? args.out : path.join(workDir, `${run.label}.mp4`),
      );
      writeFileSync(file, bytes);
      console.log(`${run.label}: ${result.fileName} → ${file} (encoded in ${result.encodeMs} ms)`);
      probe(file, result, run.label);
    }
    if (!args.archive) {
      const cancelled = await browser.evaluate<{
        name?: string;
        error?: string;
        progressAfterCancel?: number;
      }>("window.videoExport.cancel()");
      check(
        "cancel",
        cancelled.name === "AbortError" && cancelled.progressAfterCancel === 0,
        JSON.stringify(cancelled),
      );
    }
    browser.cdp.close();
  } finally {
    child?.kill();
    server.close();
  }
}

try {
  await main();
} finally {
  if (workDir && args.keep) console.log(`kept ${workDir}`);
  else if (workDir) await rm(workDir, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else console.log("\nall video export checks passed");
