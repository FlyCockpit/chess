import type { Session } from "@cockpit-chess/auth";
import type prismaInstance from "@cockpit-chess/db";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";
import type { Context } from "../context";

const { budgets, configurations, lock } = vi.hoisted(() => ({
  budgets: new Map<string, ReturnType<typeof vi.fn>>(),
  configurations: [] as Record<string, unknown>[],
  lock: vi.fn(),
}));
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
vi.mock("@cockpit-chess/auth/lock-slots", () => ({
  withLockSlot: (run: () => Promise<unknown>) => run(),
}));
vi.mock("@cockpit-chess/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "unit-test-only-purpose-separation-key" },
}));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({
  lockCliCredentials: lock,
  withCliCredentialLockSlot: (run: () => Promise<unknown>) => run(),
}));
vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: (options: Record<string, unknown>) => {
    const consume = vi.fn();
    budgets.set(String(options.keyPrefix), consume);
    configurations.push(options);
    return consume;
  },
}));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { chessModerationRouter } = await import("./chess-moderation");
const { invalidateForceTwoFactorSettingsCache } = await import("../index");
const now = new Date("2026-11-28T02:00:00.000Z");
function context(role: "admin" | "user" | null = null): Context {
  if (!role) return { session: null, clientIp: "192.0.2.10" };
  return {
    clientIp: "192.0.2.10",
    session: {
      user: {
        id: role,
        role,
        email: "test@example.com",
        emailVerified: true,
        name: "Test",
        twoFactorEnabled: true,
        createdAt: new Date("2025-01-01"),
        banned: false,
        banExpires: null,
        deletionRequestedAt: null,
      },
      session: { id: "session", userId: role, expiresAt: new Date("2027-01-01") },
    } as Session,
  };
}
function client(ctx: Context = context()) {
  return createRouterClient(chessModerationRouter, { context: ctx });
}
function visible() {
  return {
    id: "match-id",
    slug: "a-published-replay",
    ownerId: "uploader",
    moderationVersion: 2,
    updatedAt: now,
  };
}
const report = { slug: "a-published-replay", reason: "privacy" as const, note: "Remove my name" };
const decision = {
  id: "match-id",
  hidden: true,
  reason: "privacy" as const,
  note: "The published text includes personal details. Contact the operator to request review.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReset(db);
  invalidateForceTwoFactorSettingsCache();
  for (const consume of budgets.values()) consume.mockResolvedValue(undefined);
  db.appSetting.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected interactive transaction");
    return run(db);
  });
  db.$queryRaw.mockResolvedValue([]);
  db.chessMatch.findFirst.mockResolvedValue(visible() as never);
  db.chessMatch.findUnique.mockResolvedValue({ id: "match-id" } as never);
  db.chessReplayReport.upsert.mockResolvedValue({ id: "notice" } as never);
  db.user.findUnique.mockResolvedValue({
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  } as never);
  db.session.findFirst.mockResolvedValue({
    id: "session",
    user: context("admin").session?.user,
  } as never);
  db.chessMatch.update.mockResolvedValue({
    id: "match-id",
    hiddenAt: now,
    moderationReason: decision.reason,
    moderationNote: decision.note,
    moderationVersion: 3,
  } as never);
});

