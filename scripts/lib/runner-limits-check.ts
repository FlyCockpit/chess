/** Real PG assertions, imported only by the owned disposable runtime child. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerSocketEvents } from "../../apps/cli/src/runner-connection.ts";
import type { RunnerLimitController as LimitController } from "../../apps/cli/src/runner-limits.ts";

export async function runnerLimitsCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  const [{ default: prisma }, limits, runners, locks, revocation, { auth, passwordPepper }] =
    await Promise.all([
      import("../../packages/db/src/index.ts"),
      import("../../packages/auth/src/runner-limits.ts"),
      import("../../packages/auth/src/runner-machine.ts"),
      import("../../packages/auth/src/device-redemption-lock.ts"),
      import("../../packages/auth/src/credential-revocation.ts"),
      import("../../packages/auth/src/index.ts"),
    ]);
  // Better-Auth belongs to the auth workspace, not root script dependencies.
  const authRequire = createRequire(new URL("../../packages/auth/package.json", import.meta.url));
  const { symmetricEncrypt } = (await import(authRequire.resolve("better-auth/crypto"))) as {
    symmetricEncrypt(input: {
      key: Awaited<typeof auth.$context>["secretConfig"];
      data: string;
    }): Promise<string>;
  };
  const validPassword = "disposable-runner-limit-password";
  const hash = await passwordPepper.hash(validPassword);
  const service = limits.createRunnerLimitsService(
    prisma,
    async (verification) =>
      verification.method === "password" && verification.password === validPassword,
  );
  const replica = limits.createRunnerLimitsService(
    prisma,
    async (verification) =>
      verification.method === "password" && verification.password === validPassword,
  );
  const actual = limits.createRunnerLimitsService(prisma);
  const owners: string[] = [];
  const verificationIds = new Set<string>();
  const operating = { matchMicros: 1_000_000, dayMicros: 10_000_000, concurrency: 2, revision: 0 };
  const hard = { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 };
  const raised = { matchMicros: 2_000_000, dayMicros: 15_000_000, concurrency: 3 };
  const lowered = { matchMicros: 500_000, dayMicros: 5_000_000, concurrency: 1 };
  const proofId = (proof: string) =>
    `runner-limit-proof:v1:${createHash("sha256").update(proof).digest("hex")}`;
  const stateId = (machineId: string) => `runner-limits:v1:${machineId}`;
  const outcome = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error as unknown }),
    );
  function expectCode(error: unknown, code: string) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
  }

  async function fixture() {
    const id = `limits-${randomUUID()}`;
    owners.push(id);
    const user = await prisma.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        name: "PG runner limits",
        emailVerified: true,
        role: "user",
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
    await prisma.account.create({
      data: { userId: id, accountId: id, providerId: "credential", password: hash },
    });
    const authority = { userId: id, sessionId: session.id };
    const { machine, secret } = await runners.mintRunnerMachineForSession(authority, {
      displayName: "PG limit runner",
    });
    const identity = {
      userId: id,
      machineId: machine.id,
      connectionGeneration: machine.connectionGeneration,
    };
    verificationIds.add(stateId(machine.id));
    await service.hello(identity, { operatingLimits: operating, hardLimits: hard });
    return { user, session, authority, machine, secret, identity };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function prove(owner: Fixture, implementation = service) {
    const result = await implementation.prove(owner.authority, {
      id: owner.machine.id,
      expectedRevision: 0,
      limits: raised,
      verification: { method: "password", password: validPassword },
    });
    assert.ok(result);
    verificationIds.add(proofId(result.proof));
    return result;
  }
  function request(owner: Fixture, proof: string, values = raised) {
    return { id: owner.machine.id, expectedRevision: 0, limits: values, proof };
  }
  async function confirm(
    owner: Fixture,
    pending: NonNullable<Awaited<ReturnType<typeof service.pending>>>,
  ) {
    return service.result(owner.identity, {
      commandId: pending.commandId,
      revision: pending.revision,
      status: "applied",
      reason: "applied",
      operatingLimits: {
        matchMicros: pending.matchMicros,
        dayMicros: pending.dayMicros,
        concurrency: pending.concurrency,
        revision: pending.revision,
      },
      hardLimits: hard,
    });
  }

  /** Observe actual PG contention, without guessing at query timing. */
  async function waitBlockedBy(pid: number, table: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND ${pid}::int = ANY(pg_blocking_pids(pid)) AND query LIKE ${`%${table}%`}`;
      if (row && row.count >= 1) return;
      await delay(20);
    }
    throw new Error("PG runner limit race did not reach its expected row lock");
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
    throw new Error("PG runner limit race did not wait for the credential lock");
  }

  /** Actual client/transport/controller replay, with only the socket wire in memory. */
  async function transportReplay(
    owner: Fixture,
    command: NonNullable<Awaited<ReturnType<typeof service.pending>>>,
  ) {
    const [
      { RunnerConnection },
      { RunnerLimitController, runnerLimitFileStore },
      { createRunnerAuthority },
      { isOwnerActive },
      { createRunnerTransport },
      { createRunnerLeaseStore },
      { redisConnection },
      { parseRunnerClientFrame, parseRunnerServerFrame },
    ] = await Promise.all([
      import("../../apps/cli/src/runner-connection.ts"),
      import("../../apps/cli/src/runner-limits.ts"),
      import("../../apps/server/src/runner-ws-authority.ts"),
      import("../../packages/auth/src/account-deletion.ts"),
      import("../../apps/server/src/runner-ws.ts"),
      import("../../apps/server/src/runner-ws-store.ts"),
      import("../../packages/queue/src/connection.ts"),
      import("../../packages/chess/src/runner-protocol.ts"),
    ]);
    const root = await mkdtemp(join(tmpdir(), "runner-limit-replay-"));
    const notices: string[] = [];
    const controllers: LimitController[] = [];
    const connections: InstanceType<typeof RunnerConnection>[] = [];
    const transports: ReturnType<typeof createRunnerTransport>[] = [];
    let applications = 0;
    let restores = 0;
    let stopped = 0;
    const executorPolicy = {
      applyOperatingLimits() {
        applications += 1;
      },
      restoreOperatingLimits() {
        restores += 1;
      },
      stopOperatingLimits() {
        stopped += 1;
      },
    };
    const openController = async () => {
      const controller = await RunnerLimitController.open({
        hard,
        store: await runnerLimitFileStore("https://app.example.test", owner.machine.id, root),
        terminal: (notice) => notices.push(notice),
        policy: executorPolicy,
      });
      controllers.push(controller);
      return controller;
    };
    const until = async (label: string, predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(10);
      }
      throw new Error(`Runner limit wire timeout: ${label}`);
    };
    function connect(controller: LimitController, discardResult: boolean) {
      const transport = createRunnerTransport({
        authority: createRunnerAuthority(isOwnerActive),
        leases: createRunnerLeaseStore(redisConnection),
        isAvailable: () => true,
        limits: service,
      });
      transports.push(transport);
      type Reservation = NonNullable<Awaited<ReturnType<typeof transport.reserve>>>;
      type Active = NonNullable<Awaited<ReturnType<Reservation["attach"]>>>;
      let active: Active | null = null;
      let events: RunnerSocketEvents | undefined;
      let retired = false;
      const deferredClientFrames: string[] = [];
      const clientFrames: ReturnType<typeof parseRunnerClientFrame>[] = [];
      const serverFrames: ReturnType<typeof parseRunnerServerFrame>[] = [];
      const discarded: ReturnType<typeof parseRunnerClientFrame>[] = [];
      let opening = Promise.resolve();
      const client = new RunnerConnection({
        url: "wss://app.example.test/api/cli/runner/ws",
        credential: owner.secret,
        hello: () => ({ models: [], engine: false, ...controller.snapshot() }),
        socketFactory: (_url, options) => ({
          bufferedAmount: 0,
          send(frame) {
            const message = parseRunnerClientFrame(frame);
            clientFrames.push(message);
            if (discardResult && message.type === "limits-result") {
              discardResult = false;
              discarded.push(message);
              return;
            }
            if (active) active.receive(frame);
            else deferredClientFrames.push(frame);
          },
          close() {
            retired = true;
            active?.finished();
          },
          subscribe(listener) {
            events = listener;
            opening = Promise.resolve().then(async () => {
              const reservation = await transport.reserve(
                options.headers.Authorization,
                "127.0.0.1",
              );
              assert.ok(reservation, "actual PG authority must reserve the paired machine");
              events?.open();
              active = await reservation.attach({
                bufferedAmount: 0,
                send(frame) {
                  serverFrames.push(parseRunnerServerFrame(frame));
                  queueMicrotask(() => events?.message(frame));
                },
                ping() {
                  active?.pong();
                },
                close(code) {
                  events?.close(code);
                },
                terminate() {
                  retired = true;
                },
              });
              assert.ok(active, "actual server transport must attach");
              if (retired) active.finished();
              else for (const frame of deferredClientFrames.splice(0)) active.receive(frame);
            });
            // Keep asynchronous handshake failures observable by the bounded caller.
            void opening.catch(() => {});
            return () => {
              events = undefined;
            };
          },
        }),
        onMessage: async (message, signal) => {
          if (message.type !== "limits") return;
          const result = await controller.apply(message.payload);
          assert.equal(client.send({ type: "limits-result", payload: result }, signal), true);
        },
      });
      connections.push(client);
      client.start();
      return {
        client,
        transport,
        opening: () => opening,
        active: () => active,
        clientFrames,
        serverFrames,
        discarded,
      };
    }
    try {
      const firstController = await openController();
      const first = connect(firstController, true);
      await first.opening();
      await until("first durable CLI result was discarded", () => first.discarded.length === 1);
      assert.equal(applications, 1);
      assert.deepEqual(firstController.snapshot().operatingLimits, {
        matchMicros: command.matchMicros,
        dayMicros: command.dayMicros,
        concurrency: command.concurrency,
        revision: command.revision,
      });
      assert.deepEqual(await service.pending(first.active()!.identity), command);
      const stillPending = await service.get(owner.authority, owner.machine.id);
      assert.equal(
        stillPending.operatingLimits?.revision,
        0,
        "discarded CLI result cannot become server confirmation",
      );
      const firstGeneration = first.active()!.identity.connectionGeneration;
      // Closing and reopening the actual file store proves receipt recovery,
      // rather than an in-memory cache or fabricated hello/result.
      first.client.stop();
      first.active()?.finished();
      await first.transport.drain();
      await firstController.close();
      const resumedController = await openController();
      assert.equal(resumedController.snapshot().operatingLimits.revision, command.revision);
      const resumed = connect(resumedController, false);
      await resumed.opening();
      await until(
        "replayed receipt confirmed through actual transport",
        async () => (await service.get(owner.authority, owner.machine.id)).pending === null,
      );
      assert.equal(resumed.active()!.identity.connectionGeneration > firstGeneration, true);
      const originalResult = first.discarded[0];
      const replayedResult = resumed.clientFrames.find((frame) => frame.type === "limits-result");
      assert.ok(originalResult && originalResult.type === "limits-result");
      assert.ok(replayedResult && replayedResult.type === "limits-result");
      assert.deepEqual(replayedResult.payload, originalResult.payload);
      assert.equal(applications, 1, "replay must not apply operating limits twice");
      assert.equal(restores, 2, "the resumed controller must restore its durable snapshot");
      assert.equal(stopped, 0);
      assert.equal(notices.length, 2, "the original change and its replay are both echoed");
      assert.equal(
        resumed.serverFrames.some(
          (frame) => frame.type === "limits" && frame.payload.commandId === command.commandId,
        ),
        true,
      );
      await until("server acknowledged the replayed receipt", () =>
        resumed.serverFrames.some(
          (frame) => frame.type === "ack" && frame.payload.commandId === command.commandId,
        ),
      );
      await resumed.active()?.idle();
      assert.equal(
        await service.result(resumed.active()!.identity, replayedResult.payload),
        false,
        "duplicate receipt remains idempotent after transport confirmation",
      );
    } finally {
      for (const connection of connections) connection.stop();
      for (const transport of transports) await transport.drain();
      for (const controller of controllers) await controller.close();
      await rm(root, { recursive: true, force: true });
      redisConnection.disconnect();
    }
  }

  try {
    // The production verifier sees the sealed password hash; no plaintext
    // credential is ever stored in a proof or control snapshot.
    const verified = await fixture();
    assert.equal(
      await actual.prove(verified.authority, {
        id: verified.machine.id,
        expectedRevision: 0,
        limits: raised,
        verification: { method: "password", password: "wrong-disposable-password" },
      }),
      null,
    );
    const passwordProof = await prove(verified, actual);
    const storedProof = await prisma.verification.findUniqueOrThrow({
      where: { id: proofId(passwordProof.proof) },
    });
    assert.equal(storedProof.value.includes(passwordProof.proof), false);
    assert.equal(storedProof.value.includes(validPassword), false);
    assert.equal(
      storedProof.expiresAt.getTime() - Date.now() <= limits.RUNNER_LIMIT_PROOF_MS,
      true,
    );

    // Exact new limits, machine, browser session and connection generation
    // are all part of a proof. A mismatched attempt does not consume it.
    await assert.rejects(
      service.set(
        verified.authority,
        request(verified, passwordProof.proof, { ...raised, dayMicros: raised.dayMicros + 1 }),
      ),
      (error) => expectCode(error, "FORBIDDEN"),
    );
    const secondSession = await prisma.session.create({
      data: {
        userId: verified.user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await assert.rejects(
      service.set(
        { userId: verified.user.id, sessionId: secondSession.id },
        request(verified, passwordProof.proof),
      ),
      (error) => expectCode(error, "FORBIDDEN"),
    );
    const { machine: secondMachine } = await runners.mintRunnerMachineForSession(
      verified.authority,
      { displayName: "Other PG limit runner" },
    );
    verificationIds.add(stateId(secondMachine.id));
    await service.hello(
      {
        userId: verified.user.id,
        machineId: secondMachine.id,
        connectionGeneration: secondMachine.connectionGeneration,
      },
      { operatingLimits: operating, hardLimits: hard },
    );
    await assert.rejects(
      service.set(verified.authority, {
        ...request(verified, passwordProof.proof),
        id: secondMachine.id,
      }),
      (error) => expectCode(error, "FORBIDDEN"),
    );
    const accepted = await service.set(verified.authority, request(verified, passwordProof.proof));
    assert.ok(accepted.pending);
    assert.equal(accepted.operatingLimits?.revision, 0, "queued is not applied");
    assert.equal(
      await prisma.verification.findUnique({ where: { id: proofId(passwordProof.proof) } }),
      null,
    );
    assert.equal(await confirm(verified, accepted.pending), true);
    await assert.rejects(
      service.set(verified.authority, {
        ...request(verified, passwordProof.proof, {
          ...raised,
          matchMicros: raised.matchMicros + 1,
        }),
        expectedRevision: 1,
      }),
      (error) => expectCode(error, "FORBIDDEN"),
    );

    const expired = await fixture();
    const expiredProof = await prove(expired);
    await prisma.verification.update({
      where: { id: proofId(expiredProof.proof) },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await assert.rejects(
      service.set(expired.authority, request(expired, expiredProof.proof)),
      (error) => expectCode(error, "FORBIDDEN"),
    );

    const reconnected = await fixture();
    const staleProof = await prove(reconnected);
    await prisma.runnerMachine.update({
      where: { id: reconnected.machine.id },
      data: { connectionGeneration: { increment: 1 } },
    });
    await assert.rejects(
      service.set(reconnected.authority, request(reconnected, staleProof.proof)),
      (error) => expectCode(error, "FORBIDDEN"),
    );
    await assert.rejects(service.pending(reconnected.identity), (error) =>
      expectCode(error, "NOT_FOUND"),
    );

    // Two independent services/replicas race revision 0. PG advisory locking
    // must leave one pending command and preserve the CLI-confirmed values.
    const competing = await fixture();
    const updates = await Promise.allSettled([
      service.set(competing.authority, {
        id: competing.machine.id,
        expectedRevision: 0,
        limits: lowered,
      }),
      replica.set(competing.authority, {
        id: competing.machine.id,
        expectedRevision: 0,
        limits: { ...lowered, dayMicros: lowered.dayMicros - 1 },
      }),
    ]);
    assert.equal(updates.filter((update) => update.status === "fulfilled").length, 1);
    const durable = await service.pending(competing.identity);
    assert.ok(durable);
    assert.deepEqual(
      await replica.pending(competing.identity),
      durable,
      "lost delivery must replay one command",
    );
    // Exercise the real CLI/controller/private file store through the actual
    // server transport and PG service, discard a result and reconnect.
    await transportReplay(competing, durable);
    const acknowledgedValues = {
      matchMicros: durable.matchMicros,
      dayMicros: durable.dayMicros,
      concurrency: durable.concurrency,
      revision: durable.revision,
    };
    const applied = await service.get(competing.authority, competing.machine.id);
    assert.equal(applied.pending, null);
    assert.deepEqual(applied.operatingLimits, acknowledgedValues);
    await assert.rejects(
      service.set(competing.authority, {
        id: competing.machine.id,
        expectedRevision: 0,
        limits: lowered,
      }),
      (error) => expectCode(error, "CONFLICT"),
    );
    await assert.rejects(
      service.set(competing.authority, {
        id: competing.machine.id,
        expectedRevision: 1,
        limits: { ...raised, matchMicros: hard.matchMicros + 1 },
      }),
      (error) => expectCode(error, "BAD_REQUEST"),
    );

    // A proof is never standing authority after the live browser or owner
    // changes. These checks execute against committed PG rows under the lock.
    for (const state of [
      "signed-out",
      "expired",
      "device",
      "impersonated",
      "unverified",
      "banned",
      "forced-2fa",
      "deleted",
    ] as const) {
      const owner = await fixture();
      const proof = await prove(owner);
      if (state === "signed-out") await prisma.session.delete({ where: { id: owner.session.id } });
      if (state === "expired")
        await prisma.session.update({
          where: { id: owner.session.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      if (state === "device")
        await prisma.session.update({
          where: { id: owner.session.id },
          data: { origin: "device-flow" },
        });
      if (state === "impersonated")
        await prisma.session.update({
          where: { id: owner.session.id },
          data: { impersonatedBy: verified.user.id },
        });
      if (state === "unverified")
        await prisma.user.update({ where: { id: owner.user.id }, data: { emailVerified: false } });
      if (state === "banned")
        await prisma.user.update({ where: { id: owner.user.id }, data: { banned: true } });
      if (state === "forced-2fa")
        await prisma.user.update({
          where: { id: owner.user.id },
          data: { role: "admin", createdAt: new Date("2020-01-01"), twoFactorEnabled: false },
        });
      if (state === "deleted") await prisma.user.delete({ where: { id: owner.user.id } });
      await assert.rejects(service.set(owner.authority, request(owner, proof.proof)));
      const row = await prisma.verification.findUniqueOrThrow({
        where: { id: stateId(owner.machine.id) },
      });
      assert.equal(JSON.parse(row.value).pending, null);
    }

    // A durable deletion marker alone is sufficient: leave both the browser
    // session and machine credentials live, without simulated ban or revoke.
    // Every E3S reader/writer must use the canonical in-transaction owner fence.
    const deleting = await fixture();
    const deletingProof = await prove(deleting);
    const { machine: pendingMachine } = await runners.mintRunnerMachineForSession(
      deleting.authority,
      { displayName: "Pending deletion limit fixture" },
    );
    const pendingIdentity = {
      userId: deleting.user.id,
      machineId: pendingMachine.id,
      connectionGeneration: pendingMachine.connectionGeneration,
    };
    verificationIds.add(stateId(pendingMachine.id));
    await service.hello(pendingIdentity, { operatingLimits: operating, hardLimits: hard });
    const beforeDeletion = await service.set(deleting.authority, {
      id: pendingMachine.id,
      expectedRevision: 0,
      limits: lowered,
    });
    assert.ok(beforeDeletion.pending);
    await prisma.user.update({
      where: { id: deleting.user.id },
      data: { deletionRequestedAt: new Date(), deletionState: "pending" },
    });
    assert.equal(
      await prisma.runnerMachine.count({
        where: { userId: deleting.user.id, revokedAt: null },
      }),
      2,
    );
    assert.ok(await prisma.session.findUnique({ where: { id: deleting.session.id } }));
    await assert.rejects(service.get(deleting.authority, deleting.machine.id));
    await assert.rejects(
      service.prove(deleting.authority, {
        id: deleting.machine.id,
        expectedRevision: 0,
        limits: raised,
        verification: { method: "password", password: validPassword },
      }),
    );
    await assert.rejects(service.set(deleting.authority, request(deleting, deletingProof.proof)));
    await assert.rejects(
      service.hello(deleting.identity, { operatingLimits: operating, hardLimits: hard }),
    );
    await assert.rejects(service.pending(pendingIdentity));
    await assert.rejects(
      service.result(pendingIdentity, {
        commandId: beforeDeletion.pending.commandId,
        revision: beforeDeletion.pending.revision,
        status: "applied",
        reason: "applied",
        operatingLimits: { ...lowered, revision: 1 },
        hardLimits: hard,
      }),
    );
    const tombstonedState = await prisma.verification.findUniqueOrThrow({
      where: { id: stateId(pendingMachine.id) },
    });
    assert.deepEqual(JSON.parse(tombstonedState.value).pending, beforeDeletion.pending);
    assert.ok(
      await prisma.verification.findUnique({ where: { id: proofId(deletingProof.proof) } }),
      "the tombstone denies the still-present exact proof before it can be consumed",
    );

    // Passwordless SSO has no weaker fallback, while an enabled verified TOTP
    // can authorize one proof through the actual configured Better-Auth crypto.
    const sso = await fixture();
    await prisma.account.deleteMany({ where: { userId: sso.user.id } });
    await prisma.account.create({
      data: {
        userId: sso.user.id,
        providerId: "oidc",
        issuer: "https://id.example.test",
        accountId: sso.user.id,
      },
    });
    assert.deepEqual((await service.get(sso.authority, sso.machine.id)).methods, {
      password: false,
      totp: false,
    });
    assert.equal(
      await service.prove(sso.authority, {
        id: sso.machine.id,
        expectedRevision: 0,
        limits: raised,
        verification: { method: "password", password: validPassword },
      }),
      null,
    );
    await assert.rejects(
      service.set(sso.authority, { id: sso.machine.id, expectedRevision: 0, limits: raised }),
      (error) => expectCode(error, "FORBIDDEN"),
    );
    const context = await auth.$context;
    const totpSecret = "disposable-runner-limit-totp-secret";
    await prisma.user.update({ where: { id: sso.user.id }, data: { twoFactorEnabled: true } });
    await prisma.twoFactor.create({
      data: {
        userId: sso.user.id,
        verified: true,
        secret: await symmetricEncrypt({ key: context.secretConfig, data: totpSecret }),
        backupCodes: "disposable-unused",
      },
    });
    // Avoid generating a code in the last second of a period. This remains a
    // bounded real-clock fixture, never mocks the actual verifier's time.
    if (Date.now() % 30_000 > 28_000) await delay(2100);
    const { code } = await auth.api.generateTOTP({ body: { secret: totpSecret } });
    const totpProof = await actual.prove(sso.authority, {
      id: sso.machine.id,
      expectedRevision: 0,
      limits: raised,
      verification: { method: "totp", code },
    });
    assert.ok(totpProof);
    verificationIds.add(proofId(totpProof.proof));
    verificationIds.add(
      `runner-limit-totp:v1:${createHash("sha256").update(sso.user.id).update("\0").update(code).digest("hex")}`,
    );
    assert.equal(
      await actual.prove(sso.authority, {
        id: sso.machine.id,
        expectedRevision: 0,
        limits: raised,
        verification: { method: "totp", code },
      }),
      null,
      "one TOTP cannot mint multiple proofs",
    );

    // RFC 4648's MZXW6=== decodes to "foo". Imported two-factor secrets
    // retain Better-Auth's base32 prefix inside the encrypted database value.
    const imported = await fixture();
    await prisma.user.update({
      where: { id: imported.user.id },
      data: { twoFactorEnabled: true },
    });
    await prisma.twoFactor.create({
      data: {
        userId: imported.user.id,
        verified: true,
        secret: await symmetricEncrypt({ key: context.secretConfig, data: "base32:MZXW6===" }),
        backupCodes: "disposable-unused",
      },
    });
    if (Date.now() % 30_000 > 28_000) await delay(2100);
    const importedCode = (await auth.api.generateTOTP({ body: { secret: "foo" } })).code;
    const importedProof = await actual.prove(imported.authority, {
      id: imported.machine.id,
      expectedRevision: 0,
      limits: raised,
      verification: { method: "totp", code: importedCode },
    });
    assert.ok(importedProof);
    verificationIds.add(proofId(importedProof.proof));
    verificationIds.add(
      `runner-limit-totp:v1:${createHash("sha256").update(imported.user.id).update("\0").update(importedCode).digest("hex")}`,
    );

    // Imported authenticator keys are arbitrary bytes, not UTF-8 strings.
    // This fixture's high-bit bytes would all be changed by a text decode.
    const binaryImported = await fixture();
    await prisma.user.update({
      where: { id: binaryImported.user.id },
      data: { twoFactorEnabled: true },
    });
    await prisma.twoFactor.create({
      data: {
        userId: binaryImported.user.id,
        verified: true,
        secret: await symmetricEncrypt({
          key: context.secretConfig,
          data: "base32:QCAYFA4EQWDIPCEJRKFYZDMOR6IJDEUT",
        }),
        backupCodes: "disposable-unused",
      },
    });
    if (Date.now() % 30_000 > 28_000) await delay(2100);
    const binaryKey = Buffer.from(Array.from({ length: 20 }, (_, index) => 0x80 + index));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const mac = createHmac("sha1", binaryKey).update(counter).digest();
    const offset = mac[mac.length - 1]! & 0x0f;
    const truncated = mac
      .subarray(offset, offset + 4)
      .reduce((total, byte) => total * 256 + byte, 0);
    const binaryCode = String((truncated & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
    const binaryProof = await actual.prove(binaryImported.authority, {
      id: binaryImported.machine.id,
      expectedRevision: 0,
      limits: raised,
      verification: { method: "totp", code: binaryCode },
    });
    assert.ok(
      binaryProof,
      "an imported non-UTF8 authenticator key must verify without text conversion",
    );
    verificationIds.add(proofId(binaryProof.proof));
    verificationIds.add(
      `runner-limit-totp:v1:${createHash("sha256").update(binaryImported.user.id).update("\0").update(binaryCode).digest("hex")}`,
    );

    // Stage BOTH lock orders for each invalidating operation. An update which
    // commits first is fenced by the later revoke/reset/archive. An operation
    // which holds the lock first prevents a stale proof from queuing anything.
    for (const invalidation of ["reset", "revoke", "archive"] as const) {
      for (const invalidationFirst of [false, true]) {
        const owner = await fixture();
        const proof = await prove(owner);
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
            if (invalidationFirst)
              await tx.$queryRaw`SELECT id FROM runner_machine WHERE id = ${owner.machine.id} FOR UPDATE`;
            else
              await tx.$queryRaw`SELECT id FROM verification WHERE id = ${stateId(owner.machine.id)} FOR UPDATE`;
            signal(backend.pid);
            await gate;
          },
          { timeout: 15_000 },
        );
        void holder.catch(fail);
        const invalidate = () =>
          invalidation === "reset"
            ? revocation.revokeCredentialsAfterPasswordReset(owner.user.id)
            : locks.withCliCredentialLockSlot(() =>
                prisma.$transaction(
                  async (tx) => {
                    await locks.lockCliCredentials(owner.user.id, tx);
                    await runners.revokeRunnerMachinesInTransaction(
                      tx,
                      owner.user.id,
                      owner.machine.id,
                    );
                    if (invalidation === "archive") {
                      await tx.user.update({
                        where: { id: owner.user.id },
                        data: { banned: true },
                      });
                      await tx.session.deleteMany({ where: { userId: owner.user.id } });
                    }
                  },
                  { timeout: 15_000 },
                ),
              );
        let changing:
          | ReturnType<typeof outcome<Awaited<ReturnType<typeof service.set>>>>
          | undefined;
        let invalidating: ReturnType<typeof outcome<unknown>> | undefined;
        try {
          const pid = await ready;
          if (invalidationFirst) invalidating = outcome(invalidate());
          else changing = outcome(service.set(owner.authority, request(owner, proof.proof)));
          await waitBlockedBy(pid, invalidationFirst ? "runner_machine" : "verification");
          if (invalidationFirst)
            changing = outcome(service.set(owner.authority, request(owner, proof.proof)));
          else invalidating = outcome(invalidate());
          await waitCredential(owner.user.id);
        } finally {
          release();
          await holder;
        }
        const [change, invalidated] = await Promise.all([changing, invalidating]);
        assert.equal(invalidated?.ok, true);
        assert.equal(
          change?.ok,
          !invalidationFirst,
          `${invalidation} ordering must determine proof admission`,
        );
        assert.equal(
          await prisma.runnerMachine.count({ where: { id: owner.machine.id, revokedAt: null } }),
          0,
        );
        await assert.rejects(service.pending(owner.identity), (error) =>
          expectCode(error, "NOT_FOUND"),
        );
        await assert.rejects(service.set(owner.authority, request(owner, proof.proof)));
      }
    }
    console.log(
      "runner-limits: real password/TOTP, exact one-use proofs, live-session fences, revisions/lost ACK and both reset/revoke/archive lock orders passed",
    );
  } finally {
    await prisma.verification.deleteMany({ where: { id: { in: [...verificationIds] } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await prisma.$disconnect();
  }
}
