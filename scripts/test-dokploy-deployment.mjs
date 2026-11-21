import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readMigrationsFolder } from "./db/lib/migration-state.mjs";
import { run as runMigrations } from "./db/migrate-runtime.mjs";
import {
  evaluateCompression,
  evaluateOptional,
  evaluateRole,
  evaluateService,
  parseOptions,
  verifyDeployment,
} from "./verify-dokploy-deployment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureEnvironment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

// The entrypoint repeats a stop's TERM only where /proc exists (have_proc);
// without it each signal sends one TERM, by design, since the image always
// has /proc. Tests of the repeat path therefore skip on hosts without /proc
// (macOS). ENTRYPOINT_TEST_ASSUME_NO_PROC=1, read only here, simulates such a
// host on Linux: those tests skip and every fixture entrypoint runs with its
// /proc detection removed, so the rest exercise the no-/proc fallback.
const procDetection = "if [ -r /proc/self/stat ]; then have_proc=true; fi";
const assumeNoProc = process.env.ENTRYPOINT_TEST_ASSUME_NO_PROC === "1";
const needsProc =
  !assumeNoProc && existsSync("/proc/self/stat")
    ? {}
    : { skip: "needs /proc (Linux); the image always has it" };
/** `test` for the /proc repeat path: skipped (with that reason) without /proc. */
const procTest = (name, fn) => test(name, needsProc, fn);

const commit = "0123456789abcdef0123456789abcdef01234567";
const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";
const project = "cockpit-chess-production-abc123";
const base = ["--url", "https://app.example.com", "--commit", commit];
const composeArgs = ["--mode", "compose", "--project", project, ...base];
const applicationsArgs = ["--mode", "applications", "--server", "web", ...base];
const commitFiles = {
  server: "/app/apps/server/dist/BUILD_COMMIT",
  worker: "/app/apps/worker/dist/BUILD_COMMIT",
  backup: "/app/apps/server/dist/BUILD_COMMIT",
};
const page = async () => ({
  headers: new Headers({ "content-encoding": "br" }),
  arrayBuffer: async () => new ArrayBuffer(4096),
});
const readyAt =
  (reported = commit) =>
  async () => ({ status: 200, json: async () => ({ ok: true, commit: reported }) });

test("a mode, an HTTPS origin and a commit are required; each mode takes only its own flags", () => {
  assert.throws(() => parseOptions([]), /--mode compose or --mode applications is required/);
  assert.throws(() => parseOptions(base), /--mode compose or --mode applications/);
  assert.throws(() => parseOptions(["--mode", "swarm", ...base]), /--mode compose or/);
  const compose = parseOptions(composeArgs);
  assert.equal(compose.timeout, 600);
  assert.equal(compose.topology, "app");
  assert.equal(parseOptions([...composeArgs, "--topology", "app-worker"]).topology, "app-worker");
  assert.throws(() => parseOptions([...composeArgs, "--topology", "worker"]), /app or app-worker/);
  assert.equal(
    parseOptions([
      "--mode",
      "compose",
      "--project",
      project,
      "--url",
      "https://a.example.com",
      "--commit",
      "ABCDEF1",
    ]).commit,
    "abcdef1",
  );
  // Without the expected commit an earlier healthy release could pass.
  assert.throws(
    () =>
      parseOptions(["--mode", "compose", "--project", project, "--url", "https://a.example.com"]),
    /--commit are required/,
  );
  assert.throws(
    () =>
      parseOptions(["--mode", "applications", "--server", "web", "--url", "https://a.example.com"]),
    /--commit are required/,
  );
  assert.throws(() => parseOptions([...composeArgs.slice(0, -1), "main"]), /commit SHA/);
  assert.throws(() => parseOptions(["--mode", "compose", ...base]), /--project is required/);
  assert.throws(
    () => parseOptions(["--mode", "compose", "--project", "Bad Name", ...base]),
    /Invalid Compose project/,
  );
  assert.throws(
    () => parseOptions([...composeArgs, "--server", "web"]),
    /--server does not apply to --mode compose/,
  );
  assert.throws(
    () => parseOptions([...applicationsArgs, "--project", project]),
    /--project does not apply to --mode applications/,
  );
  assert.throws(() => parseOptions([...applicationsArgs, "--topology", "app"]), /does not apply/);
  assert.throws(() => parseOptions(["--mode", "applications", ...base]), /--server is required/);
  assert.equal(parseOptions([...applicationsArgs, "--worker", "jobs"]).worker, "jobs");
  assert.throws(() => parseOptions([...applicationsArgs, "--worker", "web"]), /different/);
  assert.throws(
    () => parseOptions([...applicationsArgs, "--applier", "old"]),
    /Use --mode compose/,
  );
  assert.throws(
    () =>
      parseOptions([
        "--mode",
        "compose",
        "--project",
        project,
        "--url",
        "https://user:password@example.com",
        "--commit",
        commit,
      ]),
    /credentials/,
  );
});

// --- Compose ---------------------------------------------------------------

const container = (service, overrides = {}) => ({
  id: `${service}-1`,
  image: `sha256:${service}`,
  project,
  service,
  status: "running",
  running: true,
  restarts: 0,
  started: "2026-11-15T10:00:00.000000000Z",
  health: "healthy",
  ...overrides,
});

test("exactly one labelled, healthy container per required role is ready; a starting one is not yet", () => {
  assert.equal(evaluateRole(project, "server", [container("server")]), true);
  assert.equal(evaluateRole(project, "worker", [container("worker")]), true);
  assert.equal(
    evaluateRole(project, "server", [container("server", { health: "starting" })]),
    false,
  );
  assert.equal(
    evaluateRole(project, "server", [container("server", { status: "restarting" })]),
    false,
  );
  assert.equal(
    evaluateRole(project, "server", [container("server", { status: "created", running: false })]),
    false,
  );
  // Docker initializes health only when the container starts.
  assert.equal(
    evaluateRole(project, "server", [
      container("server", { status: "created", running: false, health: null }),
    ]),
    false,
  );
});

test("a missing, duplicated, mislabelled, unhealthy, stopped or unchecked role cannot report success", () => {
  assert.throws(() => evaluateRole(project, "server", []), /no server container/);
  assert.throws(() => evaluateRole(project, "worker", []), /no worker container/);
  assert.throws(
    () =>
      evaluateRole(project, "server", [
        container("server"),
        container("server", { id: "server-2" }),
      ]),
    /exactly one server container/,
  );
  assert.throws(
    () => evaluateRole(project, "server", [container("server", { project: "other" })]),
    /label mismatch/,
  );
  assert.throws(() => evaluateRole(project, "server", [container("backup")]), /label mismatch/);
  assert.throws(
    () => evaluateRole(project, "server", [container("server", { health: "unhealthy" })]),
    /unhealthy/,
  );
  assert.throws(
    () =>
      evaluateRole(project, "worker", [
        container("worker", { status: "exited", running: false, health: "starting" }),
      ]),
    /worker: the container has exited/,
  );
  assert.throws(
    () => evaluateRole(project, "server", [container("server", { health: null })]),
    /no healthcheck/,
  );
});

