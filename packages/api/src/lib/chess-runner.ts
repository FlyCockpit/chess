import { randomUUID } from "node:crypto";
import { isAccountDeletionPending } from "@cockpit-chess/auth/account-state";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { LockSlotTimeoutError, withLockSlot } from "@cockpit-chess/auth/lock-slots";
import { readRunnerLimitsInTransaction } from "@cockpit-chess/auth/runner-limits-store";
import {
  RunnerMachineForbiddenError,
  RunnerMachineSessionRevokedError,
  requireRunnerMachineMintAuthority,
} from "@cockpit-chess/auth/runner-machine";
import {
  applyUci,
  archiveByteLength,
  beginHostedTurn,
  boardAt,
  createMatch,
  finishMatch,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  matchConfigSchema,
  parseArchive,
  playHostedHumanTurn,
  playHumanTurn,
  submitMove,
} from "@cockpit-chess/chess";
import {
  RUNNER_COMMAND_WINDOW,
  RUNNER_MAX_MATCHES_PER_MACHINE,
  RUNNER_RESUME_GRACE_MS,
  type RunnerClientMessage,
  type RunnerDelivery,
  runnerClientMessageSchema,
  runnerConfigDigest,
  runnerMatchConfigSchema,
  runnerServerMessageSchema,
} from "@cockpit-chess/chess/runner-protocol";
import { gamePositions, storedSpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { redisConnection } from "@cockpit-chess/queue";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "../context";
import { readStoredArchive } from "./chess-archive";
import { chessTurnData } from "./chess-human";
import { chessDigest as digest } from "./chess-official";
import { chessStatsColumns } from "./chess-stats";
import { slugify } from "./slug";

export const RUNNER_COMMAND_CHANNEL = "chess_runner_command";
export const RUNNER_COMMAND_TTL_MS = 5 * 60_000;
export const RUNNER_OUTBOX_LIMIT = 32;
export const RUNNER_EVENT_LIMIT = 4096;
export const RUNNER_COMMAND_LIMIT = 4096;
const MAX_MACHINE_MATCHES = RUNNER_MAX_MATCHES_PER_MACHINE;
const MAX_OWNER_MATCHES = 64;
const activeStates = ["offered", "accepted", "starting", "running"];

export const createRunnerInput = z.strictObject({
  machineId: z.string().min(1).max(128),
  creationKey: z.uuid(),
  config: matchConfigSchema,
});
export const runnerSlugInput = z.strictObject({
  slug: z
    .string()
    .min(1)
    .max(180)
    .regex(/^[a-z0-9-]+$/),
});
export const runnerCommandInput = runnerSlugInput.extend({
  commandId: z.uuid(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
});
export const runnerMoveInput = runnerCommandInput.extend({
  expectedSeq: z.number().int().min(0).max(2_147_483_646),
  fen: z.string().min(1).max(128),
  move: z.string().regex(/^(?:[a-h][1-8][a-h][1-8][qrbn]?|resign)$/),
});

export type RunnerControlIdentity = {
  userId: string;
  machineId: string;
  connectionGeneration: number;
};
type BrowserContext = Context & { session: NonNullable<Context["session"]> };
const notFound = () => new ORPCError("NOT_FOUND");
const stale = () => new ORPCError("CONFLICT", { data: { reason: "runner-stale" } });

const controlSelect = {
  id: true,
  slug: true,
  source: true,
  ownerId: true,
  Owner: { select: { deletionRequestedAt: true } },
  status: true,
  runnerMachineId: true,
  runnerGeneration: true,
  runnerState: true,
  runnerRevision: true,
  runnerAcceptedSeq: true,
  runnerLastContactAt: true,
  runnerResumeDeadline: true,
  archive: true,
  spectatorEvaluations: true,
} satisfies Prisma.ChessMatchSelect;
type ControlRow = Prisma.ChessMatchGetPayload<{ select: typeof controlSelect }>;

function activeRunner(row: Pick<ControlRow, "status" | "runnerState">) {
  return ["queued", "running"].includes(row.status) && activeStates.includes(row.runnerState ?? "");
}

function snapshot(row: ControlRow) {
  const archive = readStoredArchive(row.archive, row.status);
  if (row.source !== "runner" || archive.source !== "local") throw stale();
  const board = boardAt(archive);
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    state: row.runnerState,
    revision: row.runnerRevision,
    acceptedSeq: row.runnerAcceptedSeq,
    fen: board.fen(),
    ply: archive.events.filter((event) => event.type === "attempt" && event.accepted).length,
    lastContactAt: row.runnerLastContactAt,
    resumeDeadline: row.runnerResumeDeadline,
    turn: archive.turn,
    result: archive.result,
    termination: archive.termination,
    verification: "self-run" as const,
  };
}

const unavailable = () =>
  new ORPCError("SERVICE_UNAVAILABLE", { data: { reason: "runner-unavailable" } });

/** One budget covers admission, checkout, SQL work and final authority before commit. */
async function runnerTransaction<T>(
  userId: string,
  authorize: (tx: Prisma.TransactionClient) => Promise<unknown>,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  validateBeforeCommit?: () => void,
) {
  const deadline = performance.now() + 4000;
  try {
    return await withLockSlot(
      () => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 2) throw unavailable();
        const maxWait = Math.min(500, Math.floor(remaining / 2));
        const timeout = remaining - maxWait;
        return prisma.$transaction(
          async (tx) => {
            const transactionDeadline = Math.min(deadline, performance.now() + timeout);
            const requireTime = () => {
              const ms = Math.floor(transactionDeadline - performance.now());
              if (ms <= 0) throw unavailable();
              return ms;
            };
            await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${requireTime()}ms`}, true)`;
            await lockCliCredentials(userId, tx);
            requireTime();
            await authorize(tx);
            requireTime();
            await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${requireTime()}ms`}, true)`;
            requireTime();
            const result = await run(tx);
            requireTime();
            // Elapsed credential/session expiry cannot be protected by an advisory lock.
            await authorize(tx);
            requireTime();
            validateBeforeCommit?.();
            return result;
          },
          { isolationLevel: "ReadCommitted", maxWait, timeout },
        );
      },
      { deadline },
    );
  } catch (error) {
    if (error instanceof LockSlotTimeoutError) throw unavailable();
    throw error;
  }
}

async function browserTransaction<T>(
  context: BrowserContext,
  run: (tx: Prisma.TransactionClient, userId: string, retain: (expiry: Date) => void) => Promise<T>,
  validateBeforeCommit?: () => void,
  validateMachine?: (
    tx: Prisma.TransactionClient,
    retain: (expiry: Date) => void,
  ) => Promise<unknown>,
) {
  if (context.credential !== undefined) throw new ORPCError("UNAUTHORIZED");
  const userId = context.session.user.id;
  const grants = temporalGrants();
  try {
    return await runnerTransaction(
      userId,
      async (tx) => {
        await requireRunnerMachineMintAuthority(
          tx,
          {
            userId,
            sessionId: context.session.session.id,
          },
          grants.retainCredential,
        );
        await validateMachine?.(tx, grants.retainCredential);
      },
      (tx) => run(tx, userId, grants.retainCredential),
      () => {
        grants.check();
        validateBeforeCommit?.();
      },
    );
  } catch (error) {
    if (error instanceof RunnerMachineSessionRevokedError) throw new ORPCError("UNAUTHORIZED");
    if (error instanceof RunnerMachineForbiddenError) throw new ORPCError("FORBIDDEN");
    throw error;
  }
}

async function liveMachine(
  tx: Prisma.TransactionClient,
  identity: RunnerControlIdentity,
  retain?: (expiry: Date) => void,
) {
  const machine = await tx.runnerMachine.findFirst({
    where: {
      id: identity.machineId,
      userId: identity.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      connectionGeneration: identity.connectionGeneration,
    },
    select: {
      id: true,
      expiresAt: true,
      User: {
        select: { banned: true, banExpires: true, emailVerified: true, deletionRequestedAt: true },
      },
    },
  });
  if (
    !machine?.User.emailVerified ||
    isAccountDeletionPending(machine.User) ||
    isUserBanned(machine.User) ||
    machine.expiresAt.getTime() <= Date.now()
  )
    throw new ORPCError("UNAUTHORIZED");
  retain?.(machine.expiresAt);
}

