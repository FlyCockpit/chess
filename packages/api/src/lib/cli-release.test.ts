import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(
  () =>
    ({}) as {
      CLI_RELEASE_REPO?: string;
      CLI_RELEASE_TAG?: string;
      CLI_RELEASE_GITHUB_TOKEN?: string;
    },
);
vi.mock("@cockpit-chess/env/server", () => ({ env }));

const {
  CliReleaseUnavailableError,
  getCliRelease,
  isCliReleaseConfigured,
  resetCliReleaseCache,
  resolveCliAssetUrl,
} = await import("./cli-release");

const fetchMock = vi.fn<typeof fetch>();

const releaseBody = {
  tag_name: "v1.4.0",
  assets: [
    {
      name: "cockpit-chess-linux-x64",
      url: "https://api.github.com/repos/acme/app/releases/assets/11",
      browser_download_url:
        "https://github.com/acme/app/releases/download/v1.4.0/cockpit-chess-linux-x64",
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestHeaders(call: number): Headers {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers);
}

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key as keyof typeof env];
  resetCliReleaseCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCliRelease", () => {
  it("throws CliReleaseUnavailableError when unconfigured, without fetching", async () => {
    expect(isCliReleaseConfigured()).toBe(false);
    await expect(getCliRelease()).rejects.toBeInstanceOf(CliReleaseUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the latest release by default", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockResolvedValueOnce(json(releaseBody));

    const release = await getCliRelease();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/app/releases/latest",
    );
    expect(release.tag).toBe("v1.4.0");
    expect(release.version).toBe("1.4.0");
    expect(release.assets.get("cockpit-chess-linux-x64")?.apiUrl).toBe(releaseBody.assets[0]?.url);
  });

  it("reads the pinned tag when CLI_RELEASE_TAG is set", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    env.CLI_RELEASE_TAG = "v1.2.3";
    fetchMock.mockResolvedValueOnce(json({ ...releaseBody, tag_name: "v1.2.3" }));

    await getCliRelease();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/app/releases/tags/v1.2.3",
    );
  });

  it("caches the release within the TTL", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockResolvedValueOnce(json(releaseBody));

    await getCliRelease();
    await getCliRelease();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a GitHub error status to CliReleaseUnavailableError", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
    await expect(getCliRelease()).rejects.toBeInstanceOf(CliReleaseUnavailableError);
  });

  it("maps a network failure to CliReleaseUnavailableError", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(getCliRelease()).rejects.toBeInstanceOf(CliReleaseUnavailableError);
  });

  it("sends the token only when configured", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockResolvedValueOnce(json(releaseBody));
    await getCliRelease();
    expect(requestHeaders(0).get("authorization")).toBeNull();
  });
});

describe("resolveCliAssetUrl", () => {
  it("returns browser_download_url for a public repo without a second fetch", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockResolvedValueOnce(json(releaseBody));

    await expect(resolveCliAssetUrl("cockpit-chess-linux-x64")).resolves.toBe(
      releaseBody.assets[0]?.browser_download_url,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null for an asset the release does not carry", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    fetchMock.mockResolvedValueOnce(json(releaseBody));
    await expect(resolveCliAssetUrl("cockpit-chess-darwin-arm64")).resolves.toBeNull();
  });

  it("asks GitHub for a signed URL on a private repo and returns the redirect target", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    env.CLI_RELEASE_GITHUB_TOKEN = "ghp_secret";
    fetchMock.mockResolvedValueOnce(json(releaseBody)).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/signed?sig=1" },
      }),
    );

    await expect(resolveCliAssetUrl("cockpit-chess-linux-x64")).resolves.toBe(
      "https://objects.githubusercontent.com/signed?sig=1",
    );

    const [assetUrl, init] = fetchMock.mock.calls[1] ?? [];
    expect(assetUrl).toBe(releaseBody.assets[0]?.url);
    expect(init?.redirect).toBe("manual");
    expect(requestHeaders(1).get("accept")).toBe("application/octet-stream");
    // The token goes to api.github.com and nowhere else.
    for (const [url, callInit] of fetchMock.mock.calls) {
      expect(new URL(String(url)).host).toBe("api.github.com");
      expect(new Headers(callInit?.headers).get("authorization")).toBe("Bearer ghp_secret");
    }
  });

  it("treats a non-redirect asset answer as unavailable", async () => {
    env.CLI_RELEASE_REPO = "acme/app";
    env.CLI_RELEASE_GITHUB_TOKEN = "ghp_secret";
    fetchMock
      .mockResolvedValueOnce(json(releaseBody))
      .mockResolvedValueOnce(new Response("binary", { status: 200 }));

    await expect(resolveCliAssetUrl("cockpit-chess-linux-x64")).rejects.toBeInstanceOf(
      CliReleaseUnavailableError,
    );
  });
});
