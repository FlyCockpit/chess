import { boardAt, createMatch, submitMove } from "@cockpit-chess/chess";
import type { Prisma } from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/auth", () => ({ auth: {}, passwordPepper: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 5 } }));
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({
  lockCliCredentials: vi.fn(),
  withCliCredentialLockSlot: (run: () => Promise<unknown>) => run(),
}));
const { default: prisma } = await import("@cockpit-chess/db");
const { lockCliCredentials } = await import("@cockpit-chess/auth/device-redemption-lock");
const { AccountExportError, assertAccountExportAuthority, streamAccountExport } = await import(
  "./account-export"
);
const db = vi.mocked(prisma);
const tx = mockDeep<Prisma.TransactionClient>();
const identity = { userId: "owner", sessionId: "browser" };
const secret = "NEVER_EXPORT_SYNTHETIC_CREDENTIAL";
const live = () => ({
  authenticatedAt: new Date(Date.now() - 1000),
  user: {
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: false,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date(),
    role: "user",
    locale: "en-US",
    twoFactorEnabled: false,
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
    deletionCursor: secret,
  },
});
const archive = () =>
  createMatch({
    title: "Private game",
    white: { name: "White", model: "random", protocol: "random" },
    black: { name: "Black", model: "random", protocol: "random" },
    rules: {},
  });
const collect = async (format: "json" | "pgn" = "json") => {
  let text = "";
  for await (const chunk of streamAccountExport(identity, format)) text += chunk;
  return text;
};

beforeEach(() => {
  vi.useRealTimers();
  mockReset(tx);
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected interactive transaction");
    return run(tx);
  });
  tx.session.findFirst.mockImplementation(async () => live() as never);
  tx.appSetting.findUnique.mockResolvedValue(null);
  tx.account.findMany.mockResolvedValue([]);
  tx.session.findMany.mockResolvedValue([]);
  tx.twoFactor.findMany.mockResolvedValue([]);
  tx.deviceCode.findMany.mockResolvedValue([]);
  tx.apiKey.findMany.mockResolvedValue([]);
  tx.runnerMachine.findMany.mockResolvedValue([]);
  tx.runnerClaim.findMany.mockResolvedValue([]);
  tx.openRouterConnection.findMany.mockResolvedValue([]);
  tx.chessMatch.findMany.mockResolvedValue([]);
  tx.chessReplayReport.findMany.mockResolvedValue([]);
  tx.chessModerationAction.findMany.mockResolvedValue([]);
  tx.verification.findMany.mockResolvedValue([]);
});

