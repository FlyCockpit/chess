import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerMachineTransaction } from "./runner-machine";

const db = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  session: { findFirst: vi.fn() },
  appSetting: { findUnique: vi.fn() },
  runnerMachine: { count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const tx = db as unknown as RunnerMachineTransaction;
const {
  digestRunnerMachineSecret,
  mintRunnerMachineForSession,
  mintRunnerMachineInTransaction,
  parseRunnerMachineSecret,
  revokeRunnerMachinesInTransaction,
  runnerMachinePublicSelect,
  RUNNER_MACHINE_DEFAULT_LIFETIME_MS,
  RUNNER_MACHINE_DIGEST_DOMAIN,
  RUNNER_MACHINE_MAX_ACTIVE,
  RUNNER_MACHINE_REVOCATION_CHANNEL,
  RUNNER_MACHINE_TOKEN_PREFIX,
  RunnerMachineForbiddenError,
  RunnerMachineInputError,
  RunnerMachineLimitError,
  RunnerMachineSessionRevokedError,
} = await import("./runner-machine");

const NOW = new Date("2026-11-27T12:00:00Z");
const session = { userId: "u1", sessionId: "s1" };
const secret = RUNNER_MACHINE_TOKEN_PREFIX + "ab".repeat(32);

function liveSession(user: Record<string, unknown> = {}) {
  return {
    id: "s1",
    user: {
      id: "u1",
      emailVerified: true,
      banned: false,
      banExpires: null,
      role: "user",
      twoFactorEnabled: false,
      createdAt: new Date("2026-01-01"),
      ...user,
    },
  };
}

const machine = {
  id: "m1",
  userId: "u1",
  displayName: "Laptop",
  credentialPrefix: secret.slice(0, RUNNER_MACHINE_TOKEN_PREFIX.length + 8),
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + RUNNER_MACHINE_DEFAULT_LIFETIME_MS),
  revokedAt: null,
  lastSeenAt: null,
  connectionGeneration: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  db.$executeRaw.mockResolvedValue(0);
  db.session.findFirst.mockResolvedValue(liveSession() as never);
  db.appSetting.findUnique.mockResolvedValue(null);
  db.runnerMachine.count.mockResolvedValue(0);
  db.runnerMachine.create.mockResolvedValue(machine);
  db.runnerMachine.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(
    async (fn: (client: RunnerMachineTransaction) => Promise<unknown>) => {
      if (typeof fn !== "function") throw new Error("Expected interactive transaction");
      return fn(tx);
    },
  );
});

afterEach(() => vi.useRealTimers());

describe("runner secret purpose and encoding", () => {
  it("binds a canonical token to the runner-only SHA256 domain", () => {
    expect(parseRunnerMachineSecret(secret)).toBe(secret);
    const digest = digestRunnerMachineSecret(secret);
    expect(digest).toBe(
      createHash("sha256")
        .update(RUNNER_MACHINE_DIGEST_DOMAIN + secret)
        .digest("hex"),
    );
    expect(digest).not.toBe(createHash("sha256").update(secret).digest("hex"));
  });

  it.each([
    "",
    "device-token",
    "cockpit_chess_" + "ab".repeat(32),
    RUNNER_MACHINE_TOKEN_PREFIX + "ab".repeat(31),
    RUNNER_MACHINE_TOKEN_PREFIX + "ab".repeat(33),
    RUNNER_MACHINE_TOKEN_PREFIX + "AB".repeat(32),
    RUNNER_MACHINE_TOKEN_PREFIX + "z".repeat(64),
    ` ${secret}`,
    `${secret} `,
    `${secret}\n`,
    `${secret}\r\n`,
  ])("rejects malformed or other-purpose credential %#", (token) => {
    expect(parseRunnerMachineSecret(token)).toBeNull();
    expect(digestRunnerMachineSecret(token)).toBeNull();
  });
});

