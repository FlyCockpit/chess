import type { Prisma } from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const { Prisma } = await import("../../../db/prisma/generated/client");
  return { default: mockDeep(), Prisma };
});
vi.mock("@cockpit-chess/env/shared", () => ({ env: {} }));
vi.mock("@cockpit-chess/queue", () => ({ redisConnection: {} }));
vi.mock("@cockpit-chess/queue/chess-job-registry", () => ({ purgeChessJobs: vi.fn() }));
vi.mock("@cockpit-chess/auth/account-deletion-verifications", () => ({
  deleteAccountVerifications: vi.fn(),
}));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({ lockCliCredentials: vi.fn() }));
vi.mock("@cockpit-chess/auth/lock-slots", () => ({ withLockSlot: (run: () => unknown) => run() }));
vi.mock("@cockpit-chess/auth/set-password-link-lock", () => ({ lockSetPasswordLinks: vi.fn() }));
vi.mock("./chess-anonymization", () => ({ anonymizePublishedReplayBatch: vi.fn() }));
vi.mock("./chess-models", () => ({ getCachedModelCatalog: vi.fn().mockReturnValue(null) }));

const { default: prisma } = await import("@cockpit-chess/db");
const { deleteAccountVerifications } = await import(
  "@cockpit-chess/auth/account-deletion-verifications"
);
const { anonymizePublishedReplayBatch } = await import("./chess-anonymization");
const { cleanupAccountDeletion } = await import("./account-deletion-cleanup");
const db = vi.mocked(prisma);
const tx = mockDeep<Prisma.TransactionClient>();
const resources = {
  record: vi.fn(),
  keyUseStopped: vi.fn(),
  runnerUseStopped: vi.fn(),
  purgeJobs: vi.fn(),
  retireKeyState: vi.fn(),
};
const user = {
  id: "victim",
  email: "victim@example.test",
  deletionRequestedAt: new Date(Date.now() - 600_000),
  deletionState: "pending",
  deletionCursor: null,
};
function phase(value: string, extra = {}) {
  const cleaning = ["stopping", "matches", "verifications", "finalizing"].includes(value);
  tx.user.findUnique.mockResolvedValue({
    ...user,
    deletionState: cleaning ? "cleaning" : value,
    deletionCursor: cleaning ? JSON.stringify({ phase: value, afterId: null }) : null,
    ...extra,
  } as never);
}
beforeEach(() => {
  vi.clearAllMocks();
  mockReset(tx);
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected interactive transaction");
    return run(tx);
  });
  phase("pending");
  resources.record.mockResolvedValue(undefined);
  resources.keyUseStopped.mockResolvedValue(true);
  resources.runnerUseStopped.mockResolvedValue(true);
  resources.purgeJobs.mockResolvedValue(true);
  resources.retireKeyState.mockResolvedValue(undefined);
  tx.chessMatch.findMany.mockResolvedValue([]);
  tx.chessMatch.count.mockResolvedValue(0);
  tx.runnerMachine.findMany.mockResolvedValue([]);
  vi.mocked(deleteAccountVerifications).mockResolvedValue(0);
});

