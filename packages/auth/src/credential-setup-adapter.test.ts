import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the pinned Prisma adapter; only the database checkout/delegates are fake.
const db = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  verification: { findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  session: { findFirst: vi.fn(), create: vi.fn() },
  account: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
const { createCredentialSetupAdapter } = await import("./credential-setup-adapter");
const { bindImpersonationSession, impersonationSessionBinding } = await import(
  "./password-sign-in-fence"
);
const { releaseSlots, tryAcquireSlots } = await import("./lock-slots");
const adapter = createCredentialSetupAdapter()({});
type Selector = Parameters<typeof adapter.update>[0]["where"][number];
const user = { id: "InviteA", email: "InviteA@example.test", emailVerified: true };

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findFirst.mockResolvedValue(user);
  db.account.findFirst.mockResolvedValue({
    id: "idp-account",
    userId: user.id,
    providerId: "sso",
    accountId: "idp-key",
  });
  db.account.update.mockResolvedValue({
    id: "idp-account",
    userId: user.id,
    providerId: "sso",
    accountId: "idp-key",
  });
  db.account.updateMany.mockResolvedValue({ count: 1 });
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null });
  db.user.update.mockResolvedValue(user);
  db.user.create.mockResolvedValue(user);
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.verification.findMany.mockResolvedValue([]);
  db.verification.findFirst.mockResolvedValue({ value: user.id });
  db.verification.create.mockImplementation(async ({ data }) => ({ id: "verification", ...data }));
  db.session.findFirst.mockResolvedValue({ id: "session" });
  db.session.create.mockImplementation(async ({ data }) => ({ id: "impersonation", ...data }));
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
  db.$executeRaw.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
});