describe("account data export", () => {
  it("exports safe own metadata and both private and published games, never credential fields", async () => {
    tx.account.findMany.mockResolvedValue([
      {
        id: "account",
        accountId: "identity",
        providerId: "credential",
        password: secret,
        accessToken: secret,
        refreshToken: secret,
        idToken: secret,
      },
    ] as never);
    tx.session.findMany.mockResolvedValue([
      { id: "session", userAgent: "Browser", token: secret },
    ] as never);
    tx.twoFactor.findMany.mockResolvedValue([
      { id: "totp", verified: true, secret, backupCodes: secret },
    ] as never);
    tx.deviceCode.findMany.mockResolvedValue([
      { id: "device", status: "approved", deviceCode: secret, userCode: secret },
    ] as never);
    tx.apiKey.findMany.mockResolvedValue([
      { id: "api-key", name: "Work", key: secret, metadata: secret },
    ] as never);
    tx.runnerMachine.findMany.mockResolvedValue([
      { id: "runner", displayName: "Laptop", credentialDigest: secret },
    ] as never);
    tx.runnerClaim.findMany.mockResolvedValue([
      { id: "claim", machineId: "runner", tokenDigest: secret, proofDigest: secret },
    ] as never);
    tx.openRouterConnection.findMany.mockResolvedValue([
      {
        id: "connection",
        label: "OpenRouter",
        limitMicros: 100n,
        keyCiphertext: secret,
        keyNonce: secret,
        keySecretId: secret,
      },
    ] as never);
    tx.chessMatch.findMany.mockResolvedValue([
      {
        id: "private",
        published: false,
        archive: archive(),
        runToken: secret,
        OfficialEntry: { id: "entry", injected: secret },
      },
      { id: "published", published: true, archive: archive(), OfficialEntry: null },
    ] as never);
    const text = await collect();
    const result = JSON.parse(text);
    expect(text).not.toContain(secret);
    expect(result.account.emailVerified).toBe(false);
    expect(result.matches.map((match: { id: string }) => match.id)).toEqual([
      "private",
      "published",
    ]);
    expect(result.matches[0].archive.config.title).toBe("Private game");
    expect(result.matches[0].OfficialEntry).toEqual({ id: "entry" });
    expect(result.openRouterConnections[0].limitMicros).toBe("100");
    expect(result.runnerMachines[0].displayName).toBe("Laptop");
    expect(result.reports).toEqual([]);
    for (const delegate of [
      tx.account,
      tx.session,
      tx.twoFactor,
      tx.deviceCode,
      tx.runnerMachine,
      tx.runnerClaim,
      tx.openRouterConnection,
    ]) {
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "owner" }),
          take: 50,
          select: expect.any(Object),
        }),
      );
    }
    expect(tx.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ referenceId: "owner" }) }),
    );
    expect(tx.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: "owner" }), take: 5 }),
    );
    expect(lockCliCredentials).toHaveBeenCalledWith("owner", tx);
  });

  it("advances bounded keyset pages without needing the previous row to survive", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `m${String(index).padStart(3, "0")}`,
    }));
    tx.runnerMachine.findMany
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ id: "m999" }] as never)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ id: "m999" }] as never);
    const result = JSON.parse(await collect());
    expect(result.runnerMachines).toHaveLength(51);
    expect(tx.runnerMachine.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ userId: "owner", id: { gt: "m049" } }),
        orderBy: { id: "asc" },
        take: 50,
      }),
    );
  });

  it("marks unsupported archives without exporting unvalidated JSON or dropping safe match metadata", async () => {
    tx.chessMatch.findMany.mockResolvedValue([
      {
        id: "old",
        title: "Retained metadata",
        published: false,
        archive: { key: secret },
        OfficialEntry: null,
      },
    ] as never);
    const result = JSON.parse(await collect());
    expect(result.matches[0]).toMatchObject({
      id: "old",
      title: "Retained metadata",
      archive: null,
      archiveError: "unsupported_ruleset_archive",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await collect("pgn")).toContain('[Event "Unsupported ruleset/archive"]');
  });

  it("uses the current PGN writer and does not query unrelated metadata for PGN", async () => {
    tx.chessMatch.findMany.mockResolvedValue([{ id: "match", archive: archive() }] as never);
    expect(await collect("pgn")).toContain('[Event "Private game"]');
    expect(tx.account.findMany).not.toHaveBeenCalled();
  });

  it.each([null, new Date(Date.now() - 300_001), new Date(Date.now() + 60_000)])(
    "requires genuine recent primary-auth proof (%s)",
    async (authenticatedAt) => {
      tx.session.findFirst.mockResolvedValue({ ...live(), authenticatedAt } as never);
      await expect(assertAccountExportAuthority(identity)).rejects.toMatchObject({
        code: "REAUTH_REQUIRED",
      });
      expect(tx.account.findMany).not.toHaveBeenCalled();
    },
  );

  it("refuses revoked/expired/foreign/device/impersonated browser sessions using the exact live predicate", async () => {
    tx.session.findFirst.mockResolvedValue(null);
    await expect(assertAccountExportAuthority(identity)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(tx.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "browser",
          userId: "owner",
          origin: "sign-in",
          impersonatedBy: null,
          expiresAt: { gt: expect.any(Date) },
        },
      }),
    );
  });

  it.each(["pending", "banned", "two-factor"])(
    "refuses %s authority before reading personal tables",
    async (condition) => {
      const value = live();
      if (condition === "pending") value.user.deletionRequestedAt = new Date() as never;
      if (condition === "banned") value.user.banned = true;
      if (condition === "two-factor")
        tx.appSetting.findUnique.mockResolvedValue({ value: "true" } as never);
      tx.session.findFirst.mockResolvedValue(value as never);
      await expect(collect()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(tx.chessMatch.findMany).not.toHaveBeenCalled();
    },
  );

  it("rechecks after a page read before releasing newly revoked personal data", async () => {
    tx.account.findMany.mockImplementation(async () => {
      tx.session.findFirst.mockResolvedValue(null);
      return [{ id: "account" }] as never;
    });
    await expect(collect()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rechecks authority before valid final JSON completion after a suspended last row", async () => {
    tx.chessMatch.findMany.mockResolvedValue([
      { id: "last", archive: archive(), OfficialEntry: null },
    ] as never);
    const chunks = streamAccountExport(identity, "json");
    let partial = "";
    for await (const chunk of chunks) {
      partial += chunk;
      if (chunk.includes('"id":"last"')) break;
    }
    // A for-await break closes a generator; manually suspend another at the last row.
    const pending = streamAccountExport(identity, "json");
    while (true) {
      const next = await pending.next();
      if (next.done) throw new Error("Expected final row");
      if (next.value.includes('"id":"last"')) break;
    }
    tx.session.findFirst.mockResolvedValue(null);
    await expect(pending.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(() => JSON.parse(partial)).toThrow();
  });

  it("aborts and bounds elapsed time without reading the whole account", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamAccountExport(identity, "json", { signal: controller.signal }).next(),
    ).rejects.toMatchObject({ code: "ABORTED" });
    const pending = streamAccountExport(identity, "json");
    await pending.next();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 240_001);
    await expect(pending.next()).rejects.toBeInstanceOf(AccountExportError);
    vi.useRealTimers();
  });
});

