import { S3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inertDatabaseUrl = [
  "post",
  "gresql://reader:",
  "inert@db.example.com:5432/cockpit_chess?sslmode=require",
].join("");

const envState = {
  BACKUP_ENABLED: true,
  BACKUP_S3_BUCKET: "backups",
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: "monitor-key",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "monitor-secret",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_ENDPOINT: "https://r2.example.com",
  BACKUP_S3_PREFIX: "/database/",
  BACKUP_S3_FORCE_PATH_STYLE: false,
  BACKUP_MAX_AGE_HOURS: 36,
  DATABASE_URL: inertDatabaseUrl,
};

vi.mock("@cockpit-chess/env/shared", () => ({ env: envState }));

const send = vi.fn();
const s3Clients = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(options: Record<string, unknown>) {
      s3Clients(options);
    }

    send = send;
  },
  ListObjectsV2Command: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

const {
  BACKUP_CHECKER_INTERVAL_HOURS,
  findLatestBackup,
  backupFreshnessRedisKey,
  backupFreshnessEnabled,
  backupFreshnessNeedsAttention,
  checkBackupFreshness,
  evaluateBackupFreshness,
  misconfiguredBackupFreshness,
  readBackupFreshness,
  refreshBackupFreshness,
  setupMissingBackupFreshness,
  writeBackupFreshness,
} = await import("./backup-freshness");
const { backupMonitorConfigWarnings } = await import("@cockpit-chess/env/backup-config");
const writer = await import(new URL("../../../../scripts/backup/s3.mjs", import.meta.url).href);

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("evaluateBackupFreshness", () => {
  it("keeps the inert monitor URL equivalent after source fragmentation", () => {
    const parsed = new URL(envState.DATABASE_URL);
    expect(parsed).toMatchObject({
      protocol: "postgresql:",
      username: "reader",
      password: "inert",
      hostname: "db.example.com",
      port: "5432",
      pathname: "/cockpit_chess",
      search: "?sslmode=require",
    });
  });

  it("is fresh inside the window", () => {
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-08T03:00:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "fresh", ageHours: 9, maxAgeHours: 36 });
    expect(backupFreshnessNeedsAttention(status)).toBe(false);
  });

  it("is stale past the window", () => {
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-06T03:00:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "stale", ageHours: 57 });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });

  it("flags an empty bucket", () => {
    const status = evaluateBackupFreshness(null, NOW, 36);
    expect(status.state).toBe("empty");
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });

  it("tolerates a few minutes of clock skew", () => {
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-08T12:02:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({ state: "fresh", ageHours: 0 });
    expect(backupFreshnessNeedsAttention(status)).toBe(false);
  });

  it("is stale when the newest backup is dated in the future", () => {
    // Clamping a negative age to 0 would read as fresh forever — the newest
    // object never ages past the limit, so a stopped cron would never alert.
    const status = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-09T12:00:00.000Z") },
      NOW,
      36,
    );
    expect(status).toMatchObject({
      state: "stale",
      ageHours: 0,
      reason: "future-timestamp",
    });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });
});

describe("misconfiguration", () => {
  beforeEach(() => {
    send.mockReset();
    s3Clients.mockReset();
  });

  it("reports no misconfiguration when the backup config is usable", () => {
    expect(backupFreshnessEnabled()).toBe(true);
    expect(misconfiguredBackupFreshness(NOW)).toBeNull();
    expect(setupMissingBackupFreshness(NOW)).toBeNull();
  });

  it("uses the real monitor validator for invalid monitor profiles", () => {
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: undefined,
      }),
    ).toEqual([
      "BACKUP_S3_BUCKET is set but BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY are missing. The freshness worker needs a dedicated ListBucket-only monitor key.",
    ]);
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_S3_ACCESS_KEY_ID: "dump-key",
        BACKUP_S3_SECRET_ACCESS_KEY: "dump-secret",
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: "dump-key",
      }),
    ).toContain(
      "BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness worker needs a separate ListBucket-only key, not the dump read/write key.",
    );
    expect(
      backupMonitorConfigWarnings({
        ...envState,
        BACKUP_S3_ENDPOINT: undefined,
      }),
    ).toContain(
      'BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset. The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
    );
  });
});