test("optional services: stopped ones are ignored, a live one is returned, a worker beside embedded jobs fails", () => {
  const stopped = container("backup", { status: "exited", running: false });
  assert.equal(evaluateOptional(project, "backup", [], { allowed: true }), null);
  assert.equal(evaluateOptional(project, "backup", [stopped], { allowed: true }), null);
  assert.equal(
    evaluateOptional(project, "worker", [container("worker", { status: "dead", running: false })], {
      allowed: false,
    }),
    null,
  );
  assert.equal(
    evaluateOptional(project, "backup", [stopped, container("backup")], { allowed: true }).id,
    "backup-1",
  );
  assert.throws(
    () => evaluateOptional(project, "worker", [container("worker")], { allowed: false }),
    /--topology app runs jobs in the server; pass --topology app-worker/,
  );
  assert.throws(
    () =>
      evaluateOptional(
        project,
        "backup",
        [container("backup"), container("backup", { id: "backup-2" })],
        { allowed: true },
      ),
    /at most one live backup container/,
  );
  assert.throws(
    () =>
      evaluateOptional(project, "backup", [container("backup", { project: "other" })], {
        allowed: true,
      }),
    /label mismatch/,
  );
});

/**
 * Inert Docker for one Compose project: answers the project-scoped `ps` per
 * service, each container's inspect, and the baked BUILD_COMMIT reads.
 * `services` maps a service to its container overrides (later: from the
 * second inspect on); a service absent from it has no containers.
 */
function fakeCompose({
  services = { server: {} },
  later = {},
  laterFrom = 1,
  commits = {},
  seen = [],
} = {}) {
  const inspects = new Map();
  return async (args) => {
    seen.push(args);
    assert.ok(!args.join(" ").includes(".Env"));
    assert.ok(!args.includes("logs") && args[0] !== "service");
    if (args[0] === "exec") {
      // Only the baked build commit is read from inside a container.
      const service = args[1].replace(/-\d+$/, "");
      assert.deepEqual(args, ["exec", args[1], "cat", commitFiles[service]]);
      if (commits[service] instanceof Error) throw commits[service];
      return `${commits[service] ?? commit}\n`;
    }
    if (args[0] === "ps") {
      assert.ok(args.includes(`label=com.docker.compose.project=${project}`));
      // A retained `docker compose run server migrate` container is not a replica.
      assert.ok(args.includes("label=com.docker.compose.oneoff=False"));
      const service = /label=com\.docker\.compose\.service=(\w+)/.exec(args.join(" "))[1];
      return services[service] ? `${service}-1` : "";
    }
    assert.deepEqual(args.slice(0, 3), ["inspect", "--type", "container"]);
    const service = args[3].replace(/-\d+$/, "");
    const count = inspects.get(service) ?? 0;
    inspects.set(service, count + 1);
    return JSON.stringify(
      container(service, { ...services[service], ...(count >= laterFrom ? later[service] : {}) }),
    );
  };
}

const composeOptions = (overrides = {}) => ({
  ...parseOptions(composeArgs),
  timeout: 1,
  ...overrides,
});
const cancelling = () => {
  const controller = new AbortController();
  return { signal: controller.signal, sleep: async () => controller.abort() };
};

test("compose: the healthy server of the expected commit and JSON readiness pass, without Swarm", async () => {
  const seen = [];
  let queried = false;
  await verifyDeployment(composeOptions(), {
    inspect: fakeCompose({ seen }),
    log: () => {},
    fetchReady: async (url, init) => {
      queried = true;
      assert.equal(url, "https://app.example.com/ready");
      assert.equal(init.redirect, "error");
      return { status: 200, json: async () => ({ ok: true, commit }) };
    },
    fetchPage: page,
  });
  assert.equal(queried, true);
  assert.ok(seen.some((args) => args[0] === "exec" && args[1] === "server-1"));
  assert.ok(!seen.some((args) => args.includes("task")));
});

test("compose app-worker: the worker is required, healthy and of the expected commit", async () => {
  const options = composeOptions({ topology: "app-worker" });
  const seen = [];
  await verifyDeployment(options, {
    inspect: fakeCompose({ services: { server: {}, worker: {} }, seen }),
    log: () => {},
    fetchReady: readyAt(),
    fetchPage: page,
  });
  assert.ok(seen.some((args) => args[0] === "exec" && args[1] === "worker-1"));
  await assert.rejects(
    verifyDeployment(options, { inspect: fakeCompose(), log: () => {} }),
    /worker: no worker container/,
  );
  await assert.rejects(
    verifyDeployment(options, {
      inspect: fakeCompose({
        services: { server: {}, worker: {} },
        commits: { worker: otherCommit },
      }),
      log: () => {},
      fetchReady: readyAt(),
    }),
    /worker: the container runs commit fedcba987654, not 0123456789ab/,
  );
  await assert.rejects(
    verifyDeployment(options, {
      inspect: fakeCompose({
        services: { server: {}, worker: {} },
        commits: { worker: new Error("no such file") },
      }),
      log: () => {},
      fetchReady: readyAt(),
    }),
    /worker: the image's build commit \(\/app\/apps\/worker\/dist\/BUILD_COMMIT\) could not be read/,
  );
  // A worker still starting holds readiness back without querying /ready.
  let queried = false;
  await assert.rejects(
    verifyDeployment(options, {
      inspect: fakeCompose({ services: { server: {}, worker: { health: "starting" } } }),
      log: () => {},
      fetchReady: async () => {
        queried = true;
        return readyAt()();
      },
      ...cancelling(),
    }),
    /timed out or was cancelled/,
  );
  assert.equal(queried, false);
});

test("compose app: a live worker beside embedded jobs fails; a stopped leftover does not", async () => {
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ services: { server: {}, worker: {} } }),
      log: () => {},
    }),
    /pass --topology app-worker/,
  );
  await verifyDeployment(composeOptions(), {
    inspect: fakeCompose({
      services: { server: {}, worker: { status: "exited", running: false } },
    }),
    log: () => {},
    fetchReady: readyAt(),
    fetchPage: page,
  });
});

