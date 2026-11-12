/**
 * Guards the hand-enumerated `COPY <app-or-package>/package.json` lists in the
 * two Dockerfiles against the actual set of workspace members on disk.
 *
 *   pnpm docker:check-copy   — verify without writing (CI gate; non-zero exit on drift)
 *
 * Why this exists: `Dockerfile` and `Dockerfile.worker` copy each workspace
 * member's `package.json` individually BEFORE `pnpm install --frozen-lockfile`
 * (so workspace symlinks + the lockfile's importers resolve) and BEFORE
 * `COPY . .`. Add a new `packages/*` or `apps/*` workspace member and forget to
 * add its COPY line and the install step fails inside `docker build` — a failure
 * that never shows up in `pnpm build`, tests, or typecheck. This script makes
 * that omission a fast, CI-visible error instead.
 *
 * The invariants it enforces (see AGENTS.md § Dockerfiles — keep server and
 * worker in sync):
 *
 *   1. Each `builder` stage installs its filtered dependency closure, so it
 *      MUST list every on-disk workspace
 *      member except the intentional exclusions below — and both Dockerfiles'
 *      builder lists must therefore be identical.
 *   2. Each `prod-deps` stage installs a filtered subset (`--filter=web...` /
 *      `--filter=worker...`), so its list must be a NON-EMPTY SUBSET of the same
 *      file's builder list — never referencing a member the builder omits or one
 *      that no longer exists on disk. Non-empty because a subset check alone is
 *      satisfied by the empty set: deleting every COPY line would otherwise read
 *      as "in sync".
 *   3. Within a stage, every COPY line must appear BEFORE that stage's
 *      `pnpm install`. This is the ordering the whole scheme depends on, so it
 *      is checked rather than assumed — a COPY that drifts below the install
 *      breaks `docker build` and passes every other check in CI.
 *
 * What it still cannot tell you: whether `prod-deps` is missing a member the
 * image needs at RUNTIME. Which members belong there is a judgment call per
 * image (see AGENTS.md), so adding that line when you add a workspace member
 * remains a manual step.
 *
 * Intentional exclusions (allowlisted, never expected in a COPY list):
 *   - apps/cli          — excluded from the Docker build context via .dockerignore
 *                         (the filtered install never needs its manifest).
 *
 * The runner stages are deliberately NOT checked for workspace members: they
 * copy only the minimal set of manifests a running image needs, not the install
 * closure. They ARE checked for runtime SCRIPTS (see the bottom of this file):
 * every sibling script a shipped shell script shells out to must be COPY'd into
 * the same image, and the committed migrations must ship with packages/db/prisma.
 * Both app images' HEALTHCHECK `--start-period` is also checked against the
 * migration startup gate (the runner's fixed follower wait + apply budget),
 * because Docker only exempts failed probes during the start-period window.
 *
 * Node builtins only — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check`.
 */

import { deepStrictEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Workspace members that legitimately have no pre-install COPY line.
const ALLOWLIST = new Set(["apps/cli"]);

// Stages whose COPY lists we verify. The runner stages are intentionally left
// out (they copy only what a running image needs, not the install closure).
const BUILDER = "builder";
const PROD_DEPS = "prod-deps";

const DOCKERFILES = ["Dockerfile", "Dockerfile.worker"];

// Beyond the follower wait, the HEALTHCHECK start-period must also fund the
// migrating leader's own startup: the optional backup and migration deploy
// can run past a follower's full wait window, and the app still needs
// time to boot once the gate opens. The 120s of apply slack funds whichever
// single backup runs (the pre-migrate and the pre-drop backup are mutually
// exclusive per run). Every other timed step of a start is parsed from the
// runner's source (BUDGET_SOURCES) and added: the pre-deploy catalog read, the
// scheduled deletions run budget plus the bookkeeping that may run past it,
// the image-schema diff, the deletions' catalog read, registration, and the
// runner-table steps (RUNTIME_STEPS × RUNTIME_STEP_TIMEOUT_MS):
// 510 > 300 + 120 + 10 + 30 + 5 + 20 + 5 + 5 + 5 × 2 = 505.
const APPLY_BUDGET_SLACK = 120;
const BUDGET_SOURCES = ["scripts/db/migrate-runtime.mjs", "scripts/db/lib/contracts.mjs"];

/** Discover on-disk workspace members: `apps/*` / `packages/*` with a package.json. */
function discoverMembers(): Set<string> {
  const members = new Set<string>();
  for (const group of ["apps", "packages"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = `${group}/${name}`;
      try {
        readFileSync(resolve(ROOT, group, name, "package.json"));
        members.add(id);
      } catch {
        // no package.json → not a workspace member (e.g. an assets-only dir)
      }
    }
  }
  return members;
}

/**
 * Yield Dockerfile *logical* lines: physical lines with trailing-backslash
 * continuations folded into one, reported at the line number the instruction
 * starts on. Without this, any multi-line `RUN`/`COPY` reads as several
 * unrelated fragments — see `installRe` for why that matters.
 */
function* logicalLines(text: string): Generator<{ line: string; lineNo: number }> {
  const physical = text.split("\n");
  let buffer = "";
  let startLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = (physical[i] ?? "").trim();
    // A `\` continues the instruction onto the next physical line.
    const continues = raw.endsWith("\\");
    const piece = continues ? raw.slice(0, -1).trim() : raw;

    if (buffer === "") startLine = i + 1;
    buffer = buffer === "" ? piece : `${buffer} ${piece}`;

    if (continues) continue;
    yield { line: buffer, lineNo: startLine };
    buffer = "";
  }
  // A file ending on a dangling continuation still yields what it accumulated.
  if (buffer !== "") yield { line: buffer, lineNo: startLine };
}

