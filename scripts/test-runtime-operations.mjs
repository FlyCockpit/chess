/** Explicit operations smoke; owns disposable services and never loads the root .env. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(import.meta.url);

async function runtimeCheck(mode) {
  assert.ok(["embedded", "external"].includes(mode));
  const [{ startWorkerRuntime }, queues, { default: prisma }, health, { serverVars }] =
    await Promise.all([
      import("../apps/worker/src/runtime.ts"),
      import("../packages/queue/src/index.ts"),
      import("../packages/db/src/index.ts"),
      import("../packages/queue/src/consumer-health.ts"),
      import("../packages/env/src/vars/server.ts"),
    ]);
  assert.equal(serverVars.WORKER_MODE.parse(undefined), "embedded");
  const inventory = Object.values(queues.QUEUE_NAMES);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  // Adjacent-release regression against actual Valkey Lua: the old inventory
  // stays live while the new server needs an additional queue. Its heartbeat
  // must never admit that server, even after the old worker republishes.
  const old = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [queues.QUEUE_NAMES.chessRun],
    () => true,
  );
  await old.start();
  assert.equal(
    await health.hasExternalConsumer(queues.redisConnection, [queues.QUEUE_NAMES.chessRun]),
    true,
  );
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  const replacement = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [queues.QUEUE_NAMES.chessRun],
    () => true,
  );
  await replacement.start();
  await old.stop();
  assert.equal(
    await health.hasExternalConsumer(queues.redisConnection, [queues.QUEUE_NAMES.chessRun]),
    true,
  );
  await replacement.stop();
  const expiringQueue = `heartbeat-expiry-${randomUUID()}`;
  const expiring = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [expiringQueue],
    () => true,
  );
  await expiring.start();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), true);
  const expiryKey = `cockpit-chess:consumers:external:${expiringQueue}`;
  const [replicaId] = await queues.redisConnection.zrange(expiryKey, 0, -1);
  assert.ok(replicaId);
  // Model a crashed publisher's expired score without waiting fifteen seconds.
  // The actual production read Lua must use Redis TIME and reject that score.
  await queues.redisConnection.zadd(expiryKey, 0, replicaId);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), false);
  await expiring.stop();
  const fatal = [];
  let runtime;
  try {
    runtime = await startWorkerRuntime({
      embedded: mode === "embedded",
      onFatal: (error) => fatal.push(error),
    });
    assert.equal(runtime.isReady(), true);
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, inventory),
      mode === "external",
    );
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, [
        ...inventory,
        "next-release-queue",
      ]),
      false,
    );
    const id = `runtime-${randomUUID()}`;
    const job = await queues.reapExpiredAuthTokensQueue.add(
      "reap-expired-auth-tokens",
      { reason: "cron" },
      { jobId: id },
    );
    const deadline = Date.now() + 15_000;
    while ((await job.getState()) !== "completed" && Date.now() < deadline) await delay(50);
    assert.equal(await job.getState(), "completed");
    const completed = await queues.reapExpiredAuthTokensQueue.getJob(id);
    assert.ok(completed);
    assert.deepEqual(completed.returnvalue, {
      reason: "cron",
      deleted: { sessions: 0, verifications: 0, deviceCodes: 0, apiKeys: 0 },
    });
    const stopping = runtime.stop();
    assert.equal(runtime.isReady(), false);
    assert.equal(runtime.stop(), stopping);
    await stopping;
    assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
    await assert.rejects(
      startWorkerRuntime({ embedded: mode === "embedded", onFatal: () => {} }),
      /already started/,
    );
    assert.deepEqual(fatal, []);
    console.log(
      `${mode}: auth-token cleanup job, readiness, withdrawal, drain, and re-entry passed.`,
    );
  } finally {
    await runtime?.stop();
    await Promise.all(
      Object.values(queues)
        .filter((value) => value instanceof queues.Queue)
        .map((queue) => queue.close()),
    );
    queues.redisConnection.disconnect();
    await prisma.$disconnect();
  }
}

/**
 * SEC-03 on real Postgres with the real Better-Auth handler: device-flow token
 * redemption and password-reset revocation share one per-user advisory lock,
 * so a redemption that claimed its code just before the revocation cannot
 * insert its session just after it.
 */
