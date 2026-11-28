// Build the publishable Node artifact without changing the private workspace name.
// Run from the repo: pnpm --filter @cockpit-chess/cli package:npm
// The native Bun compiler remains scripts/compile.ts.
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "../..");
const output = join(root, "dist/npm");
const engineName = "stockfish-19-lite-single";
const sourceName = "stockfish-19.0.1-source.tar.gz";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stockfishManifest = z.object({
  version: z.literal("19.0.1"),
  files: z.object({
    "bin/stockfish-19-lite-single.js": hash,
    "bin/stockfish-19-lite-single.wasm": hash,
    "Copying.txt": hash,
  }),
  source: z.object({ file: z.literal(sourceName), sha256: hash }),
});

// These npm releases omit their monorepos' license or inherited-code notices.
// Supplement only these exact installed packages with notices from their npm
// gitHead, never a mutable latest-branch license or a generic MIT template.
const supplementalLicenses: Record<
  string,
  {
    directory: string;
    source: string;
    packageSha256: string;
    files: Record<string, string>;
    declaredLicense?: string;
    upstreamLicense?: string;
    note?: string;
  }
> = {
  "@cfworker/json-schema@4.1.4": {
    directory: "cfworker-json-schema-4.1.4",
    source: "https://github.com/cfworker/cfworker/tree/e45acacf25e083ac1b4b09bdd940d27c33bffcc5",
    packageSha256: "8a28ea54909d111c20593901f539535753220c9c35db4387ac6ecae0792c882f",
    files: {
      "LICENSE.md": "376944252ab78ca6b41aee44ddea8894927ee67891e77e61eb9d59af63e35094",
      "THIRD_PARTY_NOTICES.md": "4f4a73e1f6978efa0aece85e05471f64ddbefde9378ec14d6a75184af44676fb",
    },
  },
  "js-tiktoken@1.0.21": {
    directory: "js-tiktoken-1.0.21",
    source: "https://github.com/dqbd/tiktoken/tree/4c8b748e07992c00386f3180af5c574b27b65139",
    packageSha256: "5040ae37366971233fd53ef33360bc8d94159fa55c0c541f5663980b53b6b3b3",
    files: {
      LICENSE: "418cb499b436128d653d79941333a5437b7be2ea9213dcc2f04d15d5d2c51d86",
    },
  },
  "standardwebhooks@1.1.1": {
    directory: "standardwebhooks-1.1.1",
    source:
      "https://github.com/standard-webhooks/standard-webhooks/tree/b4d2c14fc5b4ccff3ff271e3b087dff812254c59",
    packageSha256: "686397f0f0202e0b693cfd3f6241d7a8da3df326f9642867a484fbbd295690b6",
    files: {
      LICENSE: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    },
    declaredLicense: "MIT",
    upstreamLicense: "Apache-2.0",
    note: "The npm package declares MIT and omits a license text; its exact gitHead has an Apache-2.0 root LICENSE and no JavaScript-directory license. Preserve the upstream text and package metadata without inventing a MIT grant or claiming this discrepancy is resolved.",
  },
};

interface BuildMetadata {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}
interface Bundler {
  build(options: {
    absWorkingDir: string;
    stdin: { contents: string; resolveDir: string; sourcefile: string; loader: "ts" };
    outfile: string;
    bundle: boolean;
    platform: "node";
    format: "esm";
    target: string;
    metafile: boolean;
    legalComments: "linked";
    banner: { js: string };
    define: Record<string, string>;
    plugins: {
      name: string;
      setup(build: {
        onResolve(
          options: { filter: RegExp },
          callback: (args: { path: string }) => { path: string; namespace: string },
        ): void;
        onLoad(
          options: { filter: RegExp; namespace: string },
          callback: () => { contents: string; loader: "js" },
        ): void;
      }): void;
    }[];
  }): Promise<{ metafile: BuildMetadata }>;
}