/**
 * Split a Dockerfile into stages keyed by their `AS <name>` label and collect
 * the `COPY <group>/<name>/package.json <group>/<name>/` members in each.
 */
function parseStages(dockerfile: string): Map<string, Set<string>> {
  const text = readFileSync(resolve(ROOT, dockerfile), "utf8");
  const stages = new Map<string, Set<string>>();
  let current: Set<string> | null = null;

  // `FROM --platform=… <image> AS <stage>`: the flags between FROM and the
  // image are optional, and `AS` is case-insensitive in Dockerfile syntax.
  const stageRe = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i;
  const copyRe =
    /^COPY\s+((?:apps|packages)\/[^/]+)\/package\.json\s+((?:apps|packages)\/[^/]+)\//i;
  // The whole point of the hand-enumerated COPY lines is that they land before
  // the install, so the lockfile's importers and workspace symlinks resolve
  // against real package.json files. A COPY that drifts below this breaks
  // `docker build` at install time and nothing else in CI would catch it.
  //
  // Matched against JOINED logical lines (see below), not physical ones. The
  // install is single-line today, but the standard BuildKit cache-mount form
  // splits it:
  //
  //     RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  //         pnpm install --frozen-lockfile
  //
  // A physical-line match would silently stop finding the install there, and
  // invariant 3 would check nothing while still reporting "in sync" — the exact
  // vacuous pass the other two invariants guard against.
  const installRe = /^RUN\s[\s\S]*pnpm\s+install/i;

  let currentStage = "";
  let installSeenAt = -1;

  for (const { line, lineNo } of logicalLines(text)) {
    const stageMatch = stageRe.exec(line);
    if (stageMatch) {
      current = new Set<string>();
      currentStage = stageMatch[1] ?? "";
      installSeenAt = -1;
      stages.set(currentStage, current);
      continue;
    }
    if (!current) continue;
    if (installRe.test(line)) {
      installSeenAt = lineNo;
      continue;
    }
    const copyMatch = copyRe.exec(line);
    if (copyMatch) {
      if (installSeenAt !== -1) {
        errors.push(
          `${dockerfile} (${currentStage}): COPY line for "${copyMatch[1]}" on line ${lineNo} ` +
            `comes AFTER \`pnpm install\` on line ${installSeenAt}. It must precede the install, ` +
            `or the install resolves against a missing package.json and \`docker build\` fails.`,
        );
      }
      // Both sides of the COPY must reference the same member; a mismatch is a
      // typo worth surfacing (e.g. a bad copy/paste of the destination path).
      if (copyMatch[1] !== copyMatch[2]) {
        errors.push(
          `${dockerfile}: COPY line mismatch — source "${copyMatch[1]}" but destination "${copyMatch[2]}".`,
        );
      }
      current.add(copyMatch[1] ?? "");
    }
  }
  return stages;
}

/** Require the actual source-to-destination mapping in the final runner stage. */
function runtimeScriptCopies(text: string): Set<string> {
  const copied = new Set<string>();
  let runner = false;
  for (const { line } of logicalLines(text)) {
    if (/^FROM\s/i.test(line)) {
      runner = /\sAS\s+runner$/i.test(line);
      continue;
    }
    if (!runner || !/^COPY\s/i.test(line)) continue;
    const body = line.replace(/^COPY\s+/i, "").replace(/^(?:--\S+\s+)*/, "");
    const parts: string[] = body.startsWith("[") ? JSON.parse(body) : body.split(/\s+/);
    const destination = parts.pop();
    if (!destination) continue;
    for (const source of parts) {
      const script = source.replace(/^\/app\//, "").replace(/^\.\//, "");
      if (!/^scripts\/.+\.(?:mjs|sh|ts)$/.test(script)) continue;
      const target = resolve(
        "/app",
        destination,
        parts.length > 1 || destination.endsWith("/") ? basename(source) : "",
      );
      const expected =
        script === "scripts/docker-entrypoint.sh"
          ? "/usr/local/bin/docker-entrypoint.sh"
          : `/app/${script}`;
      if (target === expected) copied.add(script);
    }
  }
  return copied;
}

/** Inventory shell siblings, Node root-relative helpers, and local ESM imports. */
function runtimeScriptReferences(script: string, text: string): Set<string> {
  const references = new Set<string>();
  const file = "((?:[A-Za-z0-9_-]+\\/)*[A-Za-z0-9._-]+\\.(?:mjs|sh|ts))";
  // Root-relative: $ROOT/scripts/x, /app/scripts/x.
  for (const match of text.matchAll(
    new RegExp(`(?:\\$ROOT\\/scripts|\\/app\\/scripts)\\/${file}`, "g"),
  )) {
    references.add(`scripts/${match[1]}`);
  }
  // Script-dir-relative: $(dirname "$0")/x, "$(cd "$(dirname "$0")" && pwd)/x", $HERE/x.
  for (const match of text.matchAll(
    new RegExp(`(?:\\$\\(dirname "\\$0"\\)|&& pwd\\)|\\$HERE|\\$\\{HERE\\})\\/${file}`, "g"),
  )) {
    references.add(relative(ROOT, resolve(ROOT, dirname(script), match[1]!)));
  }
  for (const match of text.matchAll(new RegExp(`["'](scripts\\/${file.slice(1, -1)})["']`, "g"))) {
    references.add(match[1]!);
  }
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.(?:mjs|sh|ts))["']/g,
  )) {
    references.add(relative(ROOT, resolve(ROOT, dirname(script), match[1]!)));
  }
  return references;
}

