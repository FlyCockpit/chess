import { beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB: the default client and an interactive transaction's `tx`
// are separate mocks, so a test sees which one each statement went to.
const db = vi.hoisted(() => ({
  verification: { deleteMany: vi.fn() },
  $executeRaw: vi.fn(),
}));
const tx = vi.hoisted(() => ({
  verification: { deleteMany: vi.fn() },
  $executeRaw: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));

const { deleteResetLinks, lockSetPasswordLinks, setPasswordLinkLockKey } = await import(
  "./set-password-link-lock"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lockSetPasswordLinks", () => {
  it("is a transaction-scoped advisory lock keyed by the user, on the default client", () => {
    lockSetPasswordLinks("u9");
    const [strings, key] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("set-password-link:u9");
    expect(key).toBe(setPasswordLinkLockKey("u9"));
  });

  it("runs inside an interactive transaction when given its tx", () => {
    lockSetPasswordLinks("u9", tx as never);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    const [strings, key] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("set-password-link:u9");
  });
});

describe("deleteResetLinks", () => {
  const where = { where: { value: "u9", identifier: { startsWith: "reset-password:" } } };

  it("deletes every reset link of the user, on the default client", () => {
    deleteResetLinks("u9");
    expect(db.verification.deleteMany).toHaveBeenCalledWith(where);
  });

  it("runs inside an interactive transaction when given its tx", () => {
    deleteResetLinks("u9", tx as never);
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    expect(tx.verification.deleteMany).toHaveBeenCalledWith(where);
  });
});