describe("checkBackupFreshness", () => {
  beforeEach(() => {
    send.mockReset();
    s3Clients.mockReset();
  });

  it("pages through the listing and picks the newest dump by date, not key order", async () => {
    send
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextContinuationToken: "t1",
        Contents: [
          {
            Key: "database/daily-20260901T030000Z.dump",
            LastModified: new Date("2026-09-01T03:00:00Z"),
          },
          {
            Key: "database/pre-migrate-20260908T030000Z.dump",
            LastModified: new Date("2026-09-08T03:00:00Z"),
          },
          {
            Key: "database/target/backup-notes.txt",
            LastModified: new Date("2026-09-08T11:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Contents: [
          {
            Key: "database/manual-20260907T030000Z.dump",
            LastModified: new Date("2026-09-07T03:00:00Z"),
          },
        ],
      });

    const status = await checkBackupFreshness(NOW);

    expect(status).toMatchObject({
      state: "fresh",
      latestKey: "database/pre-migrate-20260908T030000Z.dump",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      Bucket: "backups",
      Prefix: "database/",
      MaxKeys: 1000,
    });
    expect(send.mock.calls[1]?.[0]?.input).toMatchObject({ ContinuationToken: "t1" });
    expect(s3Clients).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "monitor-key",
          secretAccessKey: "monitor-secret",
        },
      }),
    );
  });

  it("uses the writer's exact normalized explicit prefix", async () => {
    for (const prefix of ["database", "/database/", "/cockpit-chess/development/database///"]) {
      const config = writer.backupS3Config({
        BACKUP_S3_BUCKET: "backups",
        BACKUP_S3_REGION: "us-east-1",
        BACKUP_S3_ACCESS_KEY_ID: "inert-writer",
        BACKUP_S3_SECRET_ACCESS_KEY: "inert-secret",
        BACKUP_S3_PREFIX: prefix,
      });
      send.mockResolvedValueOnce({ Contents: [] });
      await findLatestBackup({ client: new S3Client({}), bucket: "backups", prefix });
      expect(send.mock.lastCall?.[0]?.input.Prefix).toBe(`${config.prefix}/`);
    }
  });

  it.each(["daily", "manual", "pre-migrate", "pre-drop"])(
    "accepts complete %s dumps and the writer's collision suffixes",
    async (label) => {
      const key = `database/${label}-20260908T030000Z-123-1.dump`;
      send.mockResolvedValueOnce({ Contents: [{ Key: key, LastModified: NOW }] });
      expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "fresh", latestKey: key });
    },
  );

  it("ignores partials, pre-restore snapshots, folders and malformed names", async () => {
    const names = [
      ".daily-20260908T030000Z.dump.partial",
      "daily-20260908T030000Z.dump.partial",
      "pre-restore-20260908T030000Z.dump",
      "backup-20260908T030000Z.dump",
      "daily-20260230T030000Z.dump",
      "daily-20260908T250000Z.dump",
      "daily-20260908T030000Z-abc.dump",
      "manual-20260908T030000Z.dump.gz",
      "daily-20260908T030000Z.dump/",
      "subdir/daily-20260908T030000Z.dump",
      "notes.dump",
    ];
    send.mockResolvedValueOnce({
      Contents: [
        ...names.map((name) => ({ Key: `database/${name}`, LastModified: NOW })),
        { Key: "database/daily-20260908T030000Z.dump", LastModified: new Date("invalid") },
        { Key: "database/manual-20260908T030000Z.dump" },
      ],
    });
    expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "empty" });
  });

  it("cannot report Chess fresh from another project's prefix", async () => {
    const neighbor = "other-app/development/database/daily-20260908T030000Z.dump";
    const chess = "cockpit-chess/development/database";
    send.mockResolvedValueOnce({ Contents: [{ Key: neighbor, LastModified: NOW }] });
    expect(
      await findLatestBackup({ client: new S3Client({}), bucket: "backups", prefix: chess }),
    ).toBeNull();
    expect(send.mock.lastCall?.[0]?.input.Prefix).toBe(`${chess}/`);
    // Prefix neighbors and the retired hash layout must also fail closed.
    send.mockResolvedValueOnce({
      Contents: [
        { Key: `${chess}-neighbor/daily-20260908T030000Z.dump`, LastModified: NOW },
        { Key: `${chess}/target-hash/daily-20260908T030000Z.dump`, LastModified: NOW },
      ],
    });
    expect(
      await findLatestBackup({ client: new S3Client({}), bucket: "backups", prefix: chess }),
    ).toBeNull();
  });

  it("fails closed at the page bound even if a recent object was seen", async () => {
    send.mockImplementation(async () => ({
      IsTruncated: true,
      NextContinuationToken: `token-${send.mock.calls.length}`,
      Contents: [{ Key: "database/daily-20260908T030000Z.dump", LastModified: NOW }],
    }));
    expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "error" });
    expect(send).toHaveBeenCalledTimes(50);
  });

  it("fails closed when a truncated listing cannot advance", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true });
    expect(await checkBackupFreshness(NOW)).toMatchObject({ state: "error" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("turns a listing failure into an error verdict instead of throwing", async () => {
    send.mockReset();
    send.mockRejectedValueOnce(new Error("AccessDenied"));

    const status = await checkBackupFreshness(NOW);

    expect(status).toMatchObject({ state: "error", message: "AccessDenied" });
    expect(backupFreshnessNeedsAttention(status)).toBe(true);
  });
});

