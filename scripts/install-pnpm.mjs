#!/usr/bin/env node
// Install the pnpm pinned by package.json `packageManager` into a Docker image.
//
// Node 25+ no longer bundles corepack, and `npm install -g` would resolve outside
// the repo's supply-chain gates. This reads `pnpm@<version>+sha512.<hex>` from
// package.json, downloads exactly that registry tarball, refuses it unless its
// SHA-512 matches the pinned digest, and unpacks it under <prefix>/lib/pnpm with
// `pnpm`/`pnpx` launchers in <bin-dir>. pnpm 12 ships a Node wrapper
// (`bin/pnpm.mjs`) around a native binary: the first `pnpm --version` below has
// the wrapper download that binary next to itself, verified against the npm
// registry signature, so it happens at image build time. The tree is then made
// readable to every UID so non-root runtime users can run it.
//
// Usage: node install-pnpm.mjs <package.json> [bin-dir=/usr/local/bin] [prefix=/usr/local]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [manifestPath, binDir = "/usr/local/bin", prefix = "/usr/local"] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: install-pnpm.mjs <package.json> [bin-dir] [prefix]");
  process.exit(2);
}

const { packageManager } = JSON.parse(readFileSync(manifestPath, "utf8"));
const match = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(packageManager ?? "");
if (!match) {
  console.error(
    `install-pnpm: packageManager must be pnpm@<x.y.z>+sha512.<hex>, got ${packageManager}`,
  );
  process.exit(1);
}
const [, version, expected] = match;

const url = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) {
  console.error(`install-pnpm: ${url} returned HTTP ${response.status}`);
  process.exit(1);
}
const tarball = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha512").update(tarball).digest("hex");
if (actual !== expected) {
  console.error(`install-pnpm: SHA-512 mismatch for pnpm ${version}; refusing to install`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "pnpm-"));
try {
  const archive = join(work, "pnpm.tgz");
  writeFileSync(archive, tarball);
  const target = join(prefix, "lib", "pnpm");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", target, "--strip-components=1"], {
    stdio: "inherit",
  });
  mkdirSync(binDir, { recursive: true });
  for (const name of ["pnpm", "pnpx"]) {
    const link = join(binDir, name);
    rmSync(link, { force: true });
    chmodSync(join(target, "bin", `${name}.mjs`), 0o755);
    symlinkSync(join(target, "bin", `${name}.mjs`), link);
  }
  const reported = execFileSync(join(binDir, "pnpm"), ["--version"], { encoding: "utf8" }).trim();
  if (reported !== version) {
    console.error(`install-pnpm: installed pnpm reports ${reported}, expected ${version}`);
    process.exit(1);
  }
  execFileSync("chmod", ["-R", "a+rX", target], { stdio: "inherit" });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`install-pnpm: pnpm ${version} installed (sha512 verified)`);