describe("impersonation session insertion fence", () => {
  const data = () =>
    bindImpersonationSession(
      { userId: "peer", impersonatedBy: user.id, token: "synthetic" },
      {
        path: "/admin/impersonate-user",
        context: { session: { session: { id: "parent", userId: user.id } } },
      },
    );
  const insert = () => adapter.create({ model: "session", data: data() });

  it("checks the actor and exact live parent under the insertion transaction", async () => {
    await insert();
    expect(db.$executeRaw.mock.calls.map((args) => args[1])).toEqual([
      `cli-credentials:${user.id}`,
    ]);
    expect(db.session.findFirst).toHaveBeenCalledWith({
      where: {
        id: "parent",
        userId: user.id,
        impersonatedBy: null,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(db.session.create).toHaveBeenCalledOnce();
    expect(Object.getOwnPropertySymbols(db.session.create.mock.calls[0]![0].data)).toEqual([]);
  });

  it.each([null, { deletionRequestedAt: new Date() }])(
    "refuses insertion when the actor is erased or fenced after before-hook validation",
    async (actor) => {
      db.$executeRaw.mockImplementation(async () => {
        db.user.findUnique.mockResolvedValue(actor);
        return 1;
      });
      await expect(insert()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
      expect(db.session.create).not.toHaveBeenCalled();
    },
  );

  it("refuses when the exact parent was revoked while waiting", async () => {
    db.$executeRaw.mockImplementation(async () => {
      db.session.findFirst.mockResolvedValue(null);
      return 1;
    });
    await expect(insert()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.session.create).not.toHaveBeenCalled();
  });

  it("refuses a missing or mismatched server-only before-hook binding", async () => {
    const bound = data();
    expect(Object.getOwnPropertySymbols({ ...bound })).toContain(impersonationSessionBinding);
    for (const candidate of [
      { userId: "peer", impersonatedBy: user.id },
      { ...bound, userId: "other-peer" },
      { ...bound, impersonatedBy: "other-actor" },
    ]) {
      await expect(adapter.create({ model: "session", data: candidate })).rejects.toMatchObject({
        status: "UNAUTHORIZED",
      });
    }
    expect(db.session.create).not.toHaveBeenCalled();
  });
});

describe("owned Verification insertion fence", () => {
  const insert = (identifier: string, value: string) =>
    adapter.create({
      model: "verification",
      data: { identifier, value, expiresAt: new Date(Date.now() + 600_000) },
    });

  it.each(["reset-password:token", "2fa-challenge", "trust-device-device"])(
    "inserts %s only within the active owner credential transaction",
    async (identifier) => {
      await insert(identifier, user.id);
      expect(db.$executeRaw.mock.calls.map((args) => args[1])).toEqual([
        `cli-credentials:${user.id}`,
      ]);
      expect(db.verification.create).toHaveBeenCalledOnce();
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "ReadCommitted",
        timeout: 20_000,
      });
    },
  );

  it.each([
    "reset-password:token",
    "2fa-challenge",
    "2fa-otp-2fa-challenge",
    "2fa-attempts-2fa-challenge",
    `2fa-otp-${user.id}!session`,
    "trust-device-device",
  ])("refuses delayed %s after physical owner erasure", async (identifier) => {
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    db.$executeRaw.mockImplementation(async () => {
      entered();
      await released;
      return 1;
    });
    const writing = insert(identifier, user.id);
    await waiting;
    db.user.findUnique.mockResolvedValue(null);
    resume();
    await expect(writing).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it.each(["2fa-otp-2fa-challenge", "2fa-attempts-2fa-challenge"])(
    "rechecks %s anchor after its owner lock wait",
    async (identifier) => {
      db.$executeRaw.mockImplementation(async () => {
        db.verification.findFirst.mockResolvedValue(null);
        return 1;
      });
      await expect(insert(identifier, "0")).rejects.toMatchObject({ status: "UNAUTHORIZED" });
      expect(db.verification.create).not.toHaveBeenCalled();
    },
  );

  it("refuses signed-in OTP rearming after its parent session is removed", async () => {
    db.$executeRaw.mockImplementation(async () => {
      db.session.findFirst.mockResolvedValue(null);
      return 1;
    });
    await expect(insert(`2fa-otp-${user.id}!session`, "otp:1")).rejects.toMatchObject({
      status: "UNAUTHORIZED",
    });
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("fences owned SSO link state but leaves current anonymous sign-in state usable", async () => {
    db.user.findUnique.mockResolvedValue({ ...user, deletionRequestedAt: null });
    await insert(
      "auth-state:link",
      JSON.stringify({ link: { userId: user.id, email: user.email } }),
    );
    expect(db.verification.create).toHaveBeenCalledOnce();
    db.verification.create.mockClear();
    db.user.findUnique.mockResolvedValue(null);
    await expect(
      insert("auth-state:link", JSON.stringify({ link: { userId: user.id, email: user.email } })),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.verification.create).not.toHaveBeenCalled();
    await insert(
      "auth-state:anonymous",
      JSON.stringify({ callbackURL: "/", codeVerifier: "synthetic" }),
    );
    expect(db.verification.create).toHaveBeenCalledOnce();
  });
});

describe.each(["update", "updateMany"] as const)("activation %s selectors", (method) => {
  const write = (where: Selector[]) =>
    adapter[method]({ model: "user", where, update: { emailVerified: true } });

  it.each(["id", "email"])(
    "rejects case-insensitive %s before lookup, checkout or writes",
    async (field) => {
      await expect(
        write([{ field, value: user[field as "id" | "email"], mode: "insensitive" }]),
      ).rejects.toThrow("Activation requires an exact user selector");
      expect(db.user.findFirst).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.user.updateMany).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).not.toHaveBeenCalled();
      expect(tryAcquireSlots(2)).toBe(true);
      releaseSlots(2);
    },
  );

  it.each<{ value: Selector["value"] }>([
    { value: ["InviteA", "invitea"] },
    { value: [1, 2] },
    { value: null },
    { value: 12 },
    { value: true },
    { value: new Date(0) },
  ])("rejects non-string selector $value before lookup, checkout or writes", async ({ value }) => {
    await expect(write([{ field: "id", value, operator: "eq" }])).rejects.toThrow(
      "Activation requires an exact user selector",
    );
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it.each<{ where: Selector[] }>([
    { where: [] },
    {
      where: [
        { field: "id", value: user.id },
        { field: "email", value: user.email },
      ],
    },
    { where: [{ field: "name", value: "Invite" }] },
    { where: [{ field: "id", value: user.id, operator: "ne" }] },
  ])("rejects broad selector $where before any side effect", async ({ where }) => {
    await expect(write(where)).rejects.toThrow("Activation requires an exact user selector");
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it.each(["id", "email"] as const)(
    "accepts exact %s and invokes this method under the locks",
    async (field) => {
      await write([{ field, value: user[field], operator: "eq", mode: "sensitive" }]);
      expect(db.$transaction).toHaveBeenCalledOnce();
      expect(db.$executeRaw.mock.calls.map((args) => args[1])).toEqual([
        "password-write:InviteA",
        "cli-credentials:InviteA",
        "set-password-link:InviteA",
      ]);
      expect(db.user[method]).toHaveBeenCalledOnce();
      expect(db.user[method === "update" ? "updateMany" : "update"]).not.toHaveBeenCalled();
      expect(db.verification.deleteMany).toHaveBeenCalled();
    },
  );
});

it("refuses verification activation after deletion while holding the existing locks", async () => {
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });
  await expect(
    adapter.update({
      model: "user",
      where: [{ field: "id", value: user.id }],
      update: { emailVerified: true },
    }),
  ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  expect(db.user.update).not.toHaveBeenCalled();
  expect(db.$executeRaw).toHaveBeenCalledTimes(3);
});

describe.each(["update", "updateMany"] as const)("existing IdP account %s", (method) => {
  const update = () =>
    adapter[method]({
      model: "account",
      where: [{ field: "id", value: "idp-account" }],
      update: {
        providerId: "sso",
        accountId: "idp-key",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
      },
    });

  it("refreshes a live owner's existing linked account inside the credential transaction", async () => {
    const order: string[] = [];
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => {
      order.push("transaction");
      const answer = await run(db);
      order.push("commit");
      return answer;
    });
    db.$executeRaw.mockImplementation(async () => {
      order.push("credential-lock");
      return 1;
    });
    db.user.findUnique.mockImplementation(async () => {
      order.push("owner");
      return { deletionRequestedAt: null };
    });
    db.account[method].mockImplementation(async () => {
      order.push("write");
      return method === "update" ? { id: "idp-account" } : { count: 1 };
    });
    await update();
    expect(order).toEqual(["transaction", "credential-lock", "owner", "write", "commit"]);
    expect(db.$executeRaw.mock.calls.map((args) => args[1])).toEqual(["cli-credentials:InviteA"]);
    expect(db.account.findFirst).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
      timeout: 20_000,
    });
  });

  it("fails closed if the original account vanished before locking", async () => {
    db.account.findFirst.mockResolvedValue(null);
    await expect(update()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.account.update).not.toHaveBeenCalled();
    expect(db.account.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a pending owner before persisting refreshed IdP tokens", async () => {
    db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });
    await expect(update()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.account.update).not.toHaveBeenCalled();
    expect(db.account.updateMany).not.toHaveBeenCalled();
    expect(db.$executeRaw.mock.calls.map((args) => args[1])).toEqual(["cli-credentials:InviteA"]);
  });

  it("rechecks owner authority only after the deletion lock wait", async () => {
    db.$executeRaw.mockImplementation(async () => {
      db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });
      return 1;
    });
    await expect(update()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.account[method]).not.toHaveBeenCalled();
  });

  it("refuses a stale owner binding that changed while waiting", async () => {
    db.account.findFirst
      .mockResolvedValueOnce({
        id: "idp-account",
        userId: user.id,
        providerId: "sso",
        accountId: "idp-key",
      })
      .mockResolvedValue({ id: "idp-account", userId: "other", providerId: "sso" });
    await expect(update()).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    expect(db.account[method]).not.toHaveBeenCalled();
  });

  it("does not turn account refresh into an ownership mutation", async () => {
    await expect(
      adapter[method]({
        model: "account",
        where: [{ field: "id", value: "idp-account" }],
        update: { userId: "other", accessToken: "synthetic" },
      }),
    ).rejects.toThrow("IdP account identity cannot change");
    expect(db.account[method]).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

it("rejects unsupported bulk IdP token writes before lookup or mutation", async () => {
  await expect(
    adapter.updateMany({
      model: "account",
      where: [{ field: "userId", value: user.id }],
      update: { refreshToken: "synthetic" },
    }),
  ).rejects.toThrow("IdP account updates require an exact account selector");
  expect(db.account.findFirst).not.toHaveBeenCalled();
  expect(db.account.updateMany).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
});

it("preserves the pinned credential password bulk write without a nested lock transaction", async () => {
  await adapter.transaction(async (transaction) =>
    transaction.updateMany({
      model: "account",
      where: [
        { field: "userId", value: user.id },
        { field: "providerId", value: "credential" },
        { field: "accountId", value: user.id },
      ],
      update: { password: "synthetic-password-hash" },
    }),
  );
  expect(db.account.updateMany).toHaveBeenCalledOnce();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.$executeRaw).not.toHaveBeenCalled();
});

describe("admin invite INSERT authorization", () => {
  const create = () =>
    adapter.create({
      model: "user",
      data: { name: "Invitee", email: user.email, emailVerified: false },
    });
  it("requires the admin-invite authorizer at the actual adapter effect", async () => {
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    await expect(runWithAllowedUserCreation("admin-invite", create)).rejects.toMatchObject({
      body: { code: "ADMIN_INVITE_AUTHORITY_REQUIRED" },
    });
    expect(db.user.create).not.toHaveBeenCalled();
  });
  it("authorizes and inserts on the same transaction while preserving a normal invite", async () => {
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    const order: string[] = [];
    const authorize = vi.fn(async (tx) => {
      expect(tx).toBe(db);
      order.push("actor");
    });
    db.user.create.mockImplementation(async () => {
      order.push("insert");
      return user;
    });
    await runWithAllowedUserCreation("admin-invite", create, { authorize });
    expect(order).toEqual(["actor", "insert"]);
    expect(authorize).toHaveBeenCalledWith(db);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
      timeout: 20_000,
    });
  });
  it("never inserts when delayed hashing outlives the actor's authority", async () => {
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    const authorize = vi.fn(async () => {
      throw new Error("actor revoked");
    });
    await expect(runWithAllowedUserCreation("admin-invite", create, { authorize })).rejects.toThrow(
      "actor revoked",
    );
    expect(db.user.create).not.toHaveBeenCalled();
  });
});