describe("resumable account erasure", () => {
  it("does not touch an active account or recreate an erased account", async () => {
    phase("active", { deletionRequestedAt: null });
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "active",
    });
    tx.user.findUnique.mockResolvedValue(null);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: true,
      phase: "complete",
    });
    expect(resources.record).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it.each(["pending", "stopping", "matches", "verifications", "finalizing"])(
    "keeps %s pending when durable external suppression cannot be written",
    async (state) => {
      phase(state);
      resources.record.mockRejectedValueOnce(new Error("register unavailable"));
      await expect(cleanupAccountDeletion(user.id, resources)).rejects.toMatchObject({
        message: "register unavailable",
      });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();
      expect(tx.chessMatch.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("refuses an unknown phase instead of skipping its resource checks", async () => {
    phase("unsupported");
    await expect(cleanupAccountDeletion(user.id, resources)).rejects.toMatchObject({
      message: "Unsupported deletion phase",
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("settles active runner commands before starting the stop-evidence phase", async () => {
    tx.chessMatch.findMany.mockResolvedValue([{ id: "running", source: "runner" }] as never);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "stopping",
    });
    expect(tx.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          terminalCause: "owner-delete",
          runToken: null,
          runnerGeneration: null,
        }),
      }),
    );
    expect(tx.runnerCommand.updateMany).toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("keeps a recent request pending without trusting an empty restarted lease store", async () => {
    phase("stopping", { deletionRequestedAt: new Date() });
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "stopping",
    });
    expect(resources.keyUseStopped).not.toHaveBeenCalled();
  });

  it.each(["keyUseStopped", "runnerUseStopped"] as const)(
    "requires positive %s evidence and propagates storage uncertainty",
    async (resource) => {
      phase("stopping");
      resources[resource].mockResolvedValueOnce(false);
      expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
        complete: false,
        phase: "stopping",
      });
      resources[resource].mockRejectedValueOnce(new Error("store unavailable"));
      await expect(cleanupAccountDeletion(user.id, resources)).rejects.toMatchObject({
        message: "store unavailable",
      });
      expect(tx.user.delete).not.toHaveBeenCalled();
    },
  );

  it("does not detach a retained match before active jobs and their results are gone", async () => {
    phase("matches");
    tx.chessMatch.findMany.mockResolvedValue([{ id: "public", published: true }] as never);
    resources.purgeJobs.mockResolvedValueOnce(false);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "matches",
    });
    expect(anonymizePublishedReplayBatch).not.toHaveBeenCalled();
    expect(tx.runnerCommand.deleteMany).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("scrubs only the published IDs whose duplicate payloads and jobs were removed", async () => {
    phase("matches");
    tx.chessMatch.findMany.mockResolvedValue([
      { id: "public", published: true },
      { id: "private", published: false },
    ] as never);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "verifications",
    });
    expect(tx.runnerCommand.deleteMany).toHaveBeenCalledWith({ where: { matchId: "public" } });
    expect(tx.runnerEvent.deleteMany).toHaveBeenCalledWith({ where: { matchId: "public" } });
    expect(tx.chessMatch.deleteMany).toHaveBeenCalledWith({
      where: { id: "private", ownerId: user.id, published: false },
    });
    expect(anonymizePublishedReplayBatch).toHaveBeenCalledWith(tx, user.id, undefined, new Set(), [
      "public",
    ]);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("retries Verification pages before deleting machines and their lookup IDs", async () => {
    phase("verifications");
    vi.mocked(deleteAccountVerifications).mockResolvedValueOnce(100);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "verifications",
    });
    expect(tx.runnerMachine.deleteMany).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("checks the final inventory again and reports complete only after User deletion", async () => {
    phase("finalizing");
    tx.chessMatch.count.mockResolvedValueOnce(1);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "matches",
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
    vi.mocked(deleteAccountVerifications).mockResolvedValueOnce(1);
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: false,
      phase: "verifications",
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(await cleanupAccountDeletion(user.id, resources)).toEqual({
      complete: true,
      phase: "complete",
    });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: user.id }, select: { id: true } });
  });

  it("a final erase failure cannot produce completion", async () => {
    phase("finalizing");
    tx.user.delete.mockRejectedValueOnce(new Error("write failed"));
    await expect(cleanupAccountDeletion(user.id, resources)).rejects.toMatchObject({
      message: "write failed",
    });
  });

  it("does not finish while erased key-hash security history cannot be retired", async () => {
    phase("finalizing");
    resources.retireKeyState.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(cleanupAccountDeletion(user.id, resources)).rejects.toMatchObject({
      message: "redis unavailable",
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("rejects malformed or extended cleanup cursors instead of skipping stop proof", async () => {
    phase("stopping", { deletionCursor: '{"phase":"finalizing","afterId":null,"skip":true}' });
    await expect(cleanupAccountDeletion(user.id, resources)).rejects.toBeDefined();
    expect(resources.record).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });
});
