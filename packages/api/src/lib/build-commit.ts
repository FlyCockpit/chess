import { readFileSync } from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit this server was built from, reported on `/ready` so an outside
 * check (`pnpm deploy:check`) can tell which release is serving. The image
 * build writes it next to the bundle (`apps/server/dist/BUILD_COMMIT`,
 * scripts/build-commit.mjs); dev servers and images built without git
 * metadata report `null`. Read once at boot.
 */
export function readBuildCommit(entry: string | undefined = process.argv[1]): string | null {
  if (!entry) return null;
  try {
    const value = readFileSync(path.join(path.dirname(entry), "BUILD_COMMIT"), "utf8")
      .trim()
      .toLowerCase();
    return SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}

let cached: string | null | undefined;
/** `readBuildCommit()` of this process's entry, read once. */
export function buildCommit(): string | null {
  if (cached === undefined) cached = readBuildCommit();
  return cached;
}

/** The upstream repository, SOURCE_CODE_URL's default. */
export const UPSTREAM_SOURCE_CODE_URL = "https://github.com/FlyCockpit/chess";
const COMMIT_PLACEHOLDER = "{commit}";

/**
 * The public source of the running code (AGPL-3.0 § 13), from SOURCE_CODE_URL:
 *   - a `{commit}` placeholder is replaced by the build commit (any host's layout,
 *     e.g. `https://git.example/fork/-/tree/{commit}`); with no known commit the link
 *     is the repository: the URL up to the placeholder, less a trailing `/tree`,
 *     `/-/tree`, `/src` or `/commit` segment;
 *   - the default upstream GitHub repository gets `/tree/<commit>`;
 *   - any other URL is used exactly as given.
 */
export function sourceCodeUrl(repository: string, commit: string | null = buildCommit()) {
  const at = repository.indexOf(COMMIT_PLACEHOLDER);
  if (at !== -1)
    return commit
      ? repository.replaceAll(COMMIT_PLACEHOLDER, commit)
      : repository
          .slice(0, at)
          .replace(/\/+$/, "")
          .replace(/(?:\/-)?\/(?:tree|src|commit)$/, "");
  const base = repository.replace(/\/+$/, "");
  if (base.toLowerCase() !== UPSTREAM_SOURCE_CODE_URL.toLowerCase()) return repository;
  return commit ? `${base}/tree/${commit}` : base;
}