describe("authoritative stored match endings in account exports", () => {
  it.each([
    ["stopped", null, "cancelled", "abandoned"],
    ["error", null, "interrupted", "emergency"],
    ["error", { kind: "credential-revoked" }, "credential-revoked", "emergency"],
    ["error", { malformed: true }, "interrupted", "emergency"],
  ] as const)(
    "normalizes %s/%j with moves retained and no stale active turn",
    async (status, ending, termination, pgnTermination) => {
      const snapshot = createMatch({
        title: "Awaiting human",
        white: { name: "Random", model: "random", protocol: "random" },
        black: { name: "Human", model: "human", protocol: "human" },
        rules: {},
      });
      submitMove(snapshot, boardAt(snapshot), "e2e4");
      const now = new Date();
      snapshot.turn = {
        type: "human",
        turnId: "11111111-1111-4111-8111-111111111111",
        side: "b",
        expectedSeq: snapshot.events.length,
        startedAt: now.toISOString(),
        deadline: new Date(now.getTime() + 60_000).toISOString(),
      };
      tx.chessMatch.findMany.mockResolvedValue([
        { id: "terminal", status, ending, archive: snapshot, OfficialEntry: null },
      ] as never);
      const result = JSON.parse(await collect());
      expect(result.matches[0].archive).toMatchObject({
        status,
        result: "*",
        termination,
        turn: { type: "idle" },
      });
      expect(result.matches[0].archive.events).toEqual(snapshot.events);
      const pgn = await collect("pgn");
      expect(pgn).toContain(`[Termination "${pgnTermination}"]`);
      expect(pgn).not.toContain('[Termination "unterminated"]');
      expect(pgn).toContain("1. e4");
      expect(snapshot.status).toBe("running");
      expect(snapshot.turn.type).toBe("human");
    },
  );
});

