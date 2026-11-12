import {
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
} from "@cockpit-chess/queue/jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    BACKUP_ENABLED: true,
    BACKUP_SCHEDULE: "off",
  },
}));

vi.mock("@cockpit-chess/env/shared", () => ({
  env: mockEnv,
}));

// The scheduler needs only constants from the side-effect-free jobs module.
// Keep its `@cockpit-chess/queue` import mocked: the production barrel constructs
// BullMQ queues (and IORedis clients) at module load.
vi.mock("@cockpit-chess/queue", async () => {
  const jobs = await import("@cockpit-chess/queue/jobs");
  return { ...jobs };
});

// Fail before any socket can be created if a future edit removes the queue
// boundary mock above. This factory is never reached by the intended graph.
vi.mock("ioredis", () => {
  throw new Error("backup-freshness scheduler tests must mock @cockpit-chess/queue");
});

const { syncBackupFreshnessScheduler } = await import("./backup-freshness-scheduler.js");

describe("syncBackupFreshnessScheduler", () => {
  const upsertJobScheduler = vi.fn(async () => undefined);
  const removeJobScheduler = vi.fn(async () => undefined);
  const queue = { upsertJobScheduler, removeJobScheduler };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.BACKUP_ENABLED = true;
    mockEnv.BACKUP_SCHEDULE = "off";
  });

  it("upserts the stable scheduler id when freshness monitoring is enabled", async () => {
    await expect(syncBackupFreshnessScheduler(queue)).resolves.toBe("upserted");
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
      { pattern: CHECK_BACKUP_FRESHNESS_CRON_PATTERN },
      { name: "check-backup-freshness", data: { reason: "cron" } },
    );
    expect(removeJobScheduler).not.toHaveBeenCalled();
  });

  it("removes the stable scheduler id when freshness monitoring is disabled", async () => {
    mockEnv.BACKUP_ENABLED = false;

    await expect(syncBackupFreshnessScheduler(queue)).resolves.toBe("removed");
    expect(removeJobScheduler).toHaveBeenCalledWith(CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID);
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("keeps monitor intent independent from the canonical dump schedule", async () => {
    mockEnv.BACKUP_SCHEDULE = "daily";
    mockEnv.BACKUP_ENABLED = false;
    await expect(syncBackupFreshnessScheduler(queue)).resolves.toBe("removed");
    mockEnv.BACKUP_SCHEDULE = "off";
    mockEnv.BACKUP_ENABLED = true;
    await expect(syncBackupFreshnessScheduler(queue)).resolves.toBe("upserted");
  });
});
