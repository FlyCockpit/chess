import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changedFiles,
  IGNORED_INPUTS,
  ruleFor,
  SUITE_SCRIPTS,
  SUITES,
  type Suite,
  selectSuites,
} from "./test-scripts-affected.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const selected = (changed: readonly string[] | undefined) =>
  [...selectSuites(changed).keys()].sort();

function tracked(): string[] {
  // Untracked (non-ignored) files too: a new file is checked before its commit.
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\0").filter(Boolean);
}

/** The test files a suite's package.json script runs (its globs expanded against git). */
function suiteFiles(suite: Suite, files: readonly string[]): string[] {
  const command = scripts[SUITE_SCRIPTS[suite]] ?? "";
  const args = [...command.matchAll(/'([^']+)'|(\S+\.test\.mjs)/g)].map((m) => m[1] ?? m[2] ?? "");
  const patterns = args.map(
    (arg) => new RegExp(`^${arg.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`),
  );
  return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

describe("the mapping", () => {
  test("verify:fast selects the three suites; verify and CI run all of them", () => {
    assert.equal(scripts["test:scripts:affected"], "node scripts/test-scripts-affected.ts");
    assert.match(scripts["verify:fast"] ?? "", / && pnpm test:scripts:affected && /);
    for (const suite of SUITES) {
      const step = `pnpm ${SUITE_SCRIPTS[suite]}`;
      assert.ok(!(scripts["verify:fast"] ?? "").includes(step), `verify:fast still runs ${step}`);
      assert.ok((scripts.verify ?? "").includes(`&& ${step} &&`), `verify must run ${step}`);
    }
    const ci = readFileSync(join(ROOT, ".github/workflows/pr-checks.yml"), "utf8");
    for (const suite of SUITES) assert.ok(ci.includes(`pnpm ${SUITE_SCRIPTS[suite]}`), suite);
  });

  test("release runs each suite once; nightly verify:tooling still runs all three", () => {
    const steps = (name: string) => (scripts[name] ?? "").split(" && ");
    const selfTests = steps("verify:tooling:self-tests");
    assert.deepEqual(steps("verify:tooling"), [
      "pnpm verify:tooling:self-tests",
      ...SUITES.map((suite) => `pnpm ${SUITE_SCRIPTS[suite]}`),
    ]);
    const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
    assert.match(release, /^\s*- run: pnpm verify && pnpm verify:tooling:self-tests$/m);
    const nightly = readFileSync(join(ROOT, ".github/workflows/nightly-tooling.yml"), "utf8");
    assert.match(nightly, /^\s*run: pnpm verify:tooling$/m);
    for (const suite of SUITES) {
      const step = `pnpm ${SUITE_SCRIPTS[suite]}`;
      assert.ok(!selfTests.includes(step), `verify:tooling:self-tests runs ${step} again`);
      assert.equal(steps("verify").filter((s) => s === step).length, 1, `verify runs ${step}`);
    }
  });

  test("every tracked or untracked file is classified by a rule", () => {
    const unclassified = tracked().filter((path) => ruleFor(path) === undefined);
    assert.deepEqual(
      unclassified,
      [],
      "classify these in scripts/test-scripts-affected.ts RULES (which suites read them?)",
    );
  });

  test("every ignored input a suite reads is classified, and selects a suite", () => {
    for (const path of IGNORED_INPUTS) {
      const rule = ruleFor(path);
      assert.ok(rule !== undefined && rule.suites !== "all" && rule.suites.length > 0, path);
    }
  });

  test("every test file of a suite selects that suite", () => {
    const files = tracked();
    for (const suite of SUITES) {
      const own = suiteFiles(suite, files);
      assert.ok(own.length > 0, `${suite}: no test files found in ${SUITE_SCRIPTS[suite]}`);
      for (const path of own) assert.ok(selectSuites([path]).has(suite), `${path} → ${suite}`);
    }
  });

  test("every test file a suite's paths select is run by one of the suite commands", () => {
    // Otherwise a new test file under scripts/backup/ would select backup and
    // still never run (not in backup:test-unit), here or in verify and CI.
    const files = tracked();
    const run = new Set(SUITES.flatMap((suite) => suiteFiles(suite, files)));
    const orphans = files.filter((path) => {
      if (!/\.test\.(?:mjs|ts)$/.test(path)) return false;
      const rule = ruleFor(path);
      return (
        rule !== undefined && rule.suites !== "all" && rule.suites.length > 0 && !run.has(path)
      );
    });
    assert.deepEqual(orphans, [], "add these to their suite's package.json script");
  });

  test("the inputs the suites were traced reading select them", () => {
    for (const [path, suites] of [
      ["scripts/db/migrate.mjs", ["db"]],
      ["scripts/db/dev-postgres-init/10-mark-local.sh", ["db"]],
      ["packages/db/prisma/migrations/0_init/migration.sql", ["db"]],
      ["packages/db/prisma/schema/chess.prisma", ["db"]],
      ["docker-compose.dev.yml", ["db"]],
      ["packages/db/package.json", ["db"]],
      ["packages/db/prisma.config.ts", ["db"]],
      // Ignored, and loaded by packages/db/prisma.config.ts.
      [".env", ["db"]],
      // migrate-runtime.test.mjs runs the real backup hook.
      ["scripts/backup/pre-migrate.sh", ["backup", "db"]],
      // bounded-child is run by db:test-unit; scripts/lib/ is a shared input.
      ["scripts/lib/bounded-child.mjs", ["backup", "db", "deploy"]],
      ["scripts/db/lib/contracts.mjs", ["backup", "db"]],
      ["scripts/db/lib/sql.mjs", ["backup", "db"]],
      ["scripts/backup/host.sh", ["backup"]],
      ["scripts/backup/restore.mjs", ["backup"]],
      // Off Linux, host/pre-migrate tests run in its first FROM image.
      ["Dockerfile", ["backup"]],
      ["scripts/build-commit.mjs", ["deploy"]],
      ["scripts/deploy-check.test.mjs", ["deploy"]],
    ] as const) {
      assert.deepEqual(selected([path]), [...suites].sort(), path);
    }
  });
});

describe("selection", () => {
  test("fails open: shared inputs, unclassified paths and an unknown base run everything", () => {
    const all = [...SUITES].sort();
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".nvmrc",
      "scripts/lib/env-manifest.ts",
      "scripts/test-scripts-affected.ts",
      "scripts/new-tool.mjs",
      "scripts/backup.mjs",
      "new-root-file.json",
    ]) {
      assert.deepEqual(selected(["apps/web/src/a.tsx", path]), all, path);
    }
    assert.deepEqual(selected(undefined), all);
    assert.match(selectSuites(["scripts/new-tool.mjs"]).get("db") ?? "", /no rule .* names it/);
  });

  test("app code, docs and other tooling skip all three", () => {
    for (const path of [
      "apps/web/src/routes/index.tsx",
      "apps/server/src/index.ts",
      "packages/api/src/routers/chess.ts",
      "packages/db/src/index.ts",
      "packages/locales/src/en-US/common.json",
      "docs/deployment.md",
      ".github/workflows/pr-checks.yml",
      "scripts/claude-hooks/pre-tool-use.mjs",
      "scripts/check-doc-citations.ts",
      "Dockerfile.worker",
      "scripts/docker-entrypoint.sh",
    ]) {
      assert.deepEqual(selected([path]), [], path);
    }
    assert.deepEqual(selected([]), []);
  });

  test("each suite is selected by its own paths only, with the first reason", () => {
    const picks = selectSuites([
      "apps/web/a.ts",
      "scripts/backup/host.sh",
      "scripts/backup/restore.mjs",
    ]);
    assert.deepEqual([...picks], [["backup", "scripts/backup/host.sh changed"]]);
  });
});

