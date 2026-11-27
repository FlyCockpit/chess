import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Actual pinned handler + production options, hooks and selective adapter.
// Only PostgreSQL and delivery are replaced. Real PG interleavings live in
// scripts/test-runtime-operations.mjs and run on Boat.
const fixture = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const events: string[] = [];
  let connections = 0;
  const controls = { injectLateRows: false, failAfterCallback: false };
  let peak = 0;
  let lockBarrier: ((key: string) => Promise<void>) | undefined;
  let readBarrier: ((where: Row) => void) | undefined;
  const match = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "user") {
        const related = tables.user?.find((item) => item.id === row.userId);
        return !!related && match(related, value as Row);
      }
      if (key === "OR") return (value as Row[]).some((condition) => match(row, condition));
      const have = row[key];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const condition = value as Row;
        if ("startsWith" in condition && !String(have).startsWith(String(condition.startsWith)))
          return false;
        if ("not" in condition && have === condition.not) return false;
        if (
          "gt" in condition &&
          !(have instanceof Date && condition.gt instanceof Date && have > condition.gt)
        )
          return false;
        if ("in" in condition && !(condition.in as unknown[]).includes(have)) return false;
        return true;
      }
      return have === value;
    });
  const delegate = (name: string) => ({
    findFirst: async ({ where }: { where: Row }) => {
      readBarrier?.(where);
      return tables[name]?.find((row) => match(row, where)) ?? null;
    },
    findUnique: async ({ where }: { where: Row }) => {
      const row = tables[name]?.find((item) => match(item, where));
      if (!row) return null;
      if (name !== "user") return row;
      return {
        ...row,
        accounts: tables.account?.filter((account) => account.userId === row.id).slice(0, 2) ?? [],
        sessions:
          tables.session
            ?.filter(
              (session) =>
                session.userId === row.id &&
                session.expiresAt instanceof Date &&
                session.expiresAt > new Date(),
            )
            .slice(0, 1) ?? [],
      };
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...data };
      tables[name] ??= [];
      tables[name].push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = tables[name]?.filter((row) => match(row, where)) ?? [];
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const rows = tables[name] ?? [];
      tables[name] = rows.filter((row) => !match(row, where));
      return { count: rows.length - tables[name].length };
    },
  });
  const client = {
    user: delegate("user"),
    account: delegate("account"),
    verification: delegate("verification"),
    session: delegate("session"),
    runnerMachine: delegate("runnerMachine"),
    chessMatch: delegate("chessMatch"),
    apiKey: delegate("apikey"),
    deviceCode: delegate("deviceCode"),
    $executeRaw: async (_sql: TemplateStringsArray, key: string) => {
      if (_sql.join("").includes('WITH "resetChallenges"')) {
        const challenges = (tables.verification ?? []).filter(
          (row) => row.value === key && String(row.identifier).startsWith("2fa-"),
        );
        const identifiers = new Set(
          challenges.flatMap((row) => [
            row.identifier,
            `2fa-otp-${row.identifier}`,
            `2fa-attempts-${row.identifier}`,
          ]),
        );
        tables.verification = (tables.verification ?? []).filter(
          (row) =>
            !identifiers.has(row.identifier) &&
            !(row.value === key && String(row.identifier).startsWith("trust-device-")),
        );
      }
      events.push(key);
      if (key?.startsWith("password-write:")) await lockBarrier?.(key);
      return 1;
    },
    $queryRaw: async () => [{ locked: true }],
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (work: unknown) => {
    if (Array.isArray(work)) return Promise.all(work);
    connections++;
    peak = Math.max(peak, connections);
    const snapshot = structuredClone(tables);
    try {
      const result = await (work as (tx: typeof client) => Promise<unknown>)(client);
      if (
        controls.failAfterCallback &&
        snapshot.account?.some(
          (old) =>
            old.providerId === "credential" &&
            tables.account?.find((row) => row.id === old.id)?.password !== old.password,
        )
      ) {
        controls.failAfterCallback = false;
        throw new Error("fixture commit failure");
      }
      if (
        controls.injectLateRows &&
        tables.account?.some((row) => row.providerId === "sso") &&
        !snapshot.account?.some((row) => row.providerId === "sso")
      ) {
        controls.injectLateRows = false;
        tables.session!.push({ id: "before-commit", userId: "invitee" });
        tables.verification!.push({
          id: "late-2fa",
          identifier: "2fa-beforecommit",
          value: "invitee",
        });
      }
      return result;
    } catch (error) {
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, snapshot);
      throw error;
    } finally {
      connections--;
    }
  });
  return {
    tables,
    client,
    events,
    match,
    controls,
    connections: () => connections,
    setLockBarrier: (fn?: typeof lockBarrier) => {
      lockBarrier = fn;
    },
    setReadBarrier: (fn?: typeof readBarrier) => {
      readBarrier = fn;
    },
    peak: () => peak,
  };
});
vi.mock("@cockpit-chess/db", () => ({ default: fixture.client }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-chess/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://app.example.test",
    BETTER_AUTH_SECRET: "disposable-activation-fixture-secret-123456789",
  },
  ADMIN_EMAILS: new Set(),
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@cockpit-chess/mailer", () => ({
  INTERACTIVE_EMAIL_DELIVERY: {},
  isEmailConfigured: () => false,
  renderResetPassword: () => ({ subject: "Reset", html: "" }),
  renderVerifyEmail: () => ({ subject: "Verify", html: "" }),
  renderTwoFactorOtp: () => ({ subject: "OTP", html: "" }),
  sendEmail: async () => {
    expect(fixture.connections()).toBe(0);
  },
}));
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { prismaAdapter: () => memoryAdapter(fixture.tables) };
});
const { auth } = await import("./index");
const { withPasswordWriteLock } = await import("./password-write-lock");
const { releaseSlots, tryAcquireSlots } = await import("./lock-slots");
const { withPasswordSignInFence } = await import("./password-sign-in-fence");
const { recordResetLinkMailed } = await import("./password-reset-links");
const { createEmailVerificationToken } = await import("better-auth/api");
const { handleOAuthUserInfo } = await import("better-auth/oauth2");
// Enter the pinned endpoint ALS only for its already-authorized OAuth seam.
// Resolve core through Better Auth's own installed dependency graph.
const authRequire = createRequire(createRequire(import.meta.url).resolve("better-auth"));
const { runWithEndpointContext } = (await import(
  authRequire.resolve("@better-auth/core/context")
)) as {
  runWithEndpointContext: <T>(
    ctx: { path: string; context: Awaited<typeof auth.$context> },
    run: () => Promise<T>,
  ) => Promise<T>;
};
const context = await auth.$context;
const hash = vi
  .spyOn(context.password, "hash")
  .mockImplementation(async (password) => `hash:${password}`);
