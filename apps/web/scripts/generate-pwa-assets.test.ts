import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { generatePwaAssets } from "./generate-pwa-assets";

const icons = [
  "favicon.ico",
  "pwa-64x64.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "maskable-icon-512x512.png",
];
test("publishes generated icons and preserves the source and manually maintained Apple tile", async () => {
  const root = await mkdtemp(join(tmpdir(), "chess-pwa-"));
  try {
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "public"));
    await writeFile(join(root, "assets/logo.png"), "source");
    await writeFile(join(root, "public/apple-touch-icon-180x180.png"), "manual");
    await generatePwaAssets(root, async () => {
      for (const name of icons) await writeFile(join(root, "assets", name), `generated:${name}`);
    });
    for (const name of icons)
      assert.equal(await readFile(join(root, "public", name), "utf8"), `generated:${name}`);
    assert.equal(await readFile(join(root, "assets/logo.png"), "utf8"), "source");
    assert.equal(
      await readFile(join(root, "public/apple-touch-icon-180x180.png"), "utf8"),
      "manual",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("does not move a partial generated set", async () => {
  const root = await mkdtemp(join(tmpdir(), "chess-pwa-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets/favicon.ico"), "partial");
    await assert.rejects(generatePwaAssets(root, () => {}));
    assert.equal(await readFile(join(root, "assets/favicon.ico"), "utf8"), "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
