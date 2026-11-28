import { describe, expect, it } from "vitest";
import { chessReconcileJobSchema, chessSpectatorJobId } from "./jobs";

describe("spectator job authority", () => {
  const base = { reason: "spectator", matchId: "match", fromPly: 0 };
  it("requires one strict current purpose and refuses ambiguous legacy jobs", () => {
    expect(chessReconcileJobSchema.safeParse(base).success).toBe(false);
    expect(
      chessReconcileJobSchema.safeParse({ ...base, access: { purpose: "public", version: 0 } })
        .success,
    ).toBe(true);
    expect(
      chessReconcileJobSchema.safeParse({
        ...base,
        access: { purpose: "public", version: 0, ownerId: "owner" },
      }).success,
    ).toBe(false);
    expect(
      chessReconcileJobSchema.safeParse({ ...base, access: { purpose: "owner" } }).success,
    ).toBe(false);
  });
  it("deduplicates without sharing public, owner, or stale moderation authority", () => {
    const jobs = [
      chessSpectatorJobId("match", 0, { purpose: "public", version: 0 }),
      chessSpectatorJobId("match", 0, { purpose: "public", version: 1 }),
      chessSpectatorJobId("match", 0, { purpose: "owner", ownerId: "one" }),
      chessSpectatorJobId("match", 0, { purpose: "owner", ownerId: "two" }),
    ];
    expect(new Set(jobs).size).toBe(4);
  });
});
