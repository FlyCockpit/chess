import { env } from "@cockpit-chess/env/server";

// Where the companion CLI's binaries come from: a GitHub Release on
// CLI_RELEASE_REPO, built and uploaded by .github/workflows/release.yml. The
// server never stores or streams the bytes. For a private repo it asks GitHub
// (with a read-only token that never leaves the server) for the asset, and
// GitHub answers with a short-lived pre-signed URL that the caller is
// redirected to. A public repo needs no token: its `browser_download_url` is
// already public.
//
// Swapping the source (S3 presigned URLs, a CDN) means replacing this module
// and keeping its two exports' shapes — see packages/api/src/routers/cli.ts

const GITHUB_API = "https://api.github.com";
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 10_000;

export type CliRelease = {
  /** Release tag, e.g. `v1.4.0`. */
  tag: string;
  /** Version without the leading `v`, as `cockpit-chess --version` prints it. */
  version: string;
  assets: Map<string, { apiUrl: string; browserDownloadUrl: string }>;
};

/** The release source is unset or GitHub could not be reached; endpoints answer 503. */
export class CliReleaseUnavailableError extends Error {}

export function isCliReleaseConfigured(): boolean {
  return Boolean(env.CLI_RELEASE_REPO);
}

let releaseCache: { key: string; release: CliRelease; expiresAt: number } | null = null;

/** Test hook. */
export function resetCliReleaseCache(): void {
  releaseCache = null;
}

function githubHeaders(accept: string): Headers {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": "cockpit-chess-cli-release-proxy",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (env.CLI_RELEASE_GITHUB_TOKEN) {
    headers.set("Authorization", `Bearer ${env.CLI_RELEASE_GITHUB_TOKEN}`);
  }
  return headers;
}

type GithubReleaseBody = {
  tag_name?: unknown;
  assets?: Array<{ name?: unknown; url?: unknown; browser_download_url?: unknown }>;
};

/** The release the app serves: CLI_RELEASE_TAG when pinned, else the latest published one. */
export async function getCliRelease(): Promise<CliRelease> {
  const repo = env.CLI_RELEASE_REPO;
  if (!repo) throw new CliReleaseUnavailableError("CLI_RELEASE_REPO is not set");

  const key = `${repo}@${env.CLI_RELEASE_TAG ?? "latest"}`;
  const now = Date.now();
  if (releaseCache && releaseCache.key === key && releaseCache.expiresAt > now) {
    return releaseCache.release;
  }

  const path = env.CLI_RELEASE_TAG
    ? `/repos/${repo}/releases/tags/${encodeURIComponent(env.CLI_RELEASE_TAG)}`
    : `/repos/${repo}/releases/latest`;

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      headers: githubHeaders("application/vnd.github+json"),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliReleaseUnavailableError(`GitHub request failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new CliReleaseUnavailableError(`GitHub answered ${response.status} for ${path}`);
  }

  const body = (await response.json()) as GithubReleaseBody;
  if (typeof body.tag_name !== "string") {
    throw new CliReleaseUnavailableError("GitHub release has no tag_name");
  }
  const assets: CliRelease["assets"] = new Map();
  for (const asset of body.assets ?? []) {
    if (
      typeof asset.name === "string" &&
      typeof asset.url === "string" &&
      typeof asset.browser_download_url === "string"
    ) {
      assets.set(asset.name, { apiUrl: asset.url, browserDownloadUrl: asset.browser_download_url });
    }
  }

  const release: CliRelease = {
    tag: body.tag_name,
    version: body.tag_name.replace(/^v/, ""),
    assets,
  };
  releaseCache = { key, release, expiresAt: now + RELEASE_CACHE_TTL_MS };
  return release;
}

/**
 * A URL the caller can GET to download one release asset, or `null` when the
 * release has no asset of that name. Never cached: for private repos the URL
 * GitHub returns is pre-signed and expires within minutes.
 */
export async function resolveCliAssetUrl(assetName: string): Promise<string | null> {
  const release = await getCliRelease();
  const asset = release.assets.get(assetName);
  if (!asset) return null;
  if (!env.CLI_RELEASE_GITHUB_TOKEN) return asset.browserDownloadUrl;

  let response: Response;
  try {
    response = await fetch(asset.apiUrl, {
      headers: githubHeaders("application/octet-stream"),
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliReleaseUnavailableError(`GitHub asset request failed: ${String(error)}`);
  }
  // Drop the body (if any) without reading the binary through this process.
  await response.body?.cancel();
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new CliReleaseUnavailableError(
      `GitHub asset request answered ${response.status} without a redirect`,
    );
  }
  return location;
}
