import { createHash } from "node:crypto";
import type { Prisma } from "@cockpit-chess/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
  runnerClaim: {
    findUnique: vi.fn<(args: Prisma.RunnerClaimFindUniqueArgs) => Promise<Row | null>>(),
    findMany: vi.fn<(args: Prisma.RunnerClaimFindManyArgs) => Promise<Array<{ id: string }>>>(),
    count: vi.fn<() => Promise<number>>(),
    create: vi.fn<(args: Prisma.RunnerClaimCreateArgs) => Promise<Row>>(),
    deleteMany: vi.fn(),
    updateMany: vi.fn<(args: Prisma.RunnerClaimUpdateManyArgs) => Promise<{ count: number }>>(),
  },
  session: {
    findFirst: vi.fn<(args: Prisma.SessionFindFirstArgs) => Promise<typeof live | null>>(),
  },
  appSetting: { findUnique: vi.fn() },
  runnerMachine: {
    count: vi.fn(),
    create: vi.fn<(args: Prisma.RunnerMachineCreateArgs) => Promise<typeof machine>>(),
    findFirst: vi.fn<(args: Prisma.RunnerMachineFindFirstArgs) => Promise<typeof machine | null>>(),
  },
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 5 } }));
const { releaseSlots, tryAcquireSlots } = await import("./lock-slots");
const {
  runnerClaimService: service,
  RUNNER_CLAIM_MAX_ROWS,
  RUNNER_CLAIM_CLEANUP_BATCH,
  RUNNER_CLAIM_LIFETIME_MS,
  RunnerClaimNotFoundError,
} = await import("./runner-claim");
const {
  digestRunnerMachineSecret,
  RUNNER_MACHINE_MAX_ACTIVE,
  RunnerMachineLimitError,
  RunnerMachineForbiddenError,
  RunnerMachineSessionRevokedError,
  RunnerMachineInputError,
} = await import("./runner-machine");

const tx = db;
const now = new Date("2026-11-27T22:00:00Z");
const proof = "a1".repeat(32);
const token = "b2".repeat(32);
const session = { userId: "owner1", sessionId: "session1" };
const input = { claimId: "claim1", proof };
type Row = Prisma.RunnerClaimGetPayload<Record<string, never>>;
let row: Row;
const live = {
  id: "session1",
  expiresAt: new Date("2026-12-27"),
  user: {
    id: "owner1",
    email: "private@example.test",
    emailVerified: true,
    banned: false,
    banExpires: null,
    role: "user",
    twoFactorEnabled: false,
    createdAt: new Date("2020-01-01"),
  },
};
const machine = {
  id: "machine1",
  userId: "owner1",
  displayName: "Chess runner",
  credentialDigest: "digest",
  credentialPrefix: "prefix",
  createdAt: now,
  expiresAt: new Date("2026-12-27"),
  revokedAt: null,
  lastSeenAt: null,
  connectionGeneration: 0,
};

beforeEach(() => {
  vi.useFakeTimers({ now });
  vi.resetAllMocks();
  row = {
    id: "claim1",
    tokenDigest: "token-digest",
    proofDigest: createHash("sha256")
      .update(`cockpit-chess:runner-claim:proof:v1\0${proof}`)
      .digest("hex"),
    createdAt: now,
    expiresAt: new Date(now.getTime() + RUNNER_CLAIM_LIFETIME_MS),
    claimedAt: null,
    userId: null,
    sessionId: null,
    machineId: null,
  };
  db.$transaction.mockImplementation(
    async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      if (typeof run !== "function") throw new Error("Expected interactive transaction");
      return run(tx as unknown as Prisma.TransactionClient);
    },
  );
  tx.$executeRaw.mockResolvedValue(0);
  tx.runnerClaim.findUnique.mockImplementation(async () => ({ ...row }));
  tx.runnerClaim.findMany.mockResolvedValue([]);
  tx.runnerClaim.count.mockResolvedValue(0);
  tx.runnerClaim.create.mockImplementation(async () => row);
  tx.runnerClaim.deleteMany.mockResolvedValue({ count: 1 });
  tx.runnerClaim.updateMany.mockImplementation(async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  });
  tx.session.findFirst.mockResolvedValue(live);
  tx.appSetting.findUnique.mockResolvedValue(null);
  tx.runnerMachine.count.mockResolvedValue(0);
  tx.runnerMachine.create.mockResolvedValue(machine);
  tx.runnerMachine.findFirst.mockResolvedValue(machine);
});
afterEach(() => vi.useRealTimers());

function claimed() {
  Object.assign(row, { userId: session.userId, sessionId: session.sessionId, claimedAt: now });
}