type TemporalGrants = {
  retain: (deadline: Date | null | undefined) => void;
  retainCredential: (expiry: Date) => void;
  check: () => void;
};

function temporalGrants(): TemporalGrants {
  let deadline: number | null = null;
  let credentialExpiry: number | null = null;
  return {
    retain(value) {
      if (value) deadline = Math.min(deadline ?? Infinity, value.getTime());
    },
    retainCredential(value) {
      const time = value.getTime();
      if (!Number.isFinite(time)) throw new ORPCError("UNAUTHORIZED");
      credentialExpiry = Math.min(credentialExpiry ?? Infinity, time);
    },
    check() {
      if (credentialExpiry !== null && credentialExpiry <= Date.now())
        throw new ORPCError("UNAUTHORIZED");
      if (deadline !== null && deadline <= Date.now()) throw stale();
    },
  };
}

async function machineTransaction<T>(
  identity: RunnerControlIdentity,
  run: (tx: Prisma.TransactionClient, grants: TemporalGrants) => Promise<T>,
) {
  const grants = temporalGrants();
  return runnerTransaction(
    identity.userId,
    (tx) => liveMachine(tx, identity, grants.retainCredential),
    (tx) => run(tx, grants),
    grants.check,
  );
}

async function lockedMatch(
  tx: Prisma.TransactionClient,
  matchId: string,
  identity: RunnerControlIdentity,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chess-runner:${matchId}`}))`;
  const row = await tx.chessMatch.findFirst({
    where: {
      id: matchId,
      ownerId: identity.userId,
      source: "runner",
      runnerMachineId: identity.machineId,
    },
    select: controlSelect,
  });
  if (!row) throw notFound();
  return row;
}

/** Delivery is a hint. The durable outbox remains authoritative after a lost publish. */
async function wake(machineId: string) {
  await redisConnection
    .publish(RUNNER_COMMAND_CHANNEL, JSON.stringify({ machineId }))
    .catch(() => undefined);
}

export async function createRunnerMatch(
  context: BrowserContext,
  raw: z.input<typeof createRunnerInput>,
) {
  const input = createRunnerInput.parse(raw);
  let archive = createMatch(input.config, "local");
  if (archive.status !== "running")
    throw new ORPCError("BAD_REQUEST", { data: { reason: "terminal-position" } });
  const offeredConfig = runnerMatchConfigSchema.safeParse({
    title: archive.config.title,
    white: archive.config.white,
    black: archive.config.black,
    rules: archive.config.rules,
    initialFen: archive.config.initialFen,
    promptVersion: archive.config.prompt.version,
  });
  if (!offeredConfig.success)
    throw new ORPCError("BAD_REQUEST", { data: { reason: "runner-config" } });
  const config = offeredConfig.data;
  const requestedDigest = runnerConfigDigest(config);
  const receiptId = digest(["runner", context.session.user.id, input.creationKey]);
  const result = await browserTransaction(context, async (tx, userId, retain) => {
    const accepted = await tx.chessCreation.findUnique({
      where: { id: receiptId },
      select: { configDigest: true, Match: { select: controlSelect } },
    });
    const requestDigest = digest({ machineId: input.machineId, configDigest: requestedDigest });
    if (accepted) {
      if (accepted.configDigest !== requestDigest) throw stale();
      if (
        !accepted.Match ||
        accepted.Match.ownerId !== userId ||
        accepted.Match.source !== "runner"
      )
        throw notFound();
      return snapshot(accepted.Match);
    }
    const machine = await tx.runnerMachine.findFirst({
      where: {
        id: input.machineId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        lastSeenAt: { gt: new Date(Date.now() - 60_000) },
      },
      select: { id: true, connectionGeneration: true, expiresAt: true },
    });
    if (!machine) throw notFound();
    retain(machine.expiresAt);
    const limits = await readRunnerLimitsInTransaction(tx, userId, machine.id);
    if (!limits || limits.generation !== machine.connectionGeneration) throw unavailable();
    const cap = Math.floor(
      Math.min(limits.operatingLimits.matchMicros, limits.hardLimits.matchMicros) / 2,
    );
    if (cap < 100) throw new ORPCError("BAD_REQUEST");
    config.rules.costBudgetMicros = Math.min(config.rules.costBudgetMicros, cap);
    archive = createMatch(config, "local");
    const configDigest = runnerConfigDigest(config);
    const ownerCount = await tx.chessMatch.count({
      where: { ownerId: userId, source: "runner", runnerState: { in: activeStates } },
    });
    const machineCount = await tx.chessMatch.count({
      where: {
        ownerId: userId,
        source: "runner",
        runnerMachineId: machine.id,
        runnerState: { in: activeStates },
      },
    });
    if (ownerCount >= MAX_OWNER_MATCHES || machineCount >= MAX_MACHINE_MATCHES)
      throw new ORPCError("TOO_MANY_REQUESTS");
    const commandId = randomUUID();
    const row = await tx.chessMatch.create({
      data: {
        slug: `${slugify(archive.config.title).slice(0, 140) || "runner-match"}-${randomUUID().slice(0, 8)}`,
        ownerId: userId,
        title: archive.config.title,
        whiteName: archive.config.white.name,
        blackName: archive.config.black.name,
        source: "runner",
        credentialSource: "runner-local",
        status: "queued",
        published: false,
        rulesKey: digest(archive.config.rules).slice(0, 16),
        rulesVersion: archive.config.rules.version,
        promptVersion: archive.config.prompt.version,
        promptHash: archive.config.prompt.hash,
        contextMode: archive.config.rules.context,
        identityMode: archive.config.rules.opponentIdentity,
        archive,
        ...chessTurnData(archive.turn),
        runnerMachineId: machine.id,
        runnerState: "offered",
        runnerRevision: 1,
        runnerAcceptedSeq: 0,
        RunnerCommands: {
          create: {
            id: commandId,
            kind: "offer",
            revision: 1,
            payload: { commandId, configDigest, config },
            expiresAt: new Date(Date.now() + RUNNER_COMMAND_TTL_MS),
          },
        },
        Creation: { create: { id: receiptId, configDigest: requestDigest } },
      },
      select: controlSelect,
    });
    return snapshot(row);
  });
  await wake(input.machineId);
  return result;
}

export async function runnerMatchStatus(
  context: BrowserContext,
  input: z.input<typeof runnerSlugInput>,
) {
  return browserTransaction(context, async (tx, userId) => {
    const row = await tx.chessMatch.findFirst({
      where: { slug: runnerSlugInput.parse(input).slug, ownerId: userId, source: "runner" },
      select: controlSelect,
    });
    if (!row) throw notFound();
    return snapshot(row);
  });
}