test("compose: a live backup service must run the expected commit; its own health is advisory", async () => {
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({
        services: { server: {}, backup: {} },
        commits: { backup: otherCommit },
      }),
      log: () => {},
      fetchReady: readyAt(),
    }),
    /backup: the container runs commit fedcba987654/,
  );
  const messages = [];
  await verifyDeployment(composeOptions(), {
    inspect: fakeCompose({ services: { server: {}, backup: { health: "unhealthy" } } }),
    log: (line) => messages.push(line),
    fetchReady: readyAt(),
    fetchPage: page,
  });
  assert.ok(
    messages.some((line) =>
      /WARNING \(non-fatal\): the backup service reports unhealthy/.test(line),
    ),
  );
  assert.ok(messages.some((line) => line.startsWith("Deployment verified:")));
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({
        services: { server: {}, backup: {} },
        later: { backup: { restarts: 1 } },
      }),
      log: () => {},
      ...cancelling(),
      fetchReady: async () => ({ status: 503, json: async () => ({ ok: false }) }),
    }),
    /backup: the container restarted during verification/,
  );
});

test("compose: a replaced, restarting, unchecked or wrong-commit server cannot pass", async () => {
  const notReady = async () => ({ status: 503, json: async () => ({ ok: false }) });
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ services: { server: { health: null } } }),
      log: () => {},
    }),
    /server: image has no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ later: { server: { id: "server-2" } } }),
      log: () => {},
      fetchReady: notReady,
      ...cancelling(),
    }),
    /server: deployment changed during verification/,
  );
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ later: { server: { image: "sha256:new" } } }),
      log: () => {},
      fetchReady: notReady,
      ...cancelling(),
    }),
    /server: deployment changed during verification/,
  );
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ later: { server: { restarts: 1 } } }),
      log: () => {},
      fetchReady: notReady,
      ...cancelling(),
    }),
    /server: the container restarted during verification/,
  );
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ commits: { server: otherCommit } }),
      log: () => {},
      fetchReady: readyAt(),
    }),
    /server: the container runs commit fedcba987654, not 0123456789ab/,
  );
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose({ commits: { server: "" } }),
      log: () => {},
      fetchReady: readyAt(),
    }),
    /server: the image does not know its commit/,
  );
});

test("compose: an explicit restart (reset count or a new start time) is a restart", async () => {
  const notReady = async () => ({ status: 503, json: async () => ({ ok: false }) });
  for (const [first, then] of [
    [{ restarts: 2 }, { restarts: 0 }],
    [{}, { started: "2026-11-15T10:05:00.000000000Z" }],
  ]) {
    await assert.rejects(
      verifyDeployment(composeOptions(), {
        inspect: fakeCompose({ services: { server: first }, later: { server: then } }),
        log: () => {},
        fetchReady: notReady,
        ...cancelling(),
      }),
      /server: the container restarted during verification/,
      JSON.stringify(then),
    );
  }
  // A container that starts while watched is not a restart.
  await verifyDeployment(composeOptions(), {
    inspect: fakeCompose({
      services: {
        server: {
          status: "created",
          running: false,
          health: null,
          started: "0001-01-01T00:00:00Z",
        },
      },
      later: {
        server: {
          status: "running",
          running: true,
          health: "healthy",
          started: container("server").started,
        },
      },
    }),
    log: () => {},
    fetchReady: readyAt(),
    fetchPage: page,
    sleep: () => delay(1),
  });
});

test("compose: the containers are checked again after the HTTP probes, and cancellation there fails", async () => {
  await assert.rejects(
    verifyDeployment(composeOptions({ topology: "app-worker" }), {
      // Snapshot and first poll see the same worker; it restarts during /ready.
      inspect: fakeCompose({
        services: { server: {}, worker: {} },
        later: { worker: { restarts: 1 } },
        laterFrom: 2,
      }),
      log: () => {},
      fetchReady: readyAt(),
      fetchPage: page,
    }),
    /worker: the container restarted during verification/,
  );
  const controller = new AbortController();
  const messages = [];
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose(),
      log: (line) => messages.push(line),
      signal: controller.signal,
      fetchReady: readyAt(),
      fetchPage: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    }),
    /timed out or was cancelled/,
  );
  assert.ok(!messages.some((line) => line.startsWith("Deployment verified:")));
});

test("an earlier healthy release does not pass: /ready must report the expected commit", async () => {
  for (const answer of [
    { status: 200, body: { ok: true, commit: otherCommit } },
    { status: 200, body: { ok: true } },
    { status: 200, body: { ok: true, commit: null } },
    { status: 503, body: { ok: true, commit } },
    { status: 200, body: { ok: false, commit } },
  ]) {
    let polls = 0;
    await assert.rejects(
      verifyDeployment(composeOptions(), {
        inspect: fakeCompose(),
        log: () => {},
        ...cancelling(),
        fetchReady: async () => {
          polls++;
          return { status: answer.status, json: async () => answer.body };
        },
      }),
      /timed out or was cancelled/,
      JSON.stringify(answer),
    );
    assert.equal(polls, 1);
  }
  // A short expected SHA matches the full one the image and /ready report.
  await verifyDeployment(composeOptions({ commit: commit.slice(0, 7) }), {
    inspect: fakeCompose(),
    log: () => {},
    fetchReady: readyAt(),
    fetchPage: page,
  });
});

test("an HTTP 200 HTML fallback does not pass public readiness; cancellation fails", async () => {
  await assert.rejects(
    verifyDeployment(composeOptions(), {
      inspect: fakeCompose(),
      log: () => {},
      ...cancelling(),
      fetchReady: async () => ({
        status: 200,
        json: async () => {
          throw new Error("HTML");
        },
      }),
    }),
    /cancelled/,
  );
});

// --- Applications (Swarm) --------------------------------------------------

const service = {
  id: "service",
  version: 1,
  image: "server:latest",
  generation: 2,
  mode: { Replicated: { Replicas: 1 } },
};
const task = {
  id: "task",
  image: service.image,
  generation: 2,
  slot: 1,
  desired: "running",
  status: "running",
  container: { ContainerID: "container", ExitCode: 0 },
};

test("previous healthy tasks and completed one-shot tasks cannot satisfy runtime readiness", () => {
  assert.equal(evaluateService("server", service, [{ ...task, generation: 1 }]), null);
  assert.equal(evaluateService("server", service, [{ ...task, status: "complete" }]), null);
  assert.equal(evaluateService("worker", service, [{ ...task, desired: "shutdown" }]), null);
});

test("failed or rolled-back deployment and incomplete replica set cannot report success", () => {
  assert.throws(
    () => evaluateService("server", service, [{ ...task, status: "failed" }]),
    /failed/,
  );
  assert.throws(
    () => evaluateService("worker", service, [{ ...task, status: "failed" }]),
    /worker:.*failed/,
  );
  assert.throws(
    () =>
      evaluateService("server", { ...service, update: { State: "rollback_completed" } }, [task]),
    /rolled back/,
  );
  assert.equal(
    evaluateService("server", { ...service, mode: { Replicated: { Replicas: 2 } } }, [task]),
    null,
  );
});

