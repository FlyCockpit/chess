import { beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB. Each statement returns a tag so the batch is visible.
const slots = vi.hoisted(() => ({ held: 0, atTransaction: [] as number[] }));
const db = vi.hoisted(() => ({
  verification: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
// The cleanup is a lock transaction, so it runs in a lock slot (lock-slots.ts):
// a pass-through that counts the slots held around each transaction.
const lockSlots = vi.hoisted(() => ({
  withLockSlot: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
    slots.held += 1;
    try {
      return await fn();
    } finally {
      slots.held -= 1;
    }
  }),
}));
vi.mock("./lock-slots", () => lockSlots);

const { afterAccountCreate, afterUserUpdate, deleteResetLinksOnActivation, noteVerificationWrite } =
  await import("./account-activation");

const CLEANUP = [
  "setPasswordLinkLock:set-password-link:u1",
  { where: { value: "u1", identifier: { startsWith: "reset-password:" } } },
];

beforeEach(() => {
  vi.clearAllMocks();
  slots.held = 0;
  slots.atTransaction = [];
  db.$executeRaw.mockImplementation(
    (_strings: TemplateStringsArray, key: string) => `setPasswordLinkLock:${key}`,
  );
  db.verification.deleteMany.mockImplementation((args: unknown) => args);
  db.$transaction.mockImplementation(async () => {
    slots.atTransaction.push(slots.held);
    return [];
  });
});

describe("account activation kills leftover reset links", () => {
  it("runs the set-password-link lock, then the reset-link delete, in one transaction after a verifying write", async () => {
    const context = { path: "/verify-email" };
    noteVerificationWrite({ emailVerified: true }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction.mock.calls[0]?.[0]).toEqual(CLEANUP);
    // In a lock slot, released afterwards.
    expect(lockSlots.withLockSlot).toHaveBeenCalledTimes(1);
    expect(slots.atTransaction).toEqual([1]);
    expect(slots.held).toBe(0);
  });

  it("leaves other updates of a verified user alone", async () => {
    const context = { path: "/update-user" };
    noteVerificationWrite({ name: "Ada" }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    // An update that set emailVerified false, or an unverified row, either.
    const unverify = { path: "/admin/update-user" };
    noteVerificationWrite({ emailVerified: false }, unverify);
    await afterUserUpdate({ id: "u1", emailVerified: false }, unverify);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("cleans up a verified row written outside any endpoint context (fail safe)", async () => {
    await afterUserUpdate({ id: "u1", emailVerified: true }, null);
    expect(db.$transaction.mock.calls[0]?.[0]).toEqual(CLEANUP);
  });

  it("cleans up when an IdP identity is linked, never for a credential account", async () => {
    await afterAccountCreate({ userId: "u1", providerId: "credential" });
    expect(db.$transaction).not.toHaveBeenCalled();
    await afterAccountCreate({ userId: "u1", providerId: "sso" });
    expect(db.$transaction.mock.calls[0]?.[0]).toEqual(CLEANUP);
  });

  it("retries, then logs the failure with the user id only and does not fail the activation", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockRejectedValue(new Error("db down"));
    const sleep = vi.fn(async () => {});
    await expect(deleteResetLinksOnActivation("u1", { sleep })).resolves.toBeUndefined();
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Each attempt in its own lock slot, every one released (no slot is held
    // across the backoff).
    expect(lockSlots.withLockSlot).toHaveBeenCalledTimes(3);
    expect(slots.held).toBe(0);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("refused at redemption"), {
      userId: "u1",
      error: "Error: db down",
    });
    errorLog.mockRestore();
  });

  it("succeeds on a retry", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce([]);
    await expect(
      deleteResetLinksOnActivation("u1", { sleep: async () => {} }),
    ).resolves.toBeUndefined();
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});