async function regularFiles(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      result.push(...(await regularFiles(join(directory, entry.name), name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Artifact input must be a regular file: ${name}`);
  }
  return result.sort();
}

async function copyTree(source: string, destination: string) {
  for (const file of await regularFiles(source)) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await copyFile(join(source, file), join(destination, file));
  }
}

async function checkedCopy(source: string, destination: string, expected: string) {
  const bytes = await readFile(source);
  if (sha256(bytes) !== expected)
    throw new Error(`Artifact checksum mismatch: ${basename(source)}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function copyMarkdown(source: string, destination: string) {
  const packagedDocs = new Map([
    [join(repository, "LICENSE"), "LICENSE"],
    [join(root, "stockfish/manifest.json"), "stockfish/manifest.json"],
    [join(repository, "docs/stockfish-distribution.md"), "STOCKFISH-SOURCE.md"],
    [join(root, "README.md"), "README.md"],
    [join(repository, "THIRD-PARTY-LICENSES.md"), "THIRD-PARTY-LICENSES.md"],
  ]);
  const text = (await readFile(source, "utf8")).replace(
    /\]\(((?:\.{1,2}\/)[^)\s]+)\)/g,
    (_match, href: string) => {
      const anchor = href.indexOf("#");
      const file = anchor === -1 ? href : href.slice(0, anchor);
      const fragment = anchor === -1 ? "" : href.slice(anchor);
      const absolute = resolve(dirname(source), file);
      const packaged = packagedDocs.get(absolute);
      if (packaged) return `](./${packaged}${fragment})`;
      const repoPath = relative(repository, absolute).split(sep).map(encodeURIComponent).join("/");
      if (repoPath.startsWith("../"))
        throw new Error("Package document link escapes the repository");
      return `](https://github.com/FlyCockpit/chess/blob/main/${repoPath}${fragment})`;
    },
  );
  await writeFile(destination, text);
}

async function dependencyLicenses(metadata: BuildMetadata) {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const input of Object.keys(metadata.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(repository, input));
    while (directory !== dirname(directory)) {
      const packageFile = join(directory, "package.json");
      try {
        const packageInfo = z
          .object({ name: z.string(), version: z.string() })
          .safeParse(JSON.parse(await readFile(packageFile, "utf8")));
        // Some packages put module-type-only manifests in subdirectories.
        if (!packageInfo.success) {
          directory = dirname(directory);
          continue;
        }
        const pkg = packageInfo.data;
        if (seen.has(directory)) break;
        seen.add(directory);
        const licenseFiles = (await readdir(directory)).filter((file) =>
          /^(?:(?:licen[cs]e|copying|notice)(?:[.-].*)?|third[-_]party[-_](?:notices|licen[cs]es)(?:[.-].*)?)$/i.test(
            file,
          ),
        );
        const target = join(output, "licenses", `${pkg.name.replaceAll("/", "__")}@${pkg.version}`);
        await mkdir(target, { recursive: true });
        const supplemental = supplementalLicenses[`${pkg.name}@${pkg.version}`];
        if (licenseFiles.length === 0 && !supplemental) {
          missing.push(`${pkg.name}@${pkg.version}`);
          break;
        }
        for (const file of licenseFiles) {
          if ((await stat(join(directory, file))).isFile())
            await copyFile(join(directory, file), join(target, file));
        }
        if (supplemental) {
          if (sha256(await readFile(packageFile)) !== supplemental.packageSha256)
            throw new Error(`Supplemental license package checksum mismatch: ${pkg.name}`);
          for (const [file, expected] of Object.entries(supplemental.files))
            await checkedCopy(
              join(root, "licenses", supplemental.directory, file),
              join(target, file),
              expected,
            );
          await copyFile(packageFile, join(target, "PACKAGE.json"));
          await writeFile(
            join(target, "SOURCE.json"),
            `${JSON.stringify({ name: pkg.name, version: pkg.version, ...supplemental }, null, 2)}\n`,
          );
        }
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      directory = dirname(directory);
    }
  }
  if (missing.length > 0)
    throw new Error(`Bundled dependencies have no license files: ${missing.sort().join(", ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--skip-web-build")) throw new Error("Unknown npm package option");
  const require = createRequire(import.meta.url);
  const webRoot = join(repository, "apps/web");
  const webRequire = createRequire(join(webRoot, "package.json"));
  // The default always refreshes the lab. The opt-out is for an immediately
  // preceding build in the same exact-tree CI job; missing assets still fail.
  if (!args.includes("--skip-web-build")) {
    const vite: {
      build(options: {
        root: string;
        configFile: string;
        build: { license: { fileName: string } };
      }): Promise<unknown>;
    } = await import(pathToFileURL(webRequire.resolve("vite")).href);
    await vite.build({
      root: webRoot,
      configFile: join(webRoot, "vite.local.config.ts"),
      build: { license: { fileName: "LICENSES.md" } },
    });
  }
  const assetsRoot = join(repository, "apps/web/dist-local");
  const assets = await regularFiles(assetsRoot);
  if (!assets.includes("local.html")) throw new Error("Missing local web entry point");
  if (!assets.includes("LICENSES.md")) throw new Error("Missing local web dependency licenses");
  const manifest = stockfishManifest.parse(
    JSON.parse(await readFile(join(root, "stockfish/manifest.json"), "utf8")),
  );
  const packageInfo = z
    .object({ version: z.string(), license: z.literal("AGPL-3.0-only") })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  // tsx already pins esbuild in the frozen workspace lock. Reuse that tool;
  // consumers of the resulting tarball need neither tsx nor a bundler.
  const tsxRequire = createRequire(require.resolve("tsx/package.json"));
  const esbuild: Bundler = await import(pathToFileURL(tsxRequire.resolve("esbuild")).href);
  const chessRequire = createRequire(require.resolve("@cockpit-chess/chess/engine"));
  const engineRoot = dirname(chessRequire.resolve("stockfish/package.json"));
  const installedEngine = z
    .object({ version: z.literal("19.0.1") })
    .parse(JSON.parse(await readFile(join(engineRoot, "package.json"), "utf8")));
  if (installedEngine.version !== manifest.version) throw new Error("Unexpected engine version");

  // Output is fixed beneath the regenerable dist directory, never a caller path.
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, "dist"), { recursive: true });
  await copyTree(assetsRoot, join(output, "web"));
  for (const [file, expected] of Object.entries(manifest.files))
    await checkedCopy(join(engineRoot, file), join(output, "stockfish", file), expected);
  await writeFile(join(output, "stockfish/package.json"), '{"type":"commonjs"}\n');
  await copyFile(join(root, "stockfish/manifest.json"), join(output, "stockfish/manifest.json"));
  await copyFile(
    join(repository, "apps/web/public/third-party/stockfish/AUTHORS"),
    join(output, "stockfish/AUTHORS"),
  );
  await copyFile(
    join(repository, "apps/web/public/third-party/stockfish/SHA256SUMS"),
    join(output, "stockfish/SHA256SUMS"),
  );
  await checkedCopy(
    join(repository, "apps/web/public/third-party/stockfish", sourceName),
    join(output, "stockfish/source", sourceName),
    manifest.source.sha256,
  );
  await copyMarkdown(
    join(repository, "docs/stockfish-distribution.md"),
    join(output, "STOCKFISH-SOURCE.md"),
  );
  await copyFile(join(repository, "LICENSE"), join(output, "LICENSE"));
  await copyMarkdown(
    join(repository, "THIRD-PARTY-LICENSES.md"),
    join(output, "THIRD-PARTY-LICENSES.md"),
  );
  await copyMarkdown(join(root, "README.md"), join(output, "README.md"));

  const defaultServer = process.env.COCKPIT_CHESS_DEFAULT_SERVER?.trim();
  const define: Record<string, string> = {};
  if (defaultServer) {
    const url = new URL(defaultServer);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("The compiled default server must be an HTTPS origin without credentials");
    define.__COCKPIT_CHESS_DEFAULT_SERVER__ = JSON.stringify(url.origin);
  }
  const source = [
    'import { readFile } from "node:fs/promises";',
    'import { fileURLToPath } from "node:url";',
    `import { configureEnginePool } from "@cockpit-chess/chess/engine";`,
    `import { registerEmbeddedLocalAssets } from "./src/local-assets.ts";`,
    `configureEnginePool({engineFile: fileURLToPath(new URL("../stockfish/bin/${engineName}.js", import.meta.url))});`,
    "registerEmbeddedLocalAssets(new Map([",
    ...assets.map(
      (file) =>
        `[${JSON.stringify(file)}, () => readFile(new URL(${JSON.stringify(`../web/${file.split("/").map(encodeURIComponent).join("/")}`)}, import.meta.url))],`,
    ),
    "]));",
    'await import("./src/main.ts");',
    "",
  ].join("\n");
  const result = await esbuild.build({
    absWorkingDir: repository,
    stdin: { contents: source, resolveDir: root, sourcefile: "npm-entry.ts", loader: "ts" },
    outfile: join(output, "dist/main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24.13",
    metafile: true,
    legalComments: "linked",
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __nodeCreateRequire } from "node:module";\nconst require = __nodeCreateRequire(import.meta.url);',
    },
    define,
    plugins: [
      {
        // ws has optional native accelerators. The pure-JS implementation is
        // portable; throwing here preserves ws's existing try/catch fallback.
        name: "portable-ws",
        setup(build) {
          build.onResolve({ filter: /^(?:bufferutil|utf-8-validate)$/ }, ({ path }) => ({
            path,
            namespace: "portable-ws",
          }));
          build.onLoad({ filter: /.*/, namespace: "portable-ws" }, () => ({
            contents: 'throw new Error("Optional native WebSocket accelerator is not included");',
            loader: "js",
          }));
        },
      },
    ],
  });
  for (const file of Object.values(result.metafile.outputs)) {
    for (const imported of file.imports) {
      if (imported.external && !isBuiltin(imported.path))
        throw new Error(`Unbundled runtime dependency: ${imported.path}`);
    }
  }
  await dependencyLicenses(result.metafile);
  // CSS/font assets are emitted separately from Vite's JavaScript module graph.
  // Retain the font's complete OFL in addition to Vite's bundled-code notices.
  await dependencyLicenses({
    inputs: { [webRequire.resolve("@fontsource-variable/roboto/LICENSE")]: {} },
    outputs: {},
  });
  await chmod(join(output, "dist/main.js"), 0o755);
  await writeFile(
    join(output, "package.json"),
    `${JSON.stringify(
      {
        name: "@flycockpit/chess",
        version: packageInfo.version,
        description: "Run Cockpit Chess locally and control your runner from the website",
        license: packageInfo.license,
        type: "module",
        bin: { "cockpit-chess": "./dist/main.js" },
        // Node 22 on Windows reports dev=0 through lstat but a real device ID
        // through FileHandle.stat, so strict journal lock identity fails closed.
        // Keep that identity fence and require the tested, consistent runtime.
        engines: { node: ">=24.13.1" },
        files: [
          "dist/",
          "web/",
          "stockfish/",
          "licenses/",
          "LICENSE",
          "README.md",
          "THIRD-PARTY-LICENSES.md",
          "STOCKFISH-SOURCE.md",
        ],
        repository: {
          type: "git",
          url: "git+https://github.com/FlyCockpit/chess.git",
          directory: "apps/cli",
        },
        homepage: "https://chess.flycockpit.app",
        bugs: { url: "https://github.com/FlyCockpit/chess/issues" },
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, "dist/npm-metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  console.log(`Staged @flycockpit/chess at ${relative(repository, output)}`);
  console.log("Inspect with npm pack --dry-run; publication is an owner action.");
}

await main();