describe("safe non-FK runner operating state export", () => {
  const operatingLimits = {
    matchMicros: 1_000_000,
    dayMicros: 10_000_000,
    concurrency: 2,
    revision: 1,
  };
  const hardLimits = { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 };
  const state = () => ({
    version: 1,
    userId: "owner",
    machineId: "runner",
    generation: 2,
    operatingLimits,
    hardLimits,
    pending: null,
    lastResult: null,
  });
  const row = (value: unknown, expiresAt = new Date(Date.now() + 60_000)) => ({
    id: "runner-limits:v1:runner",
    identifier: "runner-limits:v1:runner",
    expiresAt,
    value: typeof value === "string" ? value : JSON.stringify(value),
  });

  it("exports only strict owner-bound operating state from exact own-machine namespace IDs", async () => {
    tx.runnerMachine.findMany.mockResolvedValue([{ id: "runner", displayName: "Laptop" }] as never);
    tx.verification.findMany.mockResolvedValue([
      row(state()),
      {
        id: "runner-limit-proof:v1:synthetic",
        identifier: "runner-limit-proof:v1:synthetic",
        value: secret,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ] as never);
    const result = JSON.parse(await collect());
    expect(result.runnerLimitStates).toEqual([
      {
        machineId: "runner",
        generation: 2,
        expiresAt: expect.any(String),
        operatingLimits,
        hardLimits,
        pending: null,
        lastResult: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(tx.verification.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["runner-limits:v1:runner"] } },
      select: { id: true, identifier: true, value: true, expiresAt: true },
      take: 50,
    });
  });

  it.each([
    () => ({ ...state(), userId: "another-owner" }),
    () => ({ ...state(), machineId: "foreign-machine" }),
    () => ({ ...state(), proof: secret }),
    () => ({ ...state(), operatingLimits: { ...operatingLimits, concurrency: 64 } }),
    () => "invalid JSON",
    () => " ".repeat(8193),
  ])("marks unsupported state without raw fallback or other-owner data", async (invalid) => {
    tx.runnerMachine.findMany.mockResolvedValue([{ id: "runner" }] as never);
    tx.verification.findMany.mockResolvedValue([row(invalid())] as never);
    const result = JSON.parse(await collect());
    expect(result.runnerLimitStates).toEqual([
      { machineId: "runner", stateError: "unsupported_runner_state" },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("another-owner");
    expect(JSON.stringify(result)).not.toContain("foreign-machine");
  });

  it("omits expired state and never scans Verification when no own machine exists", async () => {
    await collect();
    expect(tx.verification.findMany).not.toHaveBeenCalled();
    tx.runnerMachine.findMany.mockResolvedValue([{ id: "runner" }] as never);
    tx.verification.findMany.mockResolvedValue([row(state(), new Date(Date.now() - 1))] as never);
    expect(JSON.parse(await collect()).runnerLimitStates).toEqual([]);
  });

  it("bounds every state query to its current 50-machine keyset page", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `m${String(index).padStart(3, "0")}`,
    }));
    tx.runnerMachine.findMany
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ id: "m999" }] as never)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ id: "m999" }] as never);
    await collect();
    expect(tx.verification.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: { in: rows.map((item) => `runner-limits:v1:${item.id}`) } },
        take: 50,
      }),
    );
    expect(tx.verification.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: { in: ["runner-limits:v1:m999"] } }, take: 50 }),
    );
  });
});

describe("own filed replay reports and moderation metadata export", () => {
  it("exports filed reports on any match through reporter-only scope and no joins or dedup digest", async () => {
    tx.chessReplayReport.findMany.mockResolvedValue([
      {
        id: "filed-report",
        createdAt: new Date("2026-01-01"),
        matchId: "another-owner-match",
        reason: "privacy",
        note: "My own report",
        reviewedAt: null,
        reporterId: secret,
        dedupKey: secret,
        Reporter: { email: secret },
        Match: { ownerId: secret, Reports: [{ note: secret }] },
      },
    ] as never);
    tx.chessMatch.findMany.mockResolvedValue([
      {
        id: "own-match",
        archive: archive(),
        OfficialEntry: null,
        hiddenAt: new Date("2026-01-02"),
        moderationReason: "privacy",
        moderationNote: "Statement provided to uploader",
        moderationVersion: 2,
        Reports: [{ id: "someone-elses-report", note: secret }],
        ModerationActions: [{ note: secret, actorId: secret }],
      },
    ] as never);
    const text = await collect();
    const result = JSON.parse(text);
    expect(result.reports).toEqual([
      {
        id: "filed-report",
        createdAt: "2026-01-01T00:00:00.000Z",
        matchId: "another-owner-match",
        reason: "privacy",
        note: "My own report",
        reviewedAt: null,
      },
    ]);
    expect(result.matches[0]).toMatchObject({
      hiddenAt: "2026-01-02T00:00:00.000Z",
      moderationReason: "privacy",
      moderationNote: "Statement provided to uploader",
      moderationVersion: 2,
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("someone-elses-report");
    expect(tx.chessReplayReport.findMany).toHaveBeenCalledWith({
      where: { reporterId: "owner", createdAt: { lte: expect.any(Date) } },
      select: {
        id: true,
        createdAt: true,
        matchId: true,
        reason: true,
        note: true,
        reviewedAt: true,
      },
      orderBy: { id: "asc" },
      take: 50,
    });
  });

  it("exports all own filed reports through bounded keyset pages", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({
      id: `r${String(index).padStart(3, "0")}`,
      reason: "spam",
      note: `Report${index}`,
    }));
    tx.chessReplayReport.findMany
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce([{ id: "r999", reason: "privacy", note: "Last report" }] as never);
    const result = JSON.parse(await collect());
    expect(result.reports).toHaveLength(51);
    expect(result.reports.at(-1).id).toBe("r999");
    expect(tx.chessReplayReport.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { reporterId: "owner", createdAt: { lte: expect.any(Date) }, id: { gt: "r049" } },
        orderBy: { id: "asc" },
        take: 50,
      }),
    );
  });

  it("does not read filed reports for PGN game downloads", async () => {
    await collect("pgn");
    expect(tx.chessReplayReport.findMany).not.toHaveBeenCalled();
  });

  it("stops report traversal on abort before the next batch", async () => {
    const controller = new AbortController();
    const pending = streamAccountExport(identity, "json", { signal: controller.signal });
    while (true) {
      const next = await pending.next();
      if (next.done) throw new Error("Expected report section");
      if (next.value.includes('"reports":[')) break;
    }
    controller.abort();
    await expect(pending.next()).rejects.toMatchObject({ code: "ABORTED" });
    expect(tx.chessReplayReport.findMany).not.toHaveBeenCalled();
  });

  it("requires live authority before valid JSON completion after the final report", async () => {
    tx.chessReplayReport.findMany.mockResolvedValue([
      { id: "last-report", reason: "privacy", note: "My note" },
    ] as never);
    const pending = streamAccountExport(identity, "json");
    let partial = "";
    while (true) {
      const next = await pending.next();
      if (next.done) throw new Error("Expected report row");
      partial += next.value;
      if (next.value.includes('"id":"last-report"')) break;
    }
    tx.session.findFirst.mockResolvedValue(null);
    await expect(pending.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(() => JSON.parse(partial)).toThrow();
  });
});