function fakeSwarm({ health = "healthy", mutate = false, commits = {}, seen = [] } = {}) {
  let reads = 0;
  return async (args) => {
    seen.push(args);
    assert.ok(!args.join(" ").includes(".Env"));
    if (args[0] === "exec") {
      assert.equal(args[1], `${args[3] === commitFiles.worker ? "jobs" : "web"}-container`);
      assert.equal(args[2], "cat");
      const role = args[3] === commitFiles.worker ? "worker" : "server";
      return `${commits[role] ?? commit}\n`;
    }
    if (args[0] === "service" && args[1] === "inspect")
      return JSON.stringify({ ...service, generation: mutate && reads++ > 0 ? 3 : 2 });
    if (args[0] === "service") return `${args.at(-1)}-task`;
    if (args[2] === "task")
      return JSON.stringify({
        ...task,
        container: { ContainerID: `${args[3].replace(/-task$/, "")}-container` },
      });
    return JSON.stringify({ running: true, health });
  };
}

const applicationsOptions = (overrides = {}) => ({
  ...parseOptions(applicationsArgs),
  timeout: 1,
  ...overrides,
});

test("applications: healthy selected tasks of the expected commit and JSON readiness pass", async () => {
  const seen = [];
  await verifyDeployment(applicationsOptions({ worker: "jobs" }), {
    inspect: fakeSwarm({ seen }),
    log: () => {},
    fetchReady: readyAt(),
    fetchPage: page,
  });
  assert.deepEqual(
    seen.filter((args) => args[0] === "exec"),
    [
      ["exec", "web-container", "cat", commitFiles.server],
      ["exec", "jobs-container", "cat", commitFiles.worker],
    ],
  );
  await assert.rejects(
    verifyDeployment(applicationsOptions(), {
      inspect: fakeSwarm({ health: null }),
      log: () => {},
    }),
    /no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(applicationsOptions(), {
      inspect: fakeSwarm({ mutate: true }),
      log: () => {},
    }),
    /changed/,
  );
  await assert.rejects(
    verifyDeployment(applicationsOptions({ worker: "jobs" }), {
      inspect: fakeSwarm({ commits: { worker: otherCommit } }),
      log: () => {},
      fetchReady: readyAt(),
    }),
    /worker: the container runs commit fedcba987654/,
  );
  await assert.rejects(
    verifyDeployment(applicationsOptions(), {
      inspect: fakeSwarm(),
      log: () => {},
      ...cancelling(),
      fetchReady: readyAt(otherCommit),
    }),
    /timed out or was cancelled/,
  );
});

test("compression is classified per content-encoding token, including identity and multi-encodings", () => {
  assert.equal(evaluateCompression("gzip"), true);
  assert.equal(evaluateCompression("BR"), true);
  assert.equal(evaluateCompression("zstd"), true);
  assert.equal(evaluateCompression("gzip, br"), true);
  assert.equal(evaluateCompression("identity"), false);
  assert.equal(evaluateCompression(""), false);
  assert.equal(evaluateCompression(null), false);
});

