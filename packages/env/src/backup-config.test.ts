import { describe, expect, it } from "vitest";

import { backupCommonConfigWarnings, backupMonitorConfigWarnings } from "./backup-config.js";

const monitor = {
  BACKUP_ENABLED: true,
  BACKUP_S3_BUCKET: "backups",
  BACKUP_S3_PREFIX: "cockpit-chess/development/database",
  BACKUP_S3_REGION: "us-east-1",
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: "inert-monitor",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "inert-secret",
};

describe("backup monitor configuration", () => {
  it("does not require writer credentials for a ListBucket-only monitor", () => {
    expect(backupMonitorConfigWarnings(monitor)).toEqual([]);
  });

  it("describes BACKUP_ENABLED as monitoring intent with separate writer controls", () => {
    const warnings = backupCommonConfigWarnings({ BACKUP_ENABLED: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Freshness monitoring is enabled");
    expect(warnings[0]).toContain("BACKUP_SCHEDULE");
    expect(backupCommonConfigWarnings({ BACKUP_ENABLED: false })).toEqual([]);
  });

  it("refuses an empty canonical prefix without rejecting nested prefixes", () => {
    for (const prefix of ["", "/", "///"]) {
      expect(backupMonitorConfigWarnings({ ...monitor, BACKUP_S3_PREFIX: prefix })).toContain(
        "BACKUP_S3_PREFIX must not be empty.",
      );
    }
    expect(
      backupMonitorConfigWarnings({ ...monitor, BACKUP_S3_PREFIX: "/team/database/" }),
    ).toEqual([]);
  });

  it("keeps monitor and writer identities distinct", () => {
    expect(
      backupMonitorConfigWarnings({
        ...monitor,
        BACKUP_S3_ACCESS_KEY_ID: monitor.BACKUP_MONITOR_S3_ACCESS_KEY_ID,
      }).join(" "),
    ).toContain("separate ListBucket-only key");
  });

  it("reports missing monitor credentials and invalid region independently", () => {
    const warnings = backupMonitorConfigWarnings({
      ...monitor,
      BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: undefined,
      BACKUP_S3_REGION: "auto",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("BACKUP_MONITOR_S3_SECRET_ACCESS_KEY");
    expect(warnings.join(" ")).toContain("real AWS region");
  });
});
