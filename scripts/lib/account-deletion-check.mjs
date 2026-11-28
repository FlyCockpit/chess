/** Actual PostgreSQL access-fence races; only the owned disposable harness calls this. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function accountDeletionCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  const [
    { default: prisma },
    { requestAccountDeletion },
    { isOwnerActive, dispatchForActiveOwner },
    runners,
    locks,
    { passwordWriteLockKey },
    { saveOpenRouterConnection },
    { admitHostedMatch, CHESS_CREATE_LOCK },
    { loadPg },
    { createCredentialSetupAdapter },
  ] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/api/src/lib/account-deletion.ts"),
    import("../../packages/auth/src/account-deletion.ts"),
    import("../../packages/auth/src/runner-machine.ts"),
    import("../../packages/auth/src/device-redemption-lock.ts"),
    import("../../packages/auth/src/password-write-lock.ts"),
    import("../../packages/api/src/lib/openrouter-account.ts"),
    import("../../packages/api/src/lib/chess-locks.ts"),
    import("../db/lib/prisma.mjs"),
    import("../../packages/auth/src/credential-setup-adapter.ts"),
  ]);
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  const owners = [];
  const pending = [];
  const accountAdapter = createCredentialSetupAdapter(prisma)({});
  const idpAccount = (owner) =>
    prisma.account.create({
      data: {
        userId: owner.user.id,
        accountId: randomUUID(),
        providerId: "fixture-idp",
        issuer: "https://idp.example.test",
        accessToken: "synthetic-initial-access",
        refreshToken: "synthetic-initial-refresh",
      },
    });
  const updateIdp = (account, refreshToken = "synthetic-updated-refresh") =>
    accountAdapter.update({
      model: "account",
      where: [{ field: "id", value: account.id }],
      update: {
        providerId: account.providerId,
        accessToken: "synthetic-updated-access",
        refreshToken,
      },
    });
  const fixture = async (extra = {}) => {
    const id = `deletion-${randomUUID()}`;
    owners.push(id);
    const user = await prisma.user.create({
      data: {
        id,
        name: "Deletion fixture",
        email: `${id}@example.test`,
        emailVerified: true,
        ...extra,
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: id,
        token: randomUUID(),
        origin: "sign-in",
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, session, authority: { userId: id, sessionId: session.id } };
  };
  const settle = (promise) => {
    const tracked = promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    pending.push(tracked);
    return tracked;
  };
  const untilWaiting = async (count = 1) => {
    const deadline = Date.now() + 5000;
    do {
      const rows = await observer.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
      );
      if (rows.rows[0].n >= count) return;
      await delay(10);
    } while (Date.now() < deadline);
    throw new Error("Expected actual PostgreSQL advisory-lock wait");
  };
  const beginLock = async (key) => {
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    return blocker;
  };
  const info = {
    label: "Synthetic",
    limitMicros: null,
    limitRemainingMicros: null,
    usageMicros: null,
    usageDailyMicros: null,
    expiresAt: null,
  };
  const save = (id) => saveOpenRouterConnection(id, "synthetic-fixture-key-only", info);
  let deletionActor;
  const actorAuthority = (owner) => ({
    kind: "admin",
    userId: owner.user.id,
    sessionId: owner.session.id,
  });
  const deletion = (owner) => requestAccountDeletion(owner.user.id, actorAuthority(deletionActor));
  const matchData = (id) => ({
    ownerId: id,
    slug: `fixture-${randomUUID()}`,
    title: "Fixture",
    whiteName: "White",
    blackName: "Black",
    source: "hosted",
    status: "queued",
    rulesKey: "fixture",
    contextMode: "history",
    identityMode: "model",
    archive: {},
    credentialSource: "operator",
  });
  try {
    deletionActor = await fixture({ role: "admin", twoFactorEnabled: true });
    // Existing credentials are durably revoked; completion never reported.
    const first = await fixture();
    const firstIdp = await idpAccount(first);
    await updateIdp(firstIdp);
    assert.equal(
      (await prisma.account.findUniqueOrThrow({ where: { id: firstIdp.id } })).refreshToken,
      "synthetic-updated-refresh",
    );
    const machine = await runners.mintRunnerMachineForSession(first.authority, {
      displayName: "Fixture",
    });
    await save(first.user.id);
    const match = await prisma.chessMatch.create({ data: matchData(first.user.id) });
    const answer = await requestAccountDeletion(first.user.id, {
      kind: "self",
      sessionId: first.session.id,
    });
    assert.equal(answer.status, "pending");
    assert.equal(answer.complete, false);
    assert.equal(await isOwnerActive(first.user.id), false);
    assert.equal(await prisma.session.count({ where: { userId: first.user.id } }), 0);
    assert.equal(await prisma.openRouterConnection.count({ where: { userId: first.user.id } }), 0);
    assert.ok(
      (await prisma.runnerMachine.findUniqueOrThrow({ where: { id: machine.machine.id } }))
        .revokedAt,
    );
    assert.equal(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: match.id } })).terminalCause,
      "owner-delete",
    );
    const again = await deletion(first);
    assert.equal(again.requestedAt.getTime(), answer.requestedAt.getTime());
    assert.equal(again.complete, false);
    await assert.rejects(
      runners.mintRunnerMachineForSession(first.authority, { displayName: "Late" }),
    );
    await assert.rejects(save(first.user.id));
    await assert.rejects(updateIdp(firstIdp, "synthetic-must-not-persist"));
    assert.equal(
      (await prisma.account.findUniqueOrThrow({ where: { id: firstIdp.id } })).refreshToken,
      "synthetic-updated-refresh",
    );
    let lateSend = false;
    await assert.rejects(
      dispatchForActiveOwner(first.user.id, async () => {
        lateSend = true;
        return new Response();
      }),
    );
    assert.equal(lateSend, false);
    await assert.rejects(
      prisma.$transaction((tx) =>
        admitHostedMatch(tx, {
          ownerId: first.user.id,
          ownKey: false,
          queueMax: 100_000,
          dailyMax: 100_000,
        }),
      ),
    );

    // A deletion already queued on the real CLI lock wins over callback and mint.
    const queued = await fixture();
    const queuedIdp = await idpAccount(queued);
    const blocker = await beginLock(locks.cliCredentialLockKey(queued.user.id));
    try {
      const erasing = settle(deletion(queued));
      await untilWaiting();
      const minting = settle(
        runners.mintRunnerMachineForSession(queued.authority, { displayName: "Late" }),
      );
      const callback = settle(save(queued.user.id));
      const idpCallback = settle(updateIdp(queuedIdp, "synthetic-must-not-persist"));
      await untilWaiting(4);
      await blocker.query("ROLLBACK");
      assert.equal((await erasing).value.complete, false);
      assert.ok((await minting).error);
      assert.ok((await callback).error);
      assert.ok((await idpCallback).error);
      assert.equal(
        (await prisma.account.findUniqueOrThrow({ where: { id: queuedIdp.id } })).refreshToken,
        "synthetic-initial-refresh",
      );
      assert.equal(
        await prisma.runnerMachine.count({ where: { userId: queued.user.id, revokedAt: null } }),
        0,
      );
      assert.equal(
        await prisma.openRouterConnection.count({ where: { userId: queued.user.id } }),
        0,
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
    }

    // Reverse IdP order: a callback already queued on the lock may finish,
    // then deletion commits and every later callback is refused.
    const callbackFirst = await fixture();
    const beforeIdp = await idpAccount(callbackFirst);
    const idpBlocker = await beginLock(locks.cliCredentialLockKey(callbackFirst.user.id));
    try {
      const refreshing = settle(updateIdp(beforeIdp, "synthetic-before-deletion"));
      await untilWaiting();
      const erasing = settle(deletion(callbackFirst));
      await untilWaiting(2);
      await idpBlocker.query("ROLLBACK");
      assert.ok((await refreshing).value);
      assert.equal((await erasing).value.complete, false);
      await assert.rejects(updateIdp(beforeIdp, "synthetic-after-deletion"));
      assert.equal(
        (await prisma.account.findUniqueOrThrow({ where: { id: beforeIdp.id } })).refreshToken,
        "synthetic-before-deletion",
      );
    } finally {
      await idpBlocker.query("ROLLBACK").catch(() => {});
      await idpBlocker.end();
    }

    // Reverse order: a real mint completes while deletion waits, then is revoked.
    const mintFirst = await fixture();
    const minted = deferred();
    const finishMint = deferred();
    const minting = settle(
      locks.withCliCredentialLockSlot(() =>
        prisma.$transaction(
          async (tx) => {
            const result = await runners.mintRunnerMachineInTransaction(tx, mintFirst.authority, {
              displayName: "Before deletion",
            });
            minted.resolve(result);
            await finishMint.promise;
            return result;
          },
          { timeout: 20_000, isolationLevel: "ReadCommitted" },
        ),
      ),
    );
    const before = await minted.promise;
    const eraseMint = settle(deletion(mintFirst));
    await untilWaiting();
    finishMint.resolve();
    assert.ok((await minting).value);
    assert.equal((await eraseMint).value.complete, false);
    assert.ok(
      (await prisma.runnerMachine.findUniqueOrThrow({ where: { id: before.machine.id } }))
        .revokedAt,
    );

    // Actual request dispatch holds the same lock. Deletion waits for that
    // admitted call, then later dispatch callbacks are never invoked.
    const spending = await fixture();
    const sent = deferred();
    const response = deferred();
    const dispatching = settle(
      dispatchForActiveOwner(spending.user.id, async () => {
        sent.resolve();
        await response.promise;
        return new Response("synthetic");
      }),
    );
    await sent.promise;
    const eraseSpend = settle(deletion(spending));
    await untilWaiting();
    assert.equal(await isOwnerActive(spending.user.id), true);
    response.resolve();
    assert.ok((await dispatching).value);
    assert.equal((await eraseSpend).value.complete, false);
    let invoked = false;
    await assert.rejects(
      dispatchForActiveOwner(spending.user.id, async () => {
        invoked = true;
        return new Response();
      }),
    );
    assert.equal(invoked, false);

    // Recovery/password-write serialization: deletion cannot overtake an
    // already-held password lock, and a later reset sees its tombstone.
    const resetting = await fixture();
    const resetLock = await beginLock(passwordWriteLockKey(resetting.user.id));
    try {
      const erasing = settle(deletion(resetting));
      await untilWaiting();
      assert.equal(await isOwnerActive(resetting.user.id), true);
      await resetLock.query("ROLLBACK");
      assert.equal((await erasing).value.complete, false);
      assert.equal(await isOwnerActive(resetting.user.id), false);
    } finally {
      await resetLock.query("ROLLBACK").catch(() => {});
      await resetLock.end();
    }

    // Match admission queued behind deletion cannot create future spending.
    const admission = await fixture();
    const createLock = await beginLock(CHESS_CREATE_LOCK);
    try {
      const erasing = settle(deletion(admission));
      await untilWaiting();
      const creating = settle(
        prisma.$transaction(
          async (tx) => {
            await admitHostedMatch(tx, {
              ownerId: admission.user.id,
              ownKey: false,
              queueMax: 100_000,
              dailyMax: 100_000,
            });
            return tx.chessMatch.create({ data: matchData(admission.user.id) });
          },
          { timeout: 20_000, isolationLevel: "ReadCommitted" },
        ),
      );
      await untilWaiting(2);
      await createLock.query("ROLLBACK");
      assert.equal((await erasing).value.complete, false);
      assert.ok((await creating).error);
      assert.equal(await prisma.chessMatch.count({ where: { ownerId: admission.user.id } }), 0);
    } finally {
      await createLock.query("ROLLBACK").catch(() => {});
      await createLock.end();
    }

    // SSO uses exactly the same fresh sign-in proof; stale/browser-impersonation
    // sessions cannot set the tombstone and a retry after failure remains usable.
    const stale = await fixture();
    await prisma.session.update({
      where: { id: stale.session.id },
      data: { authenticatedAt: new Date(Date.now() - 301_000) },
    });
    await assert.rejects(
      requestAccountDeletion(stale.user.id, { kind: "self", sessionId: stale.session.id }),
      (error) => error.data?.reason === "REAUTH_REQUIRED",
    );
    assert.equal(await isOwnerActive(stale.user.id), true);
    await prisma.session.update({
      where: { id: stale.session.id },
      data: { authenticatedAt: new Date() },
    });
    assert.equal(
      (await requestAccountDeletion(stale.user.id, { kind: "self", sessionId: stale.session.id }))
        .complete,
      false,
    );
    // A new session row from an old SSO enrollment rotation cannot refresh
    // the primary-authentication proof. Unknown provenance is also refused.
    const rotated = await fixture();
    await prisma.session.update({
      where: { id: rotated.session.id },
      data: { authenticatedAt: new Date(Date.now() - 86_400_000) },
    });
    const { sessionAuthenticationTime } = await import(
      "../../packages/auth/src/password-sign-in-fence.ts"
    );
    const inherited = await sessionAuthenticationTime(
      { userId: rotated.user.id },
      {
        path: "/two-factor/enable",
        context: { session: { session: { id: rotated.session.id, userId: rotated.user.id } } },
      },
    );
    const rotatedSession = await prisma.session.create({
      data: {
        userId: rotated.user.id,
        token: randomUUID(),
        origin: "sign-in",
        authenticatedAt: inherited,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await assert.rejects(
      requestAccountDeletion(rotated.user.id, { kind: "self", sessionId: rotatedSession.id }),
      (error) => error.data?.reason === "REAUTH_REQUIRED",
    );
    await prisma.session.update({
      where: { id: rotatedSession.id },
      data: { authenticatedAt: null },
    });
    await assert.rejects(
      requestAccountDeletion(rotated.user.id, { kind: "self", sessionId: rotatedSession.id }),
      (error) => error.data?.reason === "REAUTH_REQUIRED",
    );
    const freshIdp = await sessionAuthenticationTime(
      { userId: rotated.user.id },
      { path: "/callback/sso" },
    );
    await prisma.session.update({
      where: { id: rotatedSession.id },
      data: { authenticatedAt: freshIdp },
    });
    assert.equal(
      (
        await requestAccountDeletion(rotated.user.id, {
          kind: "self",
          sessionId: rotatedSession.id,
        })
      ).complete,
      false,
    );

    const [{ usersRouter }, orpc] = await Promise.all([
      import("../../packages/api/src/routers/users.ts"),
      import(
        (await import("node:module"))
          .createRequire(new URL("../../packages/api/package.json", import.meta.url))
          .resolve("@orpc/server")
      ),
    ]);
    const client = (owner) =>
      orpc.createRouterClient(usersRouter, {
        context: { session: { user: owner.user, session: owner.session } },
      });
    const waitBlockedBy = async (blocker) => {
      const until = Date.now() + 5000;
      do {
        const result = await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))",
          [blocker.processID],
        );
        if (result.rows.length) return;
        await delay(10);
      } while (Date.now() < until);
      throw new Error("Expected actual row-lock waiter");
    };
    const rowLock = async (userId) => {
      const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [userId]);
      return blocker;
    };

    // Destructive intent queued on target locks must not retain a demoted actor.
    const demoted = await fixture({ role: "admin", twoFactorEnabled: true });
    const removalTarget = await fixture();
    const removeBlocker = await beginLock(passwordWriteLockKey(removalTarget.user.id));
    try {
      const removing = settle(client(demoted).remove({ userId: removalTarget.user.id }));
      await untilWaiting();
      await client(deletionActor).setRole({ userId: demoted.user.id, role: "user" });
      await removeBlocker.query("ROLLBACK");
      assert.ok((await removing).error, "Demoted actor's queued removal must fail");
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: removalTarget.user.id } }))
          .deletionRequestedAt,
        null,
      );
    } finally {
      await removeBlocker.query("ROLLBACK").catch(() => {});
      await removeBlocker.end();
    }

    // Session revocation while an archive waits must be visible at its effect.
    const signedOut = await fixture({ role: "admin", twoFactorEnabled: true });
    const archiveTarget = await fixture();
    const archiveBlocker = await beginLock(locks.cliCredentialLockKey(archiveTarget.user.id));
    try {
      const archiving = settle(client(signedOut).archive({ userId: archiveTarget.user.id }));
      await untilWaiting();
      await prisma.session.delete({ where: { id: signedOut.session.id } });
      await archiveBlocker.query("ROLLBACK");
      assert.ok((await archiving).error, "Revoked actor session must not archive");
      assert.notEqual(
        (await prisma.user.findUniqueOrThrow({ where: { id: archiveTarget.user.id } })).banned,
        true,
      );
    } finally {
      await archiveBlocker.query("ROLLBACK").catch(() => {});
      await archiveBlocker.end();
    }

    // A role write cannot use a stale actor snapshot when the actor row changed
    // while its locking read waited; Serializable may reject instead of rereading.
    const roleActor = await fixture({ role: "admin", twoFactorEnabled: true });
    const roleTarget = await fixture();
    const roleBlocker = await rowLock(roleActor.user.id);
    try {
      const promoting = settle(
        client(roleActor).setRole({ userId: roleTarget.user.id, role: "admin" }),
      );
      await waitBlockedBy(roleBlocker);
      await roleBlocker.query('UPDATE "user" SET role = $1 WHERE id = $2', [
        "user",
        roleActor.user.id,
      ]);
      await roleBlocker.query("COMMIT");
      assert.ok((await promoting).error, "Role mutation with revoked actor must fail");
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: roleTarget.user.id } })).role,
        "user",
      );
    } finally {
      await roleBlocker.query("ROLLBACK").catch(() => {});
      await roleBlocker.end();
    }

    // Reverse order: already-admitted effects retain their actor User+Session
    // shares until commit, so either kind of revocation waits behind the effect.
    for (const revoke of ["role", "session"]) {
      const actor = await fixture({ role: "admin", twoFactorEnabled: true });
      const target = await fixture();
      const blocker = await rowLock(target.user.id);
      try {
        const removing = settle(client(actor).remove({ userId: target.user.id }));
        await waitBlockedBy(blocker);
        const revoking = settle(
          revoke === "role"
            ? prisma.user.update({ where: { id: actor.user.id }, data: { role: "user" } })
            : prisma.session.delete({ where: { id: actor.session.id } }),
        );
        const until = Date.now() + 5000;
        for (;;) {
          const result = await observer.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          if (result.rows[0].n >= 2) break;
          if (Date.now() > until)
            throw new Error("Actor revocation did not wait for admitted effect");
          await delay(10);
        }
        await blocker.query("COMMIT");
        assert.equal((await removing).value.complete, false);
        assert.ok((await revoking).value);
        assert.ok(
          (await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } }))
            .deletionRequestedAt,
        );
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
      }
    }
    // Restore is an access-grant sibling, so it uses the same locked actor
    // assertion without the last-admin removal semantics.
    const restoringActor = await fixture({ role: "admin", twoFactorEnabled: true });
    const restoreTarget = await fixture({ banned: true, banExpires: null });
    const restoreBlocker = await rowLock(restoringActor.user.id);
    try {
      const restoring = settle(client(restoringActor).unarchive({ userId: restoreTarget.user.id }));
      await waitBlockedBy(restoreBlocker);
      await restoreBlocker.query('UPDATE "user" SET role = $1 WHERE id = $2', [
        "user",
        restoringActor.user.id,
      ]);
      await restoreBlocker.query("COMMIT");
      assert.ok((await restoring).error, "Revoked actor cannot restore an account");
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: restoreTarget.user.id } })).banned,
        true,
      );
    } finally {
      await restoreBlocker.query("ROLLBACK").catch(() => {});
      await restoreBlocker.end();
    }
    await client(deletionActor).unarchive({ userId: restoreTarget.user.id });
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: restoreTarget.user.id } })).banned,
      false,
    );
    const pendingRestore = await fixture({
      banned: true,
      deletionRequestedAt: new Date(),
      deletionState: "pending",
    });
    await client(deletionActor).unarchive({ userId: pendingRestore.user.id });
    assert.equal(
      await isOwnerActive(pendingRestore.user.id),
      false,
      "Restore cannot clear deletion authority fence",
    );

    // Actual Better-Auth admin invite hashes before the raw adapter effect.
    // A pending actor while that effect waits cannot insert even an admin row.
    const inviteActor = await fixture({ role: "admin", twoFactorEnabled: true });
    const inviteEmail = `${randomUUID()}@example.test`;
    const inviteBlocker = await rowLock(inviteActor.user.id);
    try {
      const inviting = settle(
        client(inviteActor).invite({
          email: inviteEmail,
          name: "Late admin",
          role: "admin",
          locale: "en-US",
        }),
      );
      await waitBlockedBy(inviteBlocker);
      await inviteBlocker.query(
        'UPDATE "user" SET "deletionRequestedAt" = now(), "deletionState" = $1 WHERE id = $2',
        ["pending", inviteActor.user.id],
      );
      await inviteBlocker.query("COMMIT");
      assert.ok((await inviting).error, "Pending administrator cannot insert an invited admin");
      assert.equal(await prisma.user.count({ where: { email: inviteEmail } }), 0);
    } finally {
      await inviteBlocker.query("ROLLBACK").catch(() => {});
      await inviteBlocker.end();
    }
    const activeInvite = await client(deletionActor).invite({
      email: `${randomUUID()}@example.test`,
      name: "Authorized invite",
      role: "admin",
      locale: "es-MX",
    });
    owners.push(activeInvite.userId);
    const invitedUser = await prisma.user.findUniqueOrThrow({ where: { id: activeInvite.userId } });
    assert.equal(invitedUser.role, "admin");
    assert.equal(invitedUser.locale, "es-MX");
    assert.equal(invitedUser.emailVerified, false);
    assert.equal(
      activeInvite.emailSent,
      false,
      "Owned fixture uses no SMTP and returns a setup link",
    );
    await client(deletionActor).resendInvite({ userId: invitedUser.id });
    const linksBefore = await prisma.verification.findMany({
      where: { value: invitedUser.id, identifier: { startsWith: "reset-password:" } },
      take: 10,
      orderBy: { id: "asc" },
      select: { id: true, identifier: true },
    });
    const resendActor = await fixture({ role: "admin", twoFactorEnabled: true });
    const resendBlocker = await rowLock(resendActor.user.id);
    try {
      const resending = settle(client(resendActor).resendInvite({ userId: invitedUser.id }));
      await waitBlockedBy(resendBlocker);
      await resendBlocker.query(
        'UPDATE "user" SET "deletionRequestedAt" = now(), "deletionState" = $1 WHERE id = $2',
        ["pending", resendActor.user.id],
      );
      await resendBlocker.query("COMMIT");
      assert.ok(
        (await resending).error,
        "Pending administrator cannot mint a replacement invite proof",
      );
      const linksAfter = await prisma.verification.findMany({
        where: { value: invitedUser.id, identifier: { startsWith: "reset-password:" } },
        take: 10,
        orderBy: { id: "asc" },
        select: { id: true, identifier: true },
      });
      assert.deepEqual(linksAfter, linksBefore);
    } finally {
      await resendBlocker.query("ROLLBACK").catch(() => {});
      await resendBlocker.end();
    }

    // Reciprocal removals hold distinct target advisory locks but serialize
    // on admission before taking actor row shares. They cannot both commit.
    const reciprocalA = await fixture({ role: "admin", twoFactorEnabled: true });
    const reciprocalB = await fixture({ role: "admin", twoFactorEnabled: true });
    const reciprocal = await Promise.all([
      settle(client(reciprocalA).remove({ userId: reciprocalB.user.id })),
      settle(client(reciprocalB).remove({ userId: reciprocalA.user.id })),
    ]);
    assert.equal(reciprocal.filter((result) => result.value).length, 1);
    assert.equal(reciprocal.filter((result) => result.error).length, 1);
    assert.equal(
      await prisma.user.count({
        where: {
          id: { in: [reciprocalA.user.id, reciprocalB.user.id] },
          deletionRequestedAt: { not: null },
        },
      }),
      1,
    );
    console.log(
      "Admin effects: actual PG remove/demotion, archive/session-revoke, role/row-lock races and reverse User+Session fences passed.",
    );
    const [{ chessRouter }, chess, human, { chessRunQueue }] = await Promise.all([
      import("../../packages/api/src/routers/chess.ts"),
      import("../../packages/chess/src/index.ts"),
      import("../../packages/api/src/lib/chess-human.ts"),
      import("../../packages/queue/src/index.ts"),
    ]);
    const humanClient = (owner, session = owner.session) =>
      orpc.createRouterClient(chessRouter, {
        // Capture the pre-deletion identity to exercise the handler's durable fence.
        context: { session: { user: owner.user, session } },
      });
    const parkedHuman = async (owner) => {
      const archive = chess.createMatch(
        {
          white: { name: "Human fixture", model: "human", protocol: "human" },
          black: { name: "Model fixture", model: "fixture/model", protocol: "openai-chat" },
          rules: {},
        },
        "hosted",
      );
      chess.beginHostedTurn(archive);
      assert.equal(archive.turn.type, "human");
      const row = await prisma.chessMatch.create({
        data: {
          ...matchData(owner.user.id),
          status: "running",
          contextMode: archive.config.rules.context,
          identityMode: archive.config.rules.opponentIdentity,
          rulesVersion: archive.config.rules.version,
          promptVersion: archive.config.prompt.version,
          promptHash: archive.config.prompt.hash,
          ...human.chessTurnData(archive.turn),
          archive,
        },
      });
      return {
        row,
        archive,
        input: {
          slug: row.slug,
          turnId: archive.turn.turnId,
          expectedSeq: archive.events.length,
          move: "e2e4",
        },
      };
    };
    const moving = await fixture();
    const parked = await parkedHuman(moving);
    const movementLock = await beginLock(locks.cliCredentialLockKey(moving.user.id));
    try {
      const erasing = settle(deletion(moving));
      await untilWaiting();
      const move = settle(humanClient(moving).move(parked.input));
      await untilWaiting(2);
      await movementLock.query("ROLLBACK");
      assert.equal((await erasing).value.complete, false);
      assert.equal((await move).error.code, "UNAUTHORIZED");
    } finally {
      await movementLock.query("ROLLBACK").catch(() => {});
      await movementLock.end();
    }
    // Fault-inject a surviving session row, as if a stale mint escaped a cleanup
    // snapshot. Active-owner validation must still refuse the stale caller.
    const lateSession = await prisma.session.create({
      data: {
        userId: moving.user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await assert.rejects(humanClient(moving, lateSession).move(parked.input), {
      code: "UNAUTHORIZED",
    });
    const refused = await prisma.chessMatch.findUniqueOrThrow({ where: { id: parked.row.id } });
    assert.equal(refused.status, "stopped");
    assert.equal(refused.turnType, "idle");
    assert.equal(refused.pendingMove, null);
    assert.equal(refused.archive.events.length, parked.archive.events.length);
    assert.equal(
      await chessRunQueue.getJob(human.chessRunJobId(parked.row.id, parked.archive)),
      undefined,
    );

    const beforeDelete = await fixture();
    const acceptedHuman = await parkedHuman(beforeDelete);
    assert.equal((await humanClient(beforeDelete).move(acceptedHuman.input)).status, "queued");
    const moved = await prisma.chessMatch.findUniqueOrThrow({
      where: { id: acceptedHuman.row.id },
    });
    assert.ok(moved.archive.events.length > acceptedHuman.archive.events.length);
    const wakeId = human.chessRunJobId(moved.id, moved.archive);
    const wake = await chessRunQueue.getJob(wakeId);
    assert.ok(wake, "An authorized move before deletion keeps its recoverable wake");
    await deletion(beforeDelete);
    assert.equal(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: moved.id } })).status,
      "stopped",
    );
    await wake.remove();
    console.log(
      "Account deletion: actual PG human-move/deletion lock ordering, stale-session denial, no refused wake/event, and accepted-before-deletion cancellation passed.",
    );
    await (await import("./account-deletion-active-check.mjs")).accountDeletionActiveCheck();
    console.log(
      "Account deletion: actual PG mint/OpenRouter+IdP callback/admission/dispatch/password lock races, durable revocation, idempotent pending and fresh browser proof passed.",
    );
  } finally {
    await Promise.allSettled(pending);
    await prisma.verification.deleteMany({ where: { value: { in: owners } } });
    await prisma.chessMatch.deleteMany({ where: { ownerId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await observer.end();
  }
}

/** Minimum supported pool: the effect policy read stays on its own transaction. */
export async function accountDeletionPoolCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(Number(process.env.DATABASE_POOL_MAX), 3);
  const [{ default: prisma }, { requestAccountDeletion }] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/api/src/lib/account-deletion.ts"),
  ]);
  const owners = [];
  const settingKey = "force2faInternalUsers";
  const prior = await prisma.appSetting.findUnique({ where: { key: settingKey } });
  const create = async (data = {}) => {
    const user = await prisma.user.create({
      data: {
        name: "Pool fixture",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
        ...data,
      },
    });
    owners.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: randomUUID(),
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, session };
  };
  try {
    await prisma.appSetting.deleteMany({ where: { key: settingKey } });
    const actor = await create({ role: "admin", twoFactorEnabled: false });
    const target = await create();
    const authority = { kind: "admin", userId: actor.user.id, sessionId: actor.session.id };
    assert.equal(
      (await requestAccountDeletion(target.user.id, authority)).complete,
      false,
      "Fresh administrator retains existing enrollment grace with pool3",
    );
    const overdue = await create({
      role: "admin",
      twoFactorEnabled: false,
      createdAt: new Date(Date.now() - 172_800_000),
    });
    const protectedTarget = await create();
    const overdueAuthority = {
      kind: "admin",
      userId: overdue.user.id,
      sessionId: overdue.session.id,
    };
    await assert.rejects(requestAccountDeletion(protectedTarget.user.id, overdueAuthority));
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: protectedTarget.user.id } }))
        .deletionRequestedAt,
      null,
    );
    await prisma.user.update({ where: { id: overdue.user.id }, data: { twoFactorEnabled: true } });
    assert.equal(
      (await requestAccountDeletion(protectedTarget.user.id, overdueAuthority)).complete,
      false,
      "Enrolled administrator remains authorized after grace",
    );
    console.log(
      "Admin effects: minimum pool3, transaction policy read, unchanged fresh-admin grace and overdue 2FA refusal passed.",
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    if (prior)
      await prisma.appSetting.upsert({
        where: { key: settingKey },
        create: prior,
        update: { value: prior.value },
      });
    else await prisma.appSetting.deleteMany({ where: { key: settingKey } });
  }
}
