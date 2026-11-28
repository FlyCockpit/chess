import { randomUUID } from "node:crypto";
import { isAccountDeletionPending } from "@cockpit-chess/auth/account-state";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { LockSlotTimeoutError, withLockSlot } from "@cockpit-chess/auth/lock-slots";
import {
  RunnerMachineForbiddenError,
  RunnerMachineSessionRevokedError,
  requireRunnerMachineMintAuthority,
} from "@cockpit-chess/auth/runner-machine";
import {
  boardAt,
  createMatch,
  finishMatch,
  matchConfigSchema,
  parseArchive,
} from "@cockpit-chess/chess";
import {
  RUNNER_COMMAND_WINDOW,
  RUNNER_RESUME_GRACE_MS,
  type RunnerClientMessage,
  type RunnerDelivery,
  runnerConfigDigest,
  runnerMatchConfigSchema,
  runnerServerMessageSchema,
} from "@cockpit-chess/chess/runner-protocol";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { redisConnection } from "@cockpit-chess/queue";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "../context";
import { chessTurnData } from "./chess-human";
import { chessDigest as digest } from "./chess-official";
import { slugify } from "./slug";

export const RUNNER_COMMAND_CHANNEL = "chess_runner_command";
export const RUNNER_COMMAND_TTL_MS = 5 * 60_000;
export const RUNNER_OUTBOX_LIMIT = 32;
export const RUNNER_EVENT_LIMIT = 4096;
export const RUNNER_COMMAND_LIMIT = 4096;
const MAX_MACHINE_MATCHES = 16;
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
  status: true,
  runnerMachineId: true,
  runnerGeneration: true,
  runnerState: true,
  runnerRevision: true,
  runnerAcceptedSeq: true,
  runnerLastContactAt: true,
  runnerResumeDeadline: true,
  archive: true,
} satisfies Prisma.ChessMatchSelect;
type ControlRow = Prisma.ChessMatchGetPayload<{ select: typeof controlSelect }>;

function activeRunner(row: Pick<ControlRow, "status" | "runnerState">) {
  return ["queued", "running"].includes(row.status) && activeStates.includes(row.runnerState ?? "");
}

function snapshot(row: ControlRow) {
  const archive = parseArchive(row.archive);
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
  run: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
) {
  if (context.credential !== undefined) throw new ORPCError("UNAUTHORIZED");
  const userId = context.session.user.id;
  try {
    return await runnerTransaction(
      userId,
      (tx) =>
        requireRunnerMachineMintAuthority(tx, {
          userId,
          sessionId: context.session.session.id,
        }),
      (tx) => run(tx, userId),
    );
  } catch (error) {
    if (error instanceof RunnerMachineSessionRevokedError) throw new ORPCError("UNAUTHORIZED");
    if (error instanceof RunnerMachineForbiddenError) throw new ORPCError("FORBIDDEN");
    throw error;
  }
}

async function liveMachine(tx: Prisma.TransactionClient, identity: RunnerControlIdentity) {
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
      User: {
        select: { banned: true, banExpires: true, emailVerified: true, deletionRequestedAt: true },
      },
    },
  });
  if (
    !machine?.User.emailVerified ||
    isAccountDeletionPending(machine.User) ||
    isUserBanned(machine.User)
  )
    throw new ORPCError("UNAUTHORIZED");
}

type TemporalGrants = {
  retain: (deadline: Date | null | undefined) => void;
  check: () => void;
};