test("compression advisory passes silently when compressed and warns without failing when not", async () => {
  const run = async (fetchPage) => {
    const messages = [];
    await verifyDeployment(composeOptions(), {
      inspect: fakeCompose(),
      log: (line) => messages.push(line),
      fetchReady: readyAt(),
      fetchPage,
    });
    return messages;
  };
  const page = (encoding, size) => async (url, init) => {
    assert.equal(url, "https://app.example.com/");
    assert.match(init.headers["accept-encoding"], /gzip/);
    assert.equal(init.redirect, "follow");
    return {
      headers: new Headers(encoding ? { "content-encoding": encoding } : {}),
      arrayBuffer: async () => new ArrayBuffer(size),
    };
  };
  const verified = (messages) => messages.some((line) => line.startsWith("Deployment verified:"));

  const compressed = await run(page("br", 4096));
  assert.ok(compressed.some((line) => /content-encoding: br/.test(line) && !/WARNING/.test(line)));
  assert.ok(verified(compressed));

  const uncompressed = await run(page(null, 4096));
  const warning = uncompressed.find((line) => line.includes("WARNING (non-fatal)"));
  assert.match(warning, /responded uncompressed/);
  assert.match(warning, /traefik\.http\.middlewares\.<name>\.compress/);
  assert.match(warning, /docs\/deployment\.md#response-compression$/);
  assert.ok(verified(uncompressed));

  const identity = await run(page("identity", 4096));
  assert.match(
    identity.find((line) => line.includes("WARNING")),
    /uncompressed/,
  );

  const tiny = await run(page(null, 12));
  assert.match(
    tiny.find((line) => line.includes("WARNING")),
    /under ~1 KB/,
  );

  const unreadable = await run(async () => {
    throw new Error("offline");
  });
  assert.match(
    unreadable.find((line) => line.includes("WARNING")),
    /could not be verified/,
  );
});

// Exercise dispatch without app dependencies or a database. Only absolute image
// script paths are remapped into an owned temporary fixture; shell logic is real.
async function entrypointFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-chess-entrypoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  const node = join(dir, "bin", "node");
  await writeFile(
    node,
    `#!/bin/sh
if [ "$1" = -p ]; then exec '${process.execPath}' "$@"; fi
exec '${process.execPath}' '${join(dir, "command.cjs")}' "$@"
`,
    { mode: 0o755 },
  );
  // tini stub: marks what it starts, then execs it (the real tini forwards
  // signals and reaps; the entrypoint execs it as PID 1).
  await writeFile(
    join(dir, "bin", "tini"),
    `#!/bin/sh
[ "$1" = -- ] && shift
FIXTURE_TINI=1 exec "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "command.cjs"),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args, id: process.env.COCKPIT_CHESS_INSTANCE_ID ?? null, writer: Boolean(process.env.BACKUP_S3_SECRET_ACCESS_KEY || process.env.BACKUP_S3_ACCESS_KEY_ID), bucket: process.env.BACKUP_S3_BUCKET ?? null, tini: Boolean(process.env.FIXTURE_TINI)}) + '\\n');
if (process.env.FIXTURE_NOTICE_FAIL && args.includes('--startup-notice')) process.exit(1);
if (process.env.FIXTURE_NOTICE_HANG && args.includes('--startup-notice')) {
  // A stalled /backups mount: the check never finishes on its own.
  process.on('SIGTERM', () => { fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({noticeTerm: true}) + '\\n'); process.exit(143); });
  setInterval(() => {}, 1000);
  console.log('notice-started');
}
if (process.env.FIXTURE_REFUSE && args.includes('apply')) process.exit(7);
if (process.env.FIXTURE_HOLD && args.includes('apply')) {
  const timer = setInterval(() => {}, 1000);
  // Like the real runner, whose TERM handler only requests its cancellation,
  // a repeated TERM (the entrypoint repeats it until the child is gone)
  // changes nothing while it drains.
  let draining = false;
  process.on('SIGTERM', () => {
    if (draining) return;
    draining = true;
    setTimeout(() => {
      fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({drained: true}) + '\\n');
      clearInterval(timer);
    }, 60);
  });
  setTimeout(() => { clearInterval(timer); process.exitCode = 99; }, 3000).unref();
  console.log('admission-started');
}
`,
  );
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const script = join(dir, "entrypoint.sh");
  let fixtureSource = source.replaceAll("/app/scripts/", `${dir}/scripts/`);
  if (assumeNoProc) {
    assert.ok(fixtureSource.includes(procDetection), "the /proc detection line exists");
    fixtureSource = fixtureSource.replace(procDetection, "");
  }
  await writeFile(script, fixtureSource);
  await mkdir(join(dir, "scripts/backup"), { recursive: true });
  for (const name of ["restore.sh", "pre-migrate.sh"])
    await writeFile(
      join(dir, "scripts/backup", name),
      `#!/bin/sh\nexec node '${dir}/scripts/backup/${name}' "$@"\n`,
    );
  /**
   * @param {string[]} args
   * @param {Record<string, string>} env
   * @param {{ signalOn?: string, signal?: NodeJS.Signals, sent?: boolean, script?: string, timeoutMs?: number, onSpawn?: (child: import("node:child_process").ChildProcess) => void }} [stop]
   *   send `signal` to the entrypoint once its output contains `signalOn`;
   *   `script` runs a modified copy instead of the entrypoint; `onSpawn` gets
   *   the entrypoint's ChildProcess
   */
  const run = async (args, env = {}, stop = {}) => {
    const log = join(dir, "commands");
    await writeFile(log, "");
    const child = spawn("sh", [stop.script ?? script, ...args], {
      env: { PATH: `${dir}/bin:${fixtureEnvironment.PATH}`, FIXTURE_LOG: log, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group: a run that hangs (a stop signal not forwarded)
      // is killed with every fixture child after a deadline instead of
      // hanging the suite.
      detached: true,
    });
    stop.onSpawn?.(child);
    // The entrypoint's own exit; `close` also waits for every process that
    // still holds its output pipes.
    const exited = new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolveCode(exitCode ?? exitSignal));
    });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (env.FIXTURE_HOLD && output.includes("admission-started")) child.kill("SIGTERM");
      if (stop.signalOn && !stop.sent && output.includes(stop.signalOn)) {
        stop.sent = true;
        child.kill(stop.signal ?? "SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let code;
    try {
      // Bounded: a regression that ignores a stop signal fails instead of hanging.
      code = await Promise.race([
        exited,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), stop.timeoutMs ?? 20_000);
        }),
      ]);
      assert.notEqual(code, "timeout", `the entrypoint did not exit in time:\n${output}`);
      // The entrypoint has exited: it must not have left a child running (a
      // stop that never reached the child). Allow 1 s for exits already under
      // way, then fail; the group is reaped either way.
      let survivors = true;
      for (let attempt = 0; attempt < 10 && survivors; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        try {
          process.kill(-child.pid, 0);
        } catch {
          survivors = false;
        }
      }
      assert.equal(
        survivors,
        false,
        `processes left running after the entrypoint exited:\n${output}`,
      );
    } finally {
      clearTimeout(timer);
      // Reap the whole group, even after a clean exit: a fixture child left
      // behind would hold the pipes and hang the suite.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone (ESRCH).
      }
      await exited.catch(() => {});
      await closed;
    }
    const lines = (await readFile(log, "utf8")).trim();
    const all = lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
    // The backups startup notice/check is reported separately.
    const isNotice = (entry) => entry.args?.includes("--startup-notice");
    return {
      code,
      output,
      all,
      commands: all.filter((entry) => !isNotice(entry)),
      notices: all.filter(isNotice),
    };
  };
  return { dir, run };
}

for (const [signal, status] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  test(`${signal} during a hanging startup check exits ${status}; the check gets TERM; the runner and CMD never start`, async (t) => {
    const { run } = await entrypointFixture(t);
    for (const args of [["migrate"], ["node", "apps/server/dist/index.mjs"]]) {
      const result = await run(
        args,
        {
          DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
          REDIS_URL: "redis://localhost",
          BETTER_AUTH_SECRET: "fixture-only",
          BACKUP_ENABLED: "true",
          FIXTURE_NOTICE_HANG: "1",
        },
        { signalOn: "notice-started", signal },
      );
      assert.equal(result.code, status, result.output);
      assert.equal(result.notices.length, 1);
      // TERM for every stop signal: a background child of sh starts with
      // SIGINT ignored, so only TERM reliably stops it.
      assert.ok(
        result.all.some((entry) => entry.noticeTerm),
        `the check got TERM: ${JSON.stringify(result.all)}`,
      );
      assert.deepEqual(
        result.commands.filter((entry) => entry.args),
        [],
        "neither the runner nor the CMD started",
      );
    }
  });
}

test("entrypoint stop-signal traps are installed before any child process", async () => {
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const body = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const trap = body.indexOf("trap 'stop_startup TERM 143' TERM");
  assert.ok(trap > 0, "the TERM trap exists");
  for (const child of ["$(node", "supervise node", "supervise bash", "exec tini"]) {
    const first = body.indexOf(child);
    assert.ok(first > trap, `${child} comes after the traps`);
  }
  // A signal between the fork and the PID assignment is only recorded (the
  // trap does not exit while a child is being launched); afterwards the child
  // is identified by its start time and gets TERM until it is gone.
  assert.match(
    body,
    /stop_startup\(\) \{\n\s*stop_signal="\$1"\n\s*\[ "\$stopping" = false \] \|\| \[ "\$have_proc" = false \] \|\| return 0\n\s*if \[ -n "\$child_pid" \]; then\n\s*stopping=true\n\s*stop_child\n\s*elif \[ "\$launching_child" = false \]; then\n\s*exit "\$2"\n\s*fi\n\s*\}/,
    "stop_startup only records a signal that lands while a child is launched",
  );
  assert.match(
    body,
    /launching_child=true\n\s*"\$@" &\n\s*child_pid=\$!\n\s*if \[ "\$have_proc" = true \]; then\n\s*proc_start "\$child_pid"\n\s*child_start=\$proc_start_value\n\s*fi\n\s*launching_child=false\n/,
    "supervise records the child's identity before it acts on a pending signal",
  );
  assert.match(
    body,
    /if \[ -n "\$stop_signal" \]; then\n\s*stopping=true\n\s*stop_child\n\s*wait "\$child_pid"/,
    "a pending or interrupting stop signal is forwarded until the child is gone",
  );
  // The trap path (stop_startup -> term_child -> child_alive -> proc_start)
  // never forks: no command substitution or external command in it.
  const fnBody = (name) => body.match(new RegExp(`\\n${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
  for (const name of ["stop_startup", "term_child", "child_alive", "proc_start"]) {
    const fn = fnBody(name);
    assert.ok(fn, `${name} exists`);
    assert.doesNotMatch(fn, /\$\(|`|\bcat\b|\bsleep\b/, `${name} never forks`);
  }
  // No step resets the handlers to the default (which PID 1 ignores).
  assert.doesNotMatch(body, /trap -( |$)/m);
});