describe("internal runner enrollment", () => {
  it("mints within one transaction, after the shared lock and live authority reads", async () => {
    const { machine: result, secret: minted } = await mintRunnerMachineForSession(session, {
      displayName: " Laptop ",
    });
    expect(result).toEqual(machine);
    expect(minted).toMatch(/^cockpit_chess_runner_[0-9a-f]{64}$/);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
      isolationLevel: "ReadCommitted",
    });
    expect(db.$executeRaw.mock.calls[0]?.slice(1)).toEqual(["cli-credentials:u1"]);
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.session.findFirst.mock.invocationCallOrder[0] ?? 0,
    );
    expect(db.session.findFirst).toHaveBeenCalledWith({
      where: {
        id: "s1",
        userId: "u1",
        expiresAt: { gt: NOW },
        origin: "sign-in",
        impersonatedBy: null,
      },
      select: expect.objectContaining({ user: expect.any(Object) }),
    });
    expect(db.appSetting.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      db.runnerMachine.create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(db.runnerMachine.count).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null, expiresAt: { gt: NOW } },
    });
    const creation = db.runnerMachine.create.mock.calls[0]?.[0];
    expect(creation).toEqual({
      data: {
        userId: "u1",
        displayName: "Laptop",
        credentialDigest: digestRunnerMachineSecret(minted),
        credentialPrefix: minted.slice(0, RUNNER_MACHINE_TOKEN_PREFIX.length + 8),
        expiresAt: new Date(NOW.getTime() + RUNNER_MACHINE_DEFAULT_LIFETIME_MS),
      },
      select: runnerMachinePublicSelect,
    });
    expect(JSON.stringify(creation)).not.toContain(minted);
    expect(runnerMachinePublicSelect).not.toHaveProperty("credentialDigest");
    expect(result).not.toHaveProperty("credentialDigest");
  });

  it("supports claim composition without opening a nested transaction", async () => {
    const expiresAt = new Date(NOW.getTime() + 60_000);
    await mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop", expiresAt });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.runnerMachine.create.mock.calls[0]?.[0].data.expiresAt).toEqual(expiresAt);
  });

  it("refuses authority removed while waiting for the credential lock", async () => {
    db.$executeRaw.mockImplementationOnce(async () => {
      db.session.findFirst.mockResolvedValue(null);
      return 0;
    });
    await expect(
      mintRunnerMachineForSession(session, { displayName: "Laptop" }),
    ).rejects.toMatchObject({ name: "RunnerMachineSessionRevokedError", code: "UNAUTHORIZED" });
    expect(db.runnerMachine.create).not.toHaveBeenCalled();
  });

  it("enforces the active-machine cap under the same lock", async () => {
    db.runnerMachine.count.mockResolvedValue(RUNNER_MACHINE_MAX_ACTIVE);
    await expect(
      mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop" }),
    ).rejects.toBeInstanceOf(RunnerMachineLimitError);
    expect(db.runnerMachine.create).not.toHaveBeenCalled();
  });

  it.each([undefined, -1, NaN, 1.5])(
    "fails closed on an invalid active-machine count %s",
    async (count) => {
      db.runnerMachine.count.mockResolvedValue(count);
      await expect(
        mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop" }),
      ).rejects.toBeInstanceOf(RunnerMachineLimitError);
      expect(db.runnerMachine.create).not.toHaveBeenCalled();
    },
  );

  it("accepts a canonical internally derived claim credential and stores only its digest", async () => {
    const result = await mintRunnerMachineInTransaction(
      tx,
      session,
      { displayName: "Laptop" },
      secret,
    );
    expect(result.secret).toBe(secret);
    expect(db.runnerMachine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ credentialDigest: digestRunnerMachineSecret(secret) }),
      select: runnerMachinePublicSelect,
    });
    expect(JSON.stringify(db.runnerMachine.create.mock.calls)).not.toContain(secret);
  });

  it("rejects a malformed internally derived claim credential", async () => {
    await expect(
      mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop" }, "general-api-key"),
    ).rejects.toBeInstanceOf(RunnerMachineInputError);
    expect(db.runnerMachine.create).not.toHaveBeenCalled();
  });

  it.each([
    { emailVerified: false },
    { banned: true, banExpires: null },
    { banned: true, banExpires: new Date(NOW.getTime() + 1000) },
    { role: "admin" },
  ])("rejects ineligible owner %#", async (user) => {
    db.session.findFirst.mockResolvedValue(liveSession(user) as never);
    await expect(
      mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop" }),
    ).rejects.toBeInstanceOf(RunnerMachineForbiddenError);
    expect(db.runnerMachine.create).not.toHaveBeenCalled();
  });

  it("reads fresh public forced-2FA settings instead of a cached gate", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "true" } as never);
    await expect(
      mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop" }),
    ).rejects.toBeInstanceOf(RunnerMachineForbiddenError);
    expect(db.appSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "force2faPublicUsers" },
      select: { value: true },
    });
  });

  it.each([
    { role: "admin", twoFactorEnabled: true },
    { role: "admin", createdAt: new Date(NOW.getTime() - 60_000) },
    { banned: true, banExpires: new Date(NOW.getTime() - 1) },
  ])("uses shared 2FA grace and expired-ban predicates %#", async (user) => {
    db.session.findFirst.mockResolvedValue(liveSession(user) as never);
    await expect(
      mintRunnerMachineInTransaction(tx, session, { displayName: "Laptop" }),
    ).resolves.toHaveProperty("machine.id", "m1");
  });

  it.each([
    { displayName: " " },
    { displayName: "x".repeat(101) },
    { displayName: "Laptop\nHome" },
    { displayName: "Laptop\rHome" },
    { displayName: "Laptop\r\nHome" },
    { displayName: "Laptop", expiresAt: NOW },
    { displayName: "Laptop", expiresAt: new Date(NOW.getTime() - 1) },
    { displayName: "Laptop", expiresAt: new Date(Number.NaN) },
  ])("rejects invalid finite enrollment input %#", async (input) => {
    await expect(mintRunnerMachineInTransaction(tx, session, input)).rejects.toBeInstanceOf(
      RunnerMachineInputError,
    );
    expect(db.runnerMachine.create).not.toHaveBeenCalled();
  });

  it("does not return a secret when the transaction fails to commit", async () => {
    db.$transaction.mockImplementationOnce(async (fn) => {
      if (typeof fn !== "function") throw new Error("Expected interactive transaction");
      await fn(tx);
      throw new Error("commit failed");
    });
    await expect(mintRunnerMachineForSession(session, { displayName: "Laptop" })).rejects.toThrow(
      "commit failed",
    );
  });

  it("rolls back authority if the browser session disappears during insertion", async () => {
    db.runnerMachine.create.mockImplementationOnce(async () => {
      db.session.findFirst.mockResolvedValue(null);
      return machine;
    });
    await expect(
      mintRunnerMachineForSession(session, { displayName: "Laptop" }),
    ).rejects.toBeInstanceOf(RunnerMachineSessionRevokedError);
    expect(db.runnerMachine.create).toHaveBeenCalledTimes(1);
  });

  it("rechecks fresh 2FA policy before returning the minted secret", async () => {
    db.runnerMachine.create.mockImplementationOnce(async () => {
      db.appSetting.findUnique.mockResolvedValue({ value: "true" });
      return machine;
    });
    await expect(
      mintRunnerMachineForSession(session, { displayName: "Laptop" }),
    ).rejects.toBeInstanceOf(RunnerMachineForbiddenError);
  });

  it("exposes stable server error codes", () => {
    expect(new RunnerMachineSessionRevokedError().code).toBe("UNAUTHORIZED");
    expect(new RunnerMachineLimitError().code).toBe("TOO_MANY_REQUESTS");
    expect(new RunnerMachineForbiddenError().code).toBe("FORBIDDEN");
  });
});

