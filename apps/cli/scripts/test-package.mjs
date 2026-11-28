// Integration check of the real npm tarball. The child runs outside this checkout
// with no runtime dependencies, an empty npm cache and registry access disabled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = resolve(process.argv[2] ?? join(cliRoot, "dist/npm"));
const isTarball = (await stat(packageRoot)).isFile();
const packArguments = isTarball ? [packageRoot] : [];
const scratchParent = resolve(process.argv[3] ?? join(homedir(), ".cache/cockpit-chess-package"));
await mkdir(scratchParent, { recursive: true });
const scratch = await mkdtemp(join(scratchParent, "artifact-"));
const installRoot = join(scratch, "install");
const privateHome = join(scratch, "home");
const configRoot = join(scratch, "config");
const cache = join(scratch, "npm-cache");
const processProofFile = join(scratch, "node-processes.jsonl");
for (const path of [installRoot, privateHome, configRoot, cache])
  await mkdir(path, { recursive: true, mode: 0o700 });

// Keep only OS process-launch requirements; never propagate a real provider key,
// npm credential, NODE_PATH, preload, personal config or per-user spending ledger.
const childEnvironment = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  TMP: scratch,
  TEMP: scratch,
  TMPDIR: scratch,
  HOME: privateHome,
  USERPROFILE: privateHome,
  APPDATA: join(privateHome, "AppData/Roaming"),
  LOCALAPPDATA: join(privateHome, "AppData/Local"),
  XDG_CONFIG_HOME: configRoot,
  COCKPIT_CHESS_CONFIG_DIR: configRoot,
  npm_config_cache: cache,
  npm_config_userconfig: join(scratch, "empty.npmrc"),
  npm_config_globalconfig: join(scratch, "empty-global.npmrc"),
  npm_config_offline: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_registry: "http://127.0.0.1:1",
  NO_COLOR: "1",
};
await writeFile(childEnvironment.npm_config_userconfig, "");
await writeFile(childEnvironment.npm_config_globalconfig, "");

const children = new Set();
const resources = [];
function launch(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: installRoot,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...options,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  const limit = 4 * 1024 * 1024;
  child.stdout.on("data", (data) => {
    stdout += data;
    if (stdout.length > limit) child.kill();
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    if (stderr.length > limit) child.kill();
  });
  const done = new Promise((resolveDone, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      resolveDone({ code, signal, stdout, stderr });
    });
  });
  return { child, done, output: () => ({ stdout, stderr }) };
}
async function bounded(promise, milliseconds, label) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(milliseconds, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Timed out: ${label}`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}
async function run(executable, args, options = {}) {
  const operation = launch(executable, args, options);
  try {
    const result = await bounded(operation.done, 90_000, args[0] ?? executable);
    assert.equal(
      result.code,
      0,
      `${executable} ${args[0]} failed (${result.code}): ${result.stderr}`,
    );
    return result;
  } finally {
    if (operation.child.exitCode === null) operation.child.kill();
  }
}

// npm.cmd is a shell script on Windows. Launch npm's actual JS entry with this
// Node executable instead, which also supports paths containing spaces.
const npmEntry = process.env.npm_execpath?.endsWith("npm-cli.js")
  ? process.env.npm_execpath
  : process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    : fileURLToPath(
        new URL("../lib/node_modules/npm/bin/npm-cli.js", pathToFileURL(process.execPath)),
      );
// Node installers may use a separate prefix (for example Homebrew on macOS).
async function npm(args, options = {}) {
  try {
    await readFile(npmEntry);
    return await run(process.execPath, [npmEntry, ...args], options);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    assert.notEqual(process.platform, "win32", "Node's npm-cli.js must exist on Windows");
    return run("npm", args, options);
  }
}

async function tree(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected packaged symlink: ${name}`);
    if (entry.isDirectory()) paths.push(...(await tree(join(directory, entry.name), name)));
    else {
      assert(entry.isFile(), `Unexpected packaged file type: ${name}`);
      paths.push(name);
    }
  }
  return paths.sort();
}

