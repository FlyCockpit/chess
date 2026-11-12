// Build standalone cockpit-chess binaries with `bun build --compile` (Bun embeds its
// runtime, so users need neither Node nor Bun). Bun is a CI-only tool here —
// run this from CI (cli-ci.yml, release.yml) or with a local Bun install:
//
//   bun scripts/compile.ts                 # every target
//   bun scripts/compile.ts linux-x64       # just one
//   COCKPIT_CHESS_DEFAULT_SERVER=https://app.example.com bun scripts/compile.ts
//                                          # bake in the default (prod) server
//
// Outputs dist/<asset name> using the names in @cockpit-chess/config/cli, which the
// app's download endpoint and the install scripts also use. Cross-compiling
// works from any host, but darwin builds must be ad-hoc signed on macOS
// (`codesign --sign -`) before an Apple Silicon Mac will run them — CI does it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_PLATFORMS, type CliPlatform } from "@cockpit-chess/config/cli";

// x64 uses Bun's "baseline" build (no AVX2 requirement) so older CPUs and some
// virtual machines can run it.
const BUN_TARGETS: Record<CliPlatform, string> = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64-baseline",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in CLI_PLATFORMS));
if (unknown.length > 0) {
  console.error(
    `Unknown target(s): ${unknown.join(", ")}. Known: ${Object.keys(CLI_PLATFORMS).join(", ")}`,
  );
  process.exit(2);
}
const platforms = (requested.length > 0 ? requested : Object.keys(CLI_PLATFORMS)) as CliPlatform[];

// The built-in default server (normally production; see src/default-server.ts),
// read from the build environment and inlined into the binary.
const defaultServer = process.env.COCKPIT_CHESS_DEFAULT_SERVER?.trim() ?? "";
if (defaultServer) {
  let url: URL | undefined;
  try {
    url = new URL(defaultServer);
  } catch {}
  if (url?.protocol !== "https:") {
    console.error(`COCKPIT_CHESS_DEFAULT_SERVER must be an https:// URL, got "${defaultServer}".`);
    process.exit(2);
  }
  console.log(`Default server: ${url.origin}`);
}
const defines = defaultServer
  ? [`--define=__COCKPIT_CHESS_DEFAULT_SERVER__=${JSON.stringify(new URL(defaultServer).origin)}`]
  : [];

// Always build first so a release cannot silently embed stale or missing assets.
const webBuild = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "web", "build:local"],
  { cwd: join(root, "../.."), stdio: "inherit" },
);
if (webBuild.status !== 0) process.exit(webBuild.status ?? 1);
const assetsRoot = join(root, "../web/dist-local");
function assetFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return assetFiles(join(directory, entry.name), relative);
    if (!entry.isFile()) throw new Error(`Expected a regular web asset: ${relative}`);
    return [relative];
  });
}
const files = assetFiles(assetsRoot).sort();
if (!files.includes("local.html"))
  throw new Error("Local web build did not produce dist-local/local.html");

// Explicit file imports work for every extension (including HTML, JS and CSS),
// preserve the original URL mapping, and avoid treating web JS as CLI code.
const staging = mkdtempSync(join(tmpdir(), "cockpit-chess-compile-"));
let exitCode = 0;
try {
  const entry = join(staging, "main.ts");
  writeFileSync(
    entry,
    [
      'import { readFile } from "node:fs/promises";',
      `import { registerEmbeddedLocalAssets } from ${JSON.stringify(join(root, "src/local-assets.ts"))};`,
      ...files.map(
        (file, index) =>
          `import asset${index} from ${JSON.stringify(join(assetsRoot, file))} with { type: "file" };`,
      ),
      "registerEmbeddedLocalAssets(new Map([",
      ...files.map((file, index) => `  [${JSON.stringify(file)}, () => readFile(asset${index})],`),
      "]));",
      `await import(${JSON.stringify(join(root, "src/main.ts"))});`,
      "",
    ].join("\n"),
  );
  console.log(`Embedding ${files.length} local web assets`);
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const platform of platforms) {
    const outfile = join(root, "dist", CLI_PLATFORMS[platform]);
    console.log(`Compiling ${platform} -> ${outfile}`);
    const result = spawnSync(
      "bun",
      [
        "build",
        entry,
        "--compile",
        "--minify",
        `--target=${BUN_TARGETS[platform]}`,
        ...defines,
        `--outfile=${outfile}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
process.exitCode = exitCode;