describe("public replay notices", () => {
  it("accepts an anonymous notice without copying the archive or storing an IP", async () => {
    await expect(client().report(report)).resolves.toEqual({ accepted: true });
    const query = db.chessMatch.findFirst.mock.calls[0]?.[0];
    expect(query?.where).toEqual({
      slug: report.slug,
      published: true,
      hiddenAt: null,
      OR: [{ ownerId: null }, { Owner: { is: { deletionRequestedAt: null } } }],
    });
    expect(query?.select).not.toHaveProperty("archive");
    const write = db.chessReplayReport.upsert.mock.calls[0]?.[0];
    expect(write?.create).toEqual({
      matchId: "match-id",
      reporterId: null,
      dedupKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      reason: "privacy",
      note: "Remove my name",
    });
    expect(JSON.stringify(write)).not.toContain("192.0.2.10");
    expect(write?.update).toEqual({});
    expect(lock).not.toHaveBeenCalled();
  });

  it("deduplicates the same replay/IP/day independently of signed-in identity and report content", async () => {
    await client().report(report);
    const first = db.chessReplayReport.upsert.mock.calls[0]?.[0];
    await client(context("user")).report({ ...report, reason: "spam", note: "Different report" });
    const second = db.chessReplayReport.upsert.mock.calls[1]?.[0];
    expect(second?.where).toEqual(first?.where);
    expect(first?.update).toEqual({});
    expect(second?.update).toEqual({});
    expect(second?.create.reporterId).toBe("user");
  });

  it("charges distinct fail-closed per-IP and per-match budgets before looking up a slug", async () => {
    expect(configurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyPrefix: "rl:chess-report-ip", points: 10, failClosed: true }),
        expect.objectContaining({
          keyPrefix: "rl:chess-report-match-ip",
          points: 3,
          failClosed: true,
        }),
      ]),
    );
    budgets.get("rl:chess-report-ip")?.mockRejectedValue(new ORPCError("TOO_MANY_REQUESTS"));
    await expect(client().report(report)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(db.chessMatch.findFirst).not.toHaveBeenCalled();
    expect(db.chessReplayReport.upsert).not.toHaveBeenCalled();
  });

  it("refuses absent trusted client IP instead of sharing a bypass identity", async () => {
    await expect(client({ session: null }).report(report)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("uses the same not-found answer for private, hidden, deleted and unknown targets", async () => {
    db.chessMatch.findFirst.mockResolvedValue(null);
    await expect(client().report(report)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.chessReplayReport.upsert).not.toHaveBeenCalled();
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it("refuses null-owner rows without D2a's neutral replay identity", async () => {
    db.chessMatch.findFirst.mockResolvedValue({ ...visible(), ownerId: null } as never);
    await expect(client().report(report)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.chessReplayReport.upsert).not.toHaveBeenCalled();
  });

  it("accepts a scrubbed retained replay without exposing any former owner", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...visible(),
      ownerId: null,
      slug: "replay-123456781234123412341234567890ab",
    } as never);
    await expect(client().report(report)).resolves.toEqual({ accepted: true });
  });

  it("locks signed-in reporter authority and refuses deletion-pending or banned identities", async () => {
    for (const authority of [
      { deletionRequestedAt: now, banned: false, banExpires: null },
      { deletionRequestedAt: null, banned: true, banExpires: null },
    ]) {
      db.user.findUnique.mockResolvedValue(authority as never);
      await expect(client(context("user")).report(report)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    expect(lock).toHaveBeenCalledWith("user", db);
    expect(db.chessReplayReport.upsert).not.toHaveBeenCalled();
  });

  it("refuses a revoked signed-in session rather than retaining its identity", async () => {
    db.session.findFirst.mockResolvedValue(null);
    await expect(client(context("user")).report(report)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.chessReplayReport.upsert).not.toHaveBeenCalled();
  });

  it("bounds notes, accepts only fixed report reasons and rejects transcript-shaped extras", async () => {
    await expect(client().report({ ...report, note: "x".repeat(1001) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      client().report({ ...report, reason: "no_violation" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client().report({ ...report, archive: {} } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.chessReplayReport.upsert).not.toHaveBeenCalled();
  });
});

describe("lightweight transcript visibility", () => {
  it("returns only version and timestamp, with no archive or engine work", async () => {
    await expect(client().visibility({ slug: report.slug })).resolves.toEqual({
      version: 2,
      updatedAt: now,
    });
    expect(db.chessMatch.findFirst.mock.calls[0]?.[0]?.select).not.toHaveProperty("archive");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses hidden/private/unknown slugs and malformed retained identities", async () => {
    db.chessMatch.findFirst.mockResolvedValue(null);
    await expect(client().visibility({ slug: report.slug })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    db.chessMatch.findFirst.mockResolvedValue({ ...visible(), ownerId: null } as never);
    await expect(client().visibility({ slug: report.slug })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("administrative moderation", () => {
  it("hides admin procedures from anonymous callers, normal users and API keys", async () => {
    const key = { ...context("admin"), credential: "api-key" as const };
    for (const ctx of [context(), context("user"), key]) {
      await expect(client(ctx).list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client(ctx).setHidden(decision)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(db.chessMatch.update).not.toHaveBeenCalled();
  });

  it("commits the uploader statement, version, audit and reviewed reports in one transaction", async () => {
    await client(context("admin")).setHidden(decision);
    expect(lock).toHaveBeenCalledWith("admin", db);
    expect(db.chessMatch.update).toHaveBeenCalledWith({
      where: { id: "match-id" },
      data: {
        hiddenAt: expect.any(Date),
        moderationReason: decision.reason,
        moderationNote: decision.note,
        moderationVersion: { increment: 1 },
      },
      select: expect.objectContaining({ moderationNote: true }),
    });
    expect(db.chessModerationAction.create).toHaveBeenCalledWith({
      data: {
        matchId: "match-id",
        actorId: "admin",
        hidden: true,
        reason: decision.reason,
        note: decision.note,
      },
      select: { id: true },
    });
    expect(db.chessReplayReport.updateMany).toHaveBeenCalledWith({
      where: { matchId: "match-id", reviewedAt: null },
      data: { reviewedAt: expect.any(Date) },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.chessOfficialEntry.update).not.toHaveBeenCalled();
    expect(db.chessMatch.update.mock.calls[0]?.[0]?.data).not.toHaveProperty("published");
  });

  it("rechecks a demoted or revoked administrator after the gate under the credential lock", async () => {
    db.session.findFirst.mockResolvedValue({ user: context("user").session?.user } as never);
    await expect(client(context("admin")).setHidden(decision)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.chessMatch.update).not.toHaveBeenCalled();
    db.session.findFirst.mockResolvedValue(null);
    await expect(client(context("admin")).setHidden(decision)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.chessModerationAction.create).not.toHaveBeenCalled();
  });

  it("withholds report text if the final live actor check fails after the list resolves", async () => {
    db.session.findFirst
      .mockResolvedValueOnce({ user: context("admin").session?.user } as never)
      .mockResolvedValueOnce(null);
    db.chessMatch.findMany.mockResolvedValue([
      { id: "match-id", createdAt: now, Reports: [{ note: "Private report" }] },
    ] as never);
    await expect(client(context("admin")).list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.chessMatch.findMany).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledWith("admin", db);
  });

  it("unhides with its own recorded reason while preserving uploader publication choice", async () => {
    await client(context("admin")).setHidden({
      ...decision,
      hidden: false,
      reason: "no_violation",
      note: "Reviewed; content can be shown again if its owner has published it.",
    });
    expect(db.chessMatch.update.mock.calls[0]?.[0]?.data).toEqual({
      hiddenAt: null,
      moderationReason: "no_violation",
      moderationNote: expect.any(String),
      moderationVersion: { increment: 1 },
    });
  });

  it("requires a bounded statement for every hide and unhide", async () => {
    for (const input of [
      { ...decision, note: "   " },
      { ...decision, note: "x".repeat(1001) },
      { ...decision, reason: "no_violation" as const },
    ]) {
      await expect(client(context("admin")).setHidden(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(db.chessMatch.update).not.toHaveBeenCalled();
  });

  it("bounds the queue, report previews and audit previews without exposing reporter identities", async () => {
    db.chessMatch.findMany.mockResolvedValue([]);
    await expect(client(context("admin")).list({ limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const query = db.chessMatch.findMany.mock.calls[0]?.[0];
    expect(query?.take).toBe(21);
    expect(query?.where).toEqual({ AND: [{ Reports: { some: { reviewedAt: null } } }] });
    expect(query?.select?.Reports).toMatchObject({ take: 10 });
    expect(query?.select?.ModerationActions).toMatchObject({ take: 10 });
    expect(JSON.stringify(query?.select)).not.toContain("reporterId");
    expect(JSON.stringify(query?.select)).not.toContain("actorId");
    expect(JSON.stringify(query?.select)).not.toContain("archive");
  });
});