/**
 * HEALTHCHECK `--start-period=<N>s` in seconds, or null when the directive (or
 * the flag) is absent. Reads logical lines so the standard two-line
 * `HEALTHCHECK … \ CMD …` form parses as one instruction.
 */
function healthcheckStartPeriod(text: string): number | null {
  for (const { line } of logicalLines(text)) {
    if (!/^HEALTHCHECK\s/i.test(line)) continue;
    const seconds = line.match(/--start-period=(\d+)s/i)?.[1];
    return seconds ? Number(seconds) : null;
  }
  return null;
}

/**
 * The follower wait, parsed from scripts/db/migrate-runtime.mjs source
 * (`export const WAIT_TIMEOUT_MS = 300_000;`). Parsed rather than hardcoded
 * here so raising the real value flips this check instead of silently
 * diverging from it.
 */
function schemaWaitDefaultSeconds(text: string): number | null {
  return exportedSeconds(text, "WAIT_TIMEOUT_MS");
}

/** `export const <NAME> = <number>;` from the runner's source. */
function exportedNumber(text: string, name: string): number | null {
  const value = text.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`))?.[1];
  return value ? Number(value.replaceAll("_", "")) : null;
}

/** `export const <NAME> = <ms>;` from the runner's source, in seconds. */
function exportedSeconds(text: string, name: string): number | null {
  const ms = exportedNumber(text, name);
  return ms === null ? null : ms / 1000;
}

/** The startup budget: every timed step of a start, in order, in seconds. */
type StartupBudget = { parts: Array<{ label: string; seconds: number }> };

/** Millisecond constants, each one timed step (label = the constant's name). */
const BUDGET_STEPS = [
  "WAIT_TIMEOUT_MS",
  "PREDEPLOY_CATALOG_TIMEOUT_MS",
  "CONTRACT_RUN_BUDGET_MS",
  "CONTRACT_PREAMBLE_TIMEOUT_MS",
  "IMAGE_SCHEMA_TIMEOUT_MS",
  "CONTRACTS_CATALOG_TIMEOUT_MS",
  "REGISTER_TIMEOUT_MS",
];

/** Parse the budget from the concatenated BUDGET_SOURCES; null when any part is missing. */
function startupBudget(text: string): StartupBudget | null {
  const parts: StartupBudget["parts"] = [];
  for (const name of BUDGET_STEPS) {
    const seconds = exportedSeconds(text, name);
    if (seconds === null) return null;
    parts.push({ label: name, seconds });
    if (name === "WAIT_TIMEOUT_MS")
      parts.push({ label: "apply budget", seconds: APPLY_BUDGET_SLACK });
  }
  const steps = exportedNumber(text, "RUNTIME_STEPS");
  const stepSeconds = exportedSeconds(text, "RUNTIME_STEP_TIMEOUT_MS");
  if (steps === null || stepSeconds === null) return null;
  parts.push({
    label: `RUNTIME_STEPS ${steps} × RUNTIME_STEP_TIMEOUT_MS`,
    seconds: steps * stepSeconds,
  });
  return { parts };
}

/**
 * The HEALTHCHECK start-period must EXCEED the schema startup gate: the
 * follower WAIT_TIMEOUT_MS plus APPLY_BUDGET_SLACK plus every other timed
 * step of a start (`startupBudget`). Both app
 * images sit in the entrypoint's schema gate before the CMD process exists,
 * and Docker only exempts failed probes during --start-period — a start-period
 * inside the gate window marks a follower that is legitimately mid-wait (or a
 * leader still deleting) as unhealthy.
 * Pure (returns error strings rather than pushing) so --self-test can drive it
 * with fixtures before `errors` exists.
 */
function healthcheckStartPeriodErrors(
  dockerfile: string,
  text: string,
  budget: StartupBudget,
): string[] {
  const startPeriod = healthcheckStartPeriod(text);
  if (startPeriod === null) {
    return [
      `${dockerfile}: no \`HEALTHCHECK … --start-period=<N>s\` found — the startup budget that ` +
        `must cover the migration wait plus apply time cannot be verified.`,
    ];
  }
  const required = budget.parts.reduce((sum, part) => sum + part.seconds, 0);
  if (startPeriod > required) return [];
  return [
    `${dockerfile}: HEALTHCHECK --start-period=${startPeriod}s is not greater than the migration ` +
      `startup gate: ${budget.parts.map((part) => `${part.label} ${part.seconds}s`).join(" + ")} ` +
      `(${BUDGET_SOURCES.join(", ")}) = ${required}s. ` +
      `A follower legitimately waiting for migrations would be marked unhealthy mid-wait. ` +
      `Raise --start-period in ${DOCKERFILES.join(" and ")}, or lower the budgets in ` +
      `${BUDGET_SOURCES.join(" and ")}.`,
  ];
}