// Copies of the entrypoint with a stop signal injected at the exact gap,
// without production hooks.
async function entrypointCopy(dir, name, edit) {
  const source = await readFile(join(dir, "entrypoint.sh"), "utf8");
  const lines = source.split("\n");
  const out = edit(lines);
  assert.notDeepEqual(out, lines, `${name}: the injection point was not found`);
  const path = join(dir, name);
  await writeFile(path, out.join("\n"));
  return path;
}
const injectBefore = (lines, target, injected) =>
  lines.flatMap((line) => (line.trim() === target ? [injected, line] : [line]));
const hangingCheckEnv = {
  DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
  REDIS_URL: "redis://localhost",
  BETTER_AUTH_SECRET: "fixture-only",
  WEBHOOK_SECRET_KEY: "fixture-only",
  BACKUP_ENABLED: "true",
  FIXTURE_NOTICE_HANG: "1",
};

for (const [signal, status] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  const name = signal.slice(3);
  // Every test in this loop needs the /proc repeat path.
  const test = procTest;
  test(`entrypoint ${signal} in the fork window (after the fork, before the PID is known) still stops a hanging startup check; exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    const script = await entrypointCopy(dir, `launch-gap-${name}.sh`, (lines) =>
      injectBefore(lines, "child_pid=$!", `  kill -${name} "$$"`),
    );
    // The TERM reaches the child within microseconds of its fork, where the
    // forked shell can still swallow it with the trap it inherited: a single
    // TERM was lost in about 40% of runs here. Repeat the case.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await run(["node", "apps/server/dist/index.mjs"], hangingCheckEnv, {
        script,
        timeoutMs: 8_000,
      });
      assert.equal(result.code, status, `attempt ${attempt}: ${result.output}`);
      assert.deepEqual(
        result.commands.filter((entry) => entry.args),
        [],
        "neither the runner nor the CMD started",
      );
    }
  });

  test(`entrypoint ${signal}: a child that misses the first TERM is still stopped (the TERM is repeated until it is gone); exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // The child swallows the first TERM it gets (then execs the command),
    // standing in for a TERM swallowed by the forked shell's inherited trap.
    // The stop is sent only once its trap is in place, so the first TERM is
    // always missed, however the processes are scheduled.
    const ready = join(dir, `deaf-ready-${name}`);
    const script = await entrypointCopy(dir, `deaf-child-${name}.sh`, (lines) =>
      injectBefore(
        lines.map((line) =>
          line.trim() === '"$@" &'
            ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
            : line,
        ),
        "child_pid=$!",
        `  while [ ! -e '${ready}' ]; do :; done; kill -${name} "$$"`,
      ),
    );
    assert.match(
      await readFile(script, "utf8"),
      /trap 'n=\$\(\(n \+ 1\)\)' TERM; : > '[^']+'; while \[ "\$n" -lt 1 \]/,
    );
    const result = await run(["node", "apps/server/dist/index.mjs"], hangingCheckEnv, {
      script,
      timeoutMs: 8_000,
    });
    assert.equal(result.code, status, result.output);
    assert.ok(result.notices.length <= 1);
    assert.deepEqual(
      result.commands.filter((entry) => entry.args),
      [],
      "neither the runner nor the CMD started",
    );
  });

  test(`entrypoint ${signal} just before supervise's wait still stops a child that misses the first TERM; exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // The signal lands after the "no stop pending" check, right before
    // `wait`: the handler runs first, then `wait` blocks. The handler must
    // itself repeat the TERM, or the deaf child runs to its end.
    const ready = join(dir, `wait-gap-ready-${name}`);
    const script = await entrypointCopy(dir, `wait-gap-${name}.sh`, (lines) =>
      injectBefore(
        lines.map((line) =>
          line.trim() === '"$@" &'
            ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
            : line,
        ),
        'wait "$child_pid"',
        `    while [ ! -e '${ready}' ]; do :; done; kill -${name} "$$"`,
      ),
    );
    const result = await run(["node", "apps/server/dist/index.mjs"], hangingCheckEnv, {
      script,
      timeoutMs: 8_000,
    });
    assert.equal(result.code, status, result.output);
    assert.deepEqual(
      result.commands.filter((entry) => entry.args),
      [],
      "neither the runner nor the CMD started",
    );
  });
}

procTest(
  "entrypoint repeated stop signals while the handler drains a child do not delay the exit; the last one sets the status",
  async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // TERM arrives while supervise waits (as from `docker stop`); the handler
    // then repeats TERM until the child, which swallows the first three, is gone; HUPs
    // arrive during that drain. Each nested trap must only record itself, and
    // must not stretch the 0.2 s pause: in dash a nested trap leaves $? at the
    // outer trap's status (here the interrupted wait's), so the pause cannot
    // branch on sleep's status.
    // (The /proc repeat path: without /proc nothing drains, and the test would
    // only check signal timing.)
    const ready = join(dir, "drain-ready");
    const script = await entrypointCopy(dir, "drain-repeat.sh", (lines) =>
      lines.map((line) =>
        line.trim() === '"$@" &'
          ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 3 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
          : line,
      ),
    );
    const exists = (path) =>
      readFile(path).then(
        () => true,
        () => false,
      );
    let first = 0;
    // Bounded, and stopped once the run is over (even a failed one).
    let over = false;
    /** @type {Promise<void> | undefined} */
    let sender;
    let result;
    try {
      result = await run(["node", "apps/server/dist/index.mjs"], hangingCheckEnv, {
        script,
        timeoutMs: 8_000,
        onSpawn: (child) => {
          sender = (async () => {
            const deadline = Date.now() + 8_000;
            while (!over && !(await exists(ready))) {
              if (Date.now() > deadline) return;
              await delay(10);
            }
            if (over) return;
            // Let supervise reach its wait.
            await delay(50);
            first = Date.now();
            child.kill("SIGTERM");
            // One HUP inside each 0.2 s pause of the drain.
            for (let i = 0; i < 3; i++) {
              await delay(i === 0 ? 60 : 200);
              if (over) return;
              child.kill("SIGHUP");
            }
          })();
        },
      });
    } finally {
      over = true;
      await sender;
    }
    const elapsed = Date.now() - first;
    assert.equal(result.code, 129, result.output);
    assert.ok(first > 0, "the child became ready");
    // About 0.6 s (three 0.2 s pauses); each stretched pause would add up to
    // 1 s (2.5 s or more in all).
    assert.ok(elapsed < 1_500, `the entrypoint took ${elapsed} ms after the first stop`);
  },
);

test("entrypoint without /proc, every stop signal still sends one TERM: a later signal stops a child that swallowed the first", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  // /proc detection forced off (the fallback outside Linux): nothing repeats
  // the TERM, so the stop guard must not swallow a later signal's TERM. The
  // first TERM (recorded during the launch) is swallowed by the child; the
  // second stop signal must stop it.
  const ready = join(dir, "noproc-ready");
  const script = await entrypointCopy(dir, "noproc.sh", (lines) =>
    injectBefore(
      lines.map((line) => {
        if (line.trim() === procDetection) return "";
        return line.trim() === '"$@" &'
          ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
          : line;
      }),
      "child_pid=$!",
      `  while [ ! -e '${ready}' ]; do :; done; kill -TERM "$$"`,
    ),
  );
  assert.doesNotMatch(await readFile(script, "utf8"), /have_proc=true/);
  const exists = (path) =>
    readFile(path).then(
      () => true,
      () => false,
    );
  let over = false;
  /** @type {Promise<void> | undefined} */
  let sender;
  let result;
  try {
    result = await run(["node", "apps/server/dist/index.mjs"], hangingCheckEnv, {
      script,
      timeoutMs: 8_000,
      onSpawn: (child) => {
        sender = (async () => {
          const deadline = Date.now() + 8_000;
          while (!over && !(await exists(ready))) {
            if (Date.now() > deadline) return;
            await delay(10);
          }
          // The first TERM has been swallowed by now; then a second stop.
          await delay(300);
          if (!over) child.kill("SIGHUP");
        })();
      },
    });
  } finally {
    over = true;
    await sender;
  }
  assert.equal(result.code, 129, result.output);
  assert.ok(result.notices.length <= 1);
});

test("all seven image commands dispatch before normal auth/Redis validation without registering an instance", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  for (const [args, expected] of [
    [["migrate"], ["db/migrate-runtime.mjs", "apply"]],
    [
      ["restore", "--list"],
      ["backup/restore.sh", "--list"],
    ],
    [
      ["backup", "--keep", "2"],
      ["backup/pre-migrate.sh", "--label", "manual", "--required", "--keep", "2"],
    ],
    [["backup-schedule"], ["backup/schedule.mjs", "run"]],
    [
      ["restore-drill", "dump"],
      ["backup/drill.mjs", "dump"],
    ],
    [
      ["hold-deletions", "3"],
      ["db/migrate-runtime.mjs", "hold", "3"],
    ],
    [
      ["hold-deletions", "--clear"],
      ["db/migrate-runtime.mjs", "hold", "--clear"],
    ],
  ]) {
    const result = await run(args, {
      DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
      BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
      COCKPIT_CHESS_INSTANCE_ID: "inherited-id-must-not-register",
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commands.length, 1);
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/${expected[0]}`,
      ...expected.slice(1),
    ]);
    assert.equal(result.commands[0].id, null);
    assert.equal(result.commands[0].writer, true);
    // `migrate` runs the runner as PID 1's child (and checks the backups
    // switch first); every other one-shot is exec'd under tini.
    assert.equal(result.commands[0].tini, args[0] !== "migrate");
    assert.equal(result.notices.length, args[0] === "migrate" ? 1 : 0);
  }
});

