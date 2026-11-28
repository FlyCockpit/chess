import { randomUUID } from "node:crypto";
import {
  applyUci,
  beginHostedTurn,
  boardAt,
  createMatch,
  matchConfigSchema,
  validateArchive,
} from "@cockpit-chess/chess";
import {
  type RunnerClientMessage,
  runnerConfigDigest,
  runnerServerMessageSchema,
} from "@cockpit-chess/chess/runner-protocol";
import type prismaInstance from "@cockpit-chess/db";
import type { Prisma } from "@cockpit-chess/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";
import type { Context } from "../context";

const { mintAuthority, publish } = vi.hoisted(() => ({ mintAuthority: vi.fn(), publish: vi.fn() }));
vi.mock("@cockpit-chess/auth/runner-limits-store", () => ({
  readRunnerLimitsInTransaction: vi.fn(async () => ({
    generation: 3,
    operatingLimits: { matchMicros: 2_000_000 },
    hardLimits: { matchMicros: 25_000_000 },
  })),
}));
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({
  lockCliCredentials: vi.fn(),
  withCliCredentialLockSlot: (run: () => unknown) => run(),
}));
vi.mock("@cockpit-chess/auth/runner-machine", () => ({
  requireRunnerMachineMintAuthority: mintAuthority,
  RunnerMachineForbiddenError: class extends Error {},
  RunnerMachineSessionRevokedError: class extends Error {},
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
vi.mock("@cockpit-chess/queue", () => ({
  redisConnection: { publish },
  chessRunQueue: {},
  ensureRunnableJob: vi.fn(),
}));
const { withLockSlot } = await import("@cockpit-chess/auth/lock-slots");
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const {
  createRunnerInput,
  createRunnerMatch,
  handleRunnerControl,
  RUNNER_COMMAND_CHANNEL,
  RUNNER_OUTBOX_LIMIT,
  runnerMatchStatus,
  runnerOutbox,
  startRunnerMatch,
  stopRunnerMatch,
  moveRunnerMatch,
  disconnectRunnerMatches,
} = await import("./chess-runner");
const { chessDigest } = await import("./chess-official");
const { RunnerMachineForbiddenError, RunnerMachineSessionRevokedError } = await import(
  "@cockpit-chess/auth/runner-machine"
);
const config = matchConfigSchema.parse({
  white: { name: "White", model: "test/white", protocol: "openai-chat" },
  black: { name: "Black", model: "test/black", protocol: "openai-chat" },
  rules: {},
});
const identity = { machineId: "machine", userId: "owner", connectionGeneration: 3 };
const context = { session: { user: { id: "owner" }, session: { id: "session" } } } as Context & {
  session: NonNullable<Context["session"]>;
};
function row() {
  return {
    id: "match",
    slug: "runner-match",
    source: "runner",
    ownerId: "owner",
    status: "queued",
    runnerMachineId: "machine",
    runnerGeneration: 3,
    runnerState: "offered",
    runnerRevision: 1,
    runnerAcceptedSeq: 0,
    runnerLastContactAt: new Date(),
    runnerResumeDeadline: new Date(Date.now() + 120_000),
    archive: createMatch(config, "local"),
  };
}
function command() {
  return {
    id: "offer",
    matchId: "match",
    kind: "offer",
    revision: 1,
    expiresAt: new Date(Date.now() + 300_000),
    cancelledAt: null,
    ackedAt: null,
  };
}
function offerPayload(commandId = "offer") {
  const configWithPrompt = { ...config, promptVersion: "1" as const };
  return {
    commandId,
    config: configWithPrompt,
    configDigest: runnerConfigDigest(configWithPrompt),
  };
}
function acceptedResponses(id = "event") {
  return [{ type: "ack", payload: { commandId: id } }];
}
function acceptanceResumePayload(offerId = "offer") {
  return {
    commandId: chessDigest(["runner-resume", "match", offerId]),
    acceptedSeq: 0,
    fen: boardAt(row().archive).fen(),
    ply: 0,
  };
}
function accept(id = "event"): RunnerClientMessage {
  return {
    version: 1,
    generation: 3,
    id,
    seq: 1,
    ack: 0,
    type: "accept",
    matchId: "match",
    payload: { commandId: "offer" },
  };
}

type OutboxCommand = {
  id: string;
  matchId: string;
  kind: string;
  revision: number;
  payload: Prisma.JsonValue;
  createdAt: Date;
  expiresAt: Date;
  ackedAt: Date | null;
  cancelledAt: Date | null;
};
function queuedCommand(
  kind: string,
  id: string,
  revision: number,
  payload: Prisma.JsonValue,
  matchId = "match",
): OutboxCommand {
  return {
    ...command(),
    id,
    matchId,
    kind,
    revision,
    payload,
    createdAt: new Date(),
  };
}

/** Query-aware commands: each active match and the separate terminal page see only their rows. */
function stageOutbox(states: ReturnType<typeof row>[], commands: OutboxCommand[]) {
  db.chessMatch.findMany.mockResolvedValue(states as never);
  db.chessMatch.findFirst.mockImplementation(
    (async (args?: Prisma.ChessMatchFindFirstArgs) =>
      states.find((state) => state.id === args?.where?.id) ?? null) as never,
  );
  const matches = (entry: OutboxCommand, where: Prisma.RunnerCommandWhereInput = {}) => {
    if (typeof where.matchId === "string" && entry.matchId !== where.matchId) return false;
    if (typeof where.kind === "string" && entry.kind !== where.kind) return false;
    if (where.ackedAt === null && entry.ackedAt !== null) return false;
    if (where.cancelledAt === null && entry.cancelledAt !== null) return false;
    if (typeof where.id === "string" && entry.id !== where.id) return false;
    if (where.id && typeof where.id === "object") {
      if (Array.isArray(where.id.in) && !where.id.in.includes(entry.id)) return false;
      if (Array.isArray(where.id.notIn) && where.id.notIn.includes(entry.id)) return false;
    }
    if (where.expiresAt && typeof where.expiresAt === "object" && "gt" in where.expiresAt) {
      const after = where.expiresAt.gt;
      if (after instanceof Date && entry.expiresAt <= after) return false;
    }
    if (where.Match && "status" in where.Match) {
      const state = states.find((candidate) => candidate.id === entry.matchId);
      if (!state || ["queued", "running"].includes(state.status)) return false;
    }
    return true;
  };
  db.runnerCommand.findMany.mockImplementation((async (args?: Prisma.RunnerCommandFindManyArgs) =>
    commands
      .filter((entry) => matches(entry, args?.where))
      .sort((left, right) => right.revision - left.revision)
      .slice(0, args?.take ?? commands.length)) as never);
  db.runnerCommand.findFirst.mockImplementation((async (
    args?: Prisma.RunnerCommandFindFirstArgs,
  ) => {
    const found = commands
      .filter((entry) => matches(entry, args?.where))
      .sort((left, right) =>
        args?.orderBy && !Array.isArray(args.orderBy) && args.orderBy.revision === "asc"
          ? left.revision - right.revision
          : right.revision - left.revision,
      );
    return found[0] ?? null;
  }) as never);
}
beforeEach(() => {
  vi.clearAllMocks();
  mockReset(db);
  db.$transaction.mockImplementation(((run: (tx: typeof db) => unknown) => run(db)) as never);
  mintAuthority.mockResolvedValue({ id: "owner" });
  publish.mockResolvedValue(0);
  db.runnerMachine.findFirst.mockResolvedValue({
    id: "machine",
    expiresAt: new Date(Date.now() + 600_000),
    connectionGeneration: 3,
    User: { emailVerified: true, banned: false, banExpires: null, deletionRequestedAt: null },
  } as never);
  db.chessMatch.findFirst.mockResolvedValue(row() as never);
  db.chessMatch.findMany.mockResolvedValue([]);
  db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
  db.chessMatch.count.mockResolvedValue(0);
  db.chessCreation.findUnique.mockResolvedValue(null);
  db.runnerCommand.findUnique.mockResolvedValue(command() as never);
  db.runnerCommand.findFirst.mockImplementation((async (
    args?: Prisma.RunnerCommandFindFirstArgs,
  ) =>
    args?.where?.kind === "offer"
      ? { payload: offerPayload(), expiresAt: new Date(Date.now() + 300_000), revision: 1 }
      : null) as never);
  db.runnerCommand.updateMany.mockResolvedValue({ count: 1 });
  db.runnerCommand.findMany.mockResolvedValue([]);
  db.runnerCommand.count.mockResolvedValue(0);
  db.runnerEvent.findUnique.mockResolvedValue(null);
  db.runnerEvent.count.mockResolvedValue(0);
});

afterEach(() => vi.useRealTimers());

describe("runner browser control", () => {
  it("persists the canonical current CLI offer and its normalized configuration digest", async () => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    await createRunnerMatch(context, {
      machineId: "machine",
      creationKey: randomUUID(),
      config: { ...config, rules: { ...config.rules, illegalPolicy: "forfeit" } },
    });
    const command = db.chessMatch.create.mock.calls[0]?.[0].data.RunnerCommands?.create;
    if (!command || Array.isArray(command)) throw new Error("Expected one durable offer");
    const offer = runnerServerMessageSchema.parse({
      version: 1,
      generation: 3,
      id: command.id,
      seq: 1,
      ack: 0,
      type: "offer",
      matchId: "match",
      payload: command.payload,
    });
    if (offer.type !== "offer") throw new Error("Expected current offer");
    expect(offer.payload.config.promptVersion).toBe("1");
    expect(offer.payload.configDigest).toBe(runnerConfigDigest(offer.payload.config));
    stageOutbox([row()], [queuedCommand("offer", String(command.id), 1, offer.payload)]);
    await expect(runnerOutbox(identity)).resolves.toEqual([
      {
        type: "offer",
        matchId: "match",
        payload: offer.payload,
      },
    ]);
  });
  it("refuses control effects on a terminal row even if an older runner state remains active", async () => {
    db.chessMatch.findFirst.mockResolvedValue({ ...row(), status: "stopped" } as never);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
  });
  it("cannot rebind or deliver a resume for a terminal row with stale active metadata", async () => {
    const terminal = { ...row(), status: "stopped", runnerState: "accepted", runnerGeneration: 2 };
    stageOutbox(
      [terminal],
      [
        queuedCommand("resume", "old-resume", 2, {
          commandId: "old-resume",
          acceptedSeq: 0,
          fen: boardAt(terminal.archive).fen(),
          ply: 0,
        }),
      ],
    );
    await expect(runnerOutbox(identity)).resolves.toEqual([]);
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("rejects forged execution source, official consent and nested credential fields", () => {
    const valid = { machineId: "machine", creationKey: randomUUID(), config };
    expect(createRunnerInput.safeParse({ ...valid, source: "hosted" }).success).toBe(false);
    expect(createRunnerInput.safeParse({ ...valid, official: true }).success).toBe(false);
    expect(
      createRunnerInput.safeParse({ ...valid, config: { ...config, apiKey: "not-a-key" } }).success,
    ).toBe(false);
  });
  it("refuses bearer/browser impersonation authority before any database transaction", async () => {
    await expect(
      runnerMatchStatus({ ...context, credential: "session-token" }, { slug: "runner-match" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("checks the current browser session under the credential lock for every status read", async () => {
    await runnerMatchStatus(context, { slug: "runner-match" });
    expect(mintAuthority).toHaveBeenCalledWith(
      db,
      { userId: "owner", sessionId: "session" },
      expect.any(Function),
    );
    expect(mintAuthority).toHaveBeenCalledTimes(2);
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "runner-match", ownerId: "owner", source: "runner" },
      }),
    );
  });
  it("refuses a surviving browser session when the shared authority helper denies pending deletion", async () => {
    mintAuthority.mockRejectedValue(new RunnerMachineForbiddenError());
    await expect(runnerMatchStatus(context, { slug: "runner-match" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.chessMatch.findFirst).not.toHaveBeenCalled();
  });
  it("refuses a status result when its browser session expires during the read", async () => {
    mintAuthority
      .mockResolvedValueOnce({ id: "owner" })
      .mockRejectedValueOnce(new RunnerMachineSessionRevokedError());
    await expect(runnerMatchStatus(context, { slug: "runner-match" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.chessMatch.findFirst).toHaveBeenCalledTimes(1);
    expect(mintAuthority).toHaveBeenCalledTimes(2);
  });
  it("rejects create before commit and wake when authority changes during its callback", async () => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    mintAuthority
      .mockResolvedValueOnce({ id: "owner" })
      .mockRejectedValueOnce(new RunnerMachineForbiddenError());
    await expect(
      createRunnerMatch(context, { machineId: "machine", creationKey: randomUUID(), config }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.chessMatch.create).toHaveBeenCalledTimes(1);
    expect(mintAuthority).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });
  it("rechecks browser authority after replaying an existing creation receipt", async () => {
    const input = { machineId: "machine", creationKey: randomUUID(), config };
    db.chessMatch.create.mockResolvedValue(row() as never);
    await createRunnerMatch(context, input);
    const receipt = db.chessMatch.create.mock.calls[0]?.[0].data.Creation;
    const acceptedDigest =
      typeof receipt?.create === "object" ? receipt.create.configDigest : undefined;
    db.chessCreation.findUnique.mockResolvedValue({
      configDigest: acceptedDigest,
      Match: row(),
    } as never);
    publish.mockClear();
    mintAuthority
      .mockClear()
      .mockResolvedValueOnce({ id: "owner" })
      .mockRejectedValueOnce(new RunnerMachineSessionRevokedError());
    await expect(createRunnerMatch(context, input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.chessMatch.create).toHaveBeenCalledTimes(1);
    expect(mintAuthority).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });
  it("rejects stop before commit and wake when its browser session expires while waiting", async () => {
    db.runnerCommand.findUnique.mockResolvedValue(null);
    mintAuthority
      .mockResolvedValueOnce({ id: "owner" })
      .mockRejectedValueOnce(new RunnerMachineSessionRevokedError());
    await expect(
      stopRunnerMatch(context, {
        slug: "runner-match",
        commandId: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(db.runnerCommand.create).toHaveBeenCalledTimes(1);
    expect(mintAuthority).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });
  it("returns no foreign or hosted match data", async () => {
    db.chessMatch.findFirst.mockResolvedValue(null);
    await expect(runnerMatchStatus(context, { slug: "foreign" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("writes source and machine binding server-side and creates the durable offer before its wake", async () => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    let committed = false;
    db.$transaction.mockImplementation((async (run: (tx: typeof db) => Promise<unknown>) => {
      const value = await run(db);
      committed = true;
      return value;
    }) as never);
    publish.mockImplementation(async () => {
      expect(committed).toBe(true);
      return 0;
    });
    const result = await createRunnerMatch(context, {
      machineId: "machine",
      creationKey: randomUUID(),
      config,
    });
    expect(result.state).toBe("offered");
    const call = db.chessMatch.create.mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({
      source: "runner",
      credentialSource: "runner-local",
      runnerMachineId: "machine",
      runnerRevision: 1,
      archive: { source: "local" },
      RunnerCommands: { create: { kind: "offer", revision: 1 } },
    });
    expect(call?.data).not.toHaveProperty("OfficialEntry");
    expect(publish).toHaveBeenCalledWith(
      RUNNER_COMMAND_CHANNEL,
      JSON.stringify({ machineId: "machine" }),
    );
  });
  it("keeps an accepted create durable when the notification publish fails", async () => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    publish.mockRejectedValue(new Error("lost hint"));
    await expect(
      createRunnerMatch(context, { machineId: "machine", creationKey: randomUUID(), config }),
    ).resolves.toMatchObject({ id: "match" });
  });
  it("replays the accepted creation receipt without allocating a second match", async () => {
    const input = { machineId: "machine", creationKey: randomUUID(), config };
    db.chessMatch.create.mockResolvedValue(row() as never);
    await createRunnerMatch(context, input);
    const receipt = db.chessMatch.create.mock.calls[0]?.[0].data.Creation;
    const acceptedDigest =
      typeof receipt?.create === "object" ? receipt.create.configDigest : undefined;
    db.chessCreation.findUnique.mockResolvedValue({
      configDigest: acceptedDigest,
      Match: row(),
    } as never);
    await createRunnerMatch(context, input);
    expect(db.chessMatch.create).toHaveBeenCalledTimes(1);
  });
  it("refuses reuse of a creation receipt with another machine or configuration", async () => {
    db.chessCreation.findUnique.mockResolvedValue({
      configDigest: "different",
      Match: row(),
    } as never);
    await expect(
      createRunnerMatch(context, { machineId: "machine", creationKey: randomUUID(), config }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("caps active matches per machine and per owner", async () => {
    db.chessMatch.count.mockResolvedValueOnce(0).mockResolvedValueOnce(16);
    await expect(
      createRunnerMatch(context, { machineId: "machine", creationKey: randomUUID(), config }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("refuses starts before local acceptance", async () => {
    db.runnerCommand.findUnique.mockResolvedValue(null);
    await expect(
      startRunnerMatch(context, {
        slug: "runner-match",
        commandId: randomUUID(),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("stops under revision CAS, cancels unsent offers and records one terminal command", async () => {
    db.runnerCommand.findUnique.mockResolvedValue(null);
    await stopRunnerMatch(context, {
      slug: "runner-match",
      commandId: randomUUID(),
      expectedRevision: 1,
    });
    expect(db.runnerCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchId: "match", ackedAt: null, cancelledAt: null },
        data: { cancelledAt: expect.any(Date) },
      }),
    );
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match", ownerId: "owner", source: "runner", runnerRevision: 1 },
        data: expect.objectContaining({
          status: "stopped",
          runnerState: "stopped",
          runnerGeneration: null,
          runnerResumeDeadline: null,
          archive: expect.objectContaining({ status: "stopped", termination: "cancelled" }),
        }),
      }),
    );
    expect(db.runnerCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "stop", revision: 2 }) }),
    );
  });
  it("reserves one terminal stop receipt beyond the active command cap", async () => {
    db.runnerCommand.findUnique.mockResolvedValue(null);
    db.runnerCommand.count.mockResolvedValue(4096);
    await expect(
      stopRunnerMatch(context, {
        slug: "runner-match",
        commandId: randomUUID(),
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ state: "stopped" });
    expect(db.runnerCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "stop" }) }),
    );
    expect(db.runnerCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { matchId: "match", ackedAt: null, cancelledAt: null } }),
    );
  });
  it("does not stop a match on a stale browser revision", async () => {
    db.runnerCommand.findUnique.mockResolvedValue(null);
    await expect(
      stopRunnerMatch(context, {
        slug: "runner-match",
        commandId: randomUUID(),
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
});

describe("runner machine control and durable outbox", () => {
  it("refuses revoked or replaced machine generations before querying commands", async () => {
    db.runnerMachine.findFirst.mockResolvedValue(null);
    await expect(runnerOutbox(identity)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.runnerCommand.findMany).not.toHaveBeenCalled();
    expect(db.runnerMachine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ connectionGeneration: 3, revokedAt: null }),
      }),
    );
  });
  it("rechecks machine expiry after its mutation callback and refuses the commit", async () => {
    db.runnerMachine.findFirst
      .mockResolvedValueOnce({
        id: "machine",
        expiresAt: new Date(Date.now() + 600_000),
        User: { emailVerified: true, banned: false, banExpires: null, deletionRequestedAt: null },
      } as never)
      .mockResolvedValueOnce(null);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(db.runnerEvent.create).toHaveBeenCalledTimes(1);
    expect(db.runnerMachine.findFirst).toHaveBeenCalledTimes(2);
  });
  it("allows unexpired machine effects after the final live authority check", async () => {
    await expect(handleRunnerControl(identity, accept())).resolves.toEqual(acceptedResponses());
    expect(db.runnerMachine.findFirst).toHaveBeenCalledTimes(2);
  });
  it.each(["offer", "resume"])(
    "rolls back accept effects if the original %s grant expires during its write",
    async (grant) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.now();
      const state = {
        ...row(),
        runnerResumeDeadline: new Date(now + (grant === "resume" ? 10 : 1000)),
      };
      db.chessMatch.findFirst.mockResolvedValue(state as never);
      db.runnerCommand.findUnique.mockResolvedValue({
        ...command(),
        expiresAt: new Date(now + (grant === "offer" ? 10 : 1000)),
      } as never);
      db.chessMatch.updateMany.mockImplementation((async () => {
        vi.setSystemTime(now + 20);
        return { count: 1 };
      }) as never);
      await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(db.runnerEvent.create).not.toHaveBeenCalled();
    },
  );
  it("rechecks original grants after the receipt write itself awaits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      expiresAt: new Date(now + 10),
    } as never);
    db.runnerEvent.create.mockImplementation((async () => {
      vi.setSystemTime(now + 20);
      return {};
    }) as never);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.runnerEvent.create).toHaveBeenCalledTimes(1);
  });
  it("rechecks original grants after the final machine authority await", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const machine = {
      id: "machine",
      expiresAt: new Date(now + 600_000),
      User: { emailVerified: true, banned: false, banExpires: null, deletionRequestedAt: null },
    };
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      expiresAt: new Date(now + 10),
    } as never);
    db.runnerMachine.findFirst
      .mockResolvedValueOnce(machine as never)
      .mockImplementationOnce((async () => {
        vi.setSystemTime(now + 20);
        return machine;
      }) as never);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.runnerMachine.findFirst).toHaveBeenCalledTimes(2);
  });
  it.each(["offer", "resume"])(
    "refuses outbox renewal if the original %s grant expires during binding",
    async (grant) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.now();
      const state = {
        ...row(),
        runnerState: grant === "offer" ? "offered" : "accepted",
        runnerResumeDeadline: new Date(now + (grant === "resume" ? 10 : 1000)),
      };
      db.chessMatch.findMany.mockResolvedValue([state] as never);
      db.chessMatch.findFirst.mockResolvedValue(state as never);
      db.runnerCommand.findFirst.mockImplementation((async (
        args?: Prisma.RunnerCommandFindFirstArgs,
      ) => (args?.where?.kind === "offer" ? { expiresAt: new Date(now + 10) } : null)) as never);
      db.chessMatch.updateMany.mockImplementation((async () => {
        vi.setSystemTime(now + 20);
        return { count: 1 };
      }) as never);
      await expect(runnerOutbox(identity)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(1);
    },
  );
  it("allows delayed accept and binding when the original grants remain unexpired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const state = { ...row(), runnerState: "accepted", runnerResumeDeadline: new Date(now + 1000) };
    db.chessMatch.findMany.mockResolvedValue([state] as never);
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    db.chessMatch.updateMany.mockImplementation((async () => {
      vi.setSystemTime(now + 20);
      return { count: 1 };
    }) as never);
    await expect(runnerOutbox(identity)).resolves.toEqual([]);
    db.chessMatch.findFirst.mockResolvedValue({ ...state, runnerState: "offered" } as never);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      expiresAt: new Date(now + 1000),
    } as never);
    await expect(handleRunnerControl(identity, accept())).resolves.toEqual(acceptedResponses());
    expect(db.runnerEvent.create).toHaveBeenCalledTimes(1);
  });
  it("refuses pending-deletion owners even when their machine row survives", async () => {
    db.runnerMachine.findFirst.mockResolvedValue({
      id: "machine",
      User: {
        emailVerified: true,
        banned: false,
        banExpires: null,
        deletionRequestedAt: new Date(),
      },
    } as never);
    await expect(runnerOutbox(identity)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.chessMatch.findMany).not.toHaveBeenCalled();
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
    expect(db.runnerMachine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          expiresAt: true,
          User: {
            select: {
              banned: true,
              banExpires: true,
              emailVerified: true,
              deletionRequestedAt: true,
            },
          },
        },
      }),
    );
  });
  it("reads a bounded durable outbox even when no subscriber received the wake", async () => {
    db.runnerCommand.findMany.mockResolvedValue([
      {
        id: "stop",
        kind: "stop",
        payload: { commandId: "stop" },
        matchId: "match",
        expiresAt: new Date(Date.now() + 300_000),
      },
    ] as never);
    expect(await runnerOutbox(identity)).toEqual([
      { type: "stop", matchId: "match", payload: { commandId: "stop" } },
    ]);
    expect(db.runnerCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: RUNNER_OUTBOX_LIMIT,
        where: expect.objectContaining({
          ackedAt: null,
          cancelledAt: null,
          expiresAt: { gt: expect.any(Date) },
          Match: {
            source: "runner",
            ownerId: "owner",
            runnerMachineId: "machine",
            status: { notIn: ["queued", "running"] },
            runnerGeneration: null,
          },
        }),
      }),
    );
  });
  it("retains outstanding IDs authoritatively even beyond the FIFO page", async () => {
    const stopped = { ...row(), runnerState: "stopped", runnerGeneration: null };
    db.runnerCommand.findMany
      .mockResolvedValueOnce([
        {
          id: "new-resume",
          matchId: stopped.id,
          kind: "stop",
          expiresAt: new Date(Date.now() + 300_000),
          payload: { commandId: "new-resume" },
        },
      ] as never)
      .mockResolvedValueOnce(
        Array.from({ length: 31 }, (_, index) => ({
          id: `old-${index}`,
          kind: "stop",
          payload: { commandId: `old-${index}` },
          matchId: stopped.id,
          expiresAt: new Date(Date.now() + 300_000),
        })) as never,
      );
    const result = await runnerOutbox(identity, ["new-resume"]);
    expect(result).toHaveLength(32);
    expect(result[0]).toMatchObject({ type: "stop", payload: { commandId: "new-resume" } });
    expect(db.runnerCommand.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["new-resume"] },
          ackedAt: null,
          cancelledAt: null,
          expiresAt: { gt: expect.any(Date) },
          Match: {
            source: "runner",
            ownerId: "owner",
            runnerMachineId: "machine",
            status: { notIn: ["queued", "running"] },
            runnerGeneration: null,
          },
        }),
        take: 4,
      }),
    );
    expect(db.runnerCommand.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ["new-resume"] } }),
        take: 32,
      }),
    );
  });
  it("retires a cancelled or acknowledged outstanding ID without reading it from a partial page", async () => {
    db.runnerCommand.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(runnerOutbox(identity, ["cancelled-command"])).resolves.toEqual([]);
    expect(db.runnerCommand.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["cancelled-command"] },
          ackedAt: null,
          cancelledAt: null,
          expiresAt: { gt: expect.any(Date) },
        }),
        take: 4,
      }),
    );
    expect(db.runnerCommand.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 32,
        where: expect.objectContaining({ id: { notIn: ["cancelled-command"] } }),
      }),
    );
  });
  it("bounds and validates the socket's outstanding IDs before DB or slot work", async () => {
    await expect(runnerOutbox(identity, ["one", "two", "three", "four", "five"])).rejects.toThrow();
    await expect(runnerOutbox(identity, ["bad/id"])).rejects.toThrow();
    await expect(runnerOutbox(identity, ["a".repeat(129)])).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("never rebinds an expired grace or resurrects its pending commands", async () => {
    const expired = { ...row(), runnerState: "accepted", runnerResumeDeadline: new Date(0) };
    db.chessMatch.findMany.mockResolvedValue([expired] as never);
    db.chessMatch.findFirst.mockResolvedValue(expired as never);
    await runnerOutbox(identity);
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runnerState: "abandoned",
          runnerGeneration: null,
          runnerResumeDeadline: null,
        }),
      }),
    );
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("replaces the generation with a fresh offer before any resume and keeps accepted phase", async () => {
    const old = { ...row(), runnerGeneration: 2, runnerState: "accepted" };
    db.chessMatch.findMany.mockResolvedValue([old] as never);
    db.chessMatch.findFirst.mockResolvedValue(old as never);
    await runnerOutbox(identity);
    expect(db.runnerCommand.findFirst).toHaveBeenCalledWith({
      where: { matchId: "match", kind: "offer" },
      orderBy: { revision: "asc" },
      select: { payload: true },
    });
    expect(db.runnerCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          matchId: "match",
          kind: { in: ["offer", "resume"] },
          ackedAt: null,
          cancelledAt: null,
        },
        data: { cancelledAt: expect.any(Date) },
      }),
    );
    expect(db.runnerCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "offer",
          revision: 2,
          payload: { ...offerPayload(), commandId: chessDigest(["runner-reoffer", "match", 3]) },
        }),
      }),
    );
    expect(db.runnerCommand.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "resume" }) }),
    );
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runnerMachineId: "machine", runnerGeneration: 2 }),
        data: expect.objectContaining({
          runnerGeneration: 3,
          runnerRevision: 2,
          runnerResumeDeadline: expect.any(Date),
        }),
      }),
    );
    expect(db.chessMatch.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("runnerState");
  });
  it("accepts an exact offer once and records one authoritative durable resume", async () => {
    expect(await handleRunnerControl(identity, accept())).toEqual(acceptedResponses());
    expect(db.runnerCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "resume",
          revision: 2,
          payload: acceptanceResumePayload(),
        }),
      }),
    );
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "runner",
          runnerGeneration: 3,
          runnerState: "offered",
          runnerRevision: 1,
        }),
        data: expect.objectContaining({
          runnerState: "accepted",
          runnerRevision: { increment: 1 },
        }),
      }),
    );
    expect(db.runnerEvent.create).toHaveBeenCalledWith({
      data: {
        id: "event",
        matchId: "match",
        payloadDigest: chessDigest({
          type: "accept",
          matchId: "match",
          payload: { commandId: "offer" },
        }),
      },
    });
  });
  it.each(["accepted", "starting", "running"])(
    "accepts a fresh reconnect offer in %s phase without downgrading it",
    async (phase) => {
      const state = {
        ...row(),
        runnerState: phase,
        runnerRevision: 3,
        status: phase === "accepted" ? "queued" : "running",
      };
      db.chessMatch.findFirst.mockResolvedValue(state as never);
      db.runnerCommand.findUnique.mockResolvedValue({
        ...command(),
        id: "reoffer",
        revision: 3,
      } as never);
      const message = {
        ...accept("fresh-accept"),
        payload: { commandId: "reoffer" },
      } as RunnerClientMessage;
      await expect(handleRunnerControl(identity, message)).resolves.toEqual(
        acceptedResponses("fresh-accept"),
      );
      expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ runnerRevision: 3, runnerState: phase }),
          data: expect.objectContaining({ runnerState: phase, runnerRevision: { increment: 1 } }),
        }),
      );
      expect(db.runnerCommand.create).toHaveBeenCalledTimes(1);
      expect(db.runnerCommand.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ kind: "resume", revision: 4 }) }),
      );
    },
  );
  it("declines a fresh reconnect offer terminally and cancels other pending controls", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      runnerState: "running",
      runnerRevision: 3,
      status: "running",
    } as never);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      id: "reoffer",
      revision: 3,
    } as never);
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        id: "declined-reoffer",
        seq: 1,
        ack: 0,
        type: "reject",
        matchId: "match",
        payload: { commandId: "reoffer", reason: "policy" },
      }),
    ).resolves.toEqual([{ type: "ack", payload: { commandId: "declined-reoffer" } }]);
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "stopped",
          runnerState: "rejected",
          runnerGeneration: null,
          runnerResumeDeadline: null,
        }),
      }),
    );
    expect(db.runnerCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchId: "match", ackedAt: null, cancelledAt: null },
        data: { cancelledAt: expect.any(Date) },
      }),
    );
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("cannot reuse an already acknowledged offer to generate another resume", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      runnerState: "accepted",
      runnerRevision: 2,
    } as never);
    db.runnerCommand.findUnique.mockResolvedValue({ ...command(), ackedAt: new Date() } as never);
    await expect(handleRunnerControl(identity, accept("new-accept"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
  it.each(["retained", "pending"])(
    "checks the %s command cap before creating an acceptance resume",
    async (cap) => {
      if (cap === "retained") db.runnerCommand.count.mockResolvedValue(4096);
      else db.runnerCommand.count.mockResolvedValueOnce(0).mockResolvedValueOnce(32);
      await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(db.runnerCommand.create).not.toHaveBeenCalled();
      expect(db.runnerEvent.create).not.toHaveBeenCalled();
    },
  );
  it("delivers a current reconnect offer in accepted phase before its resume", async () => {
    stageOutbox(
      [{ ...row(), runnerState: "accepted", runnerRevision: 3 }],
      [queuedCommand("offer", "reoffer", 3, offerPayload("reoffer"))],
    );
    await expect(runnerOutbox(identity)).resolves.toEqual([
      { type: "offer", matchId: "match", payload: offerPayload("reoffer") },
    ]);
  });
  it("reuses the initial unaccepted offer on a replacement socket", async () => {
    const state = { ...row(), runnerGeneration: 2 };
    stageOutbox([state], [queuedCommand("offer", "offer", 1, offerPayload())]);
    await expect(runnerOutbox(identity)).resolves.toEqual([
      { type: "offer", matchId: "match", payload: offerPayload() },
    ]);
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ runnerGeneration: 3, runnerRevision: 1 }),
      }),
    );
  });
  it("delivers reconciliation before an executable command despite tied timestamps and reversed IDs", async () => {
    const state = { ...row(), status: "running", runnerState: "running", runnerRevision: 4 };
    const offer = queuedCommand("offer", "offer", 1, offerPayload());
    offer.ackedAt = new Date();
    const resume = queuedCommand("resume", "z-resume", 3, {
      commandId: "z-resume",
      acceptedSeq: 0,
      ply: 0,
      fen: boardAt(state.archive).fen(),
    });
    const start = queuedCommand("start", "a-start", 4, { commandId: "a-start", expectedSeq: 0 });
    start.createdAt = resume.createdAt;
    stageOutbox([state], [start, resume, offer]);
    expect(await runnerOutbox(identity)).toEqual([
      { type: "resume", matchId: state.id, payload: resume.payload },
    ]);
    // Even already-delivered credit cannot make a dependent start eligible early.
    expect(await runnerOutbox(identity, [start.id])).toEqual([
      { type: "resume", matchId: state.id, payload: resume.payload },
    ]);
    db.runnerCommand.findUnique.mockResolvedValue(resume as never);
    db.runnerCommand.updateMany.mockImplementation((async (
      args: Prisma.RunnerCommandUpdateManyArgs,
    ) => {
      if (args.where?.id === resume.id && args.data.ackedAt instanceof Date)
        resume.ackedAt = args.data.ackedAt;
      return { count: 1 };
    }) as never);
    expect(
      await handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "resume-ack",
        type: "ack",
        payload: { commandId: resume.id },
      }),
    ).toEqual([{ type: "ack", payload: { commandId: "resume-ack" } }]);
    expect(await runnerOutbox(identity)).toEqual([
      { type: "start", matchId: state.id, payload: start.payload },
    ]);
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it.each(["sequence", "fen"])(
    "withholds start after a %s-mismatched acknowledged resume",
    async (fault) => {
      const state = { ...row(), status: "running", runnerState: "running", runnerRevision: 4 };
      const offer = queuedCommand("offer", "offer", 1, offerPayload());
      offer.ackedAt = new Date();
      const otherBoard = boardAt(state.archive);
      applyUci(otherBoard, "e2e4");
      const resume = queuedCommand("resume", "resume", 3, {
        commandId: "resume",
        acceptedSeq: fault === "sequence" ? 1 : 0,
        ply: fault === "sequence" ? 1 : 0,
        fen: fault === "fen" ? otherBoard.fen() : boardAt(state.archive).fen(),
      });
      resume.ackedAt = new Date();
      stageOutbox(
        [state],
        [offer, resume, queuedCommand("start", "start", 4, { commandId: "start", expectedSeq: 0 })],
      );
      expect(await runnerOutbox(identity)).toEqual([]);
    },
  );
  it("selects replacement offers before 32 older blocked executable commands", async () => {
    const states = Array.from({ length: 16 }, (_, index) => ({
      ...row(),
      id: `match-${index}`,
      status: "running",
      runnerState: "running",
      runnerRevision: 3,
    }));
    const commands = states.flatMap((state, index) => [
      queuedCommand(
        "start",
        `old-start-${index}`,
        1,
        { commandId: `old-start-${index}`, expectedSeq: 0 },
        state.id,
      ),
      queuedCommand(
        "human-move",
        `old-human-${index}`,
        2,
        { commandId: `old-human-${index}`, expectedSeq: 0, uci: "e2e4" },
        state.id,
      ),
      queuedCommand("offer", `reoffer-${index}`, 3, offerPayload(`reoffer-${index}`), state.id),
    ]);
    stageOutbox(states, commands);
    const deliveries = await runnerOutbox(identity);
    expect(deliveries).toHaveLength(16);
    expect(deliveries.every((message) => message.type === "offer")).toBe(true);
    expect(deliveries.map((message) => ("matchId" in message ? message.matchId : ""))).toEqual(
      states.map((state) => state.id),
    );
    for (const state of states)
      expect(db.runnerCommand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ matchId: state.id, ackedAt: null, cancelledAt: null }),
          take: RUNNER_OUTBOX_LIMIT,
          orderBy: { revision: "desc" },
        }),
      );
  });
  it("prioritizes a pending human echo before reconciliation or another start", async () => {
    const state = { ...row(), status: "running", runnerState: "running", runnerRevision: 4 };
    const human = queuedCommand("human-move", "human", 2, {
      commandId: "human",
      uci: "e2e4",
      expectedSeq: 0,
    });
    stageOutbox(
      [state],
      [
        human,
        queuedCommand("resume", "resume", 3, {
          commandId: "resume",
          acceptedSeq: 0,
          ply: 0,
          fen: boardAt(state.archive).fen(),
        }),
        queuedCommand("start", "start", 4, { commandId: "start", expectedSeq: 0 }),
      ],
    );
    expect(await runnerOutbox(identity)).toEqual([
      { type: "human-move", matchId: state.id, payload: human.payload },
    ]);
  });
  it.each(["digest", "shape"])(
    "refuses a malformed original %s when preparing a reconnect offer",
    async (fault) => {
      const state = { ...row(), runnerState: "accepted", runnerGeneration: 2 };
      db.chessMatch.findMany.mockResolvedValue([state] as never);
      db.chessMatch.findFirst.mockResolvedValue(state as never);
      const payload =
        fault === "digest"
          ? { ...offerPayload(), configDigest: "a".repeat(64) }
          : { commandId: "offer", configDigest: "a".repeat(64) };
      db.runnerCommand.findFirst.mockResolvedValue({ payload } as never);
      await expect(runnerOutbox(identity)).rejects.toThrow();
      expect(db.runnerCommand.create).not.toHaveBeenCalled();
      expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    },
  );
  it("deduplicates exact repeated events without reapplying state", async () => {
    db.runnerEvent.findUnique.mockResolvedValue({
      matchId: "match",
      payloadDigest: chessDigest({
        type: "accept",
        matchId: "match",
        payload: { commandId: "offer" },
      }),
    } as never);
    expect(await handleRunnerControl(identity, accept())).toEqual([
      { type: "ack", payload: { commandId: "event" } },
    ]);
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("refuses an event id replayed with another command or match", async () => {
    db.runnerEvent.findUnique.mockResolvedValue({
      matchId: "other",
      payloadDigest: "different",
    } as never);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
  });
  it("acks semantic accept retries with a new wire ID without accepting twice", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      runnerState: "accepted",
      runnerRevision: 2,
    } as never);
    db.runnerEvent.findFirst.mockResolvedValue({ id: "previous-wire-id" } as never);
    expect(await handleRunnerControl(identity, accept("new-wire-id"))).toEqual([
      { type: "ack", payload: { commandId: "new-wire-id" } },
    ]);
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
    expect(db.runnerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: "new-wire-id", matchId: "match" }),
      }),
    );
  });
  it("refuses a frame whose generation differs from its authenticated socket", async () => {
    await expect(
      handleRunnerControl(identity, { ...accept(), generation: 2 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("bounds retained command receipts even when previous resumes were acknowledged", async () => {
    const old = { ...row(), runnerGeneration: 2, runnerState: "accepted" };
    db.chessMatch.findMany.mockResolvedValue([old] as never);
    db.chessMatch.findFirst.mockResolvedValue(old as never);
    db.runnerCommand.count.mockResolvedValue(4096);
    await expect(runnerOutbox(identity)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("validates persisted payloads before delivering them", async () => {
    stageOutbox(
      [{ ...row(), runnerState: "accepted" }],
      [queuedCommand("resume", "resume", 2, { commandId: "resume", path: "/not-allowed" })],
    );
    await expect(runnerOutbox(identity)).rejects.toThrow();
  });
  it("records a matching snapshot without creating another resume or consuming command capacity", async () => {
    const state = row();
    db.runnerCommand.count.mockResolvedValue(4096);
    const responses = await handleRunnerControl(identity, {
      version: 1,
      generation: 3,
      seq: 1,
      ack: 0,
      id: "snapshot-event",
      type: "snapshot",
      matchId: "match",
      payload: { acceptedSeq: 0, fen: boardAt(state.archive).fen(), ply: 0 },
    });
    expect(responses).toEqual([{ type: "ack", payload: { commandId: "snapshot-event" } }]);
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
    expect(db.runnerCommand.count).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runnerGeneration: 3, runnerRevision: 1 }),
        data: { runnerLastContactAt: expect.any(Date) },
      }),
    );
    expect(db.runnerEvent.create).toHaveBeenCalledTimes(1);
  });
  it("settles a terminal stop at the event cap with one bounded first-ACK receipt", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "stopped",
      runnerState: "stopped",
      runnerGeneration: null,
      runnerRevision: 2,
    } as never);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      id: "stop",
      kind: "stop",
      revision: 2,
    } as never);
    db.runnerEvent.count.mockResolvedValue(4096);
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "stop-ack",
        type: "ack",
        payload: { commandId: "stop" },
      }),
    ).resolves.toEqual([{ type: "ack", payload: { commandId: "stop-ack" } }]);
    expect(db.runnerCommand.updateMany).toHaveBeenCalledWith({
      where: {
        id: "stop",
        matchId: "match",
        kind: "stop",
        ackedAt: null,
        cancelledAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { ackedAt: expect.any(Date) },
    });
    expect(db.runnerEvent.count).toHaveBeenCalledTimes(1);
    expect(db.runnerEvent.create).toHaveBeenCalledWith({
      data: {
        id: "stop-ack",
        matchId: "match",
        payloadDigest: chessDigest({
          type: "ack",
          matchId: "match",
          payload: { commandId: "stop" },
        }),
      },
    });
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(db.runnerMachine.findFirst).toHaveBeenCalledTimes(2);
  });
  it("replays terminal stop ACKs with fresh wire IDs without receipt growth or another write", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "stopped",
      runnerState: "stopped",
      runnerGeneration: null,
      runnerRevision: 2,
    } as never);
    const stop = {
      ...command(),
      id: "stop",
      kind: "stop",
      revision: 2,
      ackedAt: null as Date | null,
    };
    db.runnerCommand.findUnique.mockImplementation((async () => ({ ...stop })) as never);
    db.runnerCommand.updateMany.mockImplementation((async () => {
      stop.ackedAt = new Date();
      return { count: 1 };
    }) as never);
    db.runnerEvent.count.mockResolvedValue(4096);
    for (const id of ["ack-one", "ack-two", "ack-three"]) {
      await expect(
        handleRunnerControl(identity, {
          version: 1,
          generation: 3,
          seq: 1,
          ack: 0,
          id,
          type: "ack",
          payload: { commandId: "stop" },
        }),
      ).resolves.toEqual([{ type: "ack", payload: { commandId: id } }]);
    }
    expect(db.runnerCommand.updateMany).toHaveBeenCalledTimes(1);
    expect(db.runnerEvent.create).toHaveBeenCalledTimes(1);
    expect(db.runnerEvent.count).toHaveBeenCalledTimes(1);
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
  it.each(["kind", "cancelled", "expired", "foreign-command", "revision", "generation"])(
    "does not bypass receipt capacity for a terminal stop ACK with invalid %s",
    async (fault) => {
      db.chessMatch.findFirst.mockResolvedValue({
        ...row(),
        status: "stopped",
        runnerState: "stopped",
        runnerGeneration: fault === "generation" ? 3 : null,
        runnerRevision: 2,
      } as never);
      db.runnerCommand.findUnique.mockResolvedValue({
        ...command(),
        id: "stop",
        kind: fault === "kind" ? "resume" : "stop",
        revision: fault === "revision" ? 1 : 2,
        matchId: fault === "foreign-command" ? "foreign" : "match",
        cancelledAt: fault === "cancelled" ? new Date() : null,
        expiresAt: fault === "expired" ? new Date(0) : new Date(Date.now() + 300_000),
      } as never);
      if (fault === "foreign-command") {
        db.runnerCommand.findUnique.mockResolvedValueOnce({ matchId: "match" } as never);
      }
      db.runnerEvent.count.mockResolvedValue(4096);
      await expect(
        handleRunnerControl(identity, {
          version: 1,
          generation: 3,
          seq: 1,
          ack: 0,
          id: "stop-ack",
          type: "ack",
          payload: { commandId: "stop" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
      expect(db.runnerEvent.create).not.toHaveBeenCalled();
    },
  );
  it("refuses to exceed the one reserved first-stop-ACK receipt", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "stopped",
      runnerState: "stopped",
      runnerGeneration: null,
      runnerRevision: 2,
    } as never);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      id: "stop",
      kind: "stop",
      revision: 2,
    } as never);
    db.runnerEvent.count.mockResolvedValue(4097);
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "stop-ack",
        type: "ack",
        payload: { commandId: "stop" },
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
  });
  it("retains the owner/source/machine binding on the terminal stop ACK escape", async () => {
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      id: "stop",
      kind: "stop",
      revision: 2,
    } as never);
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "stop-ack",
        type: "ack",
        payload: { commandId: "stop" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match", ownerId: "owner", source: "runner", runnerMachineId: "machine" },
      }),
    );
    expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
  });
  it("preserves existing global wire ID payload binding before the terminal stop ACK escape", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "stopped",
      runnerState: "stopped",
      runnerGeneration: null,
      runnerRevision: 2,
    } as never);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      id: "stop",
      kind: "stop",
      revision: 2,
    } as never);
    db.runnerEvent.findUnique.mockResolvedValue({
      matchId: "foreign",
      payloadDigest: "another-payload",
    } as never);
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "reused-wire-id",
        type: "ack",
        payload: { commandId: "stop" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
  });
  it("rolls back the terminal stop ACK if its original command TTL lapses during the write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "stopped",
      runnerState: "stopped",
      runnerGeneration: null,
      runnerRevision: 2,
    } as never);
    db.runnerCommand.findUnique.mockResolvedValue({
      ...command(),
      id: "stop",
      kind: "stop",
      revision: 2,
      expiresAt: new Date(now + 10),
    } as never);
    db.runnerCommand.updateMany.mockImplementation((async () => {
      vi.setSystemTime(now + 20);
      return { count: 1 };
    }) as never);
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "stop-ack",
        type: "ack",
        payload: { commandId: "stop" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
  });
  it.each(["accept", "resume-ack", "snapshot"])(
    "does not exempt ordinary %s effects from the general receipt cap",
    async (kind) => {
      db.runnerEvent.count.mockResolvedValue(4096);
      const state = row();
      const message: RunnerClientMessage =
        kind === "accept"
          ? accept()
          : kind === "resume-ack"
            ? {
                version: 1,
                generation: 3,
                seq: 1,
                ack: 0,
                id: "ack-resume",
                type: "ack",
                payload: { commandId: "resume" },
              }
            : {
                version: 1,
                generation: 3,
                seq: 1,
                ack: 0,
                id: "snapshot",
                type: "snapshot",
                matchId: "match",
                payload: { acceptedSeq: 0, fen: boardAt(state.archive).fen(), ply: 0 },
              };
      if (kind === "resume-ack")
        db.runnerCommand.findUnique.mockResolvedValue({
          ...command(),
          id: "resume",
          kind: "resume",
        } as never);
      await expect(handleRunnerControl(identity, message)).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
      expect(db.runnerEvent.create).not.toHaveBeenCalled();
      expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["offer", "human-move"])(
    "does not treat transport ack as semantic %s acceptance",
    async (kind) => {
      db.runnerCommand.findUnique.mockResolvedValue({ ...command(), kind } as never);
      await expect(
        handleRunnerControl(identity, {
          version: 1,
          generation: 3,
          seq: 1,
          ack: 0,
          id: "event",
          type: "ack",
          payload: { commandId: "offer" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
      expect(db.runnerCommand.updateMany).not.toHaveBeenCalled();
      expect(db.runnerEvent.create).not.toHaveBeenCalled();
    },
  );
  it("rejects stale match generation even with a valid current machine", async () => {
    db.chessMatch.findFirst.mockResolvedValue({ ...row(), runnerGeneration: 2 } as never);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(db.runnerEvent.create).not.toHaveBeenCalled();
  });
  it("refuses submitted snapshots that disagree with authoritative board or sequence", async () => {
    const state = row();
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "event",
        type: "snapshot",
        matchId: "match",
        payload: { acceptedSeq: 1, fen: boardAt(state.archive).fen(), ply: 0 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("refuses arbitrary events or moves rather than trusting client game outcomes", async () => {
    await expect(
      handleRunnerControl(identity, {
        version: 1,
        generation: 3,
        seq: 1,
        ack: 0,
        id: "event",
        type: "event",
        matchId: "match",
        payload: { kind: "completed" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("runner absolute transaction admission budget", () => {
  it("expires queued browser and machine requests in actual lock slots without late transactions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder1 = withLockSlot(() => held);
    const holder2 = withLockSlot(() => held);
    try {
      const browser = expect(
        runnerMatchStatus(context, { slug: "runner-match" }),
      ).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "runner-unavailable" },
      });
      const machine = expect(runnerOutbox(identity)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "runner-unavailable" },
      });
      expect(db.$transaction).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4001);
      await Promise.all([browser, machine]);
    } finally {
      release();
      await Promise.all([holder1, holder2]);
    }
    await Promise.resolve();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("gives nearly expired admitted work only its remaining checkout and transaction budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder1 = withLockSlot(() => held);
    const holder2 = withLockSlot(() => held);
    const request = runnerMatchStatus(context, { slug: "runner-match" });
    try {
      await vi.advanceTimersByTimeAsync(3900);
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([holder1, holder2]);
    }
    await expect(request).resolves.toMatchObject({ id: "match" });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
      maxWait: 50,
      timeout: 50,
    });
    expect(db.$executeRaw.mock.calls[0]?.[1]).toBe("50ms");
  });
  it("rejects a callback that consumes its remaining absolute budget before final authority", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    db.chessMatch.findFirst.mockImplementation((async () => {
      await vi.advanceTimersByTimeAsync(3501);
      return row();
    }) as never);
    await expect(runnerMatchStatus(context, { slug: "runner-match" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(mintAuthority).toHaveBeenCalledTimes(1);
  });
});

describe("authoritative runner gameplay", () => {
  it("pins a valid archive after intersecting advertised match ceilings", async () => {
    const { readRunnerLimitsInTransaction } = await import(
      "@cockpit-chess/auth/runner-limits-store"
    );
    vi.mocked(readRunnerLimitsInTransaction).mockResolvedValueOnce({
      generation: 3,
      operatingLimits: { matchMicros: 1_000_000 },
      hardLimits: { matchMicros: 25_000_000 },
    } as never);
    db.chessMatch.create.mockResolvedValue(row() as never);
    await createRunnerMatch(context, { machineId: "machine", creationKey: randomUUID(), config });
    const data = db.chessMatch.create.mock.calls[0]?.[0].data;
    const archive = validateArchive(data?.archive);
    expect(archive.config.rules.costBudgetMicros).toBe(500_000);
  });
  function running(human = false) {
    const state = row();
    state.status = "running";
    state.runnerState = "running";
    state.archive = createMatch(
      human
        ? {
            ...config,
            white: { name: "Human", model: "human", protocol: "human" },
            rules: { ...config.rules, context: "fresh" },
          }
        : config,
    );
    beginHostedTurn(state.archive);
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    db.runnerCommand.findUnique.mockResolvedValue(null);
    db.runnerCommand.findFirst.mockResolvedValue(null);
    return state;
  }
  function frame(
    type: "move",
    payload: { uci: string; ply: number; fen: string },
  ): RunnerClientMessage {
    return { ...accept(), type, payload };
  }
  function move(state: ReturnType<typeof row>, uci = "e2e4") {
    const board = boardAt(state.archive);
    applyUci(board, uci);
    return frame("move", { uci, ply: 1, fen: board.fen() });
  }
  it("independently applies a legal model move and writes a current valid archive before next dispatch", async () => {
    const state = running();
    const replies = await handleRunnerControl(identity, move(state));
    expect(replies.map((r) => r.type)).toEqual(["ack"]);
    expect(db.runnerCommand.create.mock.calls.map(([args]) => args.data.kind)).toEqual([
      "resume",
      "start",
    ]);
    expect(db.runnerCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchId: "match", kind: "resume", ackedAt: null, cancelledAt: null },
      }),
    );
    const data = db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({
      status: "running",
      runnerAcceptedSeq: 1,
      whiteCostMicros: null,
      blackCostMicros: null,
    });
    const archive = validateArchive(data?.archive);
    expect(boardAt(archive).turn()).toBe("b");
    expect(archive.turn.type).toBe("model");
  });
  it.each(["commands", "events"])(
    "settles %s journal exhaustion as unscored event-limit before another dispatch",
    async (kind) => {
      const state = running();
      db.runnerCommand.count.mockImplementation((async (args?: Prisma.RunnerCommandCountArgs) =>
        args?.where?.ackedAt === null ? 0 : kind === "commands" ? 4092 : 0) as never);
      db.runnerEvent.count.mockResolvedValue(kind === "events" ? 4080 : 0);
      expect(await handleRunnerControl(identity, move(state))).toEqual(acceptedResponses());
      const data = db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data;
      expect(data).toMatchObject({
        status: "error",
        runnerState: "error",
        runnerGeneration: null,
        result: "*",
        terminalCause: "event-limit",
      });
      expect(validateArchive(data?.archive).termination).toBe("event-limit");
      expect(db.runnerCommand.create.mock.calls.map(([args]) => args.data.kind)).toEqual(["stop"]);
    },
  );
  it("allows the next turn immediately below both journal reserve thresholds", async () => {
    const state = running();
    db.runnerCommand.count.mockImplementation((async (args?: Prisma.RunnerCommandCountArgs) =>
      args?.where?.ackedAt === null ? 0 : 4091) as never);
    db.runnerEvent.count.mockResolvedValue(4079);
    expect(await handleRunnerControl(identity, move(state))).toEqual(acceptedResponses());
    expect(db.runnerCommand.create.mock.calls.map(([args]) => args.data.kind)).toEqual([
      "resume",
      "start",
    ]);
    expect(db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "running",
      runnerAcceptedSeq: 1,
      runnerGeneration: 3,
    });
  });
  it.each(["illegal", "ply", "fen", "human", "generation"])(
    "refuses %s move without a durable write or next dispatch",
    async (fault) => {
      const state = running(fault === "human");
      const message = move(state);
      if (message.type !== "move") throw new Error("Expected move");
      if (fault === "illegal") message.payload.uci = "e2e5";
      if (fault === "ply") message.payload.ply = 2;
      if (fault === "fen") message.payload.fen = boardAt(state.archive).fen();
      if (fault === "generation")
        db.chessMatch.findFirst.mockResolvedValue({ ...state, runnerGeneration: 2 } as never);
      await expect(handleRunnerControl(identity, message)).rejects.toMatchObject({
        code: fault === "illegal" ? "BAD_REQUEST" : "CONFLICT",
      });
      expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
      expect(db.runnerCommand.create).not.toHaveBeenCalled();
    },
  );
  it("keeps clocks running during disconnect and settles server expiry before a late legal move", async () => {
    const state = running();
    const now = Date.now();
    beginState();
    function beginState() {
      state.archive.turn = { type: "idle" };
      beginHostedTurn(state.archive, new Date(now - 61_000));
    }
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    await handleRunnerControl(identity, move(state));
    const data = db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({
      status: "completed",
      runnerGeneration: null,
      runnerAcceptedSeq: 0,
      result: "0-1",
      terminalCause: "move-timeout",
    });
    validateArchive(data?.archive);
  });
  it("replays bounded rejected attempts through the common illegal policy", async () => {
    const state = running();
    const response = await handleRunnerControl(identity, {
      ...accept(),
      type: "event",
      payload: {
        kind: "completed",
        result: "0-1",
        termination: "illegal-forfeit",
        ply: 0,
        fen: boardAt(state.archive).fen(),
        rejectedAttempts: Array.from({ length: 3 }, () => ({ move: "e2e5" })),
      },
    });
    expect(response.map((r) => r.type)).toEqual(["ack"]);
    const data = db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({ status: "completed", whiteIllegal: 3, runnerGeneration: null });
    validateArchive(data?.archive);
  });
  it("refuses a fabricated checkmate on a live board", async () => {
    const state = running();
    await expect(
      handleRunnerControl(identity, {
        ...accept(),
        type: "event",
        payload: {
          kind: "completed",
          result: "1-0",
          termination: "checkmate",
          ply: 0,
          fen: boardAt(state.archive).fen(),
          rejectedAttempts: [],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
  it("accepts a human move only from the live owner board and forwards its pre-move ply", async () => {
    const state = running(true);
    const result = await moveRunnerMatch(context, {
      slug: state.slug,
      commandId: randomUUID(),
      expectedRevision: state.runnerRevision,
      expectedSeq: 0,
      fen: boardAt(state.archive).fen(),
      move: "e2e4",
    });
    expect(result.acceptedSeq).toBe(1);
    expect(db.runnerCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "human-move",
          payload: expect.objectContaining({ uci: "e2e4", expectedSeq: 0 }),
        }),
      }),
    );
    validateArchive(db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data.archive);
  });
  it.each([
    ["session", true],
    ["machine", true],
    ["session", false],
    ["machine", false],
  ] as const)(
    "checks retained %s expiry after the final machine await (expired: %s)",
    async (credential, expired) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.now();
      const state = running(true);
      const expiry = new Date(now + (expired ? 10 : 1000));
      const machine = {
        id: "machine",
        expiresAt: credential === "machine" ? expiry : new Date(now + 1000),
        User: { emailVerified: true, banned: false, banExpires: null, deletionRequestedAt: null },
      };
      mintAuthority.mockImplementation(
        async (_tx: unknown, _session: unknown, retain: (value: Date) => void) => {
          retain(credential === "session" ? expiry : new Date(now + 1000));
          return { id: "owner" };
        },
      );
      db.runnerMachine.findFirst
        .mockResolvedValueOnce(machine as never)
        .mockImplementationOnce((async () => {
          vi.setSystemTime(now + 20);
          return machine;
        }) as never);
      const operation = moveRunnerMatch(context, {
        slug: state.slug,
        commandId: randomUUID(),
        expectedRevision: state.runnerRevision,
        expectedSeq: 0,
        fen: boardAt(state.archive).fen(),
        move: "e2e4",
      });
      if (expired) {
        await expect(operation).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(publish).not.toHaveBeenCalled();
      } else await expect(operation).resolves.toMatchObject({ acceptedSeq: 1 });
      expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(1);
      expect(db.runnerMachine.findFirst).toHaveBeenCalledTimes(2);
    },
  );
  it("retains machine expiry across the final control authorization await", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const machine = {
      id: "machine",
      expiresAt: new Date(now + 10),
      User: { emailVerified: true, banned: false, banExpires: null, deletionRequestedAt: null },
    };
    db.runnerMachine.findFirst
      .mockResolvedValueOnce(machine as never)
      .mockImplementationOnce((async () => {
        vi.setSystemTime(now + 20);
        return machine;
      }) as never);
    await expect(handleRunnerControl(identity, accept())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.runnerMachine.findFirst).toHaveBeenCalledTimes(2);
  });
  it("records exactly120s disconnect grace only for this live generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T01:00:00Z"));
    await disconnectRunnerMatches(identity);
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "runner",
          runnerMachineId: "machine",
          runnerGeneration: 3,
          runnerResumeDeadline: { gt: new Date() },
        }),
        data: { runnerResumeDeadline: new Date(Date.now() + 120_000) },
      }),
    );
  });
  it("accepts a local operating-limit stop while the server is awaiting a human", async () => {
    const state = running(true);
    await handleRunnerControl(identity, {
      ...accept(),
      type: "event",
      payload: {
        kind: "stopped",
        result: "*",
        termination: "cancelled",
        ply: 0,
        fen: boardAt(state.archive).fen(),
        rejectedAttempts: [],
      },
    });
    expect(db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "stopped",
      runnerGeneration: null,
    });
  });
  it("rechecks the original turn deadline after the last receipt write", async () => {
    vi.useFakeTimers();
    const state = running();
    const deadline =
      state.archive.turn.type === "idle" ? 0 : Date.parse(state.archive.turn.deadline);
    db.runnerEvent.create.mockImplementation((async () => {
      vi.setSystemTime(deadline + 1);
      return {};
    }) as never);
    await expect(handleRunnerControl(identity, move(state))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("withholds an old start until the replacement offer is accepted", async () => {
    const state = running();
    const offer = queuedCommand("offer", "reoffer", 4, offerPayload("reoffer"));
    offer.ackedAt = new Date();
    const resume = queuedCommand("resume", "old-resume", 2, {
      commandId: "old-resume",
      acceptedSeq: 0,
      ply: 0,
      fen: boardAt(state.archive).fen(),
    });
    resume.ackedAt = new Date();
    stageOutbox(
      [state],
      [offer, resume, queuedCommand("start", "start", 3, { commandId: "start", expectedSeq: 0 })],
    );
    await expect(runnerOutbox(identity)).resolves.toEqual([]);
  });
  it("normalizes a revoked match status over its still-running archive", async () => {
    const state = running(true);
    state.status = "stopped";
    state.runnerState = "stopped";
    state.runnerGeneration = null as never;
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    const result = await runnerMatchStatus(context, { slug: state.slug });
    expect(result).toMatchObject({
      status: "stopped",
      turn: { type: "idle" },
      termination: "cancelled",
      result: "*",
    });
  });
  it("classifies a delayed sweep at the first model deadline, not the later exhausted clock", async () => {
    const state = running();
    state.archive = createMatch({
      ...config,
      rules: { ...config.rules, clock: { w: 120_000, b: 120_000 }, turnTimeoutMs: 60_000 },
    });
    beginHostedTurn(state.archive, new Date(Date.now() - 130_000));
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    await handleRunnerControl(identity, move(state));
    const archive = validateArchive(db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data.archive);
    expect(archive.termination).toBe("move-timeout");
    expect(archive.events.find((e) => e.type === "timing")).toMatchObject({ elapsedMs: 60_000 });
  });
  it("abandons an expired human reconnect grace before accepting browser input", async () => {
    const state = running(true);
    state.archive = createMatch({
      ...config,
      white: { name: "Human", model: "human", protocol: "human" },
      rules: { ...config.rules, context: "fresh", turnTimeoutMs: 300_000 },
    });
    beginHostedTurn(state.archive, new Date(Date.now() - 121_000));
    state.runnerResumeDeadline = new Date(Date.now() - 1);
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    const result = await moveRunnerMatch(context, {
      slug: state.slug,
      commandId: randomUUID(),
      expectedRevision: state.runnerRevision,
      expectedSeq: 0,
      fen: boardAt(state.archive).fen(),
      move: "e2e4",
    });
    expect(result).toMatchObject({ state: "abandoned", acceptedSeq: 0, turn: { type: "idle" } });
    expect(db.runnerCommand.create).not.toHaveBeenCalled();
  });
  it("refuses a browser move when its original grace expires during receipt persistence", async () => {
    vi.useFakeTimers();
    const state = running(true);
    state.runnerResumeDeadline = new Date(Date.now() + 1000);
    db.chessMatch.findFirst.mockResolvedValue(state as never);
    db.runnerEvent.create.mockImplementation((async () => {
      vi.setSystemTime(Date.now() + 1001);
      return {};
    }) as never);
    await expect(
      moveRunnerMatch(context, {
        slug: state.slug,
        commandId: randomUUID(),
        expectedRevision: state.runnerRevision,
        expectedSeq: 0,
        fen: boardAt(state.archive).fen(),
        move: "e2e4",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("runner durable authenticated contact", () => {
  it("renews contact with no active games using exact generation and a bounded write interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T04:00:00Z"));
    await runnerOutbox(identity);
    expect(db.runnerMachine.updateMany).toHaveBeenCalledWith({
      where: {
        id: "machine",
        userId: "owner",
        connectionGeneration: 3,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(Date.now() - 15_000) } }],
      },
      data: { lastSeenAt: new Date() },
    });
  });
  it("cannot refresh contact from a superseded or revoked identity", async () => {
    db.runnerMachine.findFirst.mockResolvedValue(null);
    await expect(runnerOutbox(identity)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.runnerMachine.updateMany).not.toHaveBeenCalled();
  });
});

it("settles pending-owner recovery as deletion even when the machine is already revoked", async () => {
  const state = { ...row(), Owner: { deletionRequestedAt: new Date() } };
  db.chessMatch.findMany.mockResolvedValue([
    { id: state.id, ownerId: "owner", runnerMachineId: "machine" },
  ] as never);
  db.chessMatch.findFirst.mockResolvedValue(state as never);
  db.runnerMachine.findFirst.mockResolvedValue(null);
  const { reconcileRunnerMatches } = await import("./chess-runner");
  await expect(reconcileRunnerMatches()).resolves.toEqual({ scanned: 1, settled: 1 });
  expect(db.chessMatch.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
    status: "stopped",
    runnerState: "stopped",
    runnerGeneration: null,
    runnerResumeDeadline: null,
    terminalCause: "owner-delete",
  });
});