/**
 * Instruction lines that run `npm install` (or `npm i` / `npm ci` / `npm add` /
 * `npx`). None is allowed: Node
 * 25+ no longer bundles corepack, and the pinned pnpm arrives through
 * scripts/install-pnpm.mjs, which checks the tarball against the SHA-512 in
 * package.json `packageManager` (`npm install -g pnpm@<x>` would trust whatever
 * the registry serves). Pure for --self-test.
 */
function disallowedNpmInstallLines(instructions: string): string[] {
  return instructions
    .split("\n")
    .filter((line) => /\bnpm\s+(?:install|i|ci|add)\b|\bnpx\s/.test(line));
}

/** The two instructions every image uses to install pnpm (see scripts/install-pnpm.mjs). */
const PNPM_BOOTSTRAP_COPY = "COPY package.json scripts/install-pnpm.mjs /tmp/pnpm-bootstrap/";
const PNPM_BOOTSTRAP_RUN =
  "node /tmp/pnpm-bootstrap/install-pnpm.mjs /tmp/pnpm-bootstrap/package.json";

/** Errors for a Dockerfile that installs pnpm any other way. Pure for --self-test. */
function pnpmBootstrapErrors(dockerfile: string, instructions: string): string[] {
  const lines = instructions.split("\n").map((line) => line.trim());
  const errors: string[] = [];
  if (!lines.includes(PNPM_BOOTSTRAP_COPY)) {
    errors.push(`${dockerfile} must \`${PNPM_BOOTSTRAP_COPY}\` to install the pinned pnpm.`);
  }
  if (!lines.some((line) => line.includes(PNPM_BOOTSTRAP_RUN))) {
    errors.push(
      `${dockerfile} must run \`${PNPM_BOOTSTRAP_RUN}\` (SHA-512-verified pnpm, scripts/install-pnpm.mjs).`,
    );
  }
  if (lines.some((line) => /\bcorepack\b/.test(line))) {
    errors.push(
      `${dockerfile} uses corepack; Node 25+ does not bundle it — use scripts/install-pnpm.mjs.`,
    );
  }
  return errors;
}

/** Errors for a .dockerignore missing a required exclusion. Pure for --self-test. */
const REQUIRED_DOCKERIGNORE = ["backups", "notes", ".docker-volumes"];
function dockerignoreErrors(dockerignore: string): string[] {
  const lines = dockerignore.split("\n").map((line) => line.trim());
  return REQUIRED_DOCKERIGNORE.filter(
    (required) => !lines.includes(required) && !lines.includes(`${required}/`),
  ).map(
    (required) =>
      `.dockerignore must exclude ${required}/ so local dumps, notes and agent-stack secrets ` +
      "(.docker-volumes/<project>/prod-auth-secret) never enter the build context.",
  );
}

/**
 * Compose build contexts other than the repo root: `context:` under `build:`
 * and the short form `build: <path>`. Quotes and trailing comments are
 * ignored. Pure for --self-test.
 */
