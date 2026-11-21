#!/usr/bin/env node
// Read-only verification on the single VPS. Never request env or container logs:
// it reads container labels and state, Swarm service and task state, and each
// image's baked BUILD_COMMIT file.
//
// Two deployment shapes (docs/deployment.md § Confirming a deploy is live):
//   --mode compose       the generated Dokploy Compose (`server`, the optional
//                        `worker` and `backup` services of one Compose project).
//   --mode applications  native Dokploy Applications (one Swarm service per role).
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sameCommit } from "./deploy-check.mjs";

const execute = promisify(execFile);
const serviceFormat =
  '{"id":{{json .ID}},"version":{{json .Version.Index}},"image":{{json .Spec.TaskTemplate.ContainerSpec.Image}},"generation":{{json .Spec.TaskTemplate.ForceUpdate}},"mode":{{json .Spec.Mode}},"update":{{json .UpdateStatus}}}';
const taskFormat =
  '{"id":{{json .ID}},"image":{{json .Spec.ContainerSpec.Image}},"generation":{{json .Spec.ForceUpdate}},"slot":{{json .Slot}},"desired":{{json .DesiredState}},"status":{{json .Status.State}},"container":{{json .Status.ContainerStatus}}}';
// Labels and state only: never .Config.Env, mounts' contents or logs.
const containerFormat =
  '{"id":{{json .Id}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"status":{{json .State.Status}},"running":{{json .State.Running}},"restarts":{{json .RestartCount}},"started":{{json .State.StartedAt}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';
/**
 * The commit each image was built from (Dockerfile / Dockerfile.worker stamp it
 * with scripts/build-commit.mjs). The backup service runs the server image.
 */
const BUILD_COMMIT_FILES = {
  server: "/app/apps/server/dist/BUILD_COMMIT",
  worker: "/app/apps/worker/dist/BUILD_COMMIT",
  backup: "/app/apps/server/dist/BUILD_COMMIT",
};
const USAGE =
  "Use --mode compose --project <compose project> [--topology app|app-worker] --url <https-origin> --commit <sha> [--timeout-seconds 600], or --mode applications --server <service> [--worker <service>] --url <https-origin> --commit <sha> [--timeout-seconds 600].";
const MODE_KEYS = {
  compose: new Set(["mode", "project", "topology", "url", "commit", "timeout-seconds"]),
  applications: new Set(["mode", "server", "worker", "url", "commit", "timeout-seconds"]),
};

export function parseOptions(args) {
  const options = {};
  const allowed = new Set([...MODE_KEYS.compose, ...MODE_KEYS.applications]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, "");
    if (
      !args[index].startsWith("--") ||
      !allowed.has(key) ||
      options[key] ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error(USAGE);
    options[key] = args[index + 1];
  }
  if (!MODE_KEYS[options.mode])
    throw new Error(`--mode compose or --mode applications is required. ${USAGE}`);
  for (const key of Object.keys(options))
    if (!MODE_KEYS[options.mode].has(key))
      throw new Error(`--${key} does not apply to --mode ${options.mode}. ${USAGE}`);
  if (!options.url || !options.commit) throw new Error(`--url and --commit are required. ${USAGE}`);
  // A healthy container proves only that something runs: an earlier release
  // left running by a failed redeploy is healthy too. Each runtime and /ready
  // must name this one.
  options.commit = options.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(options.commit))
    throw new Error("--commit must be a commit SHA (7 to 40 hex characters).");
  if (options.mode === "compose") {
    if (!options.project) throw new Error(`--project is required with --mode compose. ${USAGE}`);
    // Compose project names: lowercase letters, digits, dashes and underscores.
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(options.project))
      throw new Error("Invalid Compose project name.");
    options.topology ??= "app";
    if (!["app", "app-worker"].includes(options.topology))
      throw new Error("--topology must be app or app-worker.");
  } else {
    if (!options.server) throw new Error(`--server is required with --mode applications. ${USAGE}`);
    for (const key of ["server", "worker"]) {
      if (options[key] && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options[key]))
        throw new Error(`Invalid ${key} service name.`);
    }
    if (options.worker && options.worker === options.server)
      throw new Error("Each role must name a different service.");
  }
  const url = new URL(options.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("--url must be an HTTPS origin without credentials, query, or path.");
  const timeout = Number(options["timeout-seconds"] || 600);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
    throw new Error("Timeout must be between 1 and 3600 seconds.");
  return { ...options, url: url.origin, timeout };
}

/**
 * Judge one required Compose role (`server`, or `worker` in app-worker): exactly
 * one container (one replica), labelled for this project and service. Returns
 * true when it runs healthy, false while it is still starting; throws when it
 * cannot become a verified deployment.
 */