describe("changedFiles", () => {
  test("commits, edits, untracked files, and both sides of a rename since the merge base", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "scripts-affected-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A git hook (or any caller) may export GIT_DIR, GIT_INDEX_FILE and the
    // like; inherited, they would point this scratch repo's writes at the
    // caller's repository. Drop every GIT_* variable.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const git = (...args: string[]) => {
      // No hooks either: a global core.hooksPath must not judge this repo. And
      // quotePath pinned on: a global core.quotePath=false would hide the
      // quoting the non-ASCII case below guards against.
      const config = [
        ...["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"],
        ...["-c", "core.quotePath=true"],
      ];
      const result = spawnSync("git", [...config, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...env,
          GIT_CEILING_DIRECTORIES: tmpdir(),
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
      return result.status === 0 ? result.stdout : undefined;
    };
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "scripts/backup"), { recursive: true });
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    writeFileSync(join(dir, "scripts/backup/restore.mjs"), "restore body that stays the same\n");
    writeFileSync(join(dir, "apps/web/a.ts"), "1");
    writeFileSync(join(dir, "README.md"), "1");
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "apps/web/a.ts"), "2");
    git("mv", "scripts/backup/restore.mjs", "apps/web/restore.mjs");
    // A committed non-ASCII name exercises the diff side; the untracked one below, ls-files.
    writeFileSync(join(dir, "apps/web/naïve.ts"), "1");
    git("add", "apps/web/naïve.ts");
    git("commit", "-q", "-am", "edit");
    writeFileSync(join(dir, "README.md"), "2");
    writeFileSync(join(dir, "new.ts"), "1");
    // Non-ASCII names come back verbatim, not quoted by core.quotePath.
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/café.md"), "1");
    const run = (args: readonly string[]) => git(...args);
    assert.deepEqual(changedFiles(run, dir)?.sort(), [
      "README.md",
      "apps/web/a.ts",
      "apps/web/naïve.ts",
      "apps/web/restore.mjs",
      "docs/café.md",
      "new.ts",
      "scripts/backup/restore.mjs",
    ]);
    // An ignored input cannot be compared with the base: present means changed.
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgresql://localhost/x\n");
    assert.deepEqual(changedFiles(run, dir)?.sort(), [
      ".env",
      "README.md",
      "apps/web/a.ts",
      "apps/web/naïve.ts",
      "apps/web/restore.mjs",
      "docs/café.md",
      "new.ts",
      "scripts/backup/restore.mjs",
    ]);
    // No base branch at all: unknown, so everything runs.
    git("branch", "-q", "-m", "main", "trunk");
    assert.equal(changedFiles(run, dir), undefined);
  });
});
