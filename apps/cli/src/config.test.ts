import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfig } from "./commands/config";
import {
  isSettableKey,
  loadConfig,
  resolveCredential,
  resolveRunnerCredential,
  resolveServer,
  saveConfig,
  withCredential,
  withRunnerCredential,
} from "./config";
import { CliError } from "./exit";

describe("config file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cockpit-chess-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads a missing file as empty", async () => {
    expect(await loadConfig(join(dir, "nope.json"))).toEqual({});
  });

  it("round-trips and keeps the credential file private", async () => {
    const path = join(dir, "nested", "config.json");
    const config = {
      server: "https://app.example.com",
      credentials: { "https://app.example.com": { kind: "session" as const, value: "t" } },
      runnerCredentials: {
        "https://app.example.com": {
          "machine-1": { value: "runner-test-secret", expiresAt: "2027-01-01T00:00:00Z" },
        },
      },
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

  it.each([{ flags: [] }, { flags: ["--json"] }])(
    "config show $flags omits all runner secrets",
    async ({ flags }) => {
      vi.stubEnv("COCKPIT_CHESS_CONFIG_DIR", dir);
      await saveConfig({
        server: "https://app.example.com",
        credentials: {
          "https://app.example.com": { kind: "session", value: "companion-test-secret" },
        },
        runnerCredentials: {
          "https://app.example.com": {
            "machine-1": { value: "runner-test-secret", expiresAt: "2027-01-01T00:00:00Z" },
          },
        },
      });
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const program = new Command();
      registerConfig(program);
      await program.parseAsync(["config", "show", ...flags], { from: "user" });
      const output = stdout.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain("https://app.example.com");
      expect(output).not.toMatch(
        /runnerCredentials|runner-test-secret|companion-test-secret|machine-1/,
      );
      expect(stderr).not.toHaveBeenCalled();
      if (flags.length > 0) expect(JSON.parse(output)).not.toHaveProperty("runnerCredentials");
    },
  );
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
  expect(isSettableKey("runnerCredentials")).toBe(false);
});

describe("runner credentials", () => {
  const prod = "https://app.example.com";
  const staging = "https://staging.example.com";
  const credential = { value: "runner-test-secret", expiresAt: "2027-01-01T00:00:00Z" };
  afterEach(() => vi.unstubAllEnvs());

  it("resolves only the exact origin and machine without falling back to companion authority", () => {
    vi.stubEnv("COCKPIT_CHESS_API_KEY", "companion-env-test-key");
    const config = withRunnerCredential({}, prod, "machine-1", credential);
    expect(resolveRunnerCredential(config, prod, "machine-1")).toEqual(credential);
    expect(resolveRunnerCredential(config, staging, "machine-1")).toBeUndefined();
    expect(resolveRunnerCredential(config, `${prod}.evil.example`, "machine-1")).toBeUndefined();
    expect(resolveRunnerCredential(config, prod, "machine-2")).toBeUndefined();
    expect(
      resolveRunnerCredential(
        { credentials: { [prod]: { kind: "session", value: "s" } } },
        prod,
        "machine-1",
      ),
    ).toBeUndefined();
    vi.stubEnv("COCKPIT_CHESS_API_KEY", "");
    expect(resolveCredential(config, prod)).toBeUndefined();
  });

  it("replaces/removes exactly one machine and preserves companion credentials and other origins", () => {
    const companion = { credentials: { [prod]: { kind: "session" as const, value: "session" } } };
    const first = withRunnerCredential(companion, prod, "one", credential);
    const second = withRunnerCredential(first, prod, "two", credential);
    const third = withRunnerCredential(second, staging, "one", credential);
    const replacement = { ...credential, value: "replacement-test-secret" };
    expect(
      resolveRunnerCredential(withRunnerCredential(third, prod, "one", replacement), prod, "one"),
    ).toEqual(replacement);
    const removed = withRunnerCredential(third, prod, "one", undefined);
    expect(removed).toEqual({
      ...companion,
      runnerCredentials: { [prod]: { two: credential }, [staging]: { one: credential } },
    });
    expect(withRunnerCredential(first, prod, "one", undefined)).toEqual(companion);
    expect(withCredential(first, prod, undefined).runnerCredentials).toEqual(
      first.runnerCredentials,
    );
    expect(third.runnerCredentials?.[prod]?.one).toEqual(credential);
  });
});
