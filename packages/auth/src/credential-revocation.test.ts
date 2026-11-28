import { beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB. Each write returns a tag (not a promise) so the transaction
// assertions can see exactly which statements were batched together.
const db = vi.hoisted(() => ({
  runnerMachine: { updateMany: vi.fn() },
  chessMatch: { updateMany: vi.fn() },
  apiKey: { deleteMany: vi.fn() },
  session: { deleteMany: vi.fn() },
  deviceCode: { deleteMany: vi.fn() },
  user: { updateMany: vi.fn() },
  account: { updateMany: vi.fn() },
  verification: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
// Pool of 3 → two CLI-credential lock slots.
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const {
  passwordChangeRevocationTarget,
  quarantineUntrustedPasswordWrite,
  REVOCATION_ATTEMPTS,
  revokeCredentialsBeforePasswordReset,
  revokeCredentialsBeforeAdminPasswordReset,
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
  revokeCredentialsInTransaction,
} = await import("./credential-revocation");
const { cliCredentialLockKey } = await import("./device-redemption-lock");

beforeEach(() => {
  vi.clearAllMocks();
  db.runnerMachine.updateMany.mockReturnValue("runnerMachine.updateMany");
  db.chessMatch.updateMany.mockReturnValue("chessMatch.updateMany");
  db.apiKey.deleteMany.mockReturnValue("apiKey.deleteMany");
  db.session.deleteMany.mockReturnValue("session.deleteMany");
  db.deviceCode.deleteMany.mockReturnValue("deviceCode.deleteMany");
  db.user.updateMany.mockReturnValue("user.updateMany");
  db.account.updateMany.mockReturnValue("account.updateMany");
  db.verification.deleteMany.mockReturnValue("verification.deleteMany");
  db.$executeRaw.mockImplementation((strings: TemplateStringsArray, key: string) =>
    strings.join("").includes('WITH "resetChallenges"')
      ? "twoFactor.deleteMany"
      : strings.join("").includes("pg_notify")
        ? "runnerMachine.notify"
        : key.startsWith("set-password-link:")
          ? "setupLock"
          : "advisoryLock",
  );
  db.$transaction.mockResolvedValue([]);
});

describe("CLI credential revocation writes", () => {
  it("scopes every delete to the one user", async () => {
    await revokeCredentialsAfterPasswordChange({ userId: "u1", keepSessionToken: "new-token" });
    expect(db.apiKey.deleteMany).toHaveBeenCalledWith({ where: { referenceId: "u1" } });
    // Own browser sessions are Better-Auth's to manage; impersonations must also end.
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: "u1", origin: "device-flow" }, { impersonatedBy: "u1" }] },
    });
    expect(db.deviceCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
});

describe("CLI credential lock", () => {
  it("opens every revocation batch with the per-user lock a device-flow redemption holds", async () => {
    await revokeCredentialsAfterPasswordReset("u1");
    const [strings, key] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe(cliCredentialLockKey("u1"));
    expect(vi.mocked(db.$transaction).mock.calls[0]?.[0][0]).toBe("advisoryLock");
  });
});

describe("revokeCredentialsBeforePasswordReset", () => {
  it("reports uncertain revocation without claiming nothing changed after a lost acknowledgment", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let accessRevoked = false;
    db.$transaction.mockImplementation(async () => {
      accessRevoked = true;
      throw new Error("commit acknowledgment lost");
    });
    try {
      await expect(
        revokeCredentialsBeforePasswordReset({
          path: "/reset-password",
          body: { token: "reset-token" },
          context: {
            internalAdapter: {
              findVerificationValue: vi.fn().mockResolvedValue({
                value: "u1",
                expiresAt: new Date(Date.now() + 60_000),
              }),
            },
          },
        }),
      ).rejects.toMatchObject({
        status: "SERVICE_UNAVAILABLE",
        body: {
          message:
            "We couldn't finish securing your account. Your password is unchanged — try the link again. Existing sign-ins and API keys may already have been revoked.",
        },
      });
      expect(accessRevoked).toBe(true);
      expect(db.$transaction).toHaveBeenCalledTimes(REVOCATION_ATTEMPTS);
      expect(db.user.updateMany).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
  it("deletes every session in the credential-lock transaction before reset can proceed", async () => {
    await revokeCredentialsBeforePasswordReset({
      path: "/reset-password",
      body: { token: "reset-token" },
      context: {
        internalAdapter: {
          findVerificationValue: vi.fn().mockResolvedValue({
            value: "u1",
            expiresAt: new Date(Date.now() + 60_000),
          }),
        },
      },
    });
    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { OR: [{ userId: "u1" }, { impersonatedBy: "u1" }] },
    });
    expect(db.$transaction).toHaveBeenCalledExactlyOnceWith([
      "advisoryLock",
      "apiKey.deleteMany",
      "session.deleteMany",
      "deviceCode.deleteMany",
      "runnerMachine.updateMany",
      "runnerMachine.notify",
      "chessMatch.updateMany",
      "twoFactor.deleteMany",
    ]);
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("revokeCredentialsAfterPasswordReset", () => {
  it("revokes credentials, then finalizes the committed reset independently", async () => {
    await revokeCredentialsAfterPasswordReset("u1");
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenNthCalledWith(1, [
      "advisoryLock",
      "apiKey.deleteMany",
      "session.deleteMany",
      "deviceCode.deleteMany",
      "runnerMachine.updateMany",
      "runnerMachine.notify",
      "chessMatch.updateMany",
      "twoFactor.deleteMany",
    ]);
    expect(db.$transaction).toHaveBeenNthCalledWith(2, ["setupLock", "verification.deleteMany"]);
    // Only the token-aware consume transaction can assert mailbox proof.
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { value: "u1", identifier: { startsWith: "reset-password:" } },
    });
  });

  // Better-Auth has already committed the password and consumed the token when
  // this runs, so a single blip must not leave the user's keys live.
  it("retries a failed transaction with a short backoff, rebuilding the batch", async () => {
    const sleeps: number[] = [];
    db.$transaction
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce([]);
    await revokeCredentialsAfterPasswordReset("u1", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([100, 400]);
    // Each sweep gets fresh promises. Finalization runs once, after the retries.
    expect(db.apiKey.deleteMany).toHaveBeenCalledTimes(3);
    expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(3);
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { value: "u1", identifier: { startsWith: "reset-password:" } },
    });
    expect(db.$executeRaw.mock.calls.map((call) => call[1])).toContain("set-password-link:u1");
    expect(db.$transaction.mock.calls.at(-1)?.[0]).toEqual([
      "setupLock",
      "verification.deleteMany",
    ]);
  });

  it.each([false, true])(
    "retries locked reset-link cleanup independently (post-sweep exhausted: %s)",
    async (postSweepExhausted) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const revocationError = new Error("post-sweep failed");
      const sleep = vi.fn().mockResolvedValue(undefined);
      let cleanupAttempts = 0;
      db.$transaction.mockImplementation(async (writes: string[]) => {
        if (writes[0] !== "setupLock") {
          if (postSweepExhausted) throw revocationError;
          return [];
        }
        cleanupAttempts += 1;
        if (cleanupAttempts < 3) throw new Error("transient cleanup failure");
        return [];
      });
      try {
        const reset = revokeCredentialsAfterPasswordReset("u1", { sleep });
        if (postSweepExhausted) await expect(reset).rejects.toBe(revocationError);
        else await expect(reset).resolves.toBeUndefined();
        expect(cleanupAttempts).toBe(3);
        expect(db.apiKey.deleteMany).toHaveBeenCalledTimes(postSweepExhausted ? 3 : 1);
        expect(db.verification.deleteMany.mock.calls).toEqual(
          Array.from({ length: 3 }, () => [
            { where: { value: "u1", identifier: { startsWith: "reset-password:" } } },
          ]),
        );
        expect(db.$transaction.mock.calls.slice(-3).map(([writes]) => writes)).toEqual(
          Array.from({ length: 3 }, () => ["setupLock", "verification.deleteMany"]),
        );
        expect(sleep.mock.calls).toEqual(
          postSweepExhausted ? [[100], [400], [100], [400]] : [[100], [400]],
        );
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "bounds exhausted cleanup retries and preserves the original failure (post-sweep exhausted: %s)",
    async (postSweepExhausted) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const revocationError = new Error("post-sweep failed");
      const cleanupError = new Error("cleanup failed");
      db.$transaction.mockImplementation(async (writes: string[]) => {
        if (writes[0] === "setupLock") throw cleanupError;
        if (postSweepExhausted) throw revocationError;
        return [];
      });
      try {
        await expect(
          revokeCredentialsAfterPasswordReset("u1", { sleep: async () => {} }),
        ).rejects.toBe(postSweepExhausted ? revocationError : cleanupError);
        expect(db.verification.deleteMany).toHaveBeenCalledTimes(3);
        expect(db.$transaction).toHaveBeenCalledTimes(postSweepExhausted ? 6 : 4);
        expect(errorLog).toHaveBeenCalledTimes(postSweepExhausted ? 2 : 1);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("logs loudly with only the user id and rethrows after the last attempt", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockImplementation(async (writes: string[]) => {
      if (writes[0] === "setupLock") return [];
      throw new Error("db down");
    });
    await expect(
      revokeCredentialsAfterPasswordReset("u1", { sleep: async () => {} }),
    ).rejects.toThrow("db down");
    expect(db.$transaction).toHaveBeenCalledTimes(REVOCATION_ATTEMPTS + 1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message, details] = errorLog.mock.calls[0] ?? [];
    expect(message).toMatch(/SECURITY: password-reset credential revocation failed/);
    expect(details).toEqual({ userId: "u1", error: "Error" });
    errorLog.mockRestore();
  });
});

describe("revokeCredentialsAfterPasswordChange", () => {
  it("revokes CLI credentials and every other session without touching email verification", async () => {
    await revokeCredentialsAfterPasswordChange({ userId: "u1", keepSessionToken: "new-token" });
    expect(db.$transaction).toHaveBeenCalledWith([
      "advisoryLock",
      "apiKey.deleteMany",
      "session.deleteMany",
      "deviceCode.deleteMany",
      "session.deleteMany",
    ]);
    // The session the change issued to the device that made it stays.
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", token: { not: "new-token" } },
    });
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("retries the same way after a committed password change", async () => {
    const target = { userId: "u1", keepSessionToken: "new-token" };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce([]);
    await revokeCredentialsAfterPasswordChange(target, { sleep: async () => {} });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(errorLog).not.toHaveBeenCalled();

    db.$transaction.mockReset();
    db.$transaction.mockRejectedValue(new Error("db down"));
    await expect(
      revokeCredentialsAfterPasswordChange(target, { sleep: async () => {} }),
    ).rejects.toThrow("db down");
    expect(errorLog.mock.calls[0]?.[0]).toMatch(/password-change credential revocation failed/);
    errorLog.mockRestore();
  });
});

describe("passwordChangeRevocationTarget", () => {
  const success = { token: "t", user: { id: "u1" } };

  it("targets the user of a successful change that signed out other sessions, keeping its new session", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: success,
      }),
    ).toEqual({ userId: "u1", keepSessionToken: "t" });
    // No new session token: nothing to keep, so nothing is revoked.
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: { token: null, user: { id: "u1" } },
      }),
    ).toBeNull();
  });

  it("ignores a change that kept other sessions", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: false },
        returned: success,
      }),
    ).toBeNull();
    expect(
      passwordChangeRevocationTarget({ path: "/change-password", body: {}, returned: success }),
    ).toBeNull();
  });

  it("ignores a rejected change (the result is an error, not a user)", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: Object.assign(new Error("INVALID_PASSWORD"), { status: "BAD_REQUEST" }),
      }),
    ).toBeNull();
  });

  it("ignores every other endpoint", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/sign-in/email",
        body: { revokeOtherSessions: true },
        returned: success,
      }),
    ).toBeNull();
  });
});

