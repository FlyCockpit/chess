/** Real PG assertions, imported ONLY by test-runtime-operations' owned child.
 * Keep this file out of ordinary Vitest discovery: its unit I/O guard stays on.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function runnerClaimsCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  const [
    { default: prisma },
    claims,
    runners,
    locks,
    revocation,
    { resolveRunnerMachineCredential },
  ] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/auth/src/runner-claim.ts"),
    import("../../packages/auth/src/runner-machine.ts"),
    import("../../packages/auth/src/device-redemption-lock.ts"),
    import("../../packages/auth/src/credential-revocation.ts"),
    import("../../apps/server/src/runner-session.ts"),
  ]);
  const service = claims.runnerClaimService;
  const otherReplica = claims.createRunnerClaimService(prisma);
  const owners: string[] = [];
  const ids: string[] = [];
  const fixture = async () => {
    const id = `claim-${randomUUID()}`;
    owners.push(id);
    const user = await prisma.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        name: "PG runner claim",
        emailVerified: true,
        role: "user",
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: id,
        token: randomUUID(),
        origin: "sign-in",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, session, authority: { userId: id, sessionId: session.id } };
  };
  const begin = async () => {
    const proof = randomBytes(32).toString("hex");
    const result = await service.begin({ proof });
    ids.push(result.claimId);
    return { ...result, input: { claimId: result.claimId, proof } };
  };
  const outcome = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error as unknown }),
    );
  const notFound = { code: "NOT_FOUND" };
  async function waitBlockedBy(pid: number, table: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND ${pid}::int = ANY(pg_blocking_pids(pid)) AND query LIKE ${`%${table}%`}`;
      if (row && row.count >= 1) return;
      await delay(20);
    }
    throw new Error("PG claim race did not reach its expected row lock");
  }
  async function waitCredential(userId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND objid::bigint = (hashtext(${locks.cliCredentialLockKey(userId)})::bigint & 4294967295)`;
      if (row && row.count >= 1) return;
      await delay(20);
    }
    throw new Error("PG claim race did not wait for the credential lock");
  }

  try {
    // Two independently constructed services model competing replicas. Real
    // advisory locks + conditional UPDATE decide the winner, not a JS mutex.
    const alice = await fixture();
    const bob = await fixture();
    const run = await begin();
    const results = await Promise.allSettled([
      service.claim(alice.authority, run.claimToken),
      otherReplica.claim(bob.authority, run.claimToken),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const winner = results[0]?.status === "fulfilled" ? alice : bob;
    const loser = winner === alice ? bob : alice;
    const denied = results.find((result) => result.status === "rejected");
    assert.equal(denied?.status === "rejected" && denied.reason.code, "NOT_FOUND");
    assert.deepEqual(await service.claim(winner.authority, run.claimToken), { claimed: true });
    await assert.rejects(service.claim(loser.authority, run.claimToken), notFound);
    for (const action of ["poll", "exchange"] as const)
      await assert.rejects(service[action]({ ...run.input, proof: run.claimToken }), notFound);
    assert.equal((await service.poll(run.input)).status, "claimed");
    const [first, second] = await Promise.all([
      service.exchange(run.input),
      otherReplica.exchange(run.input),
    ]);
    assert.equal(first.machineId, second.machineId);
    assert.equal(
      first.credential === second.credential,
      true,
      "lost-response retry must return identical authority",
    );
    assert.equal(first.claimant.email, winner.user.email);
    assert.equal(await prisma.runnerMachine.count({ where: { userId: winner.user.id } }), 1);
    const stored = await prisma.runnerMachine.findUniqueOrThrow({ where: { id: first.machineId } });
    assert.equal(
      stored.credentialDigest === runners.digestRunnerMachineSecret(first.credential),
      true,
    );
    assert.equal(JSON.stringify(stored).includes(first.credential), false);
    assert.equal(
      (await prisma.runnerClaim.findUniqueOrThrow({ where: { id: run.claimId } })).sessionId,
      winner.session.id,
    );

    await locks.withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        await locks.lockCliCredentials(winner.user.id, tx);
        await runners.revokeRunnerMachinesInTransaction(tx, winner.user.id, first.machineId);
      }),
    );
    await assert.rejects(service.poll(run.input), notFound);
    await assert.rejects(service.exchange(run.input), notFound);
    await assert.rejects(service.claim(winner.authority, run.claimToken), notFound);

    const expired = await begin();
    await prisma.runnerClaim.update({
      where: { id: expired.claimId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await assert.rejects(service.claim(alice.authority, expired.claimToken), notFound);
    await assert.rejects(service.poll(expired.input), notFound);
    await assert.rejects(service.exchange(expired.input), notFound);

    // A second tab/session cannot replace the session which approved the run.
    const tabOwner = await fixture();
    const tabRun = await begin();
    await service.claim(tabOwner.authority, tabRun.claimToken);
    const tab = await prisma.session.create({
      data: {
        userId: tabOwner.user.id,
        token: randomUUID(),
        origin: "sign-in",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await service.claim({ userId: tabOwner.user.id, sessionId: tab.id }, tabRun.claimToken);
    assert.equal(
      (await prisma.runnerClaim.findUniqueOrThrow({ where: { id: tabRun.claimId } })).sessionId,
      tabOwner.session.id,
    );
    await prisma.session.delete({ where: { id: tabOwner.session.id } });
    await assert.rejects(service.exchange(tabRun.input), notFound);
    await assert.rejects(
      service.claim({ userId: tabOwner.user.id, sessionId: tab.id }, tabRun.claimToken),
      notFound,
    );
    assert.equal(await prisma.runnerMachine.count({ where: { userId: tabOwner.user.id } }), 0);

    for (const state of [
      "unverified",
      "banned",
      "2fa",
      "device",
      "impersonated",
      "expired-session",
    ] as const) {
      const owner = await fixture();
      const pending = await begin();
      if (state === "unverified")
        await prisma.user.update({ where: { id: owner.user.id }, data: { emailVerified: false } });
      if (state === "banned")
        await prisma.user.update({ where: { id: owner.user.id }, data: { banned: true } });
      if (state === "2fa")
        await prisma.user.update({
          where: { id: owner.user.id },
          data: { role: "admin", createdAt: new Date("2020-01-01"), twoFactorEnabled: false },
        });
      if (state === "device")
        await prisma.session.update({
          where: { id: owner.session.id },
          data: { origin: "device-flow" },
        });
      if (state === "impersonated")
        await prisma.session.update({
          where: { id: owner.session.id },
          data: { impersonatedBy: alice.user.id },
        });
      if (state === "expired-session")
        await prisma.session.update({
          where: { id: owner.session.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      await assert.rejects(service.claim(owner.authority, pending.claimToken));
      assert.equal(
        (await prisma.runnerClaim.findUniqueOrThrow({ where: { id: pending.claimId } })).userId,
        null,
      );
      assert.equal(await prisma.runnerMachine.count({ where: { userId: owner.user.id } }), 0);
    }

    // Failure after the mint must roll back BOTH the credential and its claim
    // binding. The same original proof can then retry successfully.
    const failedOwner = await fixture();
    const failedRun = await begin();
    await service.claim(failedOwner.authority, failedRun.claimToken);
    const failing = claims.createRunnerClaimService({
      $transaction: (run, options) =>
        prisma.$transaction(async (tx) => {
          await run(tx);
          throw new Error("injected commit failure");
        }, options),
    });
    await assert.rejects(failing.exchange(failedRun.input), /injected commit failure/);
    assert.equal(await prisma.runnerMachine.count({ where: { userId: failedOwner.user.id } }), 0);
    assert.equal(
      (await prisma.runnerClaim.findUniqueOrThrow({ where: { id: failedRun.claimId } })).machineId,
      null,
    );
    await service.exchange(failedRun.input);
    await revocation.revokeCredentialsAfterPasswordReset(failedOwner.user.id);
    await assert.rejects(service.exchange(failedRun.input), notFound);

    // An authorized reset's pre-write fence remains effective even when the
    // password write subsequently rolls back. Failed recovery cannot restore
    // an old approved claim or create a runner after the fence.
    const failedResetOwner = await fixture();
    const failedResetRun = await begin();
    await service.claim(failedResetOwner.authority, failedResetRun.claimToken);
    const account = await prisma.account.create({
      data: {
        userId: failedResetOwner.user.id,
        accountId: failedResetOwner.user.id,
        providerId: "credential",
        password: "disposable-fixture-previous-hash",
      },
    });
    await revocation.revokeCredentialsBeforeAdminPasswordReset(failedResetOwner.user.id);
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.account.update({
          where: { id: account.id },
          data: { password: "disposable-fixture-new-hash" },
        });
        throw new Error("injected password write failure");
      }),
      /injected password write failure/,
    );
    assert.equal(
      (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).password,
      "disposable-fixture-previous-hash",
    );
    await assert.rejects(service.exchange(failedResetRun.input), notFound);
    assert.equal(
      await prisma.runnerMachine.count({ where: { userId: failedResetOwner.user.id } }),
      0,
    );

    // Observe actual lock waits to prove BOTH reset/exchange orders. Reset
    // first prevents minting; exchange first is included in reset's sweep.
    for (const resetFirst of [false, true]) {
      const owner = await fixture();
      const pending = await begin();
      await service.claim(owner.authority, pending.claimToken);
      const initial = await runners.mintRunnerMachineForSession(owner.authority, {
        displayName: "race lock fixture",
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal = (_pid: number) => {};
      let fail = (_error: unknown) => {};
      const ready = new Promise<number>((resolve, reject) => {
        signal = resolve;
        fail = reject;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          const [backend] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          assert.ok(backend);
          if (resetFirst)
            await tx.$queryRaw`SELECT id FROM runner_machine WHERE id = ${initial.machine.id} FOR UPDATE`;
          else await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${owner.user.id} FOR UPDATE`;
          signal(backend.pid);
          await gate;
        },
        { timeout: 15_000 },
      );
      void holder.catch(fail);
      let exchanging:
        | ReturnType<typeof outcome<Awaited<ReturnType<typeof service.exchange>>>>
        | undefined;
      let resetting: ReturnType<typeof outcome<void>> | undefined;
      try {
        const pid = await ready;
        if (resetFirst)
          resetting = outcome(revocation.revokeCredentialsAfterPasswordReset(owner.user.id));
        else exchanging = outcome(service.exchange(pending.input));
        await waitBlockedBy(pid, "runner_machine");
        if (resetFirst) exchanging = outcome(service.exchange(pending.input));
        else resetting = outcome(revocation.revokeCredentialsAfterPasswordReset(owner.user.id));
        await waitCredential(owner.user.id);
      } finally {
        release();
        await holder;
      }
      const [exchange, reset] = await Promise.all([exchanging, resetting]);
      assert.equal(reset?.ok, true);
      assert.ok(exchange);
      if (resetFirst) assert.equal(exchange.ok, false);
      else {
        assert.equal(exchange.ok, true);
        if (exchange.ok)
          assert.equal(
            await resolveRunnerMachineCredential(`Bearer ${exchange.value.credential}`),
            null,
          );
      }
      assert.equal(
        await prisma.runnerMachine.count({ where: { userId: owner.user.id, revokedAt: null } }),
        0,
      );
      await assert.rejects(service.exchange(pending.input), notFound);
    }

    // Include unexchanged approvals in the owner cap; two competing claims
    // for the last reservation must never both pass.
    const capped = await fixture();
    const reservations = Array.from({ length: runners.RUNNER_MACHINE_MAX_ACTIVE - 1 }, () => ({
      id: randomUUID(),
      tokenDigest: randomBytes(32).toString("hex"),
      proofDigest: randomBytes(32).toString("hex"),
      userId: capped.user.id,
      sessionId: capped.session.id,
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    }));
    ids.push(...reservations.map((row) => row.id));
    await prisma.runnerClaim.createMany({ data: reservations });
    const capRuns = [await begin(), await begin()];
    const capResults = await Promise.allSettled(
      capRuns.map((run) => service.claim(capped.authority, run.claimToken)),
    );
    assert.equal(capResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      await prisma.runnerClaim.count({ where: { userId: capped.user.id, machineId: null } }),
      runners.RUNNER_MACHINE_MAX_ACTIVE,
    );

    // The global bound includes anonymous, approved AND exchanged rows.
    // With exactly one free slot, replicas race begin; only one is inserted.
    const current = await prisma.runnerClaim.count();
    const seed = Array.from({ length: claims.RUNNER_CLAIM_MAX_ROWS - current - 1 }, () => ({
      id: randomUUID(),
      tokenDigest: randomBytes(32).toString("hex"),
      proofDigest: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 600_000),
    }));
    ids.push(...seed.map((row) => row.id));
    await prisma.runnerClaim.createMany({ data: seed });
    const race = await Promise.allSettled([begin(), begin()]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await prisma.runnerClaim.count(), claims.RUNNER_CLAIM_MAX_ROWS);
    await assert.rejects(begin(), { code: "TOO_MANY_REQUESTS" });
    // Expiry and bounded cleanup recover capacity, never delete a machine.
    const beforeMachines = await prisma.runnerMachine.count();
    await prisma.runnerClaim.updateMany({
      where: { id: { in: ids } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const cleaned = await begin();
    assert.equal(
      await prisma.runnerClaim.count(),
      claims.RUNNER_CLAIM_MAX_ROWS - claims.RUNNER_CLAIM_CLEANUP_BATCH + 1,
    );
    assert.equal(await prisma.runnerMachine.count(), beforeMachines);
    const onlyProofDigest = await prisma.runnerClaim.findUniqueOrThrow({
      where: { id: cleaned.claimId },
    });
    assert.equal(
      onlyProofDigest.proofDigest,
      createHash("sha256")
        .update(`cockpit-chess:runner-claim:proof:v1\0${cleaned.input.proof}`)
        .digest("hex"),
    );
    assert.equal(JSON.stringify(onlyProofDigest).includes(cleaned.input.proof), false);
    console.log(
      "runner-claims: first-owner, stable exchange, live authority/reset races, rollback and bounded cleanup passed",
    );
  } finally {
    await prisma.runnerClaim.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await prisma.$disconnect();
  }
}