describe("own uploader moderation decision history export", () => {
  it("exports only own-match statements and strips administrator identity and adapter joins", async () => {
    tx.chessModerationAction.findMany.mockResolvedValue([
      {
        id: "own-match-decision",
        createdAt: new Date("2026-01-03"),
        matchId: "own-match",
        hidden: true,
        reason: "harassment",
        note: "Statement for this uploader",
        actorId: secret,
        Actor: { name: secret },
        Match: { ownerId: "owner", Reports: [{ note: secret }] },
      },
    ] as never);
    const text = await collect();
    const result = JSON.parse(text);
    expect(result.moderationActions).toEqual([
      {
        id: "own-match-decision",
        createdAt: "2026-01-03T00:00:00.000Z",
        matchId: "own-match",
        hidden: true,
        reason: "harassment",
        note: "Statement for this uploader",
      },
    ]);
    expect(text).not.toContain(secret);
    expect(tx.chessModerationAction.findMany).toHaveBeenCalledWith({
      where: { Match: { is: { ownerId: "owner" } }, createdAt: { lte: expect.any(Date) } },
      select: { id: true, createdAt: true, matchId: true, hidden: true, reason: true, note: true },
      orderBy: { id: "asc" },
      take: 50,
    });
  });

  it("pages decisions by match owner rather than privileged actor identity", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({
      id: `a${String(index).padStart(3, "0")}`,
    }));
    tx.chessModerationAction.findMany
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce([{ id: "a999" }] as never);
    expect(JSON.parse(await collect()).moderationActions).toHaveLength(51);
    expect(tx.chessModerationAction.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          Match: { is: { ownerId: "owner" } },
          createdAt: { lte: expect.any(Date) },
          id: { gt: "a049" },
        },
        take: 50,
      }),
    );
    expect(
      tx.chessModerationAction.findMany.mock.calls.every(
        ([args]) => !Reflect.has(args?.where ?? {}, "actorId"),
      ),
    ).toBe(true);
  });

  it("requires live authority before final JSON closure after the final decision", async () => {
    tx.chessModerationAction.findMany.mockResolvedValue([
      { id: "last-decision", note: "Statement" },
    ] as never);
    const pending = streamAccountExport(identity, "json");
    let partial = "";
    while (true) {
      const next = await pending.next();
      if (next.done) throw new Error("Expected decision row");
      partial += next.value;
      if (next.value.includes('"id":"last-decision"')) break;
    }
    tx.session.findFirst.mockResolvedValue(null);
    await expect(pending.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(() => JSON.parse(partial)).toThrow();
  });
});
