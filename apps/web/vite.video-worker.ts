import { readFileSync } from "node:fs";
import path from "node:path";
import type { UserConfig } from "vite";

const mediabunnyVersion = (
  JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "node_modules/mediabunny/package.json"), "utf8"),
  ) as { version: string }
).version;

/**
 * Worker build options for the MP4 export, shared by the hosted build
 * (vite.config.ts) and the CLI's local lab (vite.local.config.ts). Module
 * workers, so the export worker can lazy-import Mediabunny as its own chunk
 * (classic/iife workers cannot code-split).
 */
export const videoWorkerOptions: NonNullable<UserConfig["worker"]> = {
  format: "es",
  rolldownOptions: {
    output: {
      // A stable name, so the hosted build's PWA precache ignore can match it.
      manualChunks(id) {
        if (id.includes("/node_modules/mediabunny/")) return "mediabunny";
      },
      // MPL-2.0 §3.2(a): tell recipients of the built file where its source is.
      banner: (chunk) =>
        chunk.name === "mediabunny"
          ? `/*! Mediabunny ${mediabunnyVersion} (unmodified), MPL-2.0 https://mozilla.org/MPL/2.0/ - source: https://github.com/Vanilagy/mediabunny/tree/v${mediabunnyVersion} */`
          : "",
    },
  },
};
