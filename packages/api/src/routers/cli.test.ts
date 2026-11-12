import type { Session } from "@cockpit-chess/auth";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context, CredentialKind } from "../context";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/queue", () => ({
  chessRunQueue: {},
  ensureRunnableJob: vi.fn(),
  redisConnection: {},
}));
vi.mock("@cockpit-chess/env/server", () => ({ env: {}, ADMIN_EMAILS: new Set<string>() }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: {} }));
const getCliRelease = vi.hoisted(() => vi.fn());
vi.mock("../lib/cli-release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cli-release")>()),
  getCliRelease,
}));

const { default: db } = await import("@cockpit-chess/db");
const { cliRouter } = await import("./cli");
const { CliReleaseUnavailableError } = await import("../lib/cli-release");
const { invalidateForceTwoFactorSettingsCache } = await import("../lib/two-factor-policy");

const now = new Date("2026-10-20T00:00:00Z");

function client(credential?: CredentialKind) {
  const context: Context = {
    credential,
    session: {
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: "session-1",
        userId: "user-1",
        token: "token",
        expiresAt: new Date("2027-01-01"),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
        updatedAt: now,
      },
    } as Session,
  };
  return createRouterClient(cliRouter, { context });
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateForceTwoFactorSettingsCache();
  db.appSetting.findMany.mockResolvedValue([]);
});

describe("cliRouter.whoami", () => {
  it("returns the signed-in user and credential kind", async () => {
    await expect(client("api-key").whoami()).resolves.toEqual({
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      credential: "api-key",
    });
    await expect(client("session-token").whoami()).resolves.toMatchObject({
      credential: "session-token",
    });
  });

  it("rejects anonymous callers", async () => {
    const anon = createRouterClient(cliRouter, { context: { session: null } });
    await expect(anon.whoami()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("cliRouter.logout", () => {
  it("deletes only the caller's own session row for a device-flow token", async () => {
    db.session.deleteMany.mockResolvedValue({ count: 1 });
    await expect(client("session-token").logout()).resolves.toEqual({ revoked: true });
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { id: "session-1", userId: "user-1" },
    });
  });

  it("is a server-side no-op for an API key", async () => {
    await expect(client("api-key").logout()).resolves.toEqual({ revoked: false });
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });
});

describe("cliRouter.latestRelease", () => {
  it("returns the served release", async () => {
    getCliRelease.mockResolvedValue({ tag: "v1.4.0", version: "1.4.0", assets: new Map() });
    await expect(client("api-key").latestRelease()).resolves.toEqual({
      available: true,
      version: "1.4.0",
      tag: "v1.4.0",
    });
  });

  it("reports unavailable when the release source is down or unset", async () => {
    getCliRelease.mockRejectedValue(new CliReleaseUnavailableError("unset"));
    await expect(client("api-key").latestRelease()).resolves.toEqual({ available: false });
  });

  it("surfaces unexpected errors", async () => {
    getCliRelease.mockRejectedValue(new Error("boom"));
    await expect(client("api-key").latestRelease()).rejects.toBeTruthy();
  });
});