function nonRootComposeContexts(compose: string): string[] {
  return [...compose.matchAll(/^\s*(?:context|build):[ \t]*([^\s#][^#\n]*?)[ \t]*(?:#.*)?$/gm)]
    .map((match) => (match[1] ?? "").replace(/^(["'])(.*)\1$/, "$2"))
    .filter((context) => context !== "." && context !== "./");
}

/** Only the metadata used by build-commit.mjs may enter the build context. */
function commitMetadataErrors(dockerignore: string): string[] {
  const lines = dockerignore.split("\n").map((line) => line.trim());
  const allowed = ["!.git/HEAD", "!.git/packed-refs", "!.git/refs/heads", "!.git/refs/heads/**"];
  const errors: string[] = [];
  if (!lines.includes(".git")) errors.push(".dockerignore must exclude .git by default.");
  for (const entry of allowed)
    if (!lines.includes(entry))
      errors.push(`.dockerignore must allow ${entry} for image commit identity.`);
  for (const line of lines.filter((entry) => entry.startsWith("!.git")))
    if (!allowed.includes(line))
      errors.push(`.dockerignore exposes unexpected Git metadata: ${line}`);
  return errors;
}

/** Commit stamping must happen after the cached build and ship with its bundle. */
function buildIdentityErrors(text: string): string[] {
  const lines = [...logicalLines(text)].map(({ line }) => line);
  const build = lines.findIndex((line) => /^RUN pnpm turbo build\b/.test(line));
  const stamp = lines.indexOf(
    "RUN node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT",
  );
  const errors: string[] = [];
  if (build < 0 || stamp <= build)
    errors.push("Dockerfile must stamp BUILD_COMMIT after the Turbo build, outside its cache.");
  if (!lines.includes("COPY --from=builder /app/apps/server/dist ./apps/server/dist"))
    errors.push("Dockerfile must ship the stamped server dist directory.");
  let runner = false;
  for (const line of lines) {
    if (/^FROM\s/i.test(line)) runner = /\sAS\s+runner$/i.test(line);
    if (runner && /^COPY\s/i.test(line) && /\.git(?:\s|\/|$)/.test(line))
      errors.push("Dockerfile must not copy Git metadata into the runtime image.");
  }
  return errors;
}

if (process.argv.includes("--self-test")) {
  const metadata = ".git\n!.git/HEAD\n!.git/packed-refs\n!.git/refs/heads\n!.git/refs/heads/**\n";
  deepStrictEqual(commitMetadataErrors(metadata), []);
  deepStrictEqual(commitMetadataErrors(metadata.replace("!.git/HEAD\n", "")).length, 1);
  deepStrictEqual(commitMetadataErrors(`${metadata}!.git/config\n`).length, 1);
  const identity = `FROM base AS builder
RUN pnpm turbo build --filter=server --filter=web
RUN node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT
FROM base AS runner
COPY --from=builder /app/apps/server/dist ./apps/server/dist`;
  deepStrictEqual(buildIdentityErrors(identity), []);
  deepStrictEqual(
    buildIdentityErrors(
      identity.replace("RUN node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT", ""),
    ).length,
    1,
  );
  deepStrictEqual(
    buildIdentityErrors(`${identity}\nCOPY --from=builder /app/.git ./.git`).length,
    1,
  );
  deepStrictEqual(
    buildIdentityErrors(
      identity.replace("COPY --from=builder /app/apps/server/dist ./apps/server/dist", ""),
    ).length,
    1,
  );
  deepStrictEqual(
    disallowedNpmInstallLines(`RUN npm install -g pnpm@12.17.0
RUN npm i -g pnpm
RUN node /tmp/pnpm-bootstrap/install-pnpm.mjs /tmp/pnpm-bootstrap/package.json
RUN npm install -g pnpm@12.17.0 \\
  && npm install left-pad
RUN npm ci
RUN npx pnpm@12.17.0 install`),
    [
      "RUN npm install -g pnpm@12.17.0",
      "RUN npm i -g pnpm",
      "RUN npm install -g pnpm@12.17.0 \\",
      "  && npm install left-pad",
      "RUN npm ci",
      "RUN npx pnpm@12.17.0 install",
    ],
  );
  deepStrictEqual(
    pnpmBootstrapErrors(
      "Dockerfile",
      `${PNPM_BOOTSTRAP_COPY}
RUN ${PNPM_BOOTSTRAP_RUN} && rm -rf /tmp/pnpm-bootstrap`,
    ),
    [],
  );
  deepStrictEqual(
    pnpmBootstrapErrors(
      "Dockerfile.dev",
      `${PNPM_BOOTSTRAP_COPY}
RUN mkdir -p /app \\
  && ${PNPM_BOOTSTRAP_RUN} \\
  && rm -rf /tmp/pnpm-bootstrap`,
    ),
    [],
  );
  deepStrictEqual(pnpmBootstrapErrors("Dockerfile", "RUN corepack enable").length, 3);
  deepStrictEqual(dockerignoreErrors("backups\nnotes/\n.docker-volumes\n"), []);
  deepStrictEqual(dockerignoreErrors("backups\nnotes\n**/.docker-volumes\n").length, 1);
  deepStrictEqual(
    nonRootComposeContexts(`services:
  a:
    build:
      context: .
  b:
    build:
      context: ./apps/server
  c:
    build:
      context: ./ # repo root
  d:
    build: ./apps/worker
  e:
    build: "."
  f:
    build:
      context: "./apps/web"
`),
    ["./apps/server", "./apps/worker", "./apps/web"],
  );
  deepStrictEqual(
    [
      ...runtimeScriptCopies(`FROM base AS builder
COPY scripts/builder.mjs ./scripts/
FROM base AS runner
# COPY scripts/comment.mjs ./scripts/
RUN echo scripts/mentioned.mjs
COPY scripts/wrong.mjs /wrong/
COPY scripts/renamed.mjs ./scripts/other.mjs
COPY --chown=node:node scripts/db/migrate-runtime.mjs ./scripts/db/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/db/lib/sql.mjs scripts/backup/pre-migrate.sh ./scripts/db/lib/
COPY ["scripts/json.mjs", "./scripts/"]
`),
    ].sort(),
    [
      "scripts/db/lib/sql.mjs",
      "scripts/db/migrate-runtime.mjs",
      "scripts/docker-entrypoint.sh",
      "scripts/json.mjs",
    ],
  );
  deepStrictEqual(
    [
      ...runtimeScriptReferences(
        "scripts/db/migrate-runtime.mjs",
        `import { checkWrapper } from "./lib/sql.mjs";
const hook = path.join(ROOT, "scripts/backup/pre-migrate.sh");
node "$ROOT/scripts/db/other.mjs"
`,
      ),
    ].sort(),
    ["scripts/backup/pre-migrate.sh", "scripts/db/lib/sql.mjs", "scripts/db/other.mjs"],
  );
  deepStrictEqual(
    [
      ...runtimeScriptReferences(
        "scripts/backup/restore.sh",
        `exec node "$(cd "$(dirname "$0")" && pwd)/restore.mjs" "$@"
node "$HERE/lib.mjs" pg-env
exec bash /app/scripts/backup/restore.sh "$@"
`,
      ),
    ].sort(),
    ["scripts/backup/lib.mjs", "scripts/backup/restore.mjs", "scripts/backup/restore.sh"],
  );
  // HEALTHCHECK start-period vs schema-wait coupling. The fixture mirrors the
  // real Dockerfiles' continuation-folded directive shape.
  const healthcheckFixture = (startPeriod: number) => `FROM base AS runner
HEALTHCHECK --interval=10s --timeout=5s --start-period=${startPeriod}s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:3001').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
`;
  deepStrictEqual(schemaWaitDefaultSeconds("export const WAIT_TIMEOUT_MS = 300_000;"), 300);
  const SHIPPED = `export const WAIT_TIMEOUT_MS = 300_000;
export const PREDEPLOY_CATALOG_TIMEOUT_MS = 10_000;
export const CONTRACT_RUN_BUDGET_MS = 30_000;
export const IMAGE_SCHEMA_TIMEOUT_MS = 20_000;
export const CONTRACTS_CATALOG_TIMEOUT_MS = 5_000;
export const RUNTIME_STEP_TIMEOUT_MS = 2_000;
export const RUNTIME_STEPS = 5;
export const REGISTER_TIMEOUT_MS = 5_000;
export const CONTRACT_PREAMBLE_TIMEOUT_MS = 5_000;`;
  const shippedBudget = startupBudget(SHIPPED);
  deepStrictEqual(
    shippedBudget?.parts.map((part) => part.seconds),
    [300, 120, 10, 30, 5, 20, 5, 5, 10],
  );
  // A missing budget constant is a parse failure, not a zero — every step counts.
  for (const name of [...BUDGET_STEPS, "RUNTIME_STEPS", "RUNTIME_STEP_TIMEOUT_MS"])
    deepStrictEqual(
      startupBudget(SHIPPED.replace(new RegExp(`export const ${name} = [\\d_]+;`), "")),
      null,
      name,
    );
  const budget = shippedBudget ?? { parts: [] };
  const withPart = (label: string, seconds: number) => ({
    parts: budget.parts.map((part) => (part.label === label ? { ...part, seconds } : part)),
  });
  // Passing: the shipped values — 510s start-period vs 505.
  deepStrictEqual(healthcheckStartPeriodErrors("Dockerfile", healthcheckFixture(510), budget), []);
  // Violating: the old 480s start-period no longer covers every step.
  deepStrictEqual(
    healthcheckStartPeriodErrors("Dockerfile", healthcheckFixture(480), budget).length,
    1,
  );
  // Violating: a 510s sum against the 510s start-period (the check is strict).
  deepStrictEqual(
    healthcheckStartPeriodErrors(
      "Dockerfile",
      healthcheckFixture(510),
      withPart("CONTRACT_RUN_BUDGET_MS", 35),
    ),
    [
      "Dockerfile: HEALTHCHECK --start-period=510s is not greater than the migration startup gate: " +
        "WAIT_TIMEOUT_MS 300s + apply budget 120s + PREDEPLOY_CATALOG_TIMEOUT_MS 10s + " +
        "CONTRACT_RUN_BUDGET_MS 35s + CONTRACT_PREAMBLE_TIMEOUT_MS 5s + IMAGE_SCHEMA_TIMEOUT_MS 20s + " +
        "CONTRACTS_CATALOG_TIMEOUT_MS 5s + REGISTER_TIMEOUT_MS 5s + " +
        "RUNTIME_STEPS 5 × RUNTIME_STEP_TIMEOUT_MS 10s " +
        "(scripts/db/migrate-runtime.mjs, scripts/db/lib/contracts.mjs) = 510s. A follower " +
        "legitimately waiting for migrations would be marked unhealthy mid-wait. Raise " +
        "--start-period in Dockerfile and Dockerfile.worker, or lower the budgets in " +
        "scripts/db/migrate-runtime.mjs and scripts/db/lib/contracts.mjs.",
    ],
  );
  // Violating: wait default raised beyond what the shipped start-period covers
  // (parsed through schemaWaitDefaultSeconds to exercise the source regex).
  const raisedWait = schemaWaitDefaultSeconds("export const WAIT_TIMEOUT_MS = 400_000;");
  deepStrictEqual(raisedWait, 400);
  deepStrictEqual(
    healthcheckStartPeriodErrors(
      "Dockerfile.worker",
      healthcheckFixture(510),
      withPart("WAIT_TIMEOUT_MS", raisedWait ?? 0),
    ).length,
    1,
  );
  console.log("Docker runtime COPY regression checks passed.");
  process.exit(0);
}

const errors: string[] = [];

const members = discoverMembers();
const expectedBuilder = new Set([...members].filter((m) => !ALLOWLIST.has(m)).sort());

const builderLists = new Map<string, Set<string>>();

for (const dockerfile of DOCKERFILES) {
  const stages = parseStages(dockerfile);

  const builder = stages.get(BUILDER);
  if (!builder) {
    errors.push(
      `${dockerfile}: no \`${BUILDER}\` stage found (expected a \`FROM … AS ${BUILDER}\`).`,
    );
  } else {
    builderLists.set(dockerfile, builder);
    // Invariant 1: builder must list every on-disk member minus the allowlist.
    const missing = [...expectedBuilder].filter((m) => !builder.has(m));
    const extra = [...builder].filter((m) => !members.has(m) || ALLOWLIST.has(m));
    for (const m of missing) {
      errors.push(
        `${dockerfile} (${BUILDER}): missing COPY line for "${m}". Add:\n    COPY ${m}/package.json ${m}/`,
      );
    }
    for (const m of extra) {
      const why = ALLOWLIST.has(m)
        ? "it is an intentional exclusion (allowlisted)"
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${BUILDER}): unexpected COPY line for "${m}" — ${why}.`);
    }
  }

  const prodDeps = stages.get(PROD_DEPS);
  if (!prodDeps) {
    errors.push(
      `${dockerfile}: no \`${PROD_DEPS}\` stage found (expected a \`FROM … AS ${PROD_DEPS}\`).`,
    );
  } else if (builder) {
    // Invariant 2: prod-deps must be a non-empty subset of this file's builder
    // list. Subset-checking alone passes vacuously on an empty set, so wiping
    // every COPY line would read as "in sync" — assert it kept some.
    if (prodDeps.size === 0) {
      errors.push(
        `${dockerfile} (${PROD_DEPS}): no workspace COPY lines found. This stage must copy the ` +
          `package.json of every member the image needs at runtime; an empty list passes the ` +
          `subset check vacuously but fails \`docker build\`.`,
      );
    }
    const notInBuilder = [...prodDeps].filter((m) => !builder.has(m));
    for (const m of notInBuilder) {
      const why = members.has(m)
        ? `it is absent from the ${BUILDER} stage (the two lists drifted)`
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${PROD_DEPS}): COPY line for "${m}" — ${why}.`);
    }
  }
}

// Invariant 1 (corollary): both builder lists resolve to the same expected set,
// so they must be identical. Report any divergence explicitly for clarity.
if (builderLists.size === DOCKERFILES.length) {
  const [a, b] = DOCKERFILES as [string, string];
  const setA = builderLists.get(a)!;
  const setB = builderLists.get(b)!;
  const onlyA = [...setA].filter((m) => !setB.has(m));
  const onlyB = [...setB].filter((m) => !setA.has(m));
  for (const m of onlyA) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${a} but not ${b}.`);
  }
  for (const m of onlyB) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${b} but not ${a}.`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  packageManager?: string;
};
const pnpmPin = packageJson.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)/)?.[1];
// scripts/install-pnpm.mjs refuses anything without the SHA-512 suffix; fail
// here first so the error shows up in CI instead of inside `docker build`.
if (!/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/.test(packageJson.packageManager ?? "")) {
  errors.push(
    "package.json packageManager must be pnpm@<x.y.z>+sha512.<hex> — the images verify the pnpm " +
      "tarball against that digest (scripts/install-pnpm.mjs).",
  );
}
if (pnpmPin) {
  for (const dockerfile of [...DOCKERFILES, "Dockerfile.dev"]) {
    const path = resolve(ROOT, dockerfile);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const prepared = [...text.matchAll(/pnpm@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    for (const version of prepared) {
      if (version !== pnpmPin) {
        errors.push(
          `${dockerfile} pins pnpm@${version} but package.json packageManager is pnpm@${pnpmPin}.`,
        );
      }
    }
    if (dockerfile !== "Dockerfile.dev" && !/tini/.test(text)) {
      errors.push(`${dockerfile} does not install or use tini as PID 1.`);
    }
  }
}

const dockerignore = existsSync(resolve(ROOT, ".dockerignore"))
  ? readFileSync(resolve(ROOT, ".dockerignore"), "utf8")
  : "";
errors.push(...dockerignoreErrors(dockerignore));
errors.push(...commitMetadataErrors(dockerignore));
errors.push(...buildIdentityErrors(readFileSync(resolve(ROOT, "Dockerfile"), "utf8")));
// BuildKit prefers `<Dockerfile>.dockerignore` next to a Dockerfile over the
// root .dockerignore, which would silently drop the exclusions above. Every
// image builds from the repo root with the root file only.
for (const entry of readdirSync(ROOT)) {
  if (entry !== ".dockerignore" && entry.endsWith(".dockerignore")) {
    errors.push(
      `${entry} would override the root .dockerignore; keep exclusions in .dockerignore.`,
    );
  }
}
for (const compose of readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f))) {
  for (const context of nonRootComposeContexts(readFileSync(resolve(ROOT, compose), "utf8"))) {
    errors.push(
      `${compose} builds from context ${context}; use the repo root so .dockerignore applies.`,
    );
  }
}

// The runtime images hold DB credentials and run pg_dump/pg_restore; their
// dependencies must stay lockfile-governed. Only instruction lines are checked,
// so comments mentioning `npm install` don't trip it.
for (const dockerfile of [...DOCKERFILES, "Dockerfile.dev"]) {
  const path = resolve(ROOT, dockerfile);
  if (!existsSync(path)) continue;
  const instructions = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  for (const line of disallowedNpmInstallLines(instructions)) {
    errors.push(
      `${dockerfile} uses \`npm install\` (${line.trim()}), which floats outside the pnpm lockfile ` +
        "and the packageManager SHA-512. Install pnpm with scripts/install-pnpm.mjs instead.",
    );
  }
  errors.push(...pnpmBootstrapErrors(dockerfile, instructions));
  if (dockerfile === "Dockerfile.dev") continue;
  // The migration runner applies the committed SQL shipped with packages/db/prisma.
  if (
    !/^COPY --from=builder \/app\/packages\/db\/prisma \.\/packages\/db\/prisma$/m.test(
      instructions,
    )
  ) {
    errors.push(
      `${dockerfile}: the runner must \`COPY --from=builder /app/packages/db/prisma ./packages/db/prisma\` ` +
        "(schema + committed migrations for the committed migration runner).",
    );
  }
}

// --- Postgres client major: the two Dockerfiles must agree ---
//
// `pg_dump` can dump a server OLDER than itself but never a NEWER one, so if a
// Dockerfile's `ARG PG_MAJOR` falls behind the database server's major, every
// backup fails at 3am with a message nobody reads. The images pin the
// client from the PGDG apt repo. Drift between any of them is the bug, so
// require one identical major everywhere.
const PG_MAJOR_SOURCES = [...DOCKERFILES];
const pgMajors = new Map<string, string>();

for (const dockerfile of PG_MAJOR_SOURCES) {
  const path = resolve(ROOT, dockerfile);
  if (!existsSync(path)) continue;
  const major = readFileSync(path, "utf8").match(/^ARG\s+PG_MAJOR=(\d+)/m)?.[1];
  if (!major) {
    errors.push(
      `${dockerfile}: no \`ARG PG_MAJOR=<major>\` found. The postgresql-client major must be ` +
        `pinned (PGDG), not inherited from Debian's default repo.`,
    );
    continue;
  }
  pgMajors.set(dockerfile, major);
}

const pgMajor = [...new Set(pgMajors.values())][0];
if (new Set(pgMajors.values()).size > 1) {
  const listed = [...pgMajors].map(([source, major]) => `${source} → ${major}`).join(", ");
  errors.push(
    `Postgres major drift: ${listed}. The client shipped in the images must be the same major as ` +
      `(or newer than) the server, and this repo keeps them identical — set the same value in ` +
      `\`ARG PG_MAJOR\` in ${PG_MAJOR_SOURCES.join(", ")}.`,
  );
}

// --- HEALTHCHECK start-period vs the migration startup gate ---
//
// Both app images sit in the entrypoint's migration gate before the CMD
// process exists: followers wait (scripts/db/migrate-runtime.mjs wait) for up
// to WAIT_TIMEOUT_MS, and the migrating leader spends backup + DDL time on top
// (APPLY_BUDGET_SLACK). Docker only exempts failed probes
// during --start-period, so a start-period inside that window marks a
// legitimately-waiting follower unhealthy. The wait default is parsed from the
// script's own source — a hardcoded copy here would drift exactly the way this
// check exists to catch.
const runnerBudget = startupBudget(
  BUDGET_SOURCES.map((file) => readFileSync(resolve(ROOT, file), "utf8")).join("\n"),
);
if (runnerBudget === null) {
  errors.push(
    `${BUDGET_SOURCES.join(", ")}: cannot parse every startup budget constant ` +
      `(${[...BUDGET_STEPS, "RUNTIME_STEPS", "RUNTIME_STEP_TIMEOUT_MS"].join(", ")}) — update ` +
      "startupBudget() in scripts/check-docker-copy.ts to match the source shape.",
  );
} else {
  for (const dockerfile of DOCKERFILES) {
    errors.push(
      ...healthcheckStartPeriodErrors(
        dockerfile,
        readFileSync(resolve(ROOT, dockerfile), "utf8"),
        runnerBudget,
      ),
    );
  }
}

// --- Runtime scripts: every sibling a shipped script invokes must be COPY'd
// too. The entrypoint execs /app/scripts/db/migrate-runtime.mjs and
// /app/scripts/backup/restore.sh; those reach their libs and
// scripts/backup/pre-migrate.sh. An image that ships the caller without the
// callee fails at the moment of a deploy or restore, not at build time. Scan
// each image's entrypoint-reachable scripts for such references and require
// every one to appear in that image's runner-stage COPY lines.
const RUNTIME_SCRIPT_ROOTS: Record<string, string[]> = {
  Dockerfile: ["scripts/docker-entrypoint.sh"],
  "Dockerfile.worker": ["scripts/docker-entrypoint.sh"],
};
for (const [dockerfile, roots] of Object.entries(RUNTIME_SCRIPT_ROOTS)) {
  const dockerfilePath = resolve(ROOT, dockerfile);
  if (!existsSync(dockerfilePath)) continue;
  const referencedScripts = new Set<string>(roots);
  for (const rel of referencedScripts) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    for (const dependency of runtimeScriptReferences(rel, readFileSync(path, "utf8"))) {
      referencedScripts.add(dependency);
    }
  }
  const copiedScripts = runtimeScriptCopies(readFileSync(dockerfilePath, "utf8"));
  for (const script of [...referencedScripts].sort()) {
    if (!existsSync(resolve(ROOT, script))) {
      errors.push(`${script} is referenced from a runtime script but does not exist in the repo.`);
      continue;
    }
    if (!copiedScripts.has(script)) {
      errors.push(
        `${dockerfile} does not COPY ${script}, but a shipped runtime script invokes it — add it to the runner-stage COPY list.`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Dockerfile COPY-list drift detected:\n");
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    "\nEdit the COPY lists in the builder/prod-deps stages of both Dockerfiles to match the workspace,",
  );
  console.error(
    "or update the ALLOWLIST in scripts/check-docker-copy.ts if an exclusion is genuinely intentional.",
  );
  process.exit(1);
}

// Report only the allowlist entries that still exist on disk. Both are
// optional workspace members, so naming a directory
// the developer already deleted reads as "this check still expects a removed member
// back" — the opposite of the truth.
//
// Tested against the filesystem, not `members`, so the report stays accurate
// whether or not an allowlisted directory is a pnpm workspace member.
const excluded = [...ALLOWLIST].filter((member) => existsSync(resolve(ROOT, member))).sort();

console.log(
  `Dockerfile COPY lists are in sync with ${members.size} workspace members` +
    (excluded.length > 0
      ? ` (${excluded.length} intentionally excluded: ${excluded.join(", ")})`
      : "") +
    (pgMajor ? `; Postgres major ${pgMajor} across images.` : "."),
);