describe("bounded runner claim creation", () => {
  it("stores only independently purpose-bound digests and returns a ten-minute URL token", async () => {
    const result = await service.begin({ proof });
    expect(result).toMatchObject({
      claimId: "claim1",
      expiresAt: row.expiresAt.toISOString(),
      pollIntervalMs: 2000,
    });
    expect(result.claimToken).toMatch(/^[0-9a-f]{64}$/);
    const data = tx.runnerClaim.create.mock.calls[0]?.[0].data;
    expect(data).toEqual({
      tokenDigest: createHash("sha256")
        .update(`cockpit-chess:runner-claim:token:v1\0${result.claimToken}`)
        .digest("hex"),
      proofDigest: row.proofDigest,
      expiresAt: row.expiresAt,
    });
    expect(JSON.stringify(data)).not.toContain(proof);
    expect(JSON.stringify(data)).not.toContain(result.claimToken);
    expect(tx.runnerMachine.create).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15000,
      maxWait: 2000,
      isolationLevel: "ReadCommitted",
    });
  });

  it("uses one cross-replica capacity lock, bounds expiry cleanup and deletes only expired selected IDs", async () => {
    tx.runnerClaim.findMany.mockResolvedValue([{ id: "expired1" }] as Row[]);
    await service.begin({ proof });
    expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe("runner-claim:capacity:v1");
    expect(tx.runnerClaim.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: RUNNER_CLAIM_CLEANUP_BATCH,
      select: { id: true },
    });
    expect(tx.runnerClaim.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["expired1"] }, expiresAt: { lte: now } },
    });
  });

  it.each([RUNNER_CLAIM_MAX_ROWS, undefined, -1, NaN, 1.5])(
    "fails closed on a full or invalid row count %s",
    async (count) => {
      tx.runnerClaim.count.mockResolvedValue(count as number);
      await expect(service.begin({ proof })).rejects.toBeInstanceOf(RunnerMachineLimitError);
      expect(tx.runnerClaim.create).not.toHaveBeenCalled();
    },
  );

  it.each(["", "A1".repeat(32), "a".repeat(63), `${proof}\n`])(
    "rejects malformed proofs before IO %#",
    async (value) => {
      await expect(service.begin({ proof: value })).rejects.toBeInstanceOf(RunnerMachineInputError);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it("refuses overload before opening or queuing a transaction and releases slots on errors", async () => {
    expect(tryAcquireSlots(4)).toBe(true);
    try {
      await expect(service.begin({ proof })).rejects.toBeInstanceOf(RunnerMachineLimitError);
    } finally {
      releaseSlots(4);
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    tx.runnerClaim.create.mockRejectedValueOnce(new Error("storage"));
    await expect(service.begin({ proof })).rejects.toThrow("storage");
    expect(tryAcquireSlots(4)).toBe(true);
    releaseSlots(4);
  });
});

describe("first eligible browser claims the run", () => {
  it("takes the E1 credential lock before the claim lock and atomically binds the original session", async () => {
    await expect(service.claim(session, token)).resolves.toEqual({ claimed: true });
    expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe("cli-credentials:owner1");
    expect(tx.$executeRaw.mock.calls[1]?.[1]).toMatch(/^runner-claim:/);
    expect(tx.runnerClaim.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: row.id, userId: null, expiresAt: { gt: now } },
      data: { userId: "owner1", sessionId: "session1", claimedAt: now },
    });
    expect(tx.runnerMachine.create).not.toHaveBeenCalled();
    expect(tx.session.findFirst).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tx.runnerClaim.findUnique.mock.calls)).not.toContain(token);
  });

  it("retries for the same account without replacing the original approval session", async () => {
    claimed();
    await expect(service.claim({ ...session, sessionId: "another-tab" }, token)).resolves.toEqual({
      claimed: true,
    });
    expect(tx.runnerClaim.updateMany).not.toHaveBeenCalled();
    expect(tx.session.findFirst.mock.calls.map((args) => args[0]?.where?.id)).toEqual([
      "another-tab",
      "session1",
      "another-tab",
    ]);
  });

  it("refuses a competing account without exposing identity or rebinding", async () => {
    claimed();
    await expect(
      service.claim({ userId: "foreign", sessionId: "s2" }, token),
    ).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
    expect(tx.runnerClaim.updateMany).not.toHaveBeenCalled();
    expect(tx.runnerMachine.create).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired", "original-session-gone", "revoked-machine", "cas-lost"])(
    "refuses %s",
    async (mode) => {
      if (mode === "missing") tx.runnerClaim.findUnique.mockResolvedValue(null);
      if (mode === "expired") row.expiresAt = now;
      if (mode === "original-session-gone") {
        claimed();
        tx.session.findFirst.mockResolvedValueOnce(live).mockResolvedValueOnce(null);
      }
      if (mode === "revoked-machine") {
        claimed();
        row.machineId = "machine1";
        tx.runnerMachine.findFirst.mockResolvedValue(null);
      }
      if (mode === "cas-lost") tx.runnerClaim.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.claim(session, token)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
    },
  );

  it.each([
    [25, 0],
    [24, 1],
    [0, 25],
  ])("caps owner machines plus unexchanged claims (%s + %s)", async (active, pending) => {
    tx.runnerMachine.count.mockResolvedValue(active);
    tx.runnerClaim.count.mockResolvedValue(pending);
    expect(active + pending).toBe(RUNNER_MACHINE_MAX_ACTIVE);
    await expect(service.claim(session, token)).rejects.toBeInstanceOf(RunnerMachineLimitError);
    expect(tx.runnerClaim.updateMany).not.toHaveBeenCalled();
  });

  it.each(["unverified", "banned", "2fa", "session-gone"])(
    "reuses fresh E1 authority for %s",
    async (mode) => {
      tx.session.findFirst.mockResolvedValue(
        mode === "session-gone"
          ? null
          : {
              ...live,
              user: {
                ...live.user,
                emailVerified: mode !== "unverified",
                banned: mode === "banned",
                role: mode === "2fa" ? "admin" : "user",
              },
            },
      );
      await expect(service.claim(session, token)).rejects.toBeInstanceOf(
        mode === "session-gone" ? RunnerMachineSessionRevokedError : RunnerMachineForbiddenError,
      );
      expect(tx.runnerClaim.updateMany).not.toHaveBeenCalled();
    },
  );
});

