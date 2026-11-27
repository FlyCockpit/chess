import { beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB: the interactive transaction runs its callback with a tx
// whose `$queryRaw` answers the try-lock. The real-Postgres race (lock held
// across the Better-Auth handler vs. a concurrent revocation) is covered by
// `pnpm runtime:test-operations`.
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  session: { findFirst: vi.fn() },
}));
const db = vi.hoisted(() => ({
  deviceCode: { findUnique: vi.fn() },
  session: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
// Pool of 3 → two CLI-credential lock slots.
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const {
  assertDeviceRedemptionLocked,
  lockedDeviceAuthorization,
  cliCredentialLockKey,
  deviceRedemptionLockHeld,
  removeDeviceSessionIfUnlocked,
  withCliCredentialLockSlot,
  withDeviceRedemptionLock,
} = await import("./device-redemption-lock");

function tokenRequest(body: unknown, type = "application/json"): Request {
  return new Request("http://app.test/api/auth/device/token", {
    method: "POST",
    headers: { "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ok = () => new Response("ok");

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([{ locked: true }]);
  tx.$executeRaw.mockResolvedValue(1);
  tx.session.findFirst.mockResolvedValue({ id: "live-session" });
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  db.session.deleteMany.mockResolvedValue({ count: 1 });
});

describe("withDeviceRedemptionLock", () => {
  it("holds the owner's CLI-credential lock while the handler runs, and leaves the body readable", async () => {
    db.deviceCode.findUnique.mockResolvedValue({ userId: "u1", status: "approved" });
    const request = tokenRequest({ device_code: "dc-1", client_id: "cockpit-chess-cli" });
    let body: unknown;

    const response = await withDeviceRedemptionLock(request, async () => {
      // The session-create hook's check passes for the owner only.
      expect(() => assertDeviceRedemptionLocked("u1")).not.toThrow();
      expect(() => assertDeviceRedemptionLocked("u2")).toThrow(/did not hold/);
      body = await request.json();
      return ok();
    });

    expect(await response.text()).toBe("ok");
    expect(body).toEqual({ device_code: "dc-1", client_id: "cockpit-chess-cli" });
    expect(db.deviceCode.findUnique).toHaveBeenCalledWith({
      where: { deviceCode: "dc-1" },
      select: { userId: true, status: true },
    });
    const [strings, key] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    // TRIED, never waited for: a waiter would pin a pooled connection.
    expect(strings.join("?")).toContain("pg_try_advisory_xact_lock(hashtext(?))");
    expect(key).toBe(cliCredentialLockKey("u1"));
    // Outside the run, nothing is held.
    expect(() => assertDeviceRedemptionLocked("u1")).toThrow();
  });

  it("answers slow_down without running the handler while another redemption holds the lock", async () => {
    db.deviceCode.findUnique.mockResolvedValue({ userId: "u1", status: "approved" });
    tx.$queryRaw.mockResolvedValue([{ locked: false }]);
    const run = vi.fn(async () => ok());

    const response = await withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), run);

    expect(run).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "slow_down" });
  });

  it("stops counting as held before Prisma's transaction timeout releases the lock", async () => {
    vi.useFakeTimers();
    try {
      db.deviceCode.findUnique.mockResolvedValue({ userId: "u1", status: "approved" });
      // Prisma's real ordering: on timeout it rolls back (releasing the lock)
      // but still awaits the callback, so the outer promise settles only when
      // the handler does. Only our own timer can mark the lapse in time.
      const seen: boolean[] = [];
      const pending = withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), async () => {
        seen.push(deviceRedemptionLockHeld("u1"));
        await vi.advanceTimersByTimeAsync(24_000);
        seen.push(deviceRedemptionLockHeld("u1"));
        await vi.advanceTimersByTimeAsync(2_000); // past 25 s, before Prisma's 30 s
        seen.push(deviceRedemptionLockHeld("u1"));
        return ok();
      });
      await pending;
      expect(seen).toEqual([true, true, false]);
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the lapse from before the transaction starts, not from when the lock is taken", async () => {
    vi.useFakeTimers();
    try {
      db.deviceCode.findUnique.mockResolvedValue({ userId: "u1", status: "approved" });
      // A slow connection checkout / BEGIN: 6 s pass before the callback runs.
      // Prisma's 30 s clock may already be running, so the lock must stop
      // counting as held at 25 s from the START, i.e. 19 s into the handler.
      db.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => {
        await vi.advanceTimersByTimeAsync(6_000);
        return fn(tx);
      });
      const seen: boolean[] = [];
      await withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), async () => {
        await vi.advanceTimersByTimeAsync(18_000);
        seen.push(deviceRedemptionLockHeld("u1"));
        await vi.advanceTimersByTimeAsync(2_000);
        seen.push(deviceRedemptionLockHeld("u1"));
        return ok();
      });
      expect(seen).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets lock transactions take the last pooled connection", async () => {
    // DATABASE_POOL_MAX 3 → 2 slots. Two redemptions (different users) hold
    // them; a third is told to poll again without opening a transaction.
    db.deviceCode.findUnique
      .mockResolvedValueOnce({ userId: "u1", status: "approved" })
      .mockResolvedValueOnce({ userId: "u2", status: "approved" })
      .mockResolvedValueOnce({ userId: "u3", status: "approved" });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = () =>
      withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), async () => {
        await gate;
        return ok();
      });
    const first = hold();
    const second = hold();
    await vi.waitFor(() => expect(db.$transaction).toHaveBeenCalledTimes(2));

    const third = await withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), async () =>
      ok(),
    );
    expect(await third.json()).toMatchObject({ error: "slow_down" });
    expect(db.$transaction).toHaveBeenCalledTimes(2);

    // A revocation waits for a slot in memory, then runs.
    let revoked = false;
    const revocation = withCliCredentialLockSlot(async () => {
      revoked = true;
    });
    await Promise.resolve();
    expect(revoked).toBe(false);
    release();
    await Promise.all([first, second, revocation]);
    expect(revoked).toBe(true);
  });

  it("reads the code from a form-encoded body too", async () => {
    db.deviceCode.findUnique.mockResolvedValue({ userId: "u1", status: "approved" });
    await withDeviceRedemptionLock(
      tokenRequest(
        "device_code=dc-form&client_id=cockpit-chess-cli",
        "application/x-www-form-urlencoded",
      ),
      async () => ok(),
    );
    expect(db.deviceCode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deviceCode: "dc-form" } }),
    );
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it.each([
    ["a pending code", { userId: null, status: "pending" }],
    ["a denied code", { userId: "u1", status: "denied" }],
    ["an unknown code", null],
  ])("runs %s unlocked (nothing can be minted, the hook refuses if it could)", async (_, row) => {
    db.deviceCode.findUnique.mockResolvedValue(row);
    const run = vi.fn(async () => {
      expect(() => assertDeviceRedemptionLocked("u1")).toThrow();
      return ok();
    });

    await withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), run);
    expect(run).toHaveBeenCalledOnce();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["no device_code", { client_id: "cockpit-chess-cli" }],
    ["a non-string code", { device_code: 7 }],
    ["an oversized code", { device_code: "x".repeat(513) }],
  ])("skips the lookup for %s", async (_, body) => {
    await withDeviceRedemptionLock(tokenRequest(body), async () => ok());
    expect(db.deviceCode.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("removeDeviceSessionIfUnlocked", () => {
  it("deletes a device-flow session whose lock lapsed before the insert committed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await removeDeviceSessionIfUnlocked({ id: "s1", userId: "u1" });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("keeps a session minted under the lock", async () => {
    db.deviceCode.findUnique.mockResolvedValue({ userId: "u1", status: "approved" });
    await withDeviceRedemptionLock(tokenRequest({ device_code: "dc" }), async () => {
      await removeDeviceSessionIfUnlocked({ id: "s1", userId: "u1" });
      return ok();
    });
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });
});

describe("browser device approval", () => {
  async function approvalFixture() {
    const { betterAuth } = await import("better-auth");
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    const data: Record<string, Record<string, unknown>[]> = {
      user: [{ id: "u1", name: "Test", email: "test@example.test", emailVerified: true }],
      account: [
        { id: "a1", userId: "u1", accountId: "u1", providerId: "credential", password: "hash" },
      ],
      session: [],
      deviceCode: [
        {
          id: "dc",
          userCode: "ABCDEFGH",
          deviceCode: "device-code",
          clientId: "mycli",
          userId: "u1",
          status: "pending",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    };
    const instance = betterAuth({
      baseURL: "https://app.example.test",
      secret: "disposable-device-test-secret-with-no-external-use",
      database: memoryAdapter(data),
      logger: { disabled: true },
      rateLimit: { enabled: false },
      emailAndPassword: {
        enabled: true,
        password: { hash: async () => "hash", verify: async () => true },
      },
      plugins: [lockedDeviceAuthorization({})],
    });
    const signed = await instance.api.signInEmail({
      body: { email: "test@example.test", password: "test-password" },
      returnHeaders: true,
    });
    const cookie = signed.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("session cookie missing");
    const approve = () =>
      instance.handler(
        new Request("https://app.example.test/api/auth/device/approve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin: "https://app.example.test",
          },
          body: JSON.stringify({ userCode: "ABCDEFGH" }),
        }),
      );
    return { approve, data };
  }

  it("keeps the real plugin approval inside the revocation lock", async () => {
    const { approve, data } = await approvalFixture();
    expect((await approve()).status).toBe(200);
    expect(data.deviceCode?.[0]?.status).toBe("approved");
    const [strings, key] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("cli-credentials:u1");
    expect(tx.session.findFirst).toHaveBeenCalledWith({
      where: { id: data.session?.[0]?.id, userId: "u1", expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.session.findFirst.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("refuses when the locked session lookup is missing, expired or owned by another user", async () => {
    for (const row of [
      null,
      { userId: "u1", expiresAt: new Date(0) },
      { userId: "other", expiresAt: new Date("2099-01-01") },
    ]) {
      const { approve, data } = await approvalFixture();
      // Better-Auth itself can still see a session; the locked DB lookup wins.
      tx.session.findFirst.mockImplementationOnce(
        async ({ where }: { where: { userId: string; expiresAt: { gt: Date } } }) =>
          row?.userId === where.userId && row.expiresAt > where.expiresAt.gt
            ? { id: "live-session" }
            : null,
      );
      expect((await approve()).status).toBe(401);
      expect(data.deviceCode?.[0]?.status).toBe("pending");
    }
  });
});