vi.spyOn(context.password, "verify").mockImplementation(
  async ({ hash, password }) => hash === `hash:${password}`,
);
const userId = "invitee";
const email = "invitee@example.test";
const user = () => fixture.tables.user![0]!;
const credential = () => fixture.tables.account!.find((row) => row.providerId === "credential")!;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Same password-write boundary mounted by Chess's server; no alternate auth instance.
const resetRequest = (request: Request) =>
  withPasswordWriteLock("/reset-password", request, () => auth.handler(request), {
    getSession: (headers) => auth.api.getSession({ headers }),
  });
const reset = (token: string) =>
  resetRequest(
    new Request("https://app.example.test/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.test" },
      body: JSON.stringify({ token, newPassword: `${token}-password-12345` }),
    }),
  );
async function link(token: string, mailed = false) {
  await fixture.client.verification.create({
    data: {
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  if (mailed) await recordResetLinkMailed({ token, userId, email });
}
async function verifyEmail() {
  const token = await createEmailVerificationToken(context.secret, email);
  return auth.handler(new Request(`https://app.example.test/api/auth/verify-email?token=${token}`));
}
const idpLink = () =>
  context.internalAdapter.createAccount({ providerId: "sso", accountId: "idp-user", userId });
beforeEach(() => {
  fixture.setLockBarrier();
  fixture.setReadBarrier();
  fixture.events.length = 0;
  fixture.controls.injectLateRows = false;
  fixture.controls.failAfterCallback = false;
  for (const key of Object.keys(fixture.tables)) delete fixture.tables[key];
  const now = new Date();
  fixture.tables.user = [
    { id: userId, name: "Invitee", email, emailVerified: false, createdAt: now, updatedAt: now },
  ];
  fixture.tables.account = [
    {
      id: "credential",
      accountId: userId,
      userId,
      providerId: "credential",
      password: "hash:prior-password",
      createdAt: now,
      updatedAt: now,
    },
  ];
  fixture.tables.session = [];
  fixture.tables.verification = [];
  hash.mockImplementation(async (password) => `hash:${password}`);
});

describe("selective reset spend and activation through production hooks", () => {
  it("refuses reset consumption outside its password transaction", async () => {
    await link("shown");
    await expect(
      context.adapter.consumeOne({
        model: "verification",
        where: [{ field: "identifier", value: "reset-password:shown" }],
      }),
    ).rejects.toThrow("Reset consumption requires its password transaction");
    expect(credential().password).toBe("hash:prior-password");
    expect(fixture.tables.verification).toHaveLength(1);
  });

  it.each(["shown", "mailed"])(
    "serializes %s first against the other reset, with mailbox proof atomic",
    async (first) => {
      await link("shown");
      await link("mailed", true);
      const hashing = deferred();
      const release = deferred();
      const queued = deferred();
      hash.mockImplementationOnce(async (password) => {
        hashing.resolve();
        await release.promise;
        return `hash:${password}`;
      });
      const winning = reset(first);
      await hashing.promise;
      const other = first === "shown" ? "mailed" : "shown";
      fixture.setReadBarrier((where) => {
        if (where.identifier === `reset-password:${other}`) queued.resolve();
      });
      const losing = reset(other);
      await queued.promise;
      release.resolve();
      expect((await winning).status).toBe(200);
      expect((await losing).status).toBe(400);
      expect(user().emailVerified).toBe(first === "mailed");
      expect(credential().password).toBe(`hash:${first}-password-12345`);
      expect(fixture.peak()).toBeLessThanOrEqual(2); // pool 3, one ordinary connection remains
    },
  );
  it.each(["shown", "verify"])(
    "serializes %s first against verify-email at the actual write",
    async (first) => {
      await link("shown");
      const entered = deferred();
      const release = deferred();
      const queued = deferred();
      if (first === "shown")
        hash.mockImplementationOnce(async (password) => {
          entered.resolve();
          await release.promise;
          return `hash:${password}`;
        });
      else
        fixture.setLockBarrier(async () => {
          entered.resolve();
          await release.promise;
        });
      const winning = first === "shown" ? reset("shown") : verifyEmail();
      await entered.promise;
      fixture.setReadBarrier((where) => {
        if (where.identifier === "reset-password:shown") queued.resolve();
      });
      const losing = first === "shown" ? verifyEmail() : reset("shown");
      if (first === "verify") await queued.promise;
      release.resolve();
      expect((await winning).status).toBe(200);
      expect((await losing).status).toBe(first === "shown" ? 200 : 400);
      expect(user().emailVerified).toBe(true);
      expect(credential().password).toBe(
        first === "shown" ? "hash:shown-password-12345" : "hash:prior-password",
      );
    },
  );
  it("preserves the pinned default denial of implicit linking to an unverified local account", async () => {
    const result = await handleOAuthUserInfo({ context } as never, {
      userInfo: { id: "idp-user", email, name: "Invitee", emailVerified: true },
      account: { providerId: "sso", accountId: "idp-user" },
      callbackURL: "https://app.example.test/",
    });
    expect(result.error).toBe("account not linked");
    expect(credential().password).toBe("hash:prior-password");
    expect(fixture.tables.account).toHaveLength(1);
    expect(user().emailVerified).toBe(false);
  });
  it("clears a pending invite's prior shown password before IdP activation, preserving the IdP session", async () => {
    await link("shown");
    expect((await reset("shown")).status).toBe(200);
    fixture.tables.apikey = [{ id: "key", referenceId: userId }];
    await idpLink();
    expect(credential().password).toBeNull();
    expect(fixture.tables.apikey).toEqual([]);
    await context.internalAdapter.updateUser(userId, { emailVerified: true });
    expect(user().emailVerified).toBe(true);
    expect(fixture.tables.verification).toEqual([]);
    const session = await runWithEndpointContext({ path: "/callback/sso", context }, () =>
      context.internalAdapter.createSession(userId),
    );
    expect(session?.userId).toBe(userId);
    expect(fixture.tables.session).toContainEqual(expect.objectContaining({ id: session!.id }));
  });
  it("revokes Chess standing credentials and 2FA for pending activation while preserving peers", async () => {
    fixture.tables.apikey = [
      { id: "key", referenceId: userId },
      { id: "peer-key", referenceId: "peer" },
    ];
    fixture.tables.deviceCode = [
      { id: "code", userId },
      { id: "peer-code", userId: "peer" },
    ];
    fixture.tables.session = [
      { id: "expired-owned", userId, expiresAt: new Date(0) },
      {
        id: "impersonated",
        userId: "peer",
        impersonatedBy: userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      { id: "peer-session", userId: "peer", expiresAt: new Date(Date.now() + 60_000) },
    ];
    fixture.tables.verification = [
      { id: "challenge", identifier: "2fa-old", value: userId },
      { id: "otp", identifier: "2fa-otp-2fa-old", value: "123456" },
      { id: "attempts", identifier: "2fa-attempts-2fa-old", value: "1" },
      { id: "fence", identifier: "2fa-old:credential:proof", value: userId },
      { id: "trust", identifier: "trust-device-old", value: userId },
      { id: "peer-challenge", identifier: "2fa-peer", value: "peer" },
      { id: "unrelated", identifier: "verify-email:unrelated", value: userId },
    ];
    await idpLink();
    expect(credential().password).toBeNull();
    expect(fixture.tables.apikey?.map((row) => row.id)).toEqual(["peer-key"]);
    expect(fixture.tables.deviceCode?.map((row) => row.id)).toEqual(["peer-code"]);
    expect(fixture.tables.session?.map((row) => row.id)).toEqual(["peer-session"]);
    expect(fixture.tables.verification?.map((row) => row.id)).toEqual([
      "peer-challenge",
      "unrelated",
    ]);
  });

  it.each(["session", "challenge"])(
    "an old-password %s delayed across SSO cleanup cannot survive",
    async (kind) => {
      const entered = deferred();
      const release = deferred();
      const request = new Request("https://app.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "prior-password" }),
      });
      const pending = withPasswordSignInFence(request, async () => {
        const hooks = context.options.databaseHooks!;
        await hooks.session!.create!.before!(
          { userId } as never,
          { path: "/sign-in/email" } as never,
        );
        entered.resolve();
        await release.promise;
        if (kind === "session") {
          fixture.tables.session!.push({ id: "late-session", userId });
          await hooks.session!.create!.after!(
            { id: "late-session", userId } as never,
            { path: "/sign-in/email" } as never,
          );
        } else {
          const row = {
            identifier: "2fa-late",
            value: userId,
            expiresAt: new Date(Date.now() + 60_000),
          };
          await fixture.client.verification.create({ data: row });
          await hooks.verification!.create!.after!(row as never);
        }
        return new Response("ok");
      });
      await entered.promise;
      await idpLink();
      release.resolve();
      expect((await pending).status).toBe(401);
      expect(fixture.tables.session).toEqual([]);
      expect(fixture.tables.verification).toEqual([]);
    },
  );
  it.each(["shown", "sso"])(
    "serializes %s first against an IdP link before verification",
    async (first) => {
      await link("shown");
      const entered = deferred();
      const release = deferred();
      const queued = deferred();
      if (first === "shown")
        hash.mockImplementationOnce(async (password) => {
          entered.resolve();
          await release.promise;
          return `hash:${password}`;
        });
      else
        fixture.setLockBarrier(async () => {
          entered.resolve();
          await release.promise;
        });
      const winning = first === "shown" ? reset("shown") : idpLink();
      await entered.promise;
      fixture.setReadBarrier((where) => {
        if (where.identifier === "reset-password:shown") queued.resolve();
      });
      const losing = first === "shown" ? idpLink() : reset("shown");
      if (first === "sso") await queued.promise;
      release.resolve();
      await winning;
      await losing;
      expect(credential().password).toBeNull();
      expect(fixture.tables.account?.some((row) => row.providerId === "sso")).toBe(true);
    },
  );
  it("sweeps old-proof sessions/challenges inserted while the SSO clear was uncommitted", async () => {
    fixture.controls.injectLateRows = true;
    await idpLink();
    expect(fixture.tables.session).toEqual([]);
    expect(fixture.tables.verification).toEqual([]);
  });
  it("keeps standalone signup and its locale/SMTP callbacks outside transactions", async () => {
    const result = await auth.handler(
      new Request("https://app.example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({
          name: "New",
          email: "new@example.test",
          password: "new-password-123456",
        }),
      }),
    );
    expect(result.status).toBe(200);
    expect(fixture.tables.user?.some((row) => row.email === "new@example.test")).toBe(true);
  });
  it.each([true, false])(
    "preserves active verified passwords / fresh OAuth signup (%s)",
    async (existingCredential) => {
      user().emailVerified = true;
      if (!existingCredential) fixture.tables.account = [];
      await idpLink();
      expect(
        fixture.tables.account
          ?.filter((row) => row.providerId === "credential")
          .map((row) => row.password),
      ).toEqual(existingCredential ? ["hash:prior-password"] : []);
    },
  );
  it.each(["active", "fresh"])(
    "preserves actual %s OAuth sign-in and its new session",
    async (kind) => {
      if (kind === "active") user().emailVerified = true;
      const providerEmail = kind === "active" ? email : "fresh@example.test";
      const result = await runWithEndpointContext({ path: "/callback/sso", context }, () =>
        handleOAuthUserInfo({ context } as never, {
          userInfo: { id: `idp-${kind}`, email: providerEmail, name: "OAuth", emailVerified: true },
          account: { providerId: "sso", accountId: `idp-${kind}` },
          callbackURL: "https://app.example.test/",
        }),
      );
      expect(result.error).toBeNull();
      expect(result.isRegister).toBe(kind === "fresh");
      expect(result.data?.session.userId).toBe(result.data?.user.id);
      expect(fixture.tables.session).toContainEqual(
        expect.objectContaining({ id: result.data!.session.id }),
      );
      expect(credential().password).toBe("hash:prior-password");
    },
  );

  it("rolls back a failed IdP insertion together with pending password clearing and standing credentials", async () => {
    await link("shown");
    fixture.tables.apikey = [{ id: "key", referenceId: userId }];
    fixture.controls.failAfterCallback = true;
    await expect(idpLink()).rejects.toThrow("fixture commit failure");
    expect(credential().password).toBe("hash:prior-password");
    expect(fixture.tables.apikey).toHaveLength(1);
    expect(fixture.tables.account).toHaveLength(1);
    expect(fixture.tables.verification).toContainEqual(
      expect.objectContaining({ identifier: "reset-password:shown" }),
    );
    await idpLink();
    expect(credential().password).toBeNull();
    expect(fixture.tables.apikey).toEqual([]);
  });

  it("routes verifying updateMany through the same activation transaction and setup decision", async () => {
    await link("shown");
    fixture.events.length = 0;
    await context.adapter.updateMany({
      model: "user",
      where: [{ field: "email", value: email }],
      update: { emailVerified: true },
    });
    expect(fixture.events[0]).toBe(`password-write:${userId}`);
    expect(fixture.events.indexOf(`set-password-link:${userId}`)).toBeGreaterThan(0);
    expect(user().emailVerified).toBe(true);
    expect(fixture.tables.verification).toEqual([]);
  });
  it("activation competitors progress locally before the real reset consumes its reserved slot", async () => {
    await link("mailed", true);
    await link("competing");
    fixture.tables.user!.push({ id: "other", email: "other@example.test", emailVerified: false });
    const entered = deferred();
    const release = deferred();
    const resetQueued = deferred();
    const order: string[] = [];
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    const activate = () =>
      context.adapter.update({
        model: "user",
        where: [{ field: "id", value: "other" }],
        update: { emailVerified: true },
      });
    let paused = false;
    fixture.setLockBarrier(async (key) => {
      if (key !== "password-write:other" || paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    });
    hash.mockImplementationOnce(async (password) => {
      // Both calls inherit the actual password holder's ALS reservation.
      first = activate().then(() => {
        order.push("first");
      });
      await entered.promise;
      second = activate().then(() => {
        order.push("second");
      });
      return `hash:${password}`;
    });
    const transaction = context.adapter.transaction.bind(context.adapter);
    const spy = vi.spyOn(context.adapter, "transaction").mockImplementation((callback) => {
      const result = transaction(callback);
      resetQueued.resolve();
      return result;
    });
    const spending = reset("mailed");
    try {
      await resetQueued.promise;
      expect(fixture.connections()).toBe(2);
      expect(fixture.events.filter((key) => key === "password-write:other")).toHaveLength(1);
      release.resolve();
      // This bound detects the local/global self-deadlock, not race ordering.
      await expect(
        Promise.race([
          spending.then((response) => response.status),
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve("reset stalled"), 1_000);
            timer.unref();
          }),
        ]),
      ).resolves.toBe(200);
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
      expect(user().emailVerified).toBe(true);
      expect(credential().password).toBe("hash:mailed-password-12345");
      expect(fixture.tables.verification).toEqual([]);
      expect(fixture.peak()).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });

  it("an activation borrower stays charged after its password holder exits and a queued reset progresses", async () => {
    await link("mailed", true);
    fixture.tables.user!.push({ id: "other", email: "other@example.test", emailVerified: false });
    const entered = deferred();
    const release = deferred();
    let activation!: Promise<unknown>;
    fixture.setLockBarrier(async (key) => {
      if (key !== "password-write:other") return;
      entered.resolve();
      await release.promise;
    });
    await withPasswordWriteLock(
      "/admin/set-user-password",
      new Request("https://app.example.test/api/auth/admin/set-user-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      }),
      async () => {
        activation = context.adapter.update({
          model: "user",
          where: [{ field: "id", value: "other" }],
          update: { emailVerified: true },
        });
        await entered.promise;
        return new Response("holder finished");
      },
      { getSession: async () => null },
    );
    try {
      expect(fixture.connections()).toBe(1);
      const pairAvailable = tryAcquireSlots(2);
      if (pairAvailable) releaseSlots(2);
      expect(pairAvailable).toBe(false);
      expect(tryAcquireSlots()).toBe(true);
      releaseSlots();
      const queued = deferred();
      fixture.setReadBarrier((where) => {
        if (where.identifier === "reset-password:mailed") queued.resolve();
      });
      const spending = reset("mailed");
      await queued.promise;
      expect(credential().password).toBe("hash:prior-password");
      release.resolve();
      await activation;
      expect((await spending).status).toBe(200);
      expect(credential().password).toBe("hash:mailed-password-12345");
      expect(fixture.peak()).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
      await activation;
    }
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("does not run queued account after-hooks for a reset transaction that rolled back", async () => {
    await link("mailed", true);
    const hooks = context.options.databaseHooks!.account!.update!;
    const after = vi.spyOn(hooks, "after");
    fixture.controls.failAfterCallback = true;
    try {
      expect((await reset("mailed")).status).toBe(500);
      expect(after).not.toHaveBeenCalled();
      expect(user().emailVerified).toBe(false);
      expect(credential().password).toBe("hash:prior-password");
      expect((await reset("mailed")).status).toBe(200);
      expect(after).toHaveBeenCalledOnce();
    } finally {
      after.mockRestore();
    }
  });
  it("rolls back token, proof and verification when the password commit fails", async () => {
    await link("mailed", true);
    const update = vi
      .spyOn(context.internalAdapter, "updatePassword")
      .mockRejectedValueOnce(new Error("write unavailable"));
    expect((await reset("mailed")).status).toBe(500);
    expect(user().emailVerified).toBe(false);
    expect(credential().password).toBe("hash:prior-password");
    expect(
      fixture.tables.verification?.some((row) => row.identifier === "reset-password:mailed"),
    ).toBe(true);
    update.mockRestore();
    expect((await reset("mailed")).status).toBe(200);
    expect(user().emailVerified).toBe(true);
  });
});