async function deviceFlowRaceCheck() {
  const [{ auth }, lock, revocation, { default: prisma }, cli, { loadPg }] = await Promise.all([
    import("../packages/auth/src/index.ts"),
    import("../packages/auth/src/device-redemption-lock.ts"),
    import("../packages/auth/src/credential-revocation.ts"),
    import("../packages/db/src/index.ts"),
    import("../packages/config/src/cli.ts"),
    import("./db/lib/prisma.mjs"),
  ]);
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  const userId = `race-${randomUUID()}`;
  const deviceSessions = () =>
    prisma.session.count({ where: { userId, origin: cli.DEVICE_FLOW_SESSION_ORIGIN } });
  const approvedCode = async () => {
    const deviceCode = randomUUID();
    await prisma.deviceCode.create({
      data: {
        deviceCode,
        userCode: randomUUID().slice(0, 8),
        userId,
        status: "approved",
        clientId: cli.CLI_CLIENT_ID,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return deviceCode;
  };
  const tokenRequest = (deviceCode) =>
    new Request(`${process.env.BETTER_AUTH_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: cli.CLI_CLIENT_ID,
      }),
    });
  const redeem = (deviceCode) => {
    const request = tokenRequest(deviceCode);
    return lock.withDeviceRedemptionLock(request, () => auth.handler(request));
  };
  /** Poll pg_locks until `predicate(rows)`; the race is staged, not timed. */
  const waitForLocks = async (label, predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await observer.query(
        `SELECT l.locktype, l.granted, a.query FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()`,
      );
      if (predicate(rows)) return;
      await delay(25);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  };
  try {
    await prisma.user.create({
      data: { id: userId, name: "Race", email: `${userId}@example.test`, emailVerified: true },
    });

    // 1. The normal login works through the lock and is tagged as a CLI session.
    const ok = await redeem(await approvedCode());
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.ok((await ok.json()).access_token);
    assert.equal(await deviceSessions(), 1);

    // 2. A redemption that reaches Better-Auth without the lock mints nothing.
    const unlocked = await auth.handler(tokenRequest(await approvedCode()));
    assert.notEqual(unlocked.status, 200);
    assert.equal(await deviceSessions(), 1);

    // 3. The race: the redemption has claimed its code and is about to insert
    //    its session (held there by a row lock on the user) when the password
    //    reset's revocation starts. The revocation must wait for the lock and
    //    then delete that session.
    const racing = await approvedCode();
    const concurrent = await approvedCode();
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      // FOR UPDATE blocks the session insert's foreign-key check (KEY SHARE).
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM "user" WHERE id = $1 FOR UPDATE`, [userId]);
      const pending = redeem(racing);
      await waitForLocks(
        "redemption holding the advisory lock, its session insert blocked",
        (rows) =>
          rows.some((r) => r.locktype === "advisory" && r.granted) &&
          rows.some((r) => !r.granted && /INSERT INTO "public"\."session"/i.test(r.query)),
      );
      // A second login for the same user does not queue behind the lock (a
      // waiter would pin a pooled connection); it is told to poll again.
      const busy = await redeem(concurrent);
      assert.equal(busy.status, 400);
      assert.equal((await busy.json()).error, "slow_down");
      await prisma.deviceCode.deleteMany({ where: { deviceCode: concurrent } });
      assert.equal(
        await prisma.deviceCode.count({ where: { userId } }),
        0,
        "the code is already claimed, so revocation alone would find nothing to delete",
      );
      const revoking = revocation.revokeCredentialsAfterPasswordReset(userId);
      await waitForLocks("revocation waiting on the advisory lock", (rows) =>
        rows.some((r) => r.locktype === "advisory" && !r.granted),
      );
      await holder.query("COMMIT");
      const raced = await pending;
      assert.equal(raced.status, 200, "the redemption itself completes");
      const { access_token: token } = await raced.json();
      await revoking;
      assert.equal(await deviceSessions(), 0, "revocation removed the session minted under it");
      assert.equal(await prisma.session.count({ where: { token } }), 0);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }

    // 4. Revocation first: the approved code is gone, so redemption is refused.
    const late = await approvedCode();
    await revocation.revokeCredentialsAfterPasswordReset(userId);
    const refused = await redeem(late);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "invalid_grant");
    assert.equal(await deviceSessions(), 0);
    console.log("device flow: redemption and revocation serialize on real Postgres (5 cases).");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
    await observer.end();
    await prisma.$disconnect();
  }
}