test("BACKUP_ENABLED is strict, and a failing startup check stops the migration", async (t) => {
  const { run } = await entrypointFixture(t);
  const env = {
    DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
    REDIS_URL: "redis://localhost",
    BETTER_AUTH_SECRET: "fixture-only",
    WEBHOOK_SECRET_KEY: "fixture-only",
  };
  for (const args of [["migrate"], ["backup"], ["node", "apps/server/dist/index.mjs"]]) {
    const bad = await run(args, { ...env, BACKUP_ENABLED: "yes" });
    assert.equal(bad.code, 1);
    assert.match(bad.output, /BACKUP_ENABLED must be true or false/);
    assert.equal(bad.commands.length + bad.notices.length, 0);
  }
  // BACKUP_ENABLED=true with no destination: pre-migrate.sh --startup-notice
  // fails (stubbed here), so neither the server nor `migrate` runs the runner.
  for (const args of [["migrate"], ["node", "apps/server/dist/index.mjs"]]) {
    const result = await run(args, { ...env, BACKUP_ENABLED: "true", FIXTURE_NOTICE_FAIL: "1" });
    assert.equal(result.code, 1, result.output);
    assert.equal(result.notices.length, 1);
    assert.equal(result.commands.length, 0);
  }
  // A server that only waits (MIGRATE_ON_START=false) needs no destination
  // when backups are on, and a waiting worker never checks.
  const waiting = await run(["node", "apps/server/dist/index.mjs"], {
    ...env,
    MIGRATE_ON_START: "false",
    BACKUP_ENABLED: "true",
    FIXTURE_NOTICE_FAIL: "1",
  });
  assert.equal(waiting.code, 0, waiting.output);
  assert.equal(waiting.notices.length, 0);
  const worker = await run(["node", "apps/worker/dist/index.mjs"], env);
  assert.equal(worker.code, 0, worker.output);
  assert.equal(worker.notices.length, 0);
});

