import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
const { dispatchForActiveOwner, isOwnerActive } = await import("./account-deletion");
const { isAccountDeletionPending } = await import("./account-state");

beforeEach(() => {
  vi.resetAllMocks();
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null, banned: false });
  db.$executeRaw.mockResolvedValue(0);
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
});

describe("durable owner authority", () => {
  it("permits an active account, including an expired temporary ban", async () => {
    expect(await isOwnerActive("u1")).toBe(true);
    db.user.findUnique.mockResolvedValue({
      deletionRequestedAt: null,
      banned: true,
      banExpires: new Date(Date.now() - 1),
    });
    expect(await isOwnerActive("u1")).toBe(true);
  });

  it.each([
    null,
    { deletionRequestedAt: new Date(), banned: false },
    { deletionRequestedAt: null, banned: true, banExpires: null },
    { deletionRequestedAt: "invalid", banned: false },
  ])("fails closed for missing, pending or banned owners", async (user) => {
    db.user.findUnique.mockResolvedValue(user);
    expect(await isOwnerActive("u1")).toBe(false);
  });

  it("fails closed on unavailable storage without exposing the driver error", async () => {
    db.user.findUnique.mockRejectedValue(new Error("private-driver-message"));
    expect(await isOwnerActive("u1")).toBe(false);
  });

  it("treats any non-null projected marker as pending", () => {
    expect(isAccountDeletionPending({ deletionRequestedAt: null })).toBe(false);
    expect(isAccountDeletionPending({ deletionRequestedAt: new Date() })).toBe(true);
    expect(isAccountDeletionPending({ deletionRequestedAt: "bad" })).toBe(true);
  });
});

describe("actual provider dispatch fence", () => {
  it("locks before reading durable authority and starts the request inside the transaction", async () => {
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      order.push(strings.join("?").includes("pg_advisory_xact_lock") ? "lock" : "timeout");
      return 0;
    });
    db.user.findUnique.mockImplementation(async () => {
      order.push("authority");
      return { deletionRequestedAt: null };
    });
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => {
      const result = await run(db);
      order.push("commit");
      return result;
    });
    const response = new Response("ok");
    const dispatch = vi.fn(async () => {
      order.push("request");
      return response;
    });
    expect(await dispatchForActiveOwner("u1", dispatch)).toBe(response);
    expect(order).toEqual(["timeout", "lock", "authority", "request", "commit"]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
      timeout: 30_000,
    });
  });

  it.each([null, { deletionRequestedAt: new Date() }])(
    "never invokes provider fetch for a missing or deletion-pending owner",
    async (user) => {
      db.user.findUnique.mockResolvedValue(user);
      const dispatch = vi.fn(async () => new Response("should not send"));
      await expect(dispatchForActiveOwner("u1", dispatch)).rejects.toThrow("no longer active");
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("cannot start a delayed request after its lock deadline", async () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValue(25_001);
    const dispatch = vi.fn(async () => new Response());
    try {
      await expect(dispatchForActiveOwner("u1", dispatch)).rejects.toThrow("no longer active");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("propagates storage refusal before fetch", async () => {
    db.user.findUnique.mockRejectedValue(new Error("storage unavailable"));
    const dispatch = vi.fn(async () => new Response());
    await expect(dispatchForActiveOwner("u1", dispatch)).rejects.toThrow("storage unavailable");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