describe("untrusted password write quarantine", () => {
  it("scrambles the credential with the app's own hash (the pepper's sealed format)", async () => {
    const hash = vi.fn(async (password: string) => `pw1:test:${password.length}`);
    await quarantineUntrustedPasswordWrite("u1", { hash, sleep: async () => {} });
    expect(hash).toHaveBeenCalledTimes(1);
    // A fresh random secret nobody knows (32 bytes, base64url).
    expect(hash.mock.calls[0]?.[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", providerId: "credential" },
      data: { password: "pw1:test:43" },
    });
  });
});

describe("impersonator credential revocation", () => {
  it.each(["pre-reset", "post-reset", "password-change"])(
    "%s deletes sessions created by the affected impersonator, preserving unrelated sessions",
    async (phase) => {
      if (phase === "pre-reset") {
        await revokeCredentialsBeforePasswordReset({
          path: "/reset-password",
          body: { token: "token" },
          context: {
            internalAdapter: {
              findVerificationValue: async () => ({
                value: "admin",
                expiresAt: new Date(Date.now() + 60_000),
              }),
            },
          },
        });
      } else if (phase === "post-reset") {
        await revokeCredentialsAfterPasswordReset("admin");
      } else {
        await revokeCredentialsAfterPasswordChange({
          userId: "admin",
          keepSessionToken: "new-token",
        });
      }
      const input = db.session.deleteMany.mock.calls[0]?.[0] as {
        where: { OR: Record<string, string>[] };
      };
      const sessions = [
        { id: "impersonated", userId: "target", impersonatedBy: "admin", origin: "sign-in" },
        { id: "unrelated", userId: "target", impersonatedBy: "other-admin", origin: "sign-in" },
        { id: "own-cli", userId: "admin", impersonatedBy: null, origin: "device-flow" },
        { id: "own-browser", userId: "admin", impersonatedBy: null, origin: "sign-in" },
      ];
      const surviving = sessions
        .filter(
          (session) =>
            !input.where.OR.some((where) =>
              Object.entries(where).every(
                ([key, value]) => session[key as keyof typeof session] === value,
              ),
            ),
        )
        .map((session) => session.id);
      expect(surviving).toEqual(
        phase !== "password-change" ? ["unrelated"] : ["unrelated", "own-browser"],
      );
      expect(db.$transaction.mock.calls[0]?.[0]).toContain("session.deleteMany");
    },
  );
});