export async function stopRunnerMatch(
  context: BrowserContext,
  raw: z.input<typeof runnerCommandInput>,
) {
  const input = runnerCommandInput.parse(raw);
  const result = await browserTransaction(context, async (tx, userId) => {
    const found = await tx.chessMatch.findFirst({
      where: { slug: input.slug, ownerId: userId, source: "runner" },
      select: controlSelect,
    });
    if (!found) throw notFound();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chess-runner:${found.id}`}))`;
    const row = await tx.chessMatch.findFirst({
      where: { id: found.id, ownerId: userId, source: "runner" },
      select: controlSelect,
    });
    if (!row) throw notFound();
    const prior = await tx.runnerCommand.findUnique({
      where: { id: input.commandId },
      select: { matchId: true, kind: true, payload: true },
    });
    if (prior) {
      if (
        prior.matchId !== row.id ||
        prior.kind !== "stop" ||
        digest(prior.payload) !==
          digest({ commandId: input.commandId, expectedRevision: input.expectedRevision })
      )
        throw stale();
      return { value: snapshot(row), machineId: row.runnerMachineId };
    }
    if (row.runnerRevision !== input.expectedRevision || !activeRunner(row)) throw stale();
    // Active controls retain at most4096 receipts. Reserve one additional
    // terminal stop receipt so reaching that cap can never block cancellation.
    if ((await tx.runnerCommand.count({ where: { matchId: row.id } })) > RUNNER_COMMAND_LIMIT)
      throw new ORPCError("TOO_MANY_REQUESTS");
    const archive = parseArchive(row.archive);
    finishMatch(archive, "*", "cancelled", "stopped");
    await tx.runnerCommand.updateMany({
      where: { matchId: row.id, ackedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });
    const written = await tx.chessMatch.updateMany({
      where: {
        id: row.id,
        ownerId: userId,
        source: "runner",
        runnerRevision: input.expectedRevision,
      },
      data: {
        status: "stopped",
        terminalCause: "owner-stop",
        runnerState: "stopped",
        runnerGeneration: null,
        runnerRevision: { increment: 1 },
        runnerResumeDeadline: null,
        runToken: null,
        heartbeatAt: null,
        archive,
        ...chessTurnData({ type: "idle" }),
      },
    });
    if (written.count !== 1) throw stale();
    await tx.runnerCommand.create({
      data: {
        id: input.commandId,
        matchId: row.id,
        kind: "stop",
        revision: row.runnerRevision + 1,
        payload: { commandId: input.commandId, expectedRevision: input.expectedRevision },
        expiresAt: new Date(Date.now() + RUNNER_COMMAND_TTL_MS),
      },
    });
    return {
      value: snapshot({
        ...row,
        archive,
        status: "stopped",
        runnerState: "stopped",
        runnerGeneration: null,
        runnerRevision: row.runnerRevision + 1,
        runnerResumeDeadline: null,
      }),
      machineId: row.runnerMachineId,
    };
  });
  if (result.machineId) await wake(result.machineId);
  return result.value;
}

/** Commands and their state transition are one transaction; publication is only a hint. */
async function appendCommand(
  tx: Prisma.TransactionClient,
  row: ControlRow,
  type: "start" | "resume" | "human-move" | "stop",
  payload: Record<string, string | number>,
  commandId: string = randomUUID(),
) {
  if ((await tx.runnerCommand.count({ where: { matchId: row.id } })) >= RUNNER_COMMAND_LIMIT)
    throw new ORPCError("TOO_MANY_REQUESTS");
  if (
    (await tx.runnerCommand.count({
      where: { matchId: row.id, ackedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } },
    })) >= RUNNER_OUTBOX_LIMIT
  )
    throw new ORPCError("TOO_MANY_REQUESTS");
  ++row.runnerRevision;
  const value = { commandId, ...payload };
  await tx.runnerCommand.create({
    data: {
      id: commandId,
      matchId: row.id,
      kind: type,
      revision: row.runnerRevision,
      payload: value,
      expiresAt: new Date(Date.now() + RUNNER_COMMAND_TTL_MS),
    },
  });
  return delivery(type, row.id, value);
}