function sourceFiles(archive) {
  const data = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, "");
    const name = `${text(345, 155) ? `${text(345, 155)}/` : ""}${text(0, 100)}`;
    const size = Number.parseInt(text(124, 12).trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= data.length);
    if ([0, 48].includes(header[156]))
      files.set(name, data.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function allowlisted(path) {
  return (
    [
      "package.json",
      "LICENSE",
      "README.md",
      "THIRD-PARTY-LICENSES.md",
      "STOCKFISH-SOURCE.md",
      "dist/main.js",
      "dist/main.js.LEGAL.txt",
      "stockfish/package.json",
      "stockfish/manifest.json",
      "stockfish/AUTHORS",
      "stockfish/SHA256SUMS",
      "stockfish/Copying.txt",
      "stockfish/bin/stockfish-19-lite-single.js",
      "stockfish/bin/stockfish-19-lite-single.wasm",
      "stockfish/source/stockfish-19.0.1-source.tar.gz",
    ].includes(path) || /^(?:web|licenses)\/[A-Za-z0-9@._/-]+$/.test(path)
  );
}

function normalizedConfig() {
  // All current schema defaults, in canonical schema order. The digest is then
  // checked by the real packed strict reader when it receives the offer.
  return {
    title: "Packed artifact local model",
    white: { name: "Local model", model: "test/runner-model", protocol: "openai-chat" },
    black: { name: "Human", model: "human", protocol: "human" },
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    rules: {
      version: "cockpit-v1",
      context: "fresh",
      opponentIdentity: "hidden",
      representation: "ascii",
      legalMoves: "provided",
      moveFormat: "strict",
      tokenAccounting: "provider",
      engineEvaluation: "after-move",
      engineNodes: 1000,
      engineCallsPerTurn: 2,
      maxAttempts: 3,
      turnTimeoutMs: 60_000,
      maxDispatches: 6,
      tokenBudget: 1_000_000,
      costBudgetMicros: 1_000_000,
      maxOutputTokens: 64,
      remarks: "off",
      clock: null,
    },
    promptVersion: "1",
  };
}

async function pairedRunner() {
  const claimToken = randomBytes(32).toString("hex");
  const credential = randomBytes(32).toString("hex");
  const received = [];
  const requests = [];
  let modelCalls = 0;
  let proof;
  let failure;
  let resolveFinished;
  const finished = new Promise((resolveFinishedPromise) => {
    resolveFinished = resolveFinishedPromise;
  });
  const json = (response, value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push(request.url);
      const claimant = { email: "artifact@example.invalid" };
      const expiresAt = new Date(Date.now() + 300_000).toISOString();
      if (request.url === "/api/cli/runner/begin") {
        assert.equal(request.method, "POST");
        assert.match(body.proof, /^[a-f0-9]{64}$/);
        proof = body.proof;
        json(response, { claimId: "artifact_claim", claimToken, expiresAt, pollIntervalMs: 2000 });
      } else if (request.url === "/api/cli/runner/poll") {
        assert.equal(body.proof, proof);
        assert.equal(body.claimId, "artifact_claim");
        json(response, { status: "claimed", claimant, controlPath: "/en-US/settings/cli" });
      } else if (request.url === "/api/cli/runner/exchange") {
        assert.equal(body.proof, proof);
        json(response, {
          machineId: "artifact_machine",
          credential,
          expiresAt,
          claimant,
          controlPath: "/en-US/settings/cli",
        });
      } else if (request.url === "/v1/chat/completions") {
        modelCalls++;
        assert.equal(modelCalls, 1, "One authorized turn must issue exactly one model request");
        assert.equal(body.model, "test/runner-model");
        assert.equal(body.stream, true);
        assert.equal(body.max_completion_tokens, 64);
        assert(!JSON.stringify(body).includes(credential));
        const shared = {
          id: "artifact_reply",
          object: "chat.completion.chunk",
          created: 0,
          model: "test/runner-model",
        };
        const events = [
          {
            ...shared,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: '{"move":"e2e4"}' },
                finish_reason: null,
              },
            ],
          },
          { ...shared, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          {
            ...shared,
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 8, total_tokens: 19 },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        );
      } else throw new Error(`Unexpected artifact HTTP request: ${request.url}`);
    } catch (error) {
      failure = error;
      response.writeHead(500);
      response.end();
      resolveFinished();
    }
  });
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const clients = new Set();
  // A minimal RFC6455 fixture, using only Node builtins so this same script runs
  // on OS matrix hosts with just the actual tarball and no workspace install.
  server.on("upgrade", (request, stream, head) => {
    try {
      assert.equal(request.url, "/api/cli/runner/ws");
      assert.equal(request.headers.upgrade?.toLowerCase(), "websocket");
      assert.equal(request.headers["sec-websocket-version"], "13");
      assert.equal(request.headers.authorization, `Bearer ${credential}`);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      stream.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      clients.add(stream);
      stream.on("close", () => clients.delete(stream));
      const socket = new EventEmitter();
      let pending = head;
      const writeFrame = (opcode, payload) => {
        const bytes = Buffer.from(payload);
        const header =
          bytes.length < 126
            ? Buffer.from([0x80 | opcode, bytes.length])
            : Buffer.from([0x80 | opcode, 126, bytes.length >>> 8, bytes.length & 255]);
        stream.write(Buffer.concat([header, bytes]));
      };
      socket.send = (text) => writeFrame(1, text);
      const consume = (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        try {
          for (;;) {
            if (pending.length < 2) return;
            assert.equal(pending[0] & 0x80, 0x80, "Fixture expects complete WebSocket frames");
            assert.equal(pending[0] & 0x70, 0, "No compression negotiated");
            assert.equal(pending[1] & 0x80, 0x80, "Client WebSocket frames must be masked");
            const opcode = pending[0] & 15;
            let length = pending[1] & 127;
            let offset = 2;
            assert.notEqual(length, 127, "Fixture frame bound");
            if (length === 126) {
              if (pending.length < 4) return;
              length = pending.readUInt16BE(2);
              offset = 4;
            }
            if (pending.length < offset + 4 + length) return;
            const mask = pending.subarray(offset, offset + 4);
            const bytes = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
            for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4];
            pending = pending.subarray(offset + 4 + length);
            if (opcode === 1) socket.emit("message", bytes);
            else if (opcode === 9) writeFrame(10, bytes);
            else if (opcode === 8) {
              writeFrame(8, bytes);
              stream.end();
              return;
            } else assert.equal(opcode, 10);
          }
        } catch (error) {
          failure = error;
          stream.destroy();
          resolveFinished();
        }
      };
      stream.on("data", consume);
      stream.on("error", (error) => {
        failure ??= error;
        resolveFinished();
      });
      connected(socket, request);
      if (head.length) consume(Buffer.alloc(0));
    } catch (error) {
      failure = error;
      stream.destroy();
      resolveFinished();
    }
  });
  resources.push(async () => {
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  });
  const config = normalizedConfig();
  function connected(socket, request) {
    let serverSeq = 0;
    let clientSeq = 0;
    let sentStart = false;
    let sentStop = false;
    const send = (type, payload, matchId) =>
      socket.send(
        JSON.stringify({
          version: 1,
          generation: 1,
          id: `server_${++serverSeq}`,
          seq: serverSeq,
          ack: clientSeq,
          type,
          ...(matchId ? { matchId } : {}),
          payload,
        }),
      );
    try {
      assert.equal(request.headers.authorization, `Bearer ${credential}`);
      send("welcome", { heartbeatMs: 25_000, livenessMs: 60_000, resumeGraceMs: 120_000 });
    } catch (error) {
      failure = error;
      resolveFinished();
      return;
    }
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        assert.equal(message.version, 1);
        assert.equal(message.generation, 1);
        assert.equal(message.seq, ++clientSeq);
        received.push(message);
        if (message.type === "hello") {
          assert.equal(
            message.payload.engine,
            true,
            "Packed shared pool must pass its real finite-node engine probe",
          );
          assert.deepEqual(message.payload.models, [
            { id: "test/runner-model", protocol: "openai-chat" },
          ]);
          assert.deepEqual(message.payload.hardLimits, {
            matchMicros: 25_000_000,
            dayMicros: 100_000_000,
            concurrency: 8,
          });
          assert.deepEqual(message.payload.operatingLimits, {
            matchMicros: 1_000_000,
            dayMicros: 10_000_000,
            concurrency: 2,
            revision: 0,
          });
          assert(!raw.toString().includes(origin), "Local endpoint must not be advertised");
          assert(!raw.toString().includes(credential), "Credential must not be advertised");
          send(
            "offer",
            {
              commandId: "artifact_offer",
              configDigest: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
              config,
            },
            "artifact_match",
          );
        } else if (message.type === "heartbeat") send("pong", message.payload);
        else if (message.type === "accept")
          send(
            "resume",
            { commandId: "artifact_resume", acceptedSeq: 0, ply: 0, fen: config.initialFen },
            "artifact_match",
          );
        else if (message.type === "snapshot" && !sentStart) {
          sentStart = true;
          send("start", { commandId: "artifact_start", expectedSeq: 0 }, "artifact_match");
        } else if (message.type === "move") {
          assert.equal(message.matchId, "artifact_match");
          assert.equal(message.payload.uci, "e2e4");
          assert.equal(message.payload.ply, 1);
          assert.equal(
            message.payload.fen,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          );
        } else if (message.type === "evaluation") {
          assert.equal(message.payload.nodes, 1000);
          assert.equal(message.payload.ply, 1);
          assert(
            Number.isFinite(message.payload.score.cp) ||
              Number.isFinite(message.payload.score.mate),
          );
          if (!sentStop) {
            sentStop = true;
            send("stop", { commandId: "artifact_stop" }, "artifact_match");
          }
        } else if (message.type === "ack" && message.payload.commandId === "artifact_stop") {
          send("error", { code: "UNAUTHORIZED" });
          resolveFinished();
        } else if (message.type === "error" || message.type === "reject")
          throw new Error(`Packed runner refused fixture: ${JSON.stringify(message)}`);
      } catch (error) {
        failure = error;
        resolveFinished();
      }
    });
  }

  await writeFile(
    join(configRoot, "runner-policy.json"),
    JSON.stringify({ baseUrl: `${origin}/v1`, allowModels: ["test/runner-model"] }),
  );
  // Model a private terminal only in this child fixture. No production flag or
  // bypass is added. The package still runs its exact no-subcommand entry point.
  const preload = join(scratch, "private-terminal.mjs");
  await writeFile(
    preload,
    `import { appendFileSync } from 'node:fs';\nObject.defineProperty(process.stderr, 'isTTY', { value: true });\nappendFileSync(${JSON.stringify(processProofFile)}, JSON.stringify({ pid: process.pid, execPath: process.execPath, argv: process.argv, bun: 'Bun' in globalThis }) + '\\n');\n`,
  );
  const environment = {
    ...childEnvironment,
    COCKPIT_CHESS_SERVER: origin,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  const invocation = npm(["exec", "--offline", "--", "@flycockpit/chess"], { env: environment });
  // Observe rejection immediately while the loopback server is running; a
  // failed child must never become an unhandled promise rejection.
  void invocation.catch(() => {});
  await bounded(
    Promise.race([finished, invocation]),
    60_000,
    "packed no-argument claim/model/engine flow",
  );
  if (failure) throw failure;
  // Revocation deliberately exits1. npm's status wrapper is not part of the
  // runner result; all preceding wire/model/engine assertions must have passed.
  let output;
  try {
    output = await invocation;
    throw new Error("Revoked packed runner unexpectedly returned success");
  } catch (error) {
    assert.match(error.message, /failed \(1\)/);
    output = error.message;
  }
  assert.equal(modelCalls, 1);
  assert(requests.includes("/api/cli/runner/begin"));
  assert(requests.includes("/api/cli/runner/poll"));
  assert(requests.includes("/api/cli/runner/exchange"));
  assert(received.some((message) => message.type === "move"));
  assert(received.some((message) => message.type === "evaluation"));
  assert(output.includes("artifact@example.invalid"));
  assert(output.includes("/en-US/runner/claim#runner-claim="));
  const launches = (await readFile(processProofFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const cliLaunch = launches.find((entry) =>
    entry.argv.some((arg) => /(?:cockpit-chess|dist[/\\]main\.js)$/.test(arg)),
  );
  assert(cliLaunch, "npm must launch the installed CLI");
  assert.equal(cliLaunch.execPath, process.execPath);
  assert.equal(cliLaunch.bun, false);
  assert(cliLaunch.argv.every((arg) => !arg.includes("tsx")));
}

async function stopRecordedChildren() {
  // npm launches the CLI as a child process. Keep its explicit PID even if a
  // failed npm wrapper no longer owns it, so a timeout cannot leak a runner.
  let recorded;
  try {
    recorded = await readFile(processProofFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const launched = recorded
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const processInfo of launched) {
    if (
      !Number.isSafeInteger(processInfo.pid) ||
      processInfo.pid <= 0 ||
      processInfo.pid === process.pid
    )
      continue;
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

try {
  const dry = JSON.parse(
    (
      await npm(["pack", "--dry-run", "--json", "--ignore-scripts", ...packArguments], {
        cwd: isTarball ? installRoot : packageRoot,
      })
    ).stdout,
  )[0];
  assert.equal(dry.name, "@flycockpit/chess");
  const packedPaths = dry.files.map((file) => file.path).sort();
  for (const path of packedPaths) {
    assert(allowlisted(path), `File outside npm allowlist: ${path}`);
    assert(
      !/(?:^|\/)(?:\.env[^/]*|node_modules|\.git|src|scripts)(?:\/|$)|\.(?:tsx?|map|log)$/.test(
        path,
      ),
      `Private/source/tooling file packaged: ${path}`,
    );
  }
  for (const required of [
    "LICENSE",
    "THIRD-PARTY-LICENSES.md",
    "STOCKFISH-SOURCE.md",
    "dist/main.js",
    "stockfish/Copying.txt",
    "stockfish/bin/stockfish-19-lite-single.js",
    "stockfish/bin/stockfish-19-lite-single.wasm",
    "stockfish/source/stockfish-19.0.1-source.tar.gz",
    "web/local.html",
  ])
    assert(packedPaths.includes(required), `Required artifact missing: ${required}`);
  const packed = JSON.parse(
    (
      await npm(
        ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch, ...packArguments],
        {
          cwd: isTarball ? installRoot : packageRoot,
        },
      )
    ).stdout,
  )[0];
  assert.deepEqual(packed.files.map((file) => file.path).sort(), packedPaths);
  await writeFile(
    join(installRoot, "package.json"),
    JSON.stringify({ name: "isolated-artifact-check", version: "1.0.0", private: true }),
  );
  await npm([
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    join(scratch, packed.filename),
  ]);
  const installed = join(installRoot, "node_modules/@flycockpit/chess");
  const actualFiles = await tree(installed);
  assert.deepEqual(actualFiles, packedPaths, "Installed tarball must match inspected pack");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.name, "@flycockpit/chess");
  assert.equal(metadata.private, undefined);
  assert.deepEqual(metadata.bin, { "cockpit-chess": "./dist/main.js" });
  assert.equal(metadata.license, "AGPL-3.0-only");
  assert.deepEqual(metadata.engines, { node: ">=24.13.1" });
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
    "scripts",
  ])
    assert.equal(metadata[field], undefined, `Published runtime may not need ${field}`);
  assert(!JSON.stringify(metadata).includes("workspace:"));
  for (const document of ["README.md", "THIRD-PARTY-LICENSES.md", "STOCKFISH-SOURCE.md"]) {
    const text = await readFile(join(installed, document), "utf8");
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
      const target = href.split("#")[0];
      assert(actualFiles.includes(target.replace(/^\.\//, "")), `Broken ${document} link: ${href}`);
    }
  }
  const engineManifest = JSON.parse(
    await readFile(join(installed, "stockfish/manifest.json"), "utf8"),
  );
  assert.equal(engineManifest.version, "19.0.1");
  for (const [path, digest] of Object.entries(engineManifest.files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(installed, "stockfish", path)))
        .digest("hex"),
      digest,
      `Exact engine checksum: ${path}`,
    );
  const source = await readFile(join(installed, "stockfish/source", engineManifest.source.file));
  assert.equal(createHash("sha256").update(source).digest("hex"), engineManifest.source.sha256);
  const correspondingSource = sourceFiles(source);
  for (const path of [
    "build.js",
    "src/Makefile",
    "src/emscripten/wasm-makefile.mk",
    "Copying.txt",
    "AUTHORS",
    "BUILD.md",
    engineManifest.source.network.file,
  ])
    assert(
      correspondingSource.has(`stockfish-19.0.1-source/${path}`),
      `Corresponding-source input missing: ${path}`,
    );
  assert.equal(
    createHash("sha256")
      .update(
        correspondingSource.get(`stockfish-19.0.1-source/${engineManifest.source.network.file}`),
      )
      .digest("hex"),
    engineManifest.source.network.sha256,
  );
  const main = await readFile(join(installed, "dist/main.js"), "utf8");
  assert(main.startsWith("#!/usr/bin/env node\n"));
  const forbiddenSecrets = [
    new RegExp(["-----BEGIN", "[ A-Z]*PRIVATE KEY-----"].join(" ")),
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\bsk-or-v1-[a-f0-9]{32,}\b/,
  ];
  for (const path of actualFiles) {
    if (/\.(?:wasm|gz|woff2?|png|jpe?g|ico|webp|mp4)$/.test(path)) continue;
    const text = await readFile(join(installed, path), "utf8");
    for (const pattern of forbiddenSecrets)
      assert(!pattern.test(text), `Possible secret pattern in ${path}`);
  }
  const version = await npm(["exec", "--offline", "--", "@flycockpit/chess", "--version"]);
  assert.equal(version.stdout.trim(), metadata.version);
  await npm(["exec", "--offline", "--", "@flycockpit/chess", "--help"]);
  await pairedRunner();
  console.log(
    `npm artifact PASS: ${packed.filename}; ${packedPaths.length} allowlisted files; isolated no-argument claim, one local model request, real finite-node Stockfish and Node launcher`,
  );
} finally {
  for (const child of children) child.kill();
  await stopRecordedChildren();
  for (const close of resources.reverse()) await close();
  await rm(scratch, { recursive: true, force: true });
}
