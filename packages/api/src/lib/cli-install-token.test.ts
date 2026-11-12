import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ BETTER_AUTH_SECRET: "a".repeat(32) }));
vi.mock("@cockpit-chess/env/server", () => ({ env }));

const { CLI_INSTALL_TOKEN_TTL_MS, createCliInstallToken, verifyCliInstallToken } = await import(
  "./cli-install-token"
);

const NOW = Date.UTC(2026, 9, 20);

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("cli install token", () => {
  beforeEach(() => {
    env.BETTER_AUTH_SECRET = "a".repeat(32);
  });

  it("round-trips the user id and expires after the TTL", () => {
    const { token, expiresAt } = createCliInstallToken("user-1", NOW);
    expect(expiresAt.getTime()).toBe(NOW + CLI_INSTALL_TOKEN_TTL_MS);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyCliInstallToken(token, NOW + 1000)).toBe("user-1");
  });

  it("rejects an expired token", () => {
    const { token } = createCliInstallToken("user-1", NOW);
    expect(verifyCliInstallToken(token, NOW + CLI_INSTALL_TOKEN_TTL_MS)).toBeNull();
    expect(verifyCliInstallToken(token, NOW + CLI_INSTALL_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const { token } = createCliInstallToken("user-1", NOW);
    const [version, , signature] = token.split(".");
    const forged = `${version}.${b64({ u: "admin-1", e: NOW + 60_000 })}.${signature}`;
    expect(verifyCliInstallToken(forged, NOW)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const { token } = createCliInstallToken("user-1", NOW);
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(verifyCliInstallToken(`${token.slice(0, -1)}${last}`, NOW)).toBeNull();
    expect(verifyCliInstallToken(`${token}x`, NOW)).toBeNull();
  });

  it("rejects another version prefix", () => {
    const { token } = createCliInstallToken("user-1", NOW);
    expect(verifyCliInstallToken(token.replace(/^v1\./, "v2."), NOW)).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "v1", "v1.abc", "v1.a.b.c", "...", "not-a-token"]) {
      expect(verifyCliInstallToken(bad, NOW)).toBeNull();
    }
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = createCliInstallToken("user-1", NOW);
    env.BETTER_AUTH_SECRET = "b".repeat(32);
    expect(verifyCliInstallToken(token, NOW)).toBeNull();
  });
});