describe("CLI proof poll and idempotent exchange", () => {
  it("only returns pending until claimed; exchange cannot mint from an unclaimed token", async () => {
    await expect(service.poll(input)).resolves.toEqual({ status: "pending" });
    await expect(service.exchange(input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
    expect(tx.session.findFirst).not.toHaveBeenCalled();
    expect(tx.runnerMachine.create).not.toHaveBeenCalled();
  });

  it.each(["c3".repeat(32), token])(
    "refuses a stolen URL or wrong proof before owner IO %#",
    async (wrong) => {
      claimed();
      for (const action of ["poll", "exchange"] as const)
        await expect(service[action]({ ...input, proof: wrong })).rejects.toBeInstanceOf(
          RunnerClaimNotFoundError,
        );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.session.findFirst).not.toHaveBeenCalled();
      expect(tx.runnerMachine.create).not.toHaveBeenCalled();
    },
  );

  it("gives claimant identity only to proof holder and never gives a credential on poll", async () => {
    claimed();
    await expect(service.poll(input)).resolves.toEqual({
      status: "claimed",
      claimant: { email: live.user.email },
      controlPath: "/en-US/settings/cli",
    });
    expect(tx.session.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "session1",
      userId: "owner1",
      origin: "sign-in",
      impersonatedBy: null,
    });
  });

  it("lost exchange responses replay the same secret and binding, with only its digest stored", async () => {
    claimed();
    const first = await service.exchange(input);
    const second = await service.exchange(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ machineId: "machine1", claimant: { email: live.user.email } });
    expect(first.credential).toMatch(/^cockpit_chess_runner_[0-9a-f]{64}$/);
    expect(tx.runnerMachine.create).toHaveBeenCalledTimes(1);
    expect(tx.runnerClaim.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.runnerMachine.create.mock.calls[0]?.[0]?.data).toMatchObject({
      credentialDigest: digestRunnerMachineSecret(first.credential),
    });
    expect(JSON.stringify(tx.runnerMachine.create.mock.calls)).not.toContain(first.credential);
    expect(tx.runnerMachine.findFirst).toHaveBeenCalledWith({
      where: {
        id: "machine1",
        userId: "owner1",
        revokedAt: null,
        expiresAt: { gt: now },
        credentialDigest: digestRunnerMachineSecret(first.credential),
      },
      select: { id: true, expiresAt: true },
    });
    // Approval token and proof never appear in persisted bindings.
    expect(JSON.stringify(tx.runnerClaim.updateMany.mock.calls)).not.toContain(proof);
  });

  it.each(["poll", "exchange"] as const)(
    "%s refuses missing, expired, revoked, banned or reset authority",
    async (action) => {
      claimed();
      row.machineId = "machine1";
      tx.runnerMachine.findFirst.mockResolvedValueOnce(null);
      await expect(service[action](input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
      tx.session.findFirst.mockResolvedValue(null);
      await expect(service[action](input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
      tx.session.findFirst.mockResolvedValue({ ...live, user: { ...live.user, banned: true } });
      await expect(service[action](input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
      row.expiresAt = now;
      await expect(service[action](input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
      expect(tx.runnerMachine.create).not.toHaveBeenCalled();
    },
  );

  it("rechecks the same owner after waiting on the credential lock", async () => {
    claimed();
    tx.runnerClaim.findUnique
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, userId: "changed-owner" });
    await expect(service.exchange(input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
    expect(tx.runnerMachine.create).not.toHaveBeenCalled();
  });

  it("refuses exchange when session disappears after mint or expiry passes during mint", async () => {
    claimed();
    tx.session.findFirst
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(null);
    await expect(service.exchange(input)).rejects.toBeInstanceOf(RunnerMachineSessionRevokedError);
    expect(tx.runnerClaim.updateMany).not.toHaveBeenCalled();
    tx.session.findFirst.mockResolvedValue(live);
    tx.runnerMachine.create.mockImplementationOnce(async () => {
      vi.setSystemTime(row.expiresAt);
      return machine;
    });
    tx.runnerClaim.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.exchange(input)).rejects.toBeInstanceOf(RunnerClaimNotFoundError);
  });
});