async function persistGame(
  tx: Prisma.TransactionClient,
  row: ControlRow,
  archive: MatchArchive,
  revision: number,
  terminalCause?: string,
) {
  if (archiveByteLength(archive) > MAX_ARCHIVE_BYTES - 4096)
    finishMatch(archive, "*", "event-limit", "error");
  const terminal = archive.status !== "running";
  if (terminal && activeRunner(row)) {
    await tx.runnerCommand.updateMany({
      where: { matchId: row.id, ackedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });
    row.runnerGeneration = null;
    row.runnerResumeDeadline = null;
    row.runnerState =
      archive.status === "completed"
        ? "completed"
        : archive.status === "stopped"
          ? "stopped"
          : "error";
    row.status = archive.status;
    // A bounded terminal reserve aborts local work even after ordinary credit is exhausted.
    const commandId = digest(["runner-terminal", row.id, row.runnerRevision]);
    ++row.runnerRevision;
    await tx.runnerCommand.create({
      data: {
        id: commandId,
        matchId: row.id,
        kind: "stop",
        revision: row.runnerRevision,
        payload: { commandId },
        expiresAt: new Date(Date.now() + RUNNER_COMMAND_TTL_MS),
      },
    });
  }
  row.runnerLastContactAt = new Date();
  const changed = await tx.chessMatch.updateMany({
    where: { id: row.id, ownerId: row.ownerId, source: "runner", runnerRevision: revision },
    data: {
      archive,
      status: row.status,
      runnerState: row.runnerState,
      runnerRevision: row.runnerRevision,
      runnerAcceptedSeq: row.runnerAcceptedSeq,
      runnerGeneration: row.runnerGeneration,
      runnerResumeDeadline: row.runnerResumeDeadline,
      runnerLastContactAt: row.runnerLastContactAt,
      runToken: null,
      heartbeatAt: null,
      // Model turn columns denote a hosted worker claim and require runToken.
      // Runner model timing lives in its durable archive; execution is fenced by
      // machine/generation/outbox, never by a hosted claim.
      ...chessTurnData(archive.turn.type === "model" ? { type: "idle" } : archive.turn),
      ...chessStatsColumns(archive),
      ...(terminalCause ? { terminalCause } : {}),
      // Usage is absent from this protocol: absence must never advertise zero cost.
      whiteCostMicros: null,
      blackCostMicros: null,
    },
  });
  if (changed.count !== 1) throw stale();
  row.archive = archive;
}

/** Server elapsed time includes disconnects; local timing never settles a clock. */
function expireTurn(archive: MatchArchive, now = new Date()) {
  const turn = archive.turn;
  if (archive.status !== "running" || turn.type === "idle" || now < new Date(turn.deadline))
    return false;
  const expiredAt = new Date(turn.deadline);
  if (turn.type === "human") playHostedHumanTurn(archive, expiredAt);
  else {
    archive.turn = { type: "idle" };
    const elapsed = expiredAt.getTime() - Date.parse(turn.startedAt);
    // The same human primitive charges wall time and settles whole-game clocks.
    // Per-turn safety expiry is distinct when no side clock expired.
    const side = boardAt(archive).turn();
    archive.events.push({
      type: "timing",
      seq: archive.events.length,
      at: expiredAt.toISOString(),
      side,
      ply: archive.events.filter((e) => e.type === "attempt" && e.accepted).length,
      elapsedMs: elapsed,
    });
    const total = archive.events
      .filter((e) => e.type === "timing" && e.side === side)
      .reduce((sum, e) => sum + (e.type === "timing" ? e.elapsedMs : 0), 0);
    const clock = archive.config.rules.clock?.[side];
    finishMatch(
      archive,
      side === "w" ? "0-1" : "1-0",
      clock !== undefined && clock !== null && total >= clock ? "timeout" : "move-timeout",
    );
  }
  return true;
}

async function nextCommands(tx: Prisma.TransactionClient, row: ControlRow, archive: MatchArchive) {
  if (archive.status !== "running") return [];
  // Leave room for the remaining replies and terminal stop/ACK. Exhausting the
  // control journal is infrastructure interruption, never a fabricated clock loss.
  if (
    (await tx.runnerCommand.count({ where: { matchId: row.id } })) >= RUNNER_COMMAND_LIMIT - 4 ||
    (await tx.runnerEvent.count({ where: { matchId: row.id } })) >= RUNNER_EVENT_LIMIT - 16
  ) {
    finishMatch(archive, "*", "event-limit", "error");
    return [];
  }
  await tx.runnerCommand.updateMany({
    where: { matchId: row.id, kind: "resume", ackedAt: null, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });
  const messages: RunnerDelivery[] = [];
  messages.push(
    await appendCommand(tx, row, "resume", {
      acceptedSeq: row.runnerAcceptedSeq,
      ply: row.runnerAcceptedSeq,
      fen: boardAt(archive).fen(),
    }),
  );
  messages.push(await appendCommand(tx, row, "start", { expectedSeq: row.runnerAcceptedSeq }));
  return messages;
}

type GameplayMessage = Extract<RunnerClientMessage, { type: "move" | "evaluation" | "event" }>;
async function gameplay(
  tx: Prisma.TransactionClient,
  row: ControlRow,
  identity: RunnerControlIdentity,
  message: GameplayMessage,
): Promise<RunnerDelivery[]> {
  const archive = parseArchive(row.archive);
  if (row.source !== "runner" || archive.source !== "local") throw stale();
  if (
    activeRunner(row) &&
    (row.runnerGeneration !== identity.connectionGeneration ||
      !row.runnerResumeDeadline ||
      row.runnerResumeDeadline <= new Date())
  )
    throw stale();
  if (await settleDue(tx, row, archive)) return [];
  const revision = row.runnerRevision;
  const positions = gamePositions(archive);
  const fen = positions.at(-1);
  // A semantic move retry is valid after a lost ACK, including after terminal settlement.
  if (message.type === "move" && message.payload.ply <= row.runnerAcceptedSeq) {
    const attempt = archive.events.filter((e) => e.type === "attempt" && e.accepted)[
      message.payload.ply - 1
    ];
    if (
      attempt?.type !== "attempt" ||
      attempt.move !== message.payload.uci ||
      attempt.fen !== message.payload.fen
    )
      throw stale();
    const human = await tx.runnerCommand.findFirst({
      where: {
        matchId: row.id,
        kind: "human-move",
        ackedAt: null,
        cancelledAt: null,
      },
      select: { id: true, payload: true },
    });
    if (human) {
      const forwarded = delivery("human-move", row.id, human.payload);
      if (
        forwarded.type !== "human-move" ||
        forwarded.payload.expectedSeq + 1 !== message.payload.ply ||
        forwarded.payload.uci !== message.payload.uci
      )
        throw stale();
      await tx.runnerCommand.updateMany({
        where: { id: human.id, ackedAt: null },
        data: { ackedAt: new Date() },
      });
      const replies = await nextCommands(tx, row, archive);
      await persistGame(tx, row, archive, revision);
      return archive.status === "running" ? replies : [];
    }
    return [];
  }
  if (message.type === "evaluation") {
    const input = message.payload;
    if (
      input.ply > row.runnerAcceptedSeq ||
      positions[input.ply] !== input.fen ||
      input.nodes !== archive.config.rules.engineNodes
    )
      throw stale();
    if (
      input.purpose === "player" &&
      !["after-move", "both"].includes(archive.config.rules.engineEvaluation)
    )
      throw stale();
    const evaluation = {
      engine: "stockfish-19-lite-single" as const,
      fen: input.fen,
      depth: 0,
      nodes: input.nodes,
      cp: "cp" in input.score ? input.score.cp : null,
      mate: "mate" in input.score ? input.score.mate : null,
      bestMove: null,
    };
    if (input.purpose === "spectator") {
      const values = storedSpectatorEvaluations.parse(row.spectatorEvaluations) ?? {};
      // First accepted score for a position wins; arbitrary repeat submissions cannot rewrite it.
      if (values[String(input.ply)]) return [];
      values[String(input.ply)] = evaluation;
      const changed = await tx.chessMatch.updateMany({
        where: { id: row.id, source: "runner", runnerRevision: revision },
        data: { spectatorEvaluations: values },
      });
      if (changed.count !== 1) throw stale();
    } else {
      if (archive.events.some((e) => e.type === "evaluation" && e.ply === input.ply)) return [];
      // Delayed player scores cannot be appended to an unrelated later event tail.
      if (input.ply !== row.runnerAcceptedSeq || archive.events.at(-1)?.type !== "attempt")
        return [];
      const board = boardAt(archive);
      archive.events.push({
        type: "evaluation",
        purpose: "after-move",
        evaluation,
        seq: archive.events.length,
        at: new Date().toISOString(),
        side: board.turn(),
        ply: input.ply,
      });
      // Evaluation is asynchronous; preserve the currently active expected event tail.
      if (archive.turn.type !== "idle") archive.turn.expectedSeq = archive.events.length;
      await persistGame(tx, row, archive, revision);
    }
    return [];
  }
  if (
    message.type === "event" &&
    message.payload.kind !== "started" &&
    archive.status !== "running"
  ) {
    if (
      message.payload.ply !== row.runnerAcceptedSeq ||
      message.payload.fen !== fen ||
      message.payload.result !== archive.result ||
      message.payload.termination !== archive.termination
    )
      throw stale();
    return [];
  }
  if (
    row.runnerGeneration !== identity.connectionGeneration ||
    row.runnerState !== "running" ||
    row.status !== "running"
  )
    throw stale();
  if (!row.runnerResumeDeadline || row.runnerResumeDeadline <= new Date()) throw stale();
  const acceptedAt = new Date();
  if (expireTurn(archive, acceptedAt)) {
    await persistGame(tx, row, archive, revision);
    return [];
  }
  if (message.type === "event" && message.payload.kind === "started") {
    if (archive.turn.type !== "model") throw stale();
    return [];
  }
  if (message.type === "move") {
    if (message.payload.ply !== row.runnerAcceptedSeq + 1 || archive.turn.type !== "model")
      throw stale();
    const board = boardAt(archive);
    try {
      applyUci(board, message.payload.uci);
    } catch {
      throw new ORPCError("BAD_REQUEST");
    }
    if (board.fen() !== message.payload.fen) throw stale();
    const turn = archive.turn;
    archive.turn = { type: "idle" };
    const attempt = playHumanTurn(
      archive,
      boardAt(archive),
      Math.max(0, acceptedAt.getTime() - Date.parse(turn.startedAt)),
      message.payload.uci,
    );
    if (attempt?.accepted) ++row.runnerAcceptedSeq;
    if (archive.status === "running") beginHostedTurn(archive);
    // The command for this ply cannot be delivered again after accepting its result.
    await tx.runnerCommand.updateMany({
      where: { matchId: row.id, kind: "start", ackedAt: null, cancelledAt: null },
      data: { ackedAt: new Date() },
    });
    const replies = await nextCommands(tx, row, archive);
    await persistGame(tx, row, archive, revision);
    return archive.status === "running" ? replies : [];
  }
  const claim = message.payload;
  if (claim.kind === "started") throw stale();
  if (claim.ply !== row.runnerAcceptedSeq || claim.fen !== fen) throw stale();
  const side = boardAt(archive).turn();
  if (claim.termination === "illegal-forfeit") {
    if (claim.kind !== "completed" || archive.turn.type !== "model") throw stale();
    archive.turn = { type: "idle" };
    if (!claim.rejectedAttempts.length) throw stale();
    for (const attemptEvidence of claim.rejectedAttempts) {
      if (archive.status !== "running") throw stale();
      const attempt = submitMove(
        archive,
        boardAt(archive),
        attemptEvidence.move,
        "",
        undefined,
        attemptEvidence.stopReason
          ? { text: "", stopReason: attemptEvidence.stopReason }
          : undefined,
      );
      if (attempt.accepted) throw stale();
    }
    if (archive.termination !== "illegal-forfeit" || archive.result !== claim.result) throw stale();
  } else if (claim.termination === "resignation") {
    if (claim.kind !== "completed" || archive.turn.type !== "model") throw stale();
    if (claim.rejectedAttempts.length || claim.result !== (side === "w" ? "0-1" : "1-0"))
      throw stale();
    finishMatch(archive, claim.result, "resignation");
  } else if (
    claim.kind === "interrupted" ||
    [
      "token-budget",
      "cost-budget",
      "provider-error",
      "engine-error",
      "event-limit",
      "account-limit",
      "credential-revoked",
    ].includes(claim.termination)
  ) {
    finishMatch(archive, "*", "interrupted", "error");
  } else if (
    claim.kind === "stopped" &&
    claim.result === "*" &&
    claim.termination === "cancelled"
  ) {
    finishMatch(archive, "*", "cancelled", "stopped");
  } else throw stale();
  await persistGame(tx, row, archive, revision);
  return [];
}

async function browserMatch(tx: Prisma.TransactionClient, userId: string, slug: string) {
  const found = await tx.chessMatch.findFirst({
    where: { slug, ownerId: userId, source: "runner" },
    select: controlSelect,
  });
  if (!found?.runnerMachineId) throw notFound();
  return lockedMatch(tx, found.id, {
    userId,
    machineId: found.runnerMachineId,
    connectionGeneration: found.runnerGeneration ?? 0,
  });
}

async function browserReceipt(
  tx: Prisma.TransactionClient,
  row: ControlRow,
  kind: string,
  input: { commandId: string },
) {
  const id = digest(["runner-browser", input.commandId]);
  const payloadDigest = digest({ kind, input });
  const prior = await tx.runnerEvent.findUnique({
    where: { id },
    select: { matchId: true, payloadDigest: true },
  });
  if (prior && (prior.matchId !== row.id || prior.payloadDigest !== payloadDigest)) throw stale();
  return {
    prior: !!prior,
    save: async () => {
      if ((await tx.runnerEvent.count({ where: { matchId: row.id } })) >= RUNNER_EVENT_LIMIT)
        throw new ORPCError("TOO_MANY_REQUESTS");
      await tx.runnerEvent.create({ data: { id, matchId: row.id, payloadDigest } });
    },
  };
}

/** Browser acceptance never allocates a hosted worker or server provider credential. */
export async function startRunnerMatch(
  context: BrowserContext,
  raw: z.input<typeof runnerCommandInput>,
) {
  const input = runnerCommandInput.parse(raw);
  let bound: RunnerControlIdentity | undefined;
  let grace: number | undefined;
  const result = await browserTransaction(
    context,
    async (tx, userId, retain) => {
      const row = await browserMatch(tx, userId, input.slug);
      const receipt = await browserReceipt(tx, row, "start", input);
      if (receipt.prior) {
        return { value: snapshot(row), machineId: row.runnerMachineId };
      }
      if (
        await tx.runnerCommand.findUnique({ where: { id: input.commandId }, select: { id: true } })
      )
        throw stale();
      if (
        row.runnerState !== "accepted" ||
        row.runnerRevision !== input.expectedRevision ||
        row.runnerGeneration === null ||
        !row.runnerResumeDeadline ||
        row.runnerResumeDeadline <= new Date()
      )
        throw stale();
      bound = {
        userId,
        machineId: row.runnerMachineId ?? "",
        connectionGeneration: row.runnerGeneration,
      };
      grace = row.runnerResumeDeadline.getTime();
      await liveMachine(tx, bound, retain);
      const archive = parseArchive(row.archive);
      beginHostedTurn(archive);
      row.status = "running";
      row.runnerState = "running";
      await tx.runnerCommand.updateMany({
        where: { matchId: row.id, kind: "resume", ackedAt: null, cancelledAt: null },
        data: { cancelledAt: new Date() },
      });
      await appendCommand(tx, row, "resume", {
        acceptedSeq: row.runnerAcceptedSeq,
        ply: row.runnerAcceptedSeq,
        fen: boardAt(archive).fen(),
      });
      await appendCommand(
        tx,
        row,
        "start",
        { expectedSeq: row.runnerAcceptedSeq },
        input.commandId,
      );
      await persistGame(tx, row, archive, input.expectedRevision);
      if (!row.runnerResumeDeadline || row.runnerResumeDeadline <= new Date()) throw stale();
      await receipt.save();
      return { value: snapshot(row), machineId: row.runnerMachineId };
    },
    () => {
      if (grace !== undefined && grace <= Date.now()) throw stale();
    },
    async (tx, retain) => {
      if (bound) await liveMachine(tx, bound, retain);
    },
  );
  if (result.machineId) await wake(result.machineId);
  return result.value;
}

/** A human action is authorized and applied before the untrusted local echo. */
export async function moveRunnerMatch(
  context: BrowserContext,
  raw: z.input<typeof runnerMoveInput>,
) {
  const input = runnerMoveInput.parse(raw);
  let originalDeadline: number | undefined;
  let originalGrace: number | undefined;
  let bound: RunnerControlIdentity | undefined;
  const result = await browserTransaction(
    context,
    async (tx, userId, retain) => {
      const row = await browserMatch(tx, userId, input.slug);
      const revision = row.runnerRevision;
      const receipt = await browserReceipt(tx, row, "human-move", input);
      if (receipt.prior) {
        return { value: snapshot(row), machineId: row.runnerMachineId };
      }
      if (
        await tx.runnerCommand.findUnique({ where: { id: input.commandId }, select: { id: true } })
      )
        throw stale();
      if (
        row.status !== "running" ||
        row.runnerState !== "running" ||
        revision !== input.expectedRevision ||
        row.runnerAcceptedSeq !== input.expectedSeq
      )
        throw stale();
      const archive = parseArchive(row.archive);
      if (archive.turn.type !== "human" || boardAt(archive).fen() !== input.fen) throw stale();
      if (row.runnerGeneration === null || !row.runnerMachineId) throw stale();
      await liveMachine(
        tx,
        {
          userId,
          machineId: row.runnerMachineId,
          connectionGeneration: row.runnerGeneration,
        },
        retain,
      );
      const acceptedAt = new Date();
      if (await settleDue(tx, row, archive, acceptedAt)) {
        await receipt.save();
        return { value: snapshot(row), machineId: row.runnerMachineId };
      }
      originalGrace = row.runnerResumeDeadline?.getTime();
      if (originalGrace === undefined) throw stale();
      bound = {
        userId,
        machineId: row.runnerMachineId,
        connectionGeneration: row.runnerGeneration,
      };
      originalDeadline = Date.parse(archive.turn.deadline);
      if (input.move !== "resign") {
        try {
          applyUci(boardAt(archive), input.move);
        } catch {
          throw new ORPCError("BAD_REQUEST");
        }
      }
      const attempt = playHostedHumanTurn(archive, acceptedAt, input.move);
      if (attempt?.accepted) ++row.runnerAcceptedSeq;
      if (archive.status === "running") beginHostedTurn(archive);
      await appendCommand(
        tx,
        row,
        "human-move",
        { uci: input.move, expectedSeq: input.expectedSeq },
        input.commandId,
      );
      await persistGame(tx, row, archive, revision);
      await receipt.save();
      return { value: snapshot(row), machineId: row.runnerMachineId };
    },
    () => {
      if (originalDeadline !== undefined && originalDeadline <= Date.now()) throw stale();
      if (originalGrace !== undefined && originalGrace <= Date.now()) throw stale();
    },
    async (tx, retain) => {
      if (bound) await liveMachine(tx, bound, retain);
    },
  );
  if (result.machineId) await wake(result.machineId);
  return result.value;
}

/** Parse stored JSON at the disclosure boundary before emitting any command. */
function delivery(type: string, matchId: string, payload: Prisma.JsonValue): RunnerDelivery {
  const {
    version: _version,
    generation: _generation,
    id: _id,
    seq: _seq,
    ack: _ack,
    ...message
  } = runnerServerMessageSchema.parse({
    version: 1,
    generation: 0,
    id: "stored-command",
    seq: 1,
    ack: 0,
    type,
    matchId,
    payload,
  });
  return message;
}

async function expireMatch(
  tx: Prisma.TransactionClient,
  row: ControlRow,
  cause: "runner-abandoned" | "runner-offer-expired",
) {
  const archive = parseArchive(row.archive);
  finishMatch(archive, "*", "cancelled", "stopped");
  const changed = await tx.chessMatch.updateMany({
    where: { id: row.id, source: "runner", runnerRevision: row.runnerRevision },
    data: {
      ...chessStatsColumns(archive),
      whiteCostMicros: null,
      blackCostMicros: null,
      status: "stopped",
      terminalCause: cause,
      runnerState: cause === "runner-abandoned" ? "abandoned" : "rejected",
      runnerGeneration: null,
      runnerRevision: { increment: 1 },
      runnerResumeDeadline: null,
      archive,
      ...chessTurnData({ type: "idle" }),
    },
  });
  if (changed.count !== 1) throw stale();
  row.status = "stopped";
  row.runnerState = cause === "runner-abandoned" ? "abandoned" : "rejected";
  row.runnerGeneration = null;
  row.runnerResumeDeadline = null;
  ++row.runnerRevision;
  row.archive = archive;
  await tx.runnerCommand.updateMany({
    where: { matchId: row.id, ackedAt: null, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });
}

/** The earliest authority/clock cutoff wins, independent of which path observes it. */
async function settleDue(
  tx: Prisma.TransactionClient,
  row: ControlRow,
  archive: MatchArchive,
  now = new Date(),
) {
  if (!activeRunner(row)) return false;
  const grace = row.runnerResumeDeadline?.getTime() ?? Infinity;
  const clock = archive.turn.type === "idle" ? Infinity : Date.parse(archive.turn.deadline);
  if (clock <= grace && expireTurn(archive, now)) {
    await persistGame(tx, row, archive, row.runnerRevision);
    return true;
  }
  if (grace <= now.getTime()) {
    await expireMatch(tx, row, "runner-abandoned");
    return true;
  }
  return false;
}

/** Bounded recovery polling replaces lost Redis delivery, using current machine generation only. */
export async function runnerOutbox(
  identity: RunnerControlIdentity,
  outstandingIds: readonly string[] = [],
): Promise<RunnerDelivery[]> {
  const outstanding = z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    )
    .max(RUNNER_COMMAND_WINDOW)
    .parse(outstandingIds);
  return machineTransaction(identity, async (tx, grants) => {
    const contact = new Date();
    // Authenticated, lease-validated polling continues even with no matches.
    // Coalesce writes while preserving current-generation presence for admission.
    await tx.runnerMachine.updateMany({
      where: {
        id: identity.machineId,
        userId: identity.userId,
        connectionGeneration: identity.connectionGeneration,
        revokedAt: null,
        expiresAt: { gt: contact },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(contact.getTime() - 15_000) } }],
      },
      data: { lastSeenAt: contact },
    });
    const active = await tx.chessMatch.findMany({
      where: {
        ownerId: identity.userId,
        source: "runner",
        runnerMachineId: identity.machineId,
        runnerState: { in: activeStates },
      },
      orderBy: { id: "asc" },
      take: MAX_MACHINE_MATCHES,
      select: controlSelect,
    });
    const boundRows: ControlRow[] = [];
    for (const match of active) {
      const row = await lockedMatch(tx, match.id, identity);
      const now = new Date();
      if (!activeRunner(row)) continue;
      const archive = parseArchive(row.archive);
      if (await settleDue(tx, row, archive, now)) continue;
      if (row.runnerState === "offered") {
        const offer = await tx.runnerCommand.findFirst({
          where: { matchId: row.id, kind: "offer" },
          select: { expiresAt: true },
        });
        if (!offer || offer.expiresAt <= now) {
          await expireMatch(tx, row, "runner-offer-expired");
          continue;
        }
        grants.retain(offer.expiresAt);
      }
      grants.retain(row.runnerResumeDeadline);
      if (row.runnerGeneration !== null && row.runnerGeneration > identity.connectionGeneration)
        throw stale();
      const replaced = row.runnerGeneration !== identity.connectionGeneration;
      let revision = row.runnerRevision;
      if (replaced && row.runnerState !== "offered") {
        if ((await tx.runnerCommand.count({ where: { matchId: row.id } })) >= RUNNER_COMMAND_LIMIT)
          throw new ORPCError("TOO_MANY_REQUESTS");
        const original = await tx.runnerCommand.findFirst({
          where: { matchId: row.id, kind: "offer" },
          orderBy: { revision: "asc" },
          select: { payload: true },
        });
        if (!original) throw stale();
        const offer = delivery("offer", row.id, original.payload);
        if (
          offer.type !== "offer" ||
          offer.payload.configDigest !== runnerConfigDigest(offer.payload.config)
        )
          throw stale();
        // The CLI restores its journal and binds the new socket only while
        // processing an offer. A resume must follow its fresh acceptance.
        await tx.runnerCommand.updateMany({
          where: {
            matchId: row.id,
            kind: { in: ["offer", "resume"] },
            ackedAt: null,
            cancelledAt: null,
          },
          data: { cancelledAt: now },
        });
        if (
          (await tx.runnerCommand.count({
            where: { matchId: row.id, ackedAt: null, cancelledAt: null, expiresAt: { gt: now } },
          })) >= RUNNER_OUTBOX_LIMIT
        )
          throw new ORPCError("TOO_MANY_REQUESTS");
        const commandId = digest(["runner-reoffer", row.id, identity.connectionGeneration]);
        ++revision;
        await tx.runnerCommand.create({
          data: {
            id: commandId,
            matchId: row.id,
            kind: "offer",
            revision,
            payload: { ...offer.payload, commandId },
            expiresAt: new Date(now.getTime() + RUNNER_COMMAND_TTL_MS),
          },
        });
      }
      const bound = await tx.chessMatch.updateMany({
        where: {
          id: row.id,
          source: "runner",
          runnerMachineId: identity.machineId,
          runnerRevision: row.runnerRevision,
          runnerGeneration: row.runnerGeneration,
        },
        data: {
          runnerGeneration: identity.connectionGeneration,
          runnerRevision: revision,
          runnerLastContactAt: now,
          runnerResumeDeadline: new Date(now.getTime() + RUNNER_RESUME_GRACE_MS),
        },
      });
      if (bound.count !== 1) throw stale();
      row.runnerGeneration = identity.connectionGeneration;
      row.runnerRevision = revision;
      row.runnerLastContactAt = now;
      row.runnerResumeDeadline = new Date(now.getTime() + RUNNER_RESUME_GRACE_MS);
      boundRows.push(row);
    }
    const pending = {
      ackedAt: null,
      cancelledAt: null,
      expiresAt: { gt: new Date() },
      Match: { source: "runner", ownerId: identity.userId, runnerMachineId: identity.machineId },
    } satisfies Prisma.RunnerCommandWhereInput;
    type Candidate = { id: string; expiresAt: Date; value: RunnerDelivery };
    const frontiers: Candidate[] = [];
    // Each match contributes at most one deliverable command. Select dependencies
    // BEFORE the machine-wide page limit, so blocked older work cannot hide offers.
    for (const row of boundRows) {
      const commands = await tx.runnerCommand.findMany({
        where: { ...pending, matchId: row.id },
        orderBy: { revision: "desc" },
        take: RUNNER_OUTBOX_LIMIT,
        select: { id: true, kind: true, payload: true, expiresAt: true, revision: true },
      });
      const add = (command: (typeof commands)[number]) =>
        frontiers.push({
          id: command.id,
          expiresAt: command.expiresAt,
          value: delivery(command.kind, row.id, command.payload),
        });
      const offer = commands.find((command) => command.kind === "offer");
      if (offer) {
        add(offer);
        continue;
      }
      const human = commands.find((command) => command.kind === "human-move");
      if (human) {
        add(human);
        continue;
      }
      const resume = await tx.runnerCommand.findFirst({
        where: { matchId: row.id, kind: "resume", cancelledAt: null },
        orderBy: { revision: "desc" },
        select: { id: true, revision: true, payload: true, ackedAt: true, expiresAt: true },
      });
      if (!resume) continue;
      const state = delivery("resume", row.id, resume.payload);
      if (state.type !== "resume") throw stale();
      const latestOffer = await tx.runnerCommand.findFirst({
        where: { matchId: row.id, kind: "offer" },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      if (!latestOffer || resume.revision <= latestOffer.revision) continue;
      if (!resume.ackedAt) {
        if (resume.expiresAt > new Date())
          frontiers.push({ id: resume.id, expiresAt: resume.expiresAt, value: state });
        continue;
      }
      if (
        row.runnerState !== "running" ||
        state.payload.acceptedSeq !== row.runnerAcceptedSeq ||
        state.payload.ply !== row.runnerAcceptedSeq ||
        state.payload.fen !== snapshot(row).fen
      )
        continue;
      for (const command of commands) {
        if (command.kind !== "start") continue;
        const start = delivery("start", row.id, command.payload);
        if (start.type === "start" && start.payload.expectedSeq === row.runnerAcceptedSeq) {
          const turn = parseArchive(row.archive).turn;
          if (turn.type !== "idle") grants.retain(new Date(turn.deadline));
          add(command);
          break;
        }
      }
    }
    const terminal = {
      ...pending,
      kind: "stop",
      Match: { ...pending.Match, status: { notIn: ["queued", "running"] }, runnerGeneration: null },
    } satisfies Prisma.RunnerCommandWhereInput;
    const select = {
      id: true,
      payload: true,
      expiresAt: true,
      matchId: true,
    } satisfies Prisma.RunnerCommandSelect;
    // A terminal receipt beyond the FIFO page must keep its outstanding credit.
    const retained = outstanding.length
      ? await tx.runnerCommand.findMany({
          where: { ...terminal, id: { in: outstanding } },
          take: RUNNER_COMMAND_WINDOW,
          select,
        })
      : [];
    const stops = await tx.runnerCommand.findMany({
      where: { ...terminal, ...(outstanding.length ? { id: { notIn: outstanding } } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: RUNNER_OUTBOX_LIMIT,
      select,
    });
    const candidates = [...retained, ...stops]
      .map((command) => ({
        id: command.id,
        expiresAt: command.expiresAt,
        value: delivery("stop", command.matchId, { commandId: command.id }),
      }))
      .concat(frontiers);
    candidates.sort(
      (left, right) =>
        Number(outstanding.includes(right.id)) - Number(outstanding.includes(left.id)),
    );
    const messages: RunnerDelivery[] = [];
    const chosen = new Set<string>();
    for (const candidate of candidates) {
      if (chosen.has(candidate.id)) continue;
      chosen.add(candidate.id);
      grants.retain(candidate.expiresAt);
      messages.push(candidate.value);
      if (messages.length === RUNNER_OUTBOX_LIMIT) break;
    }
    grants.check();
    return messages;
  });
}

/** Exact event IDs/digests survive reconnect and crash; no submitted board/outcome is trusted. */
export async function handleRunnerControl(
  identity: RunnerControlIdentity,
  raw: RunnerClientMessage,
): Promise<RunnerDelivery[]> {
  const parsed = runnerClientMessageSchema.safeParse(raw);
  if (!parsed.success) throw new ORPCError("BAD_REQUEST");
  const message = parsed.data;
  if (message.generation !== identity.connectionGeneration) throw new ORPCError("UNAUTHORIZED");
  if (
    !["accept", "reject", "ack", "snapshot", "move", "evaluation", "event"].includes(message.type)
  )
    throw new ORPCError("BAD_REQUEST");
  return machineTransaction(identity, async (tx, grants) => {
    let matchId: string;
    if (message.type === "ack") {
      const command = await tx.runnerCommand.findUnique({
        where: { id: message.payload.commandId },
        select: { matchId: true },
      });
      if (!command) throw notFound();
      matchId = command.matchId;
    } else if ("matchId" in message) matchId = message.matchId;
    else throw new ORPCError("BAD_REQUEST");
    const row = await lockedMatch(tx, matchId, identity);
    const ack: RunnerDelivery = { type: "ack", payload: { commandId: message.id } };
    const eventDigest = digest({ type: message.type, matchId, payload: message.payload });
    const prior = await tx.runnerEvent.findUnique({
      where: { id: message.id },
      select: { matchId: true, payloadDigest: true },
    });
    if (prior) {
      if (prior.matchId !== matchId || prior.payloadDigest !== eventDigest) throw stale();
      return [ack];
    }
    if (message.type === "move" || message.type === "evaluation" || message.type === "event") {
      if ((await tx.runnerEvent.count({ where: { matchId } })) >= RUNNER_EVENT_LIMIT)
        throw new ORPCError("TOO_MANY_REQUESTS");
      if (activeRunner(row) && row.runnerResumeDeadline && row.runnerResumeDeadline > new Date())
        grants.retain(row.runnerResumeDeadline);
      const turn = parseArchive(row.archive).turn;
      if (
        message.type !== "evaluation" &&
        turn.type !== "idle" &&
        Date.parse(turn.deadline) > Date.now()
      )
        grants.retain(new Date(turn.deadline));
      await gameplay(tx, row, identity, message);
      grants.check();
      await tx.runnerEvent.create({
        data: { id: message.id, matchId, payloadDigest: eventDigest },
      });
      return [ack];
    }
    if (activeStates.includes(row.runnerState ?? "") && !activeRunner(row)) throw stale();
    if (message.type === "ack" && !activeRunner(row)) {
      // A terminal stop must release credit even if ordinary receipts are full.
      // Reserve one first-ACK receipt to bind its wire ID; later semantic ACKs
      // use the command's durable ackedAt without appending more rows.
      const command = await tx.runnerCommand.findUnique({
        where: { id: message.payload.commandId },
        select: {
          id: true,
          matchId: true,
          kind: true,
          revision: true,
          expiresAt: true,
          cancelledAt: true,
          ackedAt: true,
        },
      });
      if (
        !command ||
        command.matchId !== matchId ||
        command.kind !== "stop" ||
        command.revision !== row.runnerRevision ||
        command.cancelledAt ||
        command.expiresAt.getTime() <= Date.now() ||
        row.runnerGeneration !== null
      )
        throw stale();
      grants.retain(command.expiresAt);
      grants.check();
      if (!command.ackedAt) {
        if ((await tx.runnerEvent.count({ where: { matchId } })) > RUNNER_EVENT_LIMIT)
          throw new ORPCError("TOO_MANY_REQUESTS");
        const changed = await tx.runnerCommand.updateMany({
          where: {
            id: command.id,
            matchId,
            kind: "stop",
            ackedAt: null,
            cancelledAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { ackedAt: new Date() },
        });
        if (changed.count !== 1) throw stale();
        grants.check();
        await tx.runnerEvent.create({
          data: { id: message.id, matchId, payloadDigest: eventDigest },
        });
      }
      grants.check();
      return [ack];
    }
    // A repeated delivery may receive a new wire ID after an ACK is lost. The
    // semantic receipt binds command ID and payload, independently of that ID.
    if (message.type === "accept" || message.type === "reject" || message.type === "ack") {
      const semantic = await tx.runnerEvent.findFirst({
        where: { matchId, payloadDigest: eventDigest },
        select: { id: true },
      });
      if (semantic) {
        if ((await tx.runnerEvent.count({ where: { matchId } })) >= RUNNER_EVENT_LIMIT)
          throw new ORPCError("TOO_MANY_REQUESTS");
        await tx.runnerEvent.create({
          data: { id: message.id, matchId, payloadDigest: eventDigest },
        });
        return [ack];
      }
    }
    if (row.runnerState !== "stopped" && row.runnerGeneration !== identity.connectionGeneration)
      throw stale();
    if (row.runnerResumeDeadline && row.runnerResumeDeadline <= new Date()) throw stale();
    grants.retain(row.runnerResumeDeadline);
    if ((await tx.runnerEvent.count({ where: { matchId } })) >= RUNNER_EVENT_LIMIT)
      throw new ORPCError("TOO_MANY_REQUESTS");

    if (message.type === "snapshot") {
      if (!activeRunner(row)) throw stale();
      const authoritative = snapshot(row);
      // Resume ACK and snapshot are separate CLI messages. A snapshot confirms
      // accepted state; creating another resume here would cause an endless loop.
      if (
        message.payload.acceptedSeq !== authoritative.acceptedSeq ||
        message.payload.fen !== authoritative.fen ||
        message.payload.ply !== authoritative.ply
      )
        throw stale();
      const changed = await tx.chessMatch.updateMany({
        where: {
          id: matchId,
          source: "runner",
          runnerMachineId: identity.machineId,
          runnerGeneration: identity.connectionGeneration,
          runnerRevision: row.runnerRevision,
        },
        data: { runnerLastContactAt: new Date() },
      });
      if (changed.count !== 1) throw stale();
    } else if (message.type === "accept" || message.type === "reject" || message.type === "ack") {
      const command = await tx.runnerCommand.findUnique({
        where: { id: message.payload.commandId },
        select: {
          id: true,
          matchId: true,
          kind: true,
          revision: true,
          expiresAt: true,
          cancelledAt: true,
          ackedAt: true,
        },
      });
      if (
        !command ||
        command.matchId !== matchId ||
        command.cancelledAt ||
        command.expiresAt.getTime() <= Date.now()
      )
        throw stale();
      grants.retain(command.expiresAt);
      if (message.type === "ack") {
        // Only semantic acceptance/board echo can release these dependencies.
        if (command.kind === "offer" || command.kind === "human-move") throw stale();
        await tx.runnerCommand.updateMany({
          where: { id: command.id, matchId, ackedAt: null },
          data: { ackedAt: new Date() },
        });
      } else {
        if (
          command.kind !== "offer" ||
          command.ackedAt ||
          command.revision !== row.runnerRevision ||
          !activeRunner(row)
        )
          throw stale();
        const rejected = message.type === "reject";
        if (
          !rejected &&
          (await tx.runnerCommand.count({ where: { matchId } })) >= RUNNER_COMMAND_LIMIT
        )
          throw new ORPCError("TOO_MANY_REQUESTS");
        const acked = await tx.runnerCommand.updateMany({
          where: { id: command.id, matchId, ackedAt: null, cancelledAt: null },
          data: { ackedAt: new Date() },
        });
        if (acked.count !== 1) throw stale();
        if (rejected) {
          await tx.runnerCommand.updateMany({
            where: { matchId, ackedAt: null, cancelledAt: null },
            data: { cancelledAt: new Date() },
          });
        } else if (
          (await tx.runnerCommand.count({
            where: { matchId, ackedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } },
          })) >= RUNNER_OUTBOX_LIMIT
        )
          throw new ORPCError("TOO_MANY_REQUESTS");
        const archive = parseArchive(row.archive);
        if (rejected) finishMatch(archive, "*", "cancelled", "stopped");
        const updated = await tx.chessMatch.updateMany({
          where: {
            id: matchId,
            source: "runner",
            runnerMachineId: identity.machineId,
            runnerGeneration: identity.connectionGeneration,
            runnerRevision: row.runnerRevision,
            runnerState: row.runnerState,
          },
          data: {
            runnerState: rejected
              ? "rejected"
              : row.runnerState === "offered"
                ? "accepted"
                : row.runnerState,
            runnerRevision: { increment: 1 },
            runnerLastContactAt: new Date(),
            ...(rejected
              ? {
                  status: "stopped",
                  runnerGeneration: null,
                  runnerResumeDeadline: null,
                  terminalCause: "runner-declined",
                  archive,
                  ...chessTurnData({ type: "idle" }),
                }
              : {}),
          },
        });
        if (updated.count !== 1) throw stale();
        if (!rejected) {
          const [pendingHuman] = await tx.runnerCommand.findMany({
            where: {
              matchId,
              kind: "human-move",
              ackedAt: null,
              cancelledAt: null,
              expiresAt: { gt: new Date() },
            },
            select: { payload: true },
            take: 1,
          });
          if (!pendingHuman) {
            const authoritative = snapshot(row);
            const commandId = digest(["runner-resume", matchId, command.id]);
            const payload = {
              commandId,
              acceptedSeq: authoritative.acceptedSeq,
              fen: authoritative.fen,
              ply: authoritative.ply,
            };
            await tx.runnerCommand.create({
              data: {
                id: commandId,
                matchId,
                kind: "resume",
                revision: row.runnerRevision + 1,
                payload,
                expiresAt: new Date(Date.now() + RUNNER_COMMAND_TTL_MS),
              },
            });
          }
        }
      }
    }
    grants.check();
    await tx.runnerEvent.create({ data: { id: message.id, matchId, payloadDigest: eventDigest } });
    grants.check();
    return [ack];
  });
}

let runnerReconcileCursor: string | undefined;
/** Bounded offline recovery; never creates a hosted job or invokes an engine. */
export async function reconcileRunnerMatches(signal?: AbortSignal) {
  const rows = await prisma.chessMatch.findMany({
    where: {
      source: "runner",
      status: { in: ["queued", "running"] },
      runnerState: { in: activeStates },
      ...(runnerReconcileCursor ? { id: { gt: runnerReconcileCursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: 50,
    select: { id: true, ownerId: true, runnerMachineId: true },
  });
  runnerReconcileCursor = rows.length === 50 ? rows.at(-1)?.id : undefined;
  let settled = 0;
  for (const item of rows) {
    if (signal?.aborted) break;
    if (!item.ownerId || !item.runnerMachineId) continue;
    try {
      settled += await runnerTransaction(
        item.ownerId,
        async () => {},
        async (tx) => {
          const row = await lockedMatch(tx, item.id, {
            userId: item.ownerId ?? "",
            machineId: item.runnerMachineId ?? "",
            connectionGeneration: 0,
          });
          if (!activeRunner(row)) return 0;
          const machine = await tx.runnerMachine.findFirst({
            where: {
              id: item.runnerMachineId ?? "",
              userId: item.ownerId ?? "",
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            select: {
              User: {
                select: {
                  emailVerified: true,
                  banned: true,
                  banExpires: true,
                  deletionRequestedAt: true,
                },
              },
            },
          });
          const archive = parseArchive(row.archive);
          const revision = row.runnerRevision;
          if (
            (row.Owner && isAccountDeletionPending(row.Owner)) ||
            (machine && isAccountDeletionPending(machine.User))
          ) {
            finishMatch(archive, "*", "cancelled", "stopped");
            await persistGame(tx, row, archive, revision, "owner-delete");
            return 1;
          }
          if (!machine?.User.emailVerified || isUserBanned(machine.User)) {
            finishMatch(archive, "*", "credential-revoked", "error");
            await persistGame(tx, row, archive, revision);
            return 1;
          }
          if (await settleDue(tx, row, archive)) return 1;
          if (row.runnerState === "offered") {
            const offer = await tx.runnerCommand.findFirst({
              where: { matchId: row.id, kind: "offer" },
              select: { expiresAt: true },
            });
            if (!offer || offer.expiresAt <= new Date()) {
              await expireMatch(tx, row, "runner-offer-expired");
              return 1;
            }
          }
          return 0;
        },
      );
    } catch {
      console.error("[chess-runner] Reconcile unavailable", { matchId: item.id });
    }
  }
  return { scanned: rows.length, settled };
}

/** Loss of this socket pauses local dispatch; a replacement cannot extend old authority. */
export async function disconnectRunnerMatches(identity: RunnerControlIdentity) {
  const disconnectedAt = Date.now();
  return machineTransaction(identity, async (tx) => {
    const now = new Date();
    return tx.chessMatch.updateMany({
      where: {
        source: "runner",
        ownerId: identity.userId,
        runnerMachineId: identity.machineId,
        runnerGeneration: identity.connectionGeneration,
        status: { in: ["queued", "running"] },
        runnerState: { in: activeStates },
        runnerResumeDeadline: { gt: now },
      },
      data: { runnerResumeDeadline: new Date(disconnectedAt + RUNNER_RESUME_GRACE_MS) },
    });
  });
}
