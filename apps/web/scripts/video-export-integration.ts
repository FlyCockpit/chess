/**
 * MP4 export integration test: encodes the fixture game in headless Chromium
 * with the real worker (WebCodecs H.264 + Mediabunny), then checks each file
 * with the host's ffprobe: codec avc1/H.264, profile, yuv420p, frame size,
 * 30 fps, frame count and duration from the plan, size under X's limit, and
 * the moov box before mdat (fast start). Also checks that cancelling stops
 * the encode, and in a game with illegal attempts (the "struggle" run) that the
 * frames at an attempt show its red rings.
 *
 *   pnpm -F web test:video
 *   pnpm -F web test:video -- --archive game.json --aspect square --out sample.mp4
 *   pnpm -F web test:video -- --frames <dir>   (keeps the struggle run's key frames as PNG)
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
  // `pnpm test:video -- --flag` passes the "--" through.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    archive: { type: "string" },
    aspect: { type: "string", default: "square" },
    out: { type: "string" },
    dir: { type: "string" },
    keep: { type: "boolean", default: false },
    frames: { type: "string" },
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
  marks: Array<{
    label: string;
    frame: number;
    ringed: string[];
    sequence?: number[];
    crowned?: { square: string; pawnFrame: number };
  }>;
  board: { x: number; y: number; square: number };
};

/** One decoded frame as RGB bytes. */
function frameRgb(file: string, frame: number, width: number, height: number): Buffer {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-i",
      file,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: width * height * 4 },
  );
  if (raw.length !== width * height * 3) throw new Error(`frame ${frame}: ${raw.length} bytes`);
  return raw;
}

/**
 * The frames at the struggle game's key moments: each ringed square shows red on its
 * left edge (the ring's line, through H.264), and with `--frames` each is kept as PNG.
 */
function checkFrames(file: string, result: RunResult, label: string) {
  if (label.startsWith("struggle"))
    check(`${label} key frames`, result.marks.length >= 5, result.marks.map((m) => m.label).join());
  for (const mark of result.marks) {
    const rgb = frameRgb(file, mark.frame, result.width, result.height);
    for (const square of mark.ringed) {
      const { x, y, square: size } = result.board;
      const px = Math.round(x + (square.charCodeAt(0) - 97) * size + size * 0.06);
      const top = y + (8 - Number(square[1])) * size;
      // The left edge's middle third: a ring there is red throughout.
      let red = 0;
      const rows = Math.round(size / 3);
      for (let row = 0; row < rows; row++) {
        const offset = ((Math.round(top + size / 3) + row) * result.width + px) * 3;
        const [r = 0, g = 0, b = 0] = rgb.subarray(offset, offset + 3);
        if (r > 150 && g < 90 && b < 90) red++;
      }
      check(`${label} ${mark.label} ring on ${square}`, red > rows * 0.8, `${red}/${rows} red`);
    }
    if (mark.crowned) {
      // After a promotion the square shows the new piece, not the pawn that slid there
      // (whose last motion frame has it exactly on the square).
      const pawn = frameRgb(file, mark.crowned.pawnFrame, result.width, result.height);
      const { x, y, square: size } = result.board;
      const left = x + (mark.crowned.square.charCodeAt(0) - 97) * size;
      const top = y + (8 - Number(mark.crowned.square[1])) * size;
      let changed = 0;
      for (let row = top; row < top + size; row++)
        for (let col = left; col < left + size; col++) {
          const offset = (row * result.width + col) * 3;
          const delta =
            Math.abs((rgb[offset] ?? 0) - (pawn[offset] ?? 0)) +
            Math.abs((rgb[offset + 1] ?? 0) - (pawn[offset + 1] ?? 0)) +
            Math.abs((rgb[offset + 2] ?? 0) - (pawn[offset + 2] ?? 0));
          if (delta > 90) changed++;
        }
      check(
        `${label} ${mark.label} new piece on ${mark.crowned.square}`,
        changed > size,
        `${changed} pixels differ from the pawn in frame ${mark.crowned.pawnFrame}`,
      );
    }
    if (mark.sequence) {
      // Pieces in motion: each of ¼ ½ ¾ through the motion and the still frame after it
      // differs from the one before on the board (a frozen picture would not).
      const { x, y, square: size } = result.board;
      const sampled = (size * 4) ** 2;
      const pictures = mark.sequence.map((n) => frameRgb(file, n, result.width, result.height));
      for (let i = 1; i < pictures.length; i++) {
        const a = pictures[i - 1] as Buffer;
        const b = pictures[i] as Buffer;
        let changed = 0;
        for (let row = y; row < y + size * 8; row += 2)
          for (let col = x; col < x + size * 8; col += 2) {
            const offset = (row * result.width + col) * 3;
            const delta =
              Math.abs((a[offset] ?? 0) - (b[offset] ?? 0)) +
              Math.abs((a[offset + 1] ?? 0) - (b[offset + 1] ?? 0)) +
              Math.abs((a[offset + 2] ?? 0) - (b[offset + 2] ?? 0));
            if (delta > 90) changed++;
          }
        check(
          `${label} ${mark.label} moves ${mark.sequence[i - 1]}→${mark.sequence[i]}`,
          // A shake moves a piece by a few pixels; a frozen frame changes none (beyond
          // codec noise, far under the per-pixel threshold).
          changed > 50,
          `${changed} of ${sampled} sampled board pixels differ`,
        );
      }
    }
    if (args.frames) {
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${mark.frame})`,
        "-frames:v",
        "1",
        path.join(path.resolve(args.frames), `${label}-${mark.label}-f${mark.frame}.png`),
      ]);
    }
  }
}

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
    const runs: Array<{ label: string; aspect: string; archive?: unknown; fixture?: string }> =
      args.archive
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
            { label: "struggle", aspect: "square", fixture: "struggle" },
            { label: "struggle-landscape", aspect: "landscape", fixture: "struggle" },
            { label: "promotion", aspect: "square", fixture: "promotion" },
          ];
    if (args.frames) await mkdir(path.resolve(args.frames), { recursive: true });
    for (const run of runs) {
      const result = await browser.evaluate<RunResult>(
        `window.videoExport.run(${JSON.stringify({ aspect: run.aspect, archive: run.archive, fixture: run.fixture, upload: `/upload/${run.label}` })})`,
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
      if (run.fixture) checkFrames(file, result, run.label);
      if (run.fixture === "promotion")
        check(
          `${run.label} marks`,
          result.marks.some((mark) => mark.crowned),
          result.marks.map((mark) => mark.label).join(),
        );
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
