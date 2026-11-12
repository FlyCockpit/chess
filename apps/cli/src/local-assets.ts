import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface LocalAssetSource {
  read(relativePath: string): Promise<Uint8Array | undefined>;
}

export function isLocalAssetPath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !relativePath.includes("\\") &&
    !relativePath.includes("\0") &&
    !relativePath.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}

// The generated compile entry registers loaders before importing main.ts.
// File-loader imports retain Bun's virtual paths; Node fs can read them in
// the executable, without depending on Bun globals in source development.
let embeddedAssets: LocalAssetSource | undefined;
export function registerEmbeddedLocalAssets(files: ReadonlyMap<string, () => Promise<Uint8Array>>) {
  embeddedAssets = {
    read: async (relativePath) =>
      isLocalAssetPath(relativePath) ? files.get(relativePath)?.() : undefined,
  };
}

export function getEmbeddedLocalAssets(): LocalAssetSource | undefined {
  return embeddedAssets;
}

export async function directoryAssetSource(directory: string): Promise<LocalAssetSource> {
  const root = await realpath(path.resolve(directory));
  return {
    read: async (relativePath) => {
      if (!isLocalAssetPath(relativePath)) return undefined;
      try {
        const file = await realpath(path.resolve(root, relativePath));
        if (!file.startsWith(`${root}${path.sep}`)) return undefined;
        return await readFile(file);
      } catch {
        return undefined;
      }
    },
  };
}