export function evaluateRole(project, role, containers) {
  if (containers.length === 0)
    throw new Error(`${role}: no ${role} container in Compose project "${project}".`);
  if (containers.length !== 1)
    throw new Error(`${role}: expected exactly one ${role} container (one replica).`);
  const [container] = containers;
  if (container.project !== project || container.service !== role)
    throw new Error(`${role}: container label mismatch.`);
  if (stopped(container))
    throw new Error(`${role}: the container has ${container.status}; inspect its logs in Dokploy.`);
  // Docker initializes health only when a container starts.
  if (container.status === "created") return false;
  if (container.health === null)
    throw new Error(`${role}: image has no healthcheck; startup cannot be verified.`);
  if (container.health === "unhealthy") throw new Error(`${role}: the container is unhealthy.`);
  return (
    container.running === true && container.status === "running" && container.health === "healthy"
  );
}

const stopped = (container) => container.status === "exited" || container.status === "dead";

/**
 * Judge an optional Compose service (`backup`; `worker` in the app topology).
 * Stopped containers do nothing and are ignored. A live one runs this
 * deployment's code against the same database, so at most one may exist and
 * the caller checks its commit. `allowed: false` means the topology has no
 * such service: a live one (a dedicated worker beside embedded jobs) fails.
 * Returns the live container or null.
 */
export function evaluateOptional(project, role, containers, { allowed }) {
  const live = containers.filter((container) => !stopped(container));
  if (live.length === 0) return null;
  if (!allowed)
    throw new Error(
      `${role}: a ${role} container runs in Compose project "${project}", but --topology app runs jobs in the server; pass --topology app-worker if this deployment uses a dedicated worker, or remove the leftover container.`,
    );
  if (live.length !== 1) throw new Error(`${role}: expected at most one live ${role} container.`);
  const [container] = live;
  if (container.project !== project || container.service !== role)
    throw new Error(`${role}: container label mismatch.`);
  return container;
}

export function evaluateService(role, service, tasks) {
  if (!service.mode?.Replicated || service.mode.Replicated.Replicas < 1)
    throw new Error(`${role}: expected an enabled Replicated service.`);
  if (/paused|rollback/.test(service.update?.State || ""))
    throw new Error(`${role}: rollout paused or rolled back; inspect Dokploy.`);
  const current = tasks.filter(
    (task) => task.image === service.image && (task.generation || 0) === (service.generation || 0),
  );
  // Historical completions and healthy old containers cannot satisfy this run.
  const selected = new Map();
  for (const task of current) {
    if (task.status === "failed" || task.status === "rejected")
      throw new Error(`${role}: a task from the selected deployment failed.`);
    if (task.status === "running" && task.desired === "running") selected.set(task.slot, task);
  }
  if (selected.size !== service.mode.Replicated.Replicas) return null;
  return [...selected.values()];
}

const compressionEncodings = new Set(["gzip", "br", "deflate", "zstd"]);

export function evaluateCompression(contentEncoding) {
  // `identity` means "no transformation", and rare multi-encodings list tokens
  // comma-separated; any compressing token counts as compressed.
  return (contentEncoding || "")
    .split(",")
    .some((token) => compressionEncodings.has(token.trim().toLowerCase()));
}

