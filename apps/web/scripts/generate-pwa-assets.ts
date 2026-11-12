import { execFileSync } from "node:child_process";
import { access, mkdir, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedIcons = [
  "favicon.ico",
  "pwa-64x64.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "maskable-icon-512x512.png",
];

/** Generate from assets/logo.png, then publish exactly the five configured outputs. */
export async function generatePwaAssets(
  root = webRoot,
  runGenerator = () => {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve("@vite-pwa/assets-generator/package.json"));
    execFileSync(process.execPath, [join(packageRoot, "bin/pwa-assets-generator.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
  },
) {
  await runGenerator();
  // Validate the complete set before moving anything. Never move the source logo or Apple tile.
  await Promise.all(generatedIcons.map((name) => access(join(root, "assets", name))));
  await mkdir(join(root, "public"), { recursive: true });
  for (const name of generatedIcons)
    await rename(join(root, "assets", name), join(root, "public", name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generatePwaAssets();
}
