import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isSettableKey,
  loadConfig,
  resolveCredential,
  resolveServer,
  saveConfig,
  withCredential,
} from "./config";
import { CliError } from "./exit";

describe("config file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cockpit-chess-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a missing file as empty", async () => {
    expect(await loadConfig(join(dir, "nope.json"))).toEqual({});
  });

  it("round-trips and keeps the credential file private", async () => {
    const path = join(dir, "nested", "config.json");
    const config = {
      server: "https://app.example.com",
      credentials: { "https://app.example.com": { kind: "session" as const, value: "t" } },
    };
    await saveConfig(config, path);
    expect(await loadConfig(path)).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path, "utf8")).toMatch(/\n$/);
  });

  it("reports corrupt JSON as a CLI error", async () => {
    const path = join(dir, "config.json");
    await saveConfig({}, path);
    await import("node:fs/promises").then((fs) => fs.writeFile(path, "{nope"));
    await expect(loadConfig(path)).rejects.toBeInstanceOf(CliError);
  });
});

describe("resolveServer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers the flag, then COCKPIT_CHESS_SERVER, then config", () => {
    vi.stubEnv("COCKPIT_CHESS_SERVER", "https://env.example.com");
    expect(resolveServer({ server: "https://cfg.example.com" }, "https://flag.example.com")).toBe(
      "https://flag.example.com",
    );
    expect(resolveServer({ server: "https://cfg.example.com" })).toBe("https://env.example.com");
  });

  it("normalizes to the origin", () => {
    expect(resolveServer({ server: "https://app.example.com/some/path?x=1" })).toBe(
      "https://app.example.com",
    );
  });

  it("refuses plain http except for localhost", () => {
    expect(() => resolveServer({ server: "http://app.example.com" })).toThrow(CliError);
    expect(resolveServer({ server: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it("falls back to the build's default server last", () => {
    vi.stubEnv("COCKPIT_CHESS_SERVER", undefined);
    expect(resolveServer({}, undefined, "https://prod.example.com/")).toBe(
      "https://prod.example.com",
    );
    expect(
      resolveServer({ server: "https://cfg.example.com" }, undefined, "https://prod.example.com"),
    ).toBe("https://cfg.example.com");
  });

  it("explains how to configure a missing server", () => {
    vi.stubEnv("COCKPIT_CHESS_SERVER", undefined);
    expect(() => resolveServer({}, undefined, undefined)).toThrow(/install command/);
  });
});

describe("resolveCredential", () => {
  afterEach(() => vi.unstubAllEnvs());

  const prod = "https://app.example.com";
  const staging = "https://staging.example.com";
  const config = { credentials: { [prod]: { kind: "session" as const, value: "prod-token" } } };

  it("lets COCKPIT_CHESS_API_KEY override the stored login", () => {
    vi.stubEnv("COCKPIT_CHESS_API_KEY", "cockpit_chess_abc");
    expect(resolveCredential(config, prod)).toEqual({
      kind: "api-key",
      value: "cockpit_chess_abc",
    });
  });

  it("returns the login stored for that exact origin", () => {
    vi.stubEnv("COCKPIT_CHESS_API_KEY", "");
    expect(resolveCredential(config, prod)).toEqual({ kind: "session", value: "prod-token" });
  });

  it("never hands one server's login to another", () => {
    vi.stubEnv("COCKPIT_CHESS_API_KEY", "");
    expect(resolveCredential(config, staging)).toBeUndefined();
    expect(resolveCredential(config, "https://app.example.com.evil.example")).toBeUndefined();
  });
});

describe("withCredential", () => {
  const prod = "https://app.example.com";
  const staging = "https://staging.example.com";

  it("adds a login without touching other servers", () => {
    const start = { credentials: { [prod]: { kind: "session" as const, value: "p" } } };
    expect(withCredential(start, staging, { kind: "api-key", value: "s" })).toEqual({
      credentials: {
        [prod]: { kind: "session", value: "p" },
        [staging]: { kind: "api-key", value: "s" },
      },
    });
  });

  it("removes one login and drops the map when it empties", () => {
    const start = {
      server: prod,
      credentials: { [prod]: { kind: "session" as const, value: "p" } },
    };
    expect(withCredential(start, prod, undefined)).toEqual({ server: prod });
  });
});

it("only exposes non-credential keys to `config set`", () => {
  expect(isSettableKey("server")).toBe(true);
  expect(isSettableKey("credentials")).toBe(false);
});