describe("activation revocation on the bound client", () => {
  it("uses only the existing transaction for all Chess standing credentials and 2FA", async () => {
    const tx = {
      runnerMachine: { updateMany: vi.fn() },
      chessMatch: { updateMany: vi.fn() },
      apiKey: { deleteMany: vi.fn() },
      deviceCode: { deleteMany: vi.fn() },
      session: { deleteMany: vi.fn() },
      $executeRaw: vi.fn(),
    };
    await revokeCredentialsInTransaction(
      tx as unknown as Parameters<typeof revokeCredentialsInTransaction>[0],
      "invitee",
    );
    expect(tx.apiKey.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { referenceId: "invitee" },
    });
    expect(tx.deviceCode.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "invitee" },
    });
    expect(tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { OR: [{ userId: "invitee" }, { impersonatedBy: "invitee" }] },
    });
    expect(tx.runnerMachine.updateMany).toHaveBeenCalledWith({
      where: { userId: "invitee", revokedAt: null },
      data: { revokedAt: expect.any(Date), connectionGeneration: { increment: 1 } },
    });
    expect(tx.chessMatch.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { ownerId: "invitee", source: "hosted", status: { in: ["queued", "running"] } },
      data: {
        status: "stopped",
        runToken: null,
        turnType: "idle",
        turnId: null,
        turnSide: null,
        turnExpectedSeq: null,
        turnStartedAt: null,
        turnDeadline: null,
        pendingMove: expect.anything(),
        terminalCause: "owner-reset",
        ending: { kind: "cancelled" },
      },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[1]?.slice(1)).toEqual(["invitee", "invitee"]);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(db.deviceCode.deleteMany).not.toHaveBeenCalled();
    expect(db.session.deleteMany).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
});

