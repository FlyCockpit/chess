import type { NotifyDataDeletionsJobData } from "@cockpit-chess/queue";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  emailConfigured: true,
  list: vi.fn(),
  mark: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@cockpit-chess/db/data-deletion-notices", () => ({
  listUnnotifiedDataDeletions: state.list,
  markDataDeletionNotified: state.mark,
}));
vi.mock("@cockpit-chess/mailer", () => ({ isEmailConfigured: () => state.emailConfigured }));
// Real `@cockpit-chess/queue` opens IORedis sockets at import; the job schema lives in
// the side-effect-free `@cockpit-chess/queue/jobs`.
vi.mock("@cockpit-chess/queue", async () => ({ ...(await import("@cockpit-chess/queue/jobs")) }));
vi.mock("../operational-alerts.js", () => ({ sendDataDeletedAlert: state.alert }));

const { handleNotifyDataDeletionsJob } = await import("./notify-data-deletions.js");

const job = (data: unknown = { reason: "cron" }) =>
  ({ id: "job-1", data }) as unknown as Job<NotifyDataDeletionsJobData>;

const notice = (name: string) => ({
  name,
  effects: `table ${name}`,
  deletedAt: new Date("2026-11-01T10:00:00Z"),
  backup: "pre-migrate-2026-11-01",
  note: null,
});

beforeEach(() => {
  state.emailConfigured = true;
  state.list.mockReset().mockResolvedValue([]);
  state.mark.mockReset().mockResolvedValue(undefined);
  state.alert.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("handleNotifyDataDeletionsJob", () => {
  it("reads nothing while email is not configured, so notices wait", async () => {
    state.emailConfigured = false;

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toEqual({
      reason: "cron",
      notified: 0,
      retried: 0,
    });
    expect(state.list).not.toHaveBeenCalled();
  });

  it("is a no-op when there is nothing to report (or no runner table)", async () => {
    await expect(handleNotifyDataDeletionsJob(job())).resolves.toMatchObject({ notified: 0 });
    expect(state.alert).not.toHaveBeenCalled();
    expect(state.mark).not.toHaveBeenCalled();
  });

  it("sends one alert per deletion, marking each only after its send", async () => {
    const a = notice("20261010000000_drop_a");
    const b = notice("20261020000000_drop_b");
    state.list.mockResolvedValueOnce([a, b]);
    const order: string[] = [];
    state.alert.mockImplementation(async (n: { name: string }) => {
      order.push(`send ${n.name}`);
    });
    state.mark.mockImplementation(async (name: string) => {
      order.push(`mark ${name}`);
    });

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toEqual({
      reason: "cron",
      notified: 2,
      retried: 0,
    });
    expect(order).toEqual([`send ${a.name}`, `mark ${a.name}`, `send ${b.name}`, `mark ${b.name}`]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  // sendDataDeletedAlert throws when nobody was emailed (no admin, every send
  // failed, Redis down): the notice must stay unmarked so the next run retries.
  it("leaves a notice unmarked when its send fails, and still sends the rest", async () => {
    const a = notice("20261010000000_drop_a");
    const b = notice("20261020000000_drop_b");
    state.list.mockResolvedValueOnce([a, b]);
    state.alert.mockRejectedValueOnce(new Error("no admin was emailed"));

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toMatchObject({
      notified: 1,
      retried: 1,
    });
    expect(state.alert).toHaveBeenCalledTimes(2);
    expect(state.mark.mock.calls).toEqual([[b.name]]);
  });

  it("logs and carries on when recording a sent notice fails", async () => {
    const a = notice("20261010000000_drop_a");
    const b = notice("20261020000000_drop_b");
    state.list.mockResolvedValueOnce([a, b]);
    state.mark.mockRejectedValueOnce(new Error("db down"));

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toMatchObject({ notified: 2 });

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain(a.name);
    expect(logged).toContain("may be sent again");
    expect(state.mark).toHaveBeenCalledWith(b.name);
  });

  it("rejects a payload the schema does not describe", async () => {
    await expect(handleNotifyDataDeletionsJob(job({ reason: "admin" }))).rejects.toThrow();
    expect(state.list).not.toHaveBeenCalled();
  });
});

it("re-sends an unmarked notice after a send-to-mark crash instead of losing it", async () => {
  const pending = notice("20261010000000_drop_a");
  state.list.mockResolvedValue([pending]);
  state.mark.mockRejectedValueOnce(new Error("process lost DB after email"));
  await handleNotifyDataDeletionsJob(job());
  await handleNotifyDataDeletionsJob(job());
  expect(state.alert).toHaveBeenCalledTimes(2);
  expect(state.mark).toHaveBeenCalledTimes(2);
  expect(state.mark.mock.calls).toEqual([[pending.name], [pending.name]]);
});
