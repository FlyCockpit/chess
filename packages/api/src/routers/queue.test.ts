import type { Session } from "@cockpit-chess/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

const chessGetJob = vi.fn();
const reconcileGetJob = vi.fn();
const authTokenGetJob = vi.fn();
const backupGetJob = vi.fn();
const deletionGetJob = vi.fn();
const listJobs = vi.fn().mockResolvedValue([]);
const redisGet = vi.fn();
const backupEnabled = vi.fn(() => true);
const backupMisconfiguration = vi.fn((): { state: "misconfigured"; reason: string } | null => null);
const backupSetupMissing = vi.fn(
  (): { state: "setup-missing"; reason: string; checkedAt: string; maxAgeHours: number } | null =>
    null,
);

vi.mock("@cockpit-chess/queue", () => {
  const fakeQueue = { getJobs: listJobs };
  return {
    chessRunQueue: { ...fakeQueue, getJob: chessGetJob },
    chessReconcileQueue: { ...fakeQueue, getJob: reconcileGetJob },
    reapExpiredAuthTokensQueue: { ...fakeQueue, getJob: authTokenGetJob },
    checkBackupFreshnessQueue: { ...fakeQueue, getJob: backupGetJob },
    notifyDataDeletionsQueue: { ...fakeQueue, getJob: deletionGetJob },
    QUEUE_NAMES: {
      chessRun: "chess-run",
      chessReconcile: "chess-reconcile",
      reapExpiredAuthTokens: "reap-expired-auth-tokens",
      checkBackupFreshness: "check-backup-freshness",
      notifyDataDeletions: "notify-data-deletions",
    },
    redisConnection: { get: redisGet },
  };
});

vi.mock("../lib/backup-freshness", () => ({
  backupFreshnessEnabled: () => backupEnabled(),
  misconfiguredBackupFreshness: () => backupMisconfiguration(),
  setupMissingBackupFreshness: () => backupSetupMissing(),
  readBackupFreshness: async (redis: { get: (key: string) => Promise<string | null> }) => {
    const raw = await redis.get("backup:freshness");
    return raw ? JSON.parse(raw) : null;
  },
}));

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<typeof import("@cockpit-chess/db").default>();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@cockpit-chess/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

const { queueRouter } = await import("./queue");

function buildContext(role: "admin" | "user"): Context {
  return {
    clientIp: "127.0.0.1",
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role,
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
      session: {
        id: "test-session-id",
        userId: "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
    } as Session,
  };
}

describe("queueRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backupEnabled.mockReturnValue(true);
    backupMisconfiguration.mockReturnValue(null);
    backupSetupMissing.mockReturnValue(null);
  });

  it.each([
    ["chess-run", chessGetJob],
    ["chess-reconcile", reconcileGetJob],
    ["reap-expired-auth-tokens", authTokenGetJob],
    ["check-backup-freshness", backupGetJob],
    ["notify-data-deletions", deletionGetJob],
  ] as const)("includes %s in the admin queue map", async (queue, getJob) => {
    getJob.mockResolvedValue(null);
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.getJob({ jobId: "job-1", queue })).resolves.toBeNull();
    expect(getJob).toHaveBeenCalledWith("job-1");
  });

  it("defaults job lookups to the chess-run queue", async () => {
    chessGetJob.mockResolvedValue(null);
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.getJob({ jobId: "job-1" })).resolves.toBeNull();
    expect(chessGetJob).toHaveBeenCalledWith("job-1");
  });

  it("bounds failed-job queries across all five queues", async () => {
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.listFailed({ limit: 5 })).resolves.toEqual({ items: [] });
    expect(listJobs).toHaveBeenCalledTimes(5);
    expect(listJobs).toHaveBeenCalledWith(["failed"], 0, 4, false);
  });

  it("reports backups as not configured without touching Redis", async () => {
    backupEnabled.mockReturnValue(false);
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({ configured: false, status: null });
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("returns the recorded freshness verdict when backups are configured", async () => {
    backupEnabled.mockReturnValue(true);
    const verdict = {
      state: "stale",
      checkedAt: "2026-09-08T00:00:00.000Z",
      latestKey: "database/backup-1.dump",
      latestAt: "2026-09-05T03:00:00.000Z",
      ageHours: 69,
      maxAgeHours: 36,
    };
    redisGet.mockResolvedValue(JSON.stringify(verdict));
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({ configured: true, status: verdict });
    expect(redisGet).toHaveBeenCalledWith("backup:freshness");
  });

  it('reports enabled backups without a bucket as setup-missing rather than as "off"', async () => {
    backupEnabled.mockReturnValue(true);
    backupSetupMissing.mockReturnValue({
      state: "setup-missing",
      checkedAt: "2026-09-08T00:00:00.000Z",
      maxAgeHours: 36,
      reason: "BACKUP_S3_BUCKET is not set.",
    });
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({
      configured: true,
      status: {
        state: "setup-missing",
        checkedAt: "2026-09-08T00:00:00.000Z",
        maxAgeHours: 36,
        reason: "BACKUP_S3_BUCKET is not set.",
      },
    });
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('reports a set-but-unusable bucket as misconfigured rather than as "off"', async () => {
    // Hiding this behind `configured: false` means the admin card disappears
    // and the operator never learns that no backups are being taken.
    backupEnabled.mockReturnValue(true);
    backupMisconfiguration.mockReturnValue({
      state: "misconfigured",
      reason: "BACKUP_S3_REGION must be a real AWS region.",
    });
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });

    await expect(client.backupStatus()).resolves.toEqual({
      configured: true,
      status: { state: "misconfigured", reason: "BACKUP_S3_REGION must be a real AWS region." },
    });
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("hides backup status from non-admins", async () => {
    const client = createRouterClient(queueRouter, { context: buildContext("user") });
    await expect(client.backupStatus()).rejects.toBeInstanceOf(ORPCError);
  });

  it.each([
    "echo",
    "seed",
    "chat-run",
    "reap-stale-chat-runs",
    "analyze-asset",
    "cleanup-assets",
    "not-a-queue",
  ])("rejects unavailable queue %s", async (queue) => {
    const client = createRouterClient(queueRouter, { context: buildContext("admin") });
    // @ts-expect-error — exercise runtime validation of untrusted HTTP input.
    await expect(client.getJob({ jobId: "job-1", queue })).rejects.toBeInstanceOf(ORPCError);
  });
});