describe("transactional runner revocation", () => {
  it("refuses an empty scoped ID instead of revoking every machine", async () => {
    await expect(revokeRunnerMachinesInTransaction(tx, "u1", "")).rejects.toBeInstanceOf(
      RunnerMachineInputError,
    );
    expect(db.runnerMachine.updateMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([undefined, "m1"])(
    "scopes durable revocation and notifies only IDs (%s)",
    async (machineId) => {
      await expect(revokeRunnerMachinesInTransaction(tx, "u1", machineId)).resolves.toBe(1);
      expect(db.runnerMachine.updateMany).toHaveBeenCalledWith({
        where: { userId: "u1", ...(machineId ? { id: machineId } : {}), revokedAt: null },
        data: { revokedAt: NOW, connectionGeneration: { increment: 1 } },
      });
      const [query, channel, payload] = db.$executeRaw.mock.calls[0] ?? [];
      expect((query as TemplateStringsArray).join("?")).toBe("SELECT pg_notify(?, ?)");
      expect(channel).toBe(RUNNER_MACHINE_REVOCATION_CHANNEL);
      expect(JSON.parse(String(payload))).toEqual({
        userId: "u1",
        ...(machineId ? { machineId } : {}),
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it("returns zero on repeat/foreign revoke, still prompting socket revalidation", async () => {
    db.runnerMachine.updateMany.mockResolvedValue({ count: 0 });
    await expect(revokeRunnerMachinesInTransaction(tx, "u1", "foreign")).resolves.toBe(0);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("propagates notification failure so the enclosing transaction rolls back", async () => {
    db.$executeRaw.mockRejectedValue(new Error("notify unavailable"));
    await expect(revokeRunnerMachinesInTransaction(tx, "u1")).rejects.toThrow("notify unavailable");
  });
});