describe("runner machine recovery policy", () => {
  it.each(["forgot", "admin", "quarantine"])(
    "%s revokes durable runner authority and publishes IDs",
    async (kind) => {
      if (kind === "forgot") await revokeCredentialsAfterPasswordReset("owner");
      else if (kind === "admin") await revokeCredentialsBeforeAdminPasswordReset("owner");
      else
        await quarantineUntrustedPasswordWrite("owner", {
          hash: async () => "unusable",
          sleep: async () => {},
        });
      expect(db.runnerMachine.updateMany).toHaveBeenCalledWith({
        where: { userId: "owner", revokedAt: null },
        data: { revokedAt: expect.any(Date), connectionGeneration: { increment: 1 } },
      });
      const notify = db.$executeRaw.mock.calls.find(([sql]) => sql.join("").includes("pg_notify"));
      expect(notify?.slice(1)).toEqual([
        "runner_machine_revoked",
        JSON.stringify({ userId: "owner" }),
      ]);
    },
  );
  it("ordinary signed-in change retains runners while companion credentials are revoked", async () => {
    await revokeCredentialsAfterPasswordChange({
      userId: "owner",
      keepSessionToken: "new-session",
    });
    expect(db.runnerMachine.updateMany).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(db.apiKey.deleteMany).toHaveBeenCalled();
    expect(db.deviceCode.deleteMany).toHaveBeenCalled();
  });
  it("admin reset fails closed before a password write when revocation cannot commit", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockRejectedValue(new Error("offline"));
    try {
      await expect(revokeCredentialsBeforeAdminPasswordReset("owner")).rejects.toMatchObject({
        status: "SERVICE_UNAVAILABLE",
      });
      expect(db.$transaction).toHaveBeenCalledTimes(REVOCATION_ATTEMPTS);
    } finally {
      log.mockRestore();
    }
  });
});