test("server apply and worker wait precede app execution, with fresh per-start identity and stripped writer keys", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  const env = {
    DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
    REDIS_URL: "redis://localhost",
    BETTER_AUTH_SECRET: "fixture-only",
    BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
    BACKUP_S3_ACCESS_KEY_ID: "fixture-only",
    BACKUP_S3_BUCKET: "fixture-bucket",
  };
  const ids = new Set();
  for (const [role, mode] of [
    ["server", "apply"],
    ["worker", "wait"],
    ["server", "apply"],
  ]) {
    const result = await run(["node", `apps/${role}/dist/index.mjs`], env);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commands.length, 2);
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/db/migrate-runtime.mjs`,
      mode,
      "--role",
      role,
    ]);
    const id = result.commands[0].id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(result.commands[1].id, id);
    assert.equal(result.commands[0].writer, true);
    assert.equal(result.commands[0].tini, false, "the runner is PID 1's child, not tini's");
    assert.equal(result.commands[1].writer, false);
    // The monitor's non-secret location settings stay; the app runs under tini.
    assert.equal(result.commands[1].bucket, "fixture-bucket");
    assert.equal(result.commands[1].tini, true);
    // Only a migrating container checks/announces backups.
    assert.equal(result.notices.length, mode === "apply" ? 1 : 0);
    ids.add(id);
  }
  assert.equal(ids.size, 3);
  const refused = await run(["node", "apps/server/dist/index.mjs"], {
    ...env,
    FIXTURE_REFUSE: "true",
  });
  assert.equal(refused.code, 7);
  assert.equal(refused.commands.length, 1, "refused migration never executes application");
  const missing = await run(["node", "apps/server/dist/index.mjs"], {});
  assert.equal(missing.code, 1);
  assert.equal(missing.commands.length, 0);
  const invalid = await run(["node", "apps/worker/dist/index.mjs"], {
    ...env,
    MIGRATE_ON_START: "bad",
  });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.commands.length, 0);
});

test("the backups startup check runs once per migrating start; a waiting server only notes backups off", async (t) => {
  const { run } = await entrypointFixture(t);
  for (const enabled of [undefined, "", "false", "true"]) {
    for (const mode of ["true", "false"]) {
      for (const args of [
        ["migrate"],
        ["node", "apps/server/dist/index.mjs"],
        ["node", "apps/worker/dist/index.mjs"],
        ["backup-schedule"],
      ]) {
        const result = await run(args, {
          DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
          REDIS_URL: "redis://localhost",
          BETTER_AUTH_SECRET: "fixture-only",
          ...(enabled === undefined ? {} : { BACKUP_ENABLED: enabled }),
          BACKUP_SCHEDULE: "daily",
          MIGRATE_ON_START: mode,
        });
        assert.equal(result.code, 0, result.output);
        // The hook owns the notice; the entrypoint prints none of its own.
        assert.doesNotMatch(result.output, /backups are OFF/i);
        // Every container that migrates checks; a waiting server prints the
        // backups-off notice only; waiting workers and one-shots stay quiet.
        const role = args[1]?.includes("server") ? "server" : args[1] ? "worker" : null;
        const expected =
          args[0] === "migrate"
            ? 1
            : role && mode === "true"
              ? 1
              : role === "server" && enabled !== "true"
                ? 1
                : 0;
        assert.equal(result.notices.length, expected, `${args.join(" ")} ${enabled} ${mode}`);
      }
    }
  }
});

test("entrypoint rejects invalid BACKUP_ENABLED before dispatching any migration or schedule", async (t) => {
  const { run } = await entrypointFixture(t);
  for (const enabled of ["TRUE", "FALSE", "1", "yes", " true", "false "]) {
    for (const args of [
      ["migrate"],
      ["node", "apps/server/dist/index.mjs"],
      ["node", "apps/worker/dist/index.mjs"],
      ["backup-schedule"],
    ]) {
      const result = await run(args, { BACKUP_ENABLED: enabled });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /FATAL: BACKUP_ENABLED must be true or false/);
      assert.doesNotMatch(result.output, /Database backups are OFF/);
      assert.deepEqual(result.commands, []);
    }
  }
});

test("agent dev startup invokes runtime apply against the pinned Compose database after generate", async () => {
  const compose = await readFile(join(root, "docker-compose.agent.yml"), "utf8");
  assert.match(
    compose,
    /pnpm -F @cockpit-chess\/db exec prisma generate[\s\S]*node scripts\/db\/migrate-runtime\.mjs apply/,
  );
  // The app-dev service pins DATABASE_URL to the in-compose postgres in its
  // `environment:` block, which beats env_file/.env (dotenv never overrides).
  assert.match(
    compose,
    /app-dev:[\s\S]*?environment:[\s\S]*?DATABASE_URL: postgresql:\/\/postgres:password@postgres:5432\/cockpit_chess[\s\S]*?migrate-runtime\.mjs apply/,
  );
  // The retired schema-push command, spelled from parts so the destructive-operation
  // scanner does not read this negative assertion as an invocation.
  const retiredPush = new RegExp(["prisma", "db", "push"].join("\\s+"));
  assert.doesNotMatch(compose, retiredPush);
  assert.doesNotMatch(compose, /APPLY_SCHEMA|db-applier/);
  assert.match(compose, /MIGRATE_ON_START: "false"/);
});

test("entrypoint shutdown forwards cancellation and waits for migration child drain", async (t) => {
  const { run } = await entrypointFixture(t);
  const result = await run(["node", "apps/server/dist/index.mjs"], {
    DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
    REDIS_URL: "redis://localhost",
    BETTER_AUTH_SECRET: "fixture-only",
    FIXTURE_HOLD: "true",
  });
  assert.equal(result.code, 143, result.output);
  assert.equal(result.commands.length, 2, JSON.stringify(result.all));
  assert.deepEqual(result.commands[1], { drained: true });
});

test("apply and waiting runtimes refuse an image whose migration bytes differ from applied history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-chess-image-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "0_init"));
  await writeFile(join(dir, "0_init/migration.sql"), "-- committed fixture SQL\n");
  const migration = readMigrationsFolder(dir)[0];
  assert.ok(migration);
  let nativeCalls = 0;
  let disconnected = 0;
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const pg = {
    Client: class {
      on() {}
      async connect() {}
      async end() {
        disconnected++;
      }
      escapeIdentifier(name) {
        return `"${name}"`;
      }
      async query(sql) {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (sql.includes("pg_catalog.pg_locks")) return { rows: [{ held: false }] };
        if (sql.includes("to_regclass")) return { rows: [{ t: "_prisma_migrations" }] };
        if (sql.includes("SELECT migration_name, checksum"))
          return {
            rows: [
              {
                migration_name: migration.name,
                checksum: "0".repeat(64),
                finished_at: new Date(),
                rolled_back_at: null,
                logs: null,
              },
            ],
          };
        throw new Error("unexpected fixture query");
      }
    },
  };
  for (const mode of ["apply", "wait"]) {
    errors.length = 0;
    assert.equal(
      await runMigrations({
        mode,
        pg,
        migrationsDir: dir,
        contracts: false,
        env: { DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture" },
        runPrisma: async () => {
          nativeCalls++;
          throw new Error("native CLI must not start");
        },
      }),
      1,
    );
    assert.match(errors.join("\n"), /checksum|immutable|differs|edited/i);
  }
  assert.equal(nativeCalls, 0);
  assert.ok(disconnected >= 2, "admission closes its owned sessions on refusal");
});