async function reportCompression(options, { fetchPage, log, deadline }) {
  // The Node server ships no compression middleware by design — that is the
  // proxy's job — and Traefik (Dokploy's default) has compression off. `/` is
  // the probe because it redirects to the SSR'd locale home, a full HTML
  // document safely above the ~1 KB threshold below which proxies legitimately
  // skip compressing. Managed platforms compress at an edge this script cannot
  // see, so a miss is a warning, never a verification failure.
  let response;
  try {
    response = await fetchPage(`${options.url}/`, {
      redirect: "follow",
      headers: { "accept-encoding": "gzip, br" },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
  } catch {
    log(
      "WARNING (non-fatal): response compression could not be verified because the request to the public site root failed after readiness passed. If this is a Dokploy deployment, confirm the Traefik compress middleware in docs/deployment.md#response-compression",
    );
    return;
  }
  const encoding = response.headers.get("content-encoding") || "";
  let bytes = null;
  try {
    bytes = (await response.arrayBuffer()).byteLength;
  } catch {
    /* Body size unavailable; judge by the header alone. */
  }
  if (evaluateCompression(encoding)) {
    log(
      `Response compression verified: the public site root was served with content-encoding: ${encoding}.`,
    );
    return;
  }
  log(
    bytes !== null && bytes < 1024
      ? `WARNING (non-fatal): response compression could not be confirmed: the public site root response was only ${bytes} bytes, and proxies skip compressing bodies under ~1 KB. Re-check a full page manually, or enable the Traefik compress middleware in docs/deployment.md#response-compression`
      : `WARNING (non-fatal): the public site root responded uncompressed (${bytes === null ? "unknown size" : `${bytes} bytes`}, no content-encoding) — on Dokploy, Traefik's compress middleware is off by default, so every SSR page and JSON response ships uncompressed until you attach a compress middleware to the server router (the traefik.http.middlewares.<name>.compress and traefik.http.routers.<name>.middlewares labels). Platforms whose edge compresses for you can ignore this warning. See docs/deployment.md#response-compression`,
  );
}

async function docker(args, signal) {
  try {
    return (
      await execute("docker", args, { signal, timeout: 10_000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(
      "Docker inspection failed. Run this on the single VPS with Docker access; no configuration was changed.",
    );
  }
}

/**
 * The container itself must run the expected release, not merely some healthy
 * container while the URL answers from another deployment. Each container ID is
 * read once, from the file its image baked at build time.
 */
function commitChecker(options, inspect, deadline) {
  const verified = new Set();
  return async (role, id) => {
    if (verified.has(id)) return;
    let commit;
    try {
      commit = (await inspect(["exec", id, "cat", BUILD_COMMIT_FILES[role]], deadline)).trim();
    } catch (error) {
      if (deadline.aborted) throw error;
      throw new Error(
        `${role}: the image's build commit (${BUILD_COMMIT_FILES[role]}) could not be read; an image built before it was stamped cannot be verified. Rebuild from the expected commit.`,
      );
    }
    if (!sameCommit(commit, options.commit))
      throw new Error(
        commit
          ? `${role}: the container runs commit ${commit.slice(0, 12)}, not ${options.commit.slice(0, 12)}; if a deploy is still running, rerun after it finishes.`
          : `${role}: the image does not know its commit (built without git metadata or BUILD_VERSION); the deployment cannot be verified.`,
      );
    verified.add(id);
  };
}

/** Compose: the project's server (+ worker), and any live optional service. */
async function composePoller(options, { inspect, log, deadline, checkCommit }) {
  const { project } = options;
  const external = options.topology === "app-worker";
  const required = external ? ["server", "worker"] : ["server"];
  // Embedded jobs (app): a live worker would consume the same queues twice.
  const optional = external ? ["backup"] : ["worker", "backup"];
  const list = async (service) => {
    const ids = (
      await inspect(
        [
          "ps",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          `label=com.docker.compose.service=${service}`,
          // Not `docker compose run` containers (`run --rm server migrate`):
          // they carry the same labels.
          "--filter",
          "label=com.docker.compose.oneoff=False",
        ],
        deadline,
      )
    )
      .split(/\s+/)
      .filter(Boolean);
    const containers = [];
    for (const id of ids)
      containers.push(
        JSON.parse(
          await inspect(
            ["inspect", "--type", "container", id, "--format", containerFormat],
            deadline,
          ),
        ),
      );
    return containers;
  };
  const snapshot = async () => {
    const roles = new Map();
    for (const role of required) {
      const containers = await list(role);
      const ready = evaluateRole(project, role, containers);
      roles.set(role, { container: containers[0], ready });
    }
    for (const role of optional) {
      const container = evaluateOptional(project, role, await list(role), {
        allowed: role === "backup",
      });
      // A live optional service is checked once it runs; health is its own
      // concern (the backup service reports backup freshness, not startup).
      roles.set(role, { container, ready: container === null || container.running === true });
    }
    return roles;
  };
  const first = await snapshot();
  const warned = new Set();
  /** Each role's StartedAt, from the first snapshot or poll that sees it running. */
  const startedAt = new Map();
  for (const [role, { container }] of first)
    if (container?.running === true) startedAt.set(role, container.started);
  log(
    `Checking the ${required.join(" and ")} container${required.length > 1 ? "s" : ""} of Compose project "${project}" (topology ${options.topology}). Run this after Dokploy finishes the deployment.`,
  );
  return async () => {
    const roles = await snapshot();
    let ready = true;
    for (const [role, { container, ready: roleReady }] of roles) {
      const before = first.get(role).container;
      if (container?.id !== before?.id || container?.image !== before?.image)
        throw new Error(
          `${role}: deployment changed during verification; rerun after the new deploy finishes.`,
        );
      if (!container) continue;
      // `restart: unless-stopped` hides a crash loop behind a fresh start. An
      // explicit restart resets RestartCount, so a changed start time counts too.
      if (container.running === true && !startedAt.has(role))
        startedAt.set(role, container.started);
      if (
        container.restarts !== before.restarts ||
        (container.running === true && container.started !== startedAt.get(role))
      )
        throw new Error(
          `${role}: the container restarted during verification; inspect its logs in Dokploy.`,
        );
      if (!roleReady) {
        ready = false;
        continue;
      }
      await checkCommit(role, container.id);
      if (role === "backup" && container.health === "unhealthy" && !warned.has(role)) {
        warned.add(role);
        log(
          "WARNING (non-fatal): the backup service reports unhealthy: its last scheduled backup failed or is overdue. Check its logs in Dokploy and docs/backup-restore.md.",
        );
      }
    }
    return ready;
  };
}

/** Applications: the selected Swarm task generation of each named service. */
async function applicationsPoller(options, { inspect, log, deadline, checkCommit }) {
  const services = ["server", "worker"].filter((role) => options[role]);
  const snapshots = new Map();
  for (const role of services) {
    snapshots.set(
      role,
      JSON.parse(
        await inspect(["service", "inspect", options[role], "--format", serviceFormat], deadline),
      ),
    );
  }
  log(
    "Checking the currently selected deployment. Run this after Dokploy finishes building each selected Application.",
  );
  return async () => {
    let ready = true;
    for (const role of services) {
      const service = JSON.parse(
        await inspect(["service", "inspect", options[role], "--format", serviceFormat], deadline),
      );
      const previous = snapshots.get(role);
      if (
        service.id !== previous.id ||
        service.image !== previous.image ||
        service.generation !== previous.generation ||
        JSON.stringify(service.mode) !== JSON.stringify(previous.mode)
      )
        throw new Error(
          `${role}: deployment changed during verification; rerun after the new build finishes.`,
        );
      const ids = (
        await inspect(["service", "ps", "--quiet", "--no-trunc", options[role]], deadline)
      )
        .split(/\s+/)
        .filter(Boolean);
      const tasks = [];
      for (const id of ids)
        tasks.push(
          JSON.parse(
            await inspect(["inspect", "--type", "task", id, "--format", taskFormat], deadline),
          ),
        );
      const selected = evaluateService(role, service, tasks);
      if (!selected) {
        ready = false;
        continue;
      }
      for (const task of selected) {
        if (!task.container?.ContainerID) {
          ready = false;
          continue;
        }
        const container = JSON.parse(
          await inspect(
            [
              "inspect",
              "--type",
              "container",
              task.container.ContainerID,
              "--format",
              containerFormat,
            ],
            deadline,
          ),
        );
        if (container.health === "unhealthy")
          throw new Error(`${role}: selected container is unhealthy.`);
        if (container.health === null)
          throw new Error(`${role}: image has no healthcheck; startup cannot be verified.`);
        if (!container.running || container.health !== "healthy") {
          ready = false;
          continue;
        }
        await checkCommit(role, task.container.ContainerID);
      }
    }
    return ready;
  };
}

async function publicReady(options, fetchReady, deadline) {
  try {
    const response = await fetchReady(`${options.url}/ready`, {
      redirect: "error",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
    const body = await response.json();
    return response.status === 200 && body.ok === true && sameCommit(body.commit, options.commit);
  } catch {
    return false;
  }
}

export async function verifyDeployment(
  options,
  {
    inspect = docker,
    fetchReady = fetch,
    fetchPage = fetch,
    sleep = delay,
    signal = new AbortController().signal,
    log = console.log,
  } = {},
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.timeout * 1000)]);
  const seams = { inspect, log, deadline, checkCommit: commitChecker(options, inspect, deadline) };
  const poll =
    options.mode === "compose"
      ? await composePoller(options, seams)
      : await applicationsPoller(options, seams);
  while (!deadline.aborted) {
    let ready = (await poll()) && (await publicReady(options, fetchReady, deadline));
    if (ready && !deadline.aborted) {
      await reportCompression(options, { fetchPage, log, deadline });
      // The containers must still be the same, settled ones after the HTTP
      // probes; a restart or replacement meanwhile throws here.
      ready = !deadline.aborted && (await poll());
    }
    if (ready && !deadline.aborted) {
      log(
        `Deployment verified: the server (and worker) containers are healthy, every live runtime container runs commit ${options.commit.slice(0, 12)}, and the public readiness endpoint reports it.`,
      );
      return;
    }
    try {
      await sleep(5000, undefined, { signal: deadline });
    } catch {
      /* Timeout or shutdown. */
    }
  }
  throw new Error(
    "Deployment verification timed out or was cancelled. Check the selected containers, the commit /ready reports and readiness in Dokploy; no rollback or database change was performed.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => controller.abort());
  try {
    await verifyDeployment(parseOptions(process.argv.slice(2)), { signal: controller.signal });
  } catch (error) {
    // Never echo command output, Docker config, response bodies, or URL errors.
    console.error(
      error instanceof TypeError || error instanceof SyntaxError
        ? "Invalid configuration or unexpected inspection response; deployment was not verified."
        : error.message,
    );
    process.exitCode = 1;
  }
}