describe("hosted match recovery cancellation", () => {
  it.each(["missing", "expired"])(
    "does not cancel matches or revoke credentials for a %s recovery token",
    async (kind) => {
      await revokeCredentialsBeforePasswordReset({
        path: "/reset-password",
        body: { token: "reset-token" },
        context: {
          internalAdapter: {
            findVerificationValue: async () =>
              kind === "missing"
                ? null
                : { value: "owner", expiresAt: new Date(Date.now() - 1000) },
          },
        },
      });
      expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["pre-reset", "post-reset", "admin", "quarantine"])(
    "%s cancels all own active hosted matches in the locked credential batch",
    async (kind) => {
      if (kind === "pre-reset")
        await revokeCredentialsBeforePasswordReset({
          path: "/reset-password",
          body: { token: "reset-token" },
          context: {
            internalAdapter: {
              findVerificationValue: async () => ({
                value: "owner",
                expiresAt: new Date(Date.now() + 60_000),
              }),
            },
          },
        });
      else if (kind === "post-reset") await revokeCredentialsAfterPasswordReset("owner");
      else if (kind === "admin") await revokeCredentialsBeforeAdminPasswordReset("owner");
      else
        await quarantineUntrustedPasswordWrite("owner", {
          hash: async () => "unusable",
          sleep: async () => {},
        });
      // No billing filter: operator-billed admin matches must be fenced too.
      expect(db.chessMatch.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { ownerId: "owner", source: "hosted", status: { in: ["queued", "running"] } },
        data: {
          status: "stopped",
          runToken: null,
          turnType: "idle",
          turnId: null,
          turnSide: null,
          turnExpectedSeq: null,
          turnStartedAt: null,
          turnDeadline: null,
          pendingMove: expect.anything(),
          terminalCause: "owner-reset",
          ending: { kind: "cancelled" },
        },
      });
      const batches = db.$transaction.mock.calls.map(([writes]) => writes as string[]);
      const cancellationBatch = batches.find((writes) => writes.includes("chessMatch.updateMany"));
      expect(cancellationBatch).toEqual([
        "advisoryLock",
        "apiKey.deleteMany",
        "session.deleteMany",
        "deviceCode.deleteMany",
        "runnerMachine.updateMany",
        "runnerMachine.notify",
        "chessMatch.updateMany",
        ...(kind === "quarantine" ? ["session.deleteMany"] : []),
        "twoFactor.deleteMany",
      ]);
    },
  );
});
