import type prismaInstance from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { withChessJobPublication } = await import("./chess-jobs");

beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected owner-lock transaction");
    return run(db);
  });
  db.chessMatch.findUnique.mockResolvedValue({ ownerId: "owner" } as never);
  db.chessMatch.findFirst.mockResolvedValue({ ownerId: "owner", slug: "original" } as never);
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null, banned: false } as never);
  db.$executeRaw.mockResolvedValue(1);
});

describe("match job publication authority", () => {
  it("rechecks owner authority after the credential lock, then publishes inside the transaction", async () => {
    const order: string[] = [];
    db.$executeRaw.mockImplementation((async (sql: TemplateStringsArray) => {
      order.push(sql.join("?").includes("pg_advisory") ? "lock" : "timeout");
      return 1;
    }) as never);
    db.user.findUnique.mockImplementation((async () => {
      order.push("owner");
      return { deletionRequestedAt: null, banned: false } as never;
    }) as never);
    const result = await withChessJobPublication("match", "run", async (assertFresh) => {
      assertFresh();
      order.push("publish");
      return "queued";
    });
    expect(result).toBe("queued");
    expect(order).toEqual(["timeout", "lock", "owner", "publish"]);
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith({
      where: { id: "match", source: "hosted", status: "queued", ownerId: "owner" },
      select: { ownerId: true, slug: true },
    });
  });

  it("never publishes after deletion wins the credential lock", async () => {
    db.user.findUnique.mockResolvedValue({
      deletionRequestedAt: new Date(),
      banned: false,
    } as never);
    const publish = vi.fn();
    expect(await withChessJobPublication("match", "run", publish)).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ownerId: null, slug: `replay-${"a".repeat(32)}` },
    { ownerId: "new-owner", slug: "changed" },
  ])("refuses stale ownership captured before waiting", async (current) => {
    db.chessMatch.findFirst.mockResolvedValue(current as never);
    const publish = vi.fn();
    await withChessJobPublication("match", { purpose: "owner", ownerId: "owner" }, publish);
    expect(publish).not.toHaveBeenCalled();
  });

  it("permits fresh safe public backfill after anonymization without former owner authority", async () => {
    db.chessMatch.findUnique.mockResolvedValue({ ownerId: null } as never);
    db.chessMatch.findFirst.mockResolvedValue({
      ownerId: null,
      slug: `replay-${"a".repeat(32)}`,
    } as never);
    const publish = vi.fn(async () => "public-job");
    expect(await withChessJobPublication("match", { purpose: "public", version: 0 }, publish)).toBe(
      "public-job",
    );
    expect(db.user.findUnique).not.toHaveBeenCalled();
    db.chessMatch.findFirst.mockResolvedValue({ ownerId: null, slug: "unscrubbed" } as never);
    publish.mockClear();
    await withChessJobPublication("match", { purpose: "public", version: 0 }, publish);
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps a stale publisher from writing after a clock jump or suspension", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      await expect(
        withChessJobPublication("match", "run", async (assertFresh) => {
          clock.mockReturnValue(121_000);
          assertFresh();
        }),
      ).rejects.toMatchObject({ message: "Match job publication expired" });
    } finally {
      clock.mockRestore();
    }
  });
});
