import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const { digestRunnerMachineSecret, RUNNER_MACHINE_TOKEN_PREFIX } = await import(
  "@cockpit-chess/auth/runner-machine"
);
const { resolveRunnerMachineCredential } = await import("./runner-session");

const NOW = new Date("2026-11-27T12:00:00Z");
const secret = RUNNER_MACHINE_TOKEN_PREFIX + "ab".repeat(32);

function machineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    userId: "u1",
    displayName: "Laptop",
    credentialPrefix: "prefix",
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    lastSeenAt: null,
    connectionGeneration: 7,
    User: { id: "u1", emailVerified: true, banned: false, banExpires: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockReset(db);
  db.runnerMachine.findUnique.mockResolvedValue(machineRow() as never);
});
afterEach(() => vi.useRealTimers());

describe("runner-only credential resolver", () => {
  it("returns a purpose-scoped machine identity, without a Better-Auth session", async () => {
    const identity = await resolveRunnerMachineCredential(`Bearer ${secret}`);
    expect(identity).toEqual({
      machineId: "m1",
      userId: "u1",
      connectionGeneration: 7,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect(identity).not.toHaveProperty("session");
    expect(db.runnerMachine.findUnique).toHaveBeenCalledWith({
      where: { credentialDigest: digestRunnerMachineSecret(secret) },
      select: expect.objectContaining({
        User: {
          select: {
            id: true,
            emailVerified: true,
            banned: true,
            banExpires: true,
            deletionRequestedAt: true,
          },
        },
      }),
    });
    expect(JSON.stringify(db.runnerMachine.findUnique.mock.calls)).not.toContain(secret);
    expect(db.session.findUnique).not.toHaveBeenCalled();
    expect(db.runnerMachine.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a runner whose owning account is pending deletion", async () => {
    db.runnerMachine.findUnique.mockResolvedValue(
      machineRow({ User: { id: "u1", emailVerified: true, deletionRequestedAt: NOW } }) as never,
    );
    expect(await resolveRunnerMachineCredential(`Bearer ${secret}`)).toBeNull();
  });

  it.each([
    undefined,
    "",
    "Bearer",
    `Basic ${secret}`,
    "Bearer browser-session",
    "Bearer device-token",
    "Bearer cockpit_chess_" + "ab".repeat(32),
    `Bearer ${secret} extra`,
    `Bearer ${secret}\n`,
    `Bearer ${secret} `,
    ` Bearer ${secret}`,
    `Bearer\t${secret}`,
    `Bearer  ${secret}`,
    "Bearer " + RUNNER_MACHINE_TOKEN_PREFIX + "AB".repeat(32),
  ])("rejects missing, malformed or other-purpose credentials before IO %#", async (header) => {
    await expect(resolveRunnerMachineCredential(header)).resolves.toBeNull();
    expect(db.runnerMachine.findUnique).not.toHaveBeenCalled();
    expect(db.session.findUnique).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("accepts a case-insensitive bearer scheme", async () => {
    await expect(resolveRunnerMachineCredential(`bearer ${secret}`)).resolves.toHaveProperty(
      "machineId",
      "m1",
    );
  });

  it.each([
    { revokedAt: NOW },
    { expiresAt: NOW },
    { expiresAt: new Date(NOW.getTime() - 1) },
    { User: null },
    { User: { id: "u1", emailVerified: false, banned: false, banExpires: null } },
    { User: { id: "u1", emailVerified: true, banned: true, banExpires: null } },
    {
      User: {
        id: "u1",
        emailVerified: true,
        banned: true,
        banExpires: new Date(NOW.getTime() + 1000),
      },
    },
  ])("rejects expired/revoked/ineligible authority %#", async (overrides) => {
    db.runnerMachine.findUnique.mockResolvedValue(machineRow(overrides) as never);
    await expect(resolveRunnerMachineCredential(`Bearer ${secret}`)).resolves.toBeNull();
  });

  it("permits a lapsed temporary ban", async () => {
    db.runnerMachine.findUnique.mockResolvedValue(
      machineRow({
        User: {
          id: "u1",
          emailVerified: true,
          banned: true,
          banExpires: new Date(NOW.getTime() - 1),
        },
      }) as never,
    );
    await expect(resolveRunnerMachineCredential(`Bearer ${secret}`)).resolves.toHaveProperty(
      "userId",
      "u1",
    );
  });

  it("rechecks durable machine authority on every action", async () => {
    await expect(resolveRunnerMachineCredential(`Bearer ${secret}`)).resolves.toHaveProperty(
      "machineId",
      "m1",
    );
    db.runnerMachine.findUnique.mockResolvedValue(machineRow({ revokedAt: NOW }) as never);
    await expect(resolveRunnerMachineCredential(`Bearer ${secret}`)).resolves.toBeNull();
    expect(db.runnerMachine.findUnique).toHaveBeenCalledTimes(2);
  });

  it("fails closed for unknown machines or unavailable storage", async () => {
    db.runnerMachine.findUnique.mockResolvedValueOnce(null);
    await expect(resolveRunnerMachineCredential(`Bearer ${secret}`)).resolves.toBeNull();
    db.runnerMachine.findUnique.mockRejectedValueOnce(new Error("lookup unavailable"));
    await expect(resolveRunnerMachineCredential(`Bearer ${secret}`)).resolves.toBeNull();
  });
});