describe("refreshBackupFreshness", () => {
  it("recomputes stale from wall-clock age even when the cache still says fresh", () => {
    const cached = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-06T12:00:00.000Z") },
      new Date("2026-09-07T12:00:00.000Z"),
      36,
    );
    expect(cached.state).toBe("fresh");

    const refreshed = refreshBackupFreshness(cached, new Date("2026-09-08T12:00:00.000Z"));
    expect(refreshed).toMatchObject({ state: "stale", ageHours: 48 });
  });

  it("marks a fresh verdict stale when the checker has not run within its interval", () => {
    const cached = evaluateBackupFreshness(
      { key: "database/target/backup-a.dump", lastModified: new Date("2026-09-08T10:00:00.000Z") },
      new Date("2026-09-08T11:00:00.000Z"),
      36,
    );
    const refreshed = refreshBackupFreshness(
      cached,
      new Date(
        new Date("2026-09-08T11:00:00.000Z").getTime() +
          (BACKUP_CHECKER_INTERVAL_HOURS + 1) * 3_600_000,
      ),
    );
    expect(refreshed?.state).toBe("stale");
  });

  it("treats malformed cache JSON as unknown on read", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(backupFreshnessRedisKey(), "{not json");
    await expect(readBackupFreshness(redis)).resolves.toBeNull();
  });

  it("rejects structured cache missing maxAgeHours even when otherwise recent", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "2026-09-08T11:00:00.000Z",
        latestKey: "database/backup-a.dump",
        ageHours: 1,
      }),
    );
    await expect(
      readBackupFreshness(redis, new Date("2026-09-08T14:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("reconciles a cached 720h threshold to the current configured limit", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "2026-09-06T12:00:00.000Z",
        latestKey: "database/backup-a.dump",
        ageHours: 48,
        maxAgeHours: 720,
      }),
    );
    await expect(
      readBackupFreshness(redis, new Date("2026-09-08T14:00:00.000Z")),
    ).resolves.toMatchObject({ state: "stale", maxAgeHours: 36 });
  });

  it("rejects structured cache with future checkedAt", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2099-01-01T00:00:00.000Z",
        latestAt: "2026-09-01T12:00:00.000Z",
        latestKey: "database/backup-a.dump",
        ageHours: 1,
        maxAgeHours: 36,
      }),
    );
    await expect(readBackupFreshness(redis)).resolves.toBeNull();
  });

  it("rejects structured cache with invalid latestAt", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    store.set(
      backupFreshnessRedisKey(),
      JSON.stringify({
        state: "fresh",
        checkedAt: "2026-09-08T12:00:00.000Z",
        latestAt: "not-a-date",
        latestKey: "database/backup-a.dump",
        ageHours: 1,
        maxAgeHours: 36,
      }),
    );
    await expect(readBackupFreshness(redis)).resolves.toBeNull();
  });
});

describe("freshness store", () => {
  it("binds the cache to database identity and prefix but survives credential rotation", () => {
    const originalUrl = envState.DATABASE_URL;
    const originalPrefix = envState.BACKUP_S3_PREFIX;
    try {
      const key = backupFreshnessRedisKey();
      envState.DATABASE_URL = "postgres://rotated:inert@DB.EXAMPLE.com/cockpit_chess";
      expect(backupFreshnessRedisKey()).toBe(key);
      envState.DATABASE_URL = "postgresql://reader:inert@db.example.com/other_database";
      expect(backupFreshnessRedisKey()).not.toBe(key);
      envState.DATABASE_URL = originalUrl;
      envState.BACKUP_S3_PREFIX = "/other-app/development/database/";
      expect(backupFreshnessRedisKey()).not.toBe(key);
    } finally {
      envState.DATABASE_URL = originalUrl;
      envState.BACKUP_S3_PREFIX = originalPrefix;
    }
  });

  it("does not trust an unbound verdict left under the former shared cache key", async () => {
    const store = new Map([
      [
        "backup:freshness",
        JSON.stringify({
          state: "fresh",
          checkedAt: NOW.toISOString(),
          latestAt: NOW.toISOString(),
          latestKey: "database/other-target/backup.dump",
          ageHours: 0,
          maxAgeHours: 36,
        }),
      ],
    ]);
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(),
    };
    await expect(readBackupFreshness(redis, NOW)).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledWith(backupFreshnessRedisKey());
    expect(backupFreshnessRedisKey()).not.toBe("backup:freshness");
  });

  it("round-trips through Redis with a TTL and treats garbage as unknown", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
    };
    const status = evaluateBackupFreshness(null, NOW, 36);

    await writeBackupFreshness(redis, status);
    expect(redis.set).toHaveBeenCalledWith(
      backupFreshnessRedisKey(),
      JSON.stringify(status),
      "EX",
      3 * 24 * 60 * 60,
    );
    const read = await readBackupFreshness(redis, NOW);
    expect(read).toEqual(status);
  });
});