async function machineTransaction<T>(
  identity: RunnerControlIdentity,
  run: (tx: Prisma.TransactionClient, grants: TemporalGrants) => Promise<T>,
) {
  let originalDeadline: number | null = null;
  const grants: TemporalGrants = {
    retain(deadline) {
      if (deadline) originalDeadline = Math.min(originalDeadline ?? Infinity, deadline.getTime());
    },
    check() {
      if (originalDeadline !== null && originalDeadline <= Date.now()) throw stale();
    },
  };
  return runnerTransaction(
    identity.userId,
    (tx) => liveMachine(tx, identity),
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
  const archive = createMatch(input.config, "local");
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
  const configDigest = runnerConfigDigest(config);
  const receiptId = digest(["runner", context.session.user.id, input.creationKey]);
  const result = await browserTransaction(context, async (tx, userId) => {
    const accepted = await tx.chessCreation.findUnique({
      where: { id: receiptId },
      select: { configDigest: true, Match: { select: controlSelect } },
    });
    const requestDigest = digest({ machineId: input.machineId, configDigest });
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
      where: { id: input.machineId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!machine) throw notFound();
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

/** E4b must install authoritative move/event handlers before enabling paid game starts. */
export async function startRunnerMatch(
  context: BrowserContext,
  input: z.input<typeof runnerCommandInput>,
): Promise<never> {
  await runnerMatchStatus(context, { slug: runnerCommandInput.parse(input).slug });
  throw new ORPCError("PRECONDITION_FAILED", { data: { reason: "runner-gameplay-unavailable" } });
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
  await tx.runnerCommand.updateMany({
    where: { matchId: row.id, ackedAt: null, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });
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
    for (const match of active) {
      const row = await lockedMatch(tx, match.id, identity);
      const now = new Date();
      if (!activeRunner(row)) continue;
      if (row.runnerResumeDeadline && row.runnerResumeDeadline <= now) {
        await expireMatch(tx, row, "runner-abandoned");
        continue;
      }
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
    }
    const pending = {
      ackedAt: null,
      cancelledAt: null,
      expiresAt: { gt: new Date() },
      Match: { source: "runner", ownerId: identity.userId, runnerMachineId: identity.machineId },
    } satisfies Prisma.RunnerCommandWhereInput;
    const select = {
      id: true,
      kind: true,
      payload: true,
      expiresAt: true,
      Match: { select: controlSelect },
    } satisfies Prisma.RunnerCommandSelect;
    // Window membership must be authoritative even when a command is beyond the
    // FIFO page. Absence from a truncated page cannot retire an outstanding ID.
    const retained =
      outstanding.length === 0
        ? []
        : await tx.runnerCommand.findMany({
            where: { ...pending, id: { in: [...outstanding] } },
            take: RUNNER_COMMAND_WINDOW,
            select,
          });
    const fifo = await tx.runnerCommand.findMany({
      where: { ...pending, ...(outstanding.length > 0 ? { id: { notIn: [...outstanding] } } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: RUNNER_OUTBOX_LIMIT - retained.length,
      select,
    });
    const commands = [...retained, ...fifo];
    const messages: RunnerDelivery[] = [];
    for (const command of commands) {
      grants.retain(command.expiresAt);
      const row = command.Match;
      if (command.kind === "stop" && row.runnerState === "stopped")
        messages.push(delivery("stop", row.id, { commandId: command.id }));
      else if (
        activeRunner(row) &&
        row.runnerGeneration === identity.connectionGeneration &&
        command.kind === "offer"
      )
        messages.push(delivery("offer", row.id, command.payload));
      else if (
        activeRunner(row) &&
        row.runnerGeneration === identity.connectionGeneration &&
        command.kind === "resume" &&
        activeStates.includes(row.runnerState ?? "")
      )
        messages.push(delivery("resume", row.id, command.payload));
      // Start is deliberately not dispatched until E4b supplies gameplay authority.
    }
    grants.check();
    return messages;
  });
}

/** Exact event IDs/digests survive reconnect and crash; no submitted board/outcome is trusted. */
export async function handleRunnerControl(
  identity: RunnerControlIdentity,
  message: RunnerClientMessage,
): Promise<RunnerDelivery[]> {
  if (message.generation !== identity.connectionGeneration) throw new ORPCError("UNAUTHORIZED");
  if (!["accept", "reject", "ack", "snapshot"].includes(message.type))
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
    if (activeStates.includes(row.runnerState ?? "") && !activeRunner(row)) throw stale();
    if (message.type === "ack" && row.status === "stopped" && row.runnerState === "stopped") {
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
    const responses: RunnerDelivery[] = [ack];
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
        // An offer ack is not acceptance: only semantic accept authorizes resume.
        if (command.kind === "offer") throw stale();
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
          responses.push(delivery("resume", matchId, payload));
        }
      }
    }
    grants.check();
    await tx.runnerEvent.create({ data: { id: message.id, matchId, payloadDigest: eventDigest } });
    grants.check();
    return responses;
  });
}