async function passwordSignInRaceCheck() {
  const [{ auth }, fence, writeLock, links, { default: prisma }] = await Promise.all([
    import("../packages/auth/src/index.ts"),
    import("../packages/auth/src/password-sign-in-fence.ts"),
    import("../packages/auth/src/password-write-lock.ts"),
    import("../packages/auth/src/password-reset-links.ts"),
    import("../packages/db/src/index.ts"),
  ]);
  const context = await auth.$context;
  const oldPassword = "disposable-old-proof-password-13579";
  const newPassword = "disposable-new-proof-password-24680";
  const oldHash = await context.password.hash(oldPassword);
  const created = [];
  const hooks = context.options.databaseHooks.session.create;
  const originalBefore = hooks.before;
  const originalVerify = context.password.verify;
  const request = (path, body, cookie = "") =>
    new Request(`${process.env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: process.env.BETTER_AUTH_URL,
        cookie,
      },
      body: JSON.stringify(body),
    });
  const send = (path, body, cookie) => {
    const req = request(path, body, cookie);
    if (path === "/sign-in/email")
      return fence.withPasswordSignInFence(req, () => auth.handler(req));
    return writeLock.withPasswordWriteLock(path, req, () => auth.handler(req), {
      getSession: (headers) => auth.api.getSession({ headers }),
    });
  };
  const fixtureUser = async (label, role = "user") => {
    const id = `password-race-${label}-${randomUUID()}`;
    created.push(id);
    const email = `${id}@example.test`;
    await prisma.user.create({
      data: { id, name: "Password race", email, emailVerified: true, role },
    });
    await prisma.account.create({
      data: {
        id: randomUUID(),
        accountId: id,
        userId: id,
        providerId: "credential",
        password: oldHash,
      },
    });
    return { id, email };
  };
  const signedIn = async (user) => {
    const response = await send("/sign-in/email", { email: user.email, password: oldPassword });
    assert.equal(response.status, 200, "fixture's normal sign-in succeeds");
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie.includes("session_token="));
    return cookie;
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  try {
    // This tests the production Better Auth admin role check. Hono's separate
    // HTTP admin/forced-2FA gate is covered by its own named gate tests.
    const adminCookie = await signedIn(await fixtureUser("admin", "admin"));
    for (const writer of ["change-keep", "change-revoke", "reset", "admin-reset"]) {
      for (const point of ["verified", "before-insert"]) {
        const user = await fixtureUser(`${writer}-${point}`);
        const writerCookie = await signedIn(user);
        await prisma.session.createMany({
          data: [
            {
              id: randomUUID(),
              userId: user.id,
              token: randomUUID(),
              expiresAt: new Date(Date.now() + 60_000),
            },
            {
              id: randomUUID(),
              userId: user.id,
              token: randomUUID(),
              origin: "device-flow",
              expiresAt: new Date(Date.now() + 60_000),
            },
          ],
        });
        await prisma.apiKey.create({ data: { referenceId: user.id, key: randomUUID() } });
        await prisma.deviceCode.create({
          data: {
            userId: user.id,
            deviceCode: randomUUID(),
            userCode: randomUUID(),
            status: "approved",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        const challenge = `2fa-${randomUUID()}`;
        await prisma.verification.create({
          data: { identifier: challenge, value: user.id, expiresAt: new Date(Date.now() + 60_000) },
        });
        const reached = deferred();
        const released = deferred();
        let armed = true;
        if (point === "verified") {
          context.password.verify = async (input) => {
            const valid = await originalVerify(input);
            if (armed && valid && input.hash === oldHash && input.password === oldPassword) {
              armed = false;
              reached.resolve();
              await released.promise;
            }
            return valid;
          };
        } else {
          hooks.before = async (session, endpoint) => {
            const result = await originalBefore(session, endpoint);
            if (armed && session.userId === user.id && endpoint?.path === "/sign-in/email") {
              armed = false;
              reached.resolve();
              await released.promise;
            }
            return result;
          };
        }
        const signingIn = send("/sign-in/email", { email: user.email, password: oldPassword });
        try {
          // A failure before the pause must fail promptly instead of hanging.
          await Promise.race([
            reached.promise,
            signingIn.then(() => {
              throw new Error("Sign-in finished before its pause point");
            }),
          ]);
          let changed;
          if (writer.startsWith("change-")) {
            changed = await send(
              "/change-password",
              {
                currentPassword: oldPassword,
                newPassword,
                revokeOtherSessions: writer === "change-revoke",
              },
              writerCookie,
            );
          } else if (writer === "reset") {
            const token = randomUUID();
            await prisma.verification.create({
              data: {
                identifier: `reset-password:${token}`,
                value: user.id,
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            assert.equal(
              await links.recordResetLinkMailed({ token, userId: user.id, email: user.email }),
              true,
            );
            changed = await send("/reset-password", { token, newPassword });
          } else {
            changed = await send(
              "/admin/set-user-password",
              { userId: user.id, newPassword },
              adminCookie,
            );
          }
          assert.equal(changed.status, 200, `${writer} completes while old proof is paused`);
          const credential = await prisma.account.findFirstOrThrow({
            where: { userId: user.id, providerId: "credential" },
          });
          assert.notEqual(credential.password, oldHash, "the password write is committed");
          assert.equal(
            await originalVerify({ hash: credential.password, password: newPassword }),
            true,
          );
          const isReset = writer === "reset" || writer === "admin-reset";
          const revoked = isReset || writer === "change-revoke";
          const expectedSessions = isReset ? 0 : writer === "change-revoke" ? 1 : 3;
          assert.equal(
            await prisma.session.count({ where: { userId: user.id } }),
            expectedSessions,
            `${writer}: established sessions follow policy`,
          );
          assert.equal(
            await prisma.apiKey.count({ where: { referenceId: user.id } }),
            revoked ? 0 : 1,
            `${writer}: standing API keys follow policy`,
          );
          assert.equal(
            await prisma.deviceCode.count({ where: { userId: user.id } }),
            revoked ? 0 : 1,
            `${writer}: approved device codes follow policy`,
          );
          if (isReset) {
            assert.equal(
              await prisma.verification.count({ where: { identifier: challenge } }),
              0,
              `${writer}: pending second-factor proof is revoked`,
            );
          }
          released.resolve();
          const raced = await signingIn;
          assert.equal(raced.status, 401, `${writer}/${point}: old proof is refused`);
          assert.equal((await raced.json()).code, "INVALID_EMAIL_OR_PASSWORD");
          assert.deepEqual(
            raced.headers.getSetCookie(),
            [],
            "a refused sign-in returns no cookies",
          );
          assert.equal(
            await prisma.session.count({ where: { userId: user.id } }),
            expectedSessions,
            "the delayed insert leaves no extra session",
          );
          console.log(
            `password sign-in: ${writer}/${point} refused the old proof on real PostgreSQL.`,
          );
        } finally {
          released.resolve();
          await signingIn.catch(() => {});
          context.password.verify = originalVerify;
          hooks.before = originalBefore;
        }
      }
    }
  } finally {
    context.password.verify = originalVerify;
    hooks.before = originalBefore;
    await prisma.verification.deleteMany({ where: { value: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  }
}

/**
 * Admin invites on real Postgres with the real Better-Auth handler: only a
 * mailed link verifies the email, neither a resend racing the invitee's own
 * password setup nor ordinary email verification leaves a working link to an
 * activated account, and a revealed link is refused once the account is
 * active. Every side takes the per-user set-password-link lock
 * (packages/auth/src/set-password-link-lock.ts, password-reset-links.ts).
 *
 * Resets go through the password-write lock exactly as apps/server mounts it
 * (`withPasswordWriteLock` around the Better-Auth handler): the account hooks
 * refuse a password write outside it.
 */
async function inviteRaceCheck() {
  const [{ auth }, links, linkLock, writeLock, setPassword, { default: prisma }, { loadPg }] =
    await Promise.all([
      import("../packages/auth/src/index.ts"),
      import("../packages/auth/src/password-reset-links.ts"),
      import("../packages/auth/src/set-password-link-lock.ts"),
      import("../packages/auth/src/password-write-lock.ts"),
      import("../packages/api/src/lib/set-password-link.ts"),
      import("../packages/db/src/index.ts"),
      import("./db/lib/prisma.mjs"),
    ]);
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  const created = [];
  const invitee = async (label) => {
    const id = `invite-${label}-${randomUUID()}`;
    created.push(id);
    await prisma.user.create({
      data: { id, name: "Invitee", email: `${id}@example.test`, emailVerified: false },
    });
    // users.invite's unusable password: a credential nobody holds.
    await prisma.account.create({
      data: {
        id: randomUUID(),
        userId: id,
        accountId: id,
        providerId: "credential",
        password: await auth.$context.then((c) => c.password.hash(randomUUID())),
      },
    });
    return { id, email: `${id}@example.test` };
  };
  const tokenOf = (url) => new URL(url).pathname.split("/").at(-1);
  const mint = async (user, { mailed }) => {
    const link = await setPassword.createSetPasswordLink({ userId: user.id, locale: "en-US" });
    assert.equal(tokenOf(link.url), link.token);
    if (mailed) {
      assert.equal(
        await links.recordResetLinkMailed({
          token: link.token,
          userId: user.id,
          email: user.email,
        }),
        true,
      );
    }
    return link.token;
  };
  // As apps/server mounts it: POST /reset-password runs holding the target
  // user's password-write lock.
  const spend = (token, newPassword = `invitee-${randomUUID()}`) => {
    const request = new Request(`${process.env.BETTER_AUTH_URL}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: process.env.BETTER_AUTH_URL },
      body: JSON.stringify({ token, newPassword }),
    });
    return writeLock.withPasswordWriteLock(
      links.RESET_PASSWORD_PATH,
      request,
      () => auth.handler(request),
      { getSession: (headers) => auth.api.getSession({ headers }) },
    );
  };
  const verified = async (user) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified;
  const resetLinks = (user) =>
    prisma.verification.count({
      where: {
        value: user.id,
        identifier: { startsWith: linkLock.RESET_PASSWORD_IDENTIFIER_PREFIX },
      },
    });
  const waitForAdvisoryWaiters = async (label, count) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await observer.query(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`,
      );
      if (rows[0].n >= count) return;
      await delay(25);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  };
  try {
    // 1. A mailed invite link verifies the email once spent; the account is
    //    then active, so a resend is refused under the lock.
    const mailedUser = await invitee("mailed");
    const ok = await spend(await mint(mailedUser, { mailed: true }));
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(await verified(mailedUser), true, "a mailed link verifies the email");
    await assert.rejects(
      setPassword.createSetPasswordLink({ userId: mailedUser.id, locale: "en-US" }),
      setPassword.SetPasswordLinkRefusedError,
    );
    assert.equal(await resetLinks(mailedUser), 0);

    // 2. A link revealed to the admin sets the password, verifies nothing, and
    //    leaves the invite pending: a mailed resend then verifies.
    const shownUser = await invitee("shown");
    const shown = await spend(await mint(shownUser, { mailed: false }));
    assert.equal(shown.status, 200, await shown.clone().text());
    assert.equal(await verified(shownUser), false, "a revealed link proves no mailbox");
    const resent = await spend(await mint(shownUser, { mailed: true }));
    assert.equal(resent.status, 200, await resent.clone().text());
    assert.equal(await verified(shownUser), true);

    // 3. The race: the invitee spends a mailed link while an admin resends.
    //    A holder keeps the set-password-link lock, so the reset's revocation
    //    (inside its password-write lock) and the resend both queue behind
    //    it; whatever order they then run in, the account ends verified with
    //    no working reset link.
    const racedUser = await invitee("raced");
    const racedToken = await mint(racedUser, { mailed: true });
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        linkLock.setPasswordLinkLockKey(racedUser.id),
      ]);
      const resetting = spend(racedToken);
      await waitForAdvisoryWaiters("the reset waiting on the set-password-link lock", 1);
      const resending = setPassword
        .createSetPasswordLink({ userId: racedUser.id, locale: "en-US" })
        .then(
          (link) => ({ token: link.token }),
          (error) => ({ error }),
        );
      await holder.query("COMMIT");
      const reset = await resetting;
      assert.equal(reset.status, 200, await reset.clone().text());
      const resend = await resending;
      assert.equal(await verified(racedUser), true);
      assert.equal(await resetLinks(racedUser), 0, "no reset link outlives the activation");
      if (resend.token) {
        const late = await spend(resend.token);
        assert.equal(late.status, 400, "the raced resend's link is dead");
      } else {
        assert.ok(resend.error instanceof setPassword.SetPasswordLinkRefusedError);
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }

    // 4. A revealed-link invitee sets a password, an admin resend during an
    //    SMTP outage reveals another link, then the invitee verifies through
    //    the ordinary verification mail: the activation deletes that leftover
    //    link (packages/auth/src/account-activation.ts), so its holder cannot
    //    replace the active account's password.
    const verifyingUser = await invitee("verify-email");
    const first = await spend(await mint(verifyingUser, { mailed: false }));
    assert.equal(first.status, 200, await first.clone().text());
    const leftover = await mint(verifyingUser, { mailed: false });
    const authApi = createRequire(
      new URL("../packages/auth/package.json", import.meta.url),
    ).resolve("better-auth/api");
    const { createEmailVerificationToken } = await import(authApi);
    const verifyToken = await createEmailVerificationToken(
      (await auth.$context).secret,
      verifyingUser.email,
    );
    const verifiedRes = await auth.handler(
      new Request(
        `${process.env.BETTER_AUTH_URL}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`,
      ),
    );
    assert.equal(verifiedRes.status, 200, await verifiedRes.clone().text());
    assert.equal(await verified(verifyingUser), true);
    assert.equal(await resetLinks(verifyingUser), 0, "verification deletes leftover reset links");
    assert.equal((await spend(leftover)).status, 400, "the revealed resend link is dead");
    await assert.rejects(
      setPassword.createSetPasswordLink({ userId: verifyingUser.id, locale: "en-US" }),
      setPassword.SetPasswordLinkRefusedError,
    );

    // 5. Correctness does not hang on that cleanup: a revealed link that
    //    survived it (written here as if every cleanup attempt had failed) is
    //    refused at redemption and deleted, while a mailed forgot-password
    //    link still resets the active account.
    const linkRow = async (user, token) =>
      prisma.verification.create({
        data: {
          identifier: `${linkLock.RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`,
          value: user.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    const survivor = `survivor-${randomUUID()}`;
    await linkRow(verifyingUser, survivor);
    const refused = await spend(survivor);
    assert.equal(refused.status, 400, "a revealed link to an active account is refused");
    assert.equal((await refused.json()).code, "INVALID_TOKEN");
    assert.equal(await resetLinks(verifyingUser), 0, "the refused link is deleted");
    const forgot = `forgot-${randomUUID()}`;
    await linkRow(verifyingUser, forgot);
    assert.equal(
      await links.recordResetLinkMailed({
        token: forgot,
        userId: verifyingUser.id,
        email: verifyingUser.email,
      }),
      true,
    );
    const forgotRes = await spend(forgot);
    assert.equal(forgotRes.status, 200, await forgotRes.clone().text());
    // 6. Both reset orders, blocked at the REAL setup lock. Two independent
    // tokens model a shown invite and request-password-reset's mailed link.
    // The observer barrier establishes the first spend before starting the other.
    const passwordWorks = async (user, password) => {
      const account = await prisma.account.findFirst({
        where: { userId: user.id, providerId: "credential" },
      });
      return (
        !!account?.password &&
        (await auth.$context).password.verify({ hash: account.password, password })
      );
    };
    for (const first of ["shown", "mailed"]) {
      const user = await invitee(`two-token-${first}`);
      const shown = `shown-${randomUUID()}`;
      const mailed = `mailed-${randomUUID()}`;
      await linkRow(user, shown);
      await linkRow(user, mailed);
      await links.recordResetLinkMailed({ token: mailed, userId: user.id, email: user.email });
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `set-password-link:${user.id}`,
        ]);
        const winning = spend(first === "shown" ? shown : mailed, `${first}-password-12345`);
        await waitForAdvisoryWaiters("first spend at its setup decision", 1);
        const losing = spend(first === "shown" ? mailed : shown, "losing-password-12345");
        await holder.query("COMMIT");
        assert.equal((await winning).status, 200);
        assert.equal((await losing).status, 400);
        assert.equal(await verified(user), first === "mailed");
        assert.equal(await passwordWorks(user, `${first}-password-12345`), true);
        assert.equal(await passwordWorks(user, "losing-password-12345"), false);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await holder.end();
      }
    }

    // 7. Both orders of shown reset vs the REAL verify-email adapter write.
    for (const first of ["shown", "verify"]) {
      const user = await invitee(`verify-race-${first}`);
      const token = await mint(user, { mailed: false });
      const verifyToken = await createEmailVerificationToken(
        (await auth.$context).secret,
        user.email,
      );
      const verify = () =>
        auth.handler(
          new Request(
            `${process.env.BETTER_AUTH_URL}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`,
          ),
        );
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `set-password-link:${user.id}`,
        ]);
        const winning =
          first === "shown" ? spend(token, "shown-before-verification-12345") : verify();
        await waitForAdvisoryWaiters("first writer at setup, holding password-write", 1);
        const losing =
          first === "shown" ? verify() : spend(token, "refused-after-verification-12345");
        await holder.query("COMMIT");
        assert.equal((await winning).status, 200);
        assert.equal((await losing).status, first === "shown" ? 200 : 400);
        assert.equal(await verified(user), true);
        assert.equal(await passwordWorks(user, "refused-after-verification-12345"), false);
        assert.equal(
          await passwordWorks(user, "shown-before-verification-12345"),
          first === "shown",
        );
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await holder.end();
      }
    }
    // Independently prove the spend's own recheck, rather than relying on
    // the HTTP lock/pre-sweep admitting or refusing the request first.
    const recheckUser = await invitee("spend-recheck");
    const recheckToken = await mint(recheckUser, { mailed: false });
    assert.equal(await links.isResetLinkRedeemable(recheckToken), true);
    const proofHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await proofHolder.connect();
    try {
      await proofHolder.query("BEGIN");
      await proofHolder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `set-password-link:${recheckUser.id}`,
      ]);
      await proofHolder.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [
        recheckUser.id,
      ]);
      const admitted = prisma.$transaction((tx) => links.admitResetSpend(tx, recheckToken));
      await waitForAdvisoryWaiters("actual consume decision rechecking activation", 1);
      await proofHolder.query("COMMIT");
      assert.equal(await admitted, false);
    } finally {
      await proofHolder.query("ROLLBACK").catch(() => {});
      await proofHolder.end();
    }

    // 8. Real BA internal account link and its PRODUCTION adapter + hooks.
    // No provider/login bypass is added: the configured IdP owns callback proof.
    // Run the link seam directly to test a pending row even when the pinned
    // provider's default requireLocalEmailVerified refuses implicit linking.
    const ssoUser = await invitee("sso-pending");
    assert.equal(
      (await spend(await mint(ssoUser, { mailed: false }), "admin-shown-password-12345")).status,
      200,
    );
    const context = await auth.$context;
    await context.internalAdapter.createAccount({
      userId: ssoUser.id,
      providerId: "sso",
      accountId: randomUUID(),
    });
    assert.equal(await passwordWorks(ssoUser, "admin-shown-password-12345"), false);
    await context.internalAdapter.updateUser(ssoUser.id, { emailVerified: true });
    assert.equal(await verified(ssoUser), true);
    assert.equal(await resetLinks(ssoUser), 0);
    for (const first of ["shown", "sso"]) {
      const user = await invitee(`sso-race-${first}`);
      const token = await mint(user, { mailed: false });
      const linkIdp = () =>
        context.internalAdapter.createAccount({
          userId: user.id,
          providerId: "sso",
          accountId: randomUUID(),
        });
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `set-password-link:${user.id}`,
        ]);
        const winning =
          first === "shown" ? spend(token, "shown-sso-race-password-12345") : linkIdp();
        await waitForAdvisoryWaiters("first SSO/reset writer holding password-write", 1);
        const losing =
          first === "shown" ? linkIdp() : spend(token, "shown-sso-race-password-12345");
        await holder.query("COMMIT");
        const firstResult = await winning;
        const secondResult = await losing;
        assert.equal(
          first === "shown" ? firstResult.status : secondResult.status,
          first === "shown" ? 200 : 400,
        );
        assert.equal(await passwordWorks(user, "shown-sso-race-password-12345"), false);
        assert.equal(
          (await prisma.account.findFirst({ where: { userId: user.id, providerId: "credential" } }))
            .password,
          null,
        );
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await holder.end();
      }
    }
    const normalSso = await invitee("sso-existing");
    await prisma.user.update({ where: { id: normalSso.id }, data: { emailVerified: true } });
    const oldCredential = await prisma.account.findFirst({
      where: { userId: normalSso.id, providerId: "credential" },
    });
    await context.internalAdapter.createAccount({
      userId: normalSso.id,
      providerId: "sso",
      accountId: randomUUID(),
    });
    assert.equal(
      (
        await prisma.account.findFirst({
          where: { userId: normalSso.id, providerId: "credential" },
        })
      ).password,
      oldCredential.password,
    );

    // 9. A failing credential write rolls back the proof/verification/token
    // together. Only the independent revocation pre-sweep may remain committed.
    const rollbackUser = await invitee("rollback");
    const rollbackToken = await mint(rollbackUser, { mailed: true });
    const updatePassword = context.internalAdapter.updatePassword;
    try {
      context.internalAdapter.updatePassword = async () => {
        throw new Error("fixture credential-write failure");
      };
      assert.equal((await spend(rollbackToken)).status, 500);
    } finally {
      context.internalAdapter.updatePassword = updatePassword;
    }
    assert.equal(await verified(rollbackUser), false);
    assert.equal(await resetLinks(rollbackUser), 1);
    assert.equal((await spend(rollbackToken)).status, 200);
    assert.equal(await verified(rollbackUser), true);

    // 10. An old proof that passed the real session BEFORE hook, then delayed
    // its insert until after the SSO clear/sweeps, is removed by the same
    // fingerprint fence mounted by the server. No sleep orders this interleave.
    const { withPasswordSignInFence } = await import(
      "../packages/auth/src/password-sign-in-fence.ts"
    );
    for (const kind of ["session", "challenge"]) {
      const user = await invitee(`sso-fence-${kind}`);
      let enter;
      let release;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      const delayed = withPasswordSignInFence(
        new Request(`${process.env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: user.email, password: "old-proof-fixture-password" }),
        }),
        async () => {
          const hooks = context.options.databaseHooks;
          await hooks.session.create.before({ userId: user.id }, { path: "/sign-in/email" });
          enter();
          await released;
          if (kind === "session") {
            const session = await prisma.session.create({
              data: {
                id: randomUUID(),
                userId: user.id,
                token: randomUUID(),
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            await hooks.session.create.after(session, { path: "/sign-in/email" });
          } else {
            const challenge = await prisma.verification.create({
              data: {
                identifier: `2fa-${randomUUID()}`,
                value: user.id,
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            await hooks.verification.create.after(challenge);
          }
          return new Response("fixture session/challenge");
        },
      );
      await entered;
      await context.internalAdapter.createAccount({
        userId: user.id,
        providerId: "sso",
        accountId: randomUUID(),
      });
      release();
      assert.equal((await delayed).status, 401);
      assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
      assert.equal(
        await prisma.verification.count({
          where: { value: user.id, identifier: { startsWith: "2fa-" } },
        }),
        0,
      );
    }

    console.log(
      "invites: mailed-only verification, resend/reset race, activation decisions, atomic spends/rollback and pending IdP cleanup hold on real Postgres (pool max 3).",
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await observer.end();
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.argv[2] === "--runtime-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    if (process.argv[3] === "device-flow") await deviceFlowRaceCheck();
    else if (process.argv[3] === "invite-race") await inviteRaceCheck();
    else if (process.argv[3] === "password-signin-race") await passwordSignInRaceCheck();
    else await runtimeCheck(process.argv[3]);
    return;
  }
  if (process.argv[2] !== "--disposable-services") {
    throw new Error("Use node scripts/test-runtime-operations.mjs --disposable-services.");
  }
  // Container names only. TEST_CONTAINER_PREFIX (shared with backup:test and
  // db:test-migrations) keeps this run's containers under your own prefix; an
  // empty or invalid value is an error, never the default.
  const namePrefix = process.env.TEST_CONTAINER_PREFIX ?? "cockpit-chess-runtime";
  assert.match(
    namePrefix,
    /^[a-z0-9][a-z0-9_.-]*$/,
    "TEST_CONTAINER_PREFIX is a Docker name prefix ([a-z0-9][a-z0-9_.-]*)",
  );
  const environment = { PATH: process.env.PATH };
  const docker = (...args) =>
    execFileSync("docker", args, {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  for (const image of ["postgres:18-alpine", "valkey/valkey:9.1-alpine"]) {
    docker("image", "inspect", image, "--format", "{{.Id}}");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "app-runtime-operations-"));
  const containers = [];
  try {
    const password = randomUUID();
    const postgres = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `${namePrefix}-pg-${randomUUID()}`,
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:18-alpine",
    );
    containers.push(postgres);
    const redis = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `${namePrefix}-redis-${randomUUID()}`,
      "--memory",
      "64m",
      "--publish",
      "127.0.0.1::6379",
      "valkey/valkey:9.1-alpine",
      "valkey-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "32mb",
      "--maxmemory-policy",
      "noeviction",
    );
    containers.push(redis);
    const port = (id, mapping) => {
      const value = docker("port", id, mapping).split(":").at(-1);
      assert.match(value, /^\d+$/);
      return value;
    };
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port(postgres, "5432/tcp")}/postgres`;
    const redisUrl = `redis://127.0.0.1:${port(redis, "6379/tcp")}`;
    for (let attempt = 0; ; attempt++) {
      try {
        docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
        break;
      } catch {
        if (attempt === 49) throw new Error("Disposable PostgreSQL did not become ready.");
        await delay(100);
      }
    }
    // Copy the committed migration closure away from root .env; the disposable
    // fixture never discovers development credentials.
    const prismaCwd = resolve(temporary, "packages/db");
    mkdirSync(prismaCwd, { recursive: true });
    cpSync(resolve(root, "packages/db/prisma.config.ts"), resolve(prismaCwd, "prisma.config.ts"));
    cpSync(resolve(root, "packages/db/prisma/schema"), resolve(prismaCwd, "prisma/schema"), {
      recursive: true,
    });
    cpSync(
      resolve(root, "packages/db/prisma/migrations"),
      resolve(prismaCwd, "prisma/migrations"),
      {
        recursive: true,
      },
    );
    cpSync(resolve(root, "scripts/db"), resolve(temporary, "scripts/db"), { recursive: true });
    mkdirSync(resolve(temporary, "scripts/lib"), { recursive: true });
    cpSync(
      resolve(root, "scripts/lib/bounded-child.mjs"),
      resolve(temporary, "scripts/lib/bounded-child.mjs"),
    );
    cpSync(resolve(root, "packages/db/package.json"), resolve(prismaCwd, "package.json"));
    symlinkSync(
      resolve(root, "packages/db/node_modules"),
      resolve(prismaCwd, "node_modules"),
      "dir",
    );
    const fixtureEnv = {
      ...environment,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NODE_ENV: "production",
      BACKUP_ENABLED: "false",
      BACKUP_SCHEDULE: "off",
    };
    for (const operation of ["empty database", "unchanged schema"]) {
      execFileSync(
        process.execPath,
        [resolve(temporary, "scripts/db/migrate-runtime.mjs"), "apply"],
        {
          cwd: temporary,
          env: fixtureEnv,
          timeout: 180_000,
          stdio: "pipe",
        },
      );
      console.log(`Canonical apply with real Prisma: ${operation} passed.`);
    }
    // The device-flow child loads the real Better-Auth instance, which needs
    // its secret and origin; throwaway values, never the developer's.
    const deviceEnv = {
      BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
      BETTER_AUTH_URL: "https://app.example.test",
    };
    // The invite race loads the same Better-Auth instance, with its own
    // throwaway secret.
    const inviteEnv = {
      DATABASE_POOL_MAX: "3",
      BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
      BETTER_AUTH_URL: "https://app.example.test",
    };
    for (const [mode, extra] of [
      ["embedded", {}],
      ["external", {}],
      ["device-flow", deviceEnv],
      ["invite-race", inviteEnv],
      ["password-signin-race", inviteEnv],
    ]) {
      const result = execFileSync(
        process.execPath,
        ["--import", "tsx", file, "--runtime-child", mode],
        {
          cwd: root,
          env: {
            ...fixtureEnv,
            ...extra,
            RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
          },
          timeout: 45_000,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        },
      );
      process.stdout.write(result);
    }
  } finally {
    const cleanupErrors = [];
    for (const id of containers.reverse()) {
      try {
        docker("stop", "--time", "2", id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error("Disposable fixture cleanup failed; inspect this run's owned containers.");
      process.exitCode = 1;
    } else {
      console.log("Removed only this smoke run's disposable containers and temporary fixture.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime operations check failed.");
  process.exitCode = 1;
}
