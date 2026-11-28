import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ownerActiveInTransaction } from "@cockpit-chess/auth/account-deletion";
import {
  lockCliCredentials,
  withCliCredentialLockSlot,
} from "@cockpit-chess/auth/device-redemption-lock";
import {
  beginHostedTurn,
  boardAt,
  createMatch,
  isOldRulesVersion,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  MODEL_PROTOCOLS,
  matchConfigSchema,
  playHostedHumanTurn,
  utf8ByteLength,
  validateArchive,
} from "@cockpit-chess/chess";
import { endingSummarySchema } from "@cockpit-chess/chess/ending";
import { CURRENT_PROMPT_VERSION, PROMPT_BUNDLES } from "@cockpit-chess/chess/prompts";
import { endAtArchiveLimit } from "@cockpit-chess/chess/runner";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env as serverEnv } from "@cockpit-chess/env/server";
import { env } from "@cockpit-chess/env/shared";
import { redisConnection } from "@cockpit-chess/queue";
import { readChessEngineStats } from "@cockpit-chess/queue/chess-capacity";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "../context";
import {
  adminOr404Procedure,
  authenticatedProcedure,
  checkAdminAuthority,
  hostedPlayerProcedure,
  protectedProcedure,
  publicProcedure,
} from "../index";
import { sourceCodeUrl } from "../lib/build-commit";
import {
  anonymizeReplay,
  anonymizeSpectatorEvaluations,
  DELETED_USER,
  neutralArchiveId,
  UNKNOWN_MODEL,
} from "../lib/chess-anonymization";
import { readStoredArchive } from "../lib/chess-archive";
import { chessTurnData, wakeHostedMatch } from "../lib/chess-human";
import { admitHostedMatch, CHESS_CREATE_LOCK } from "../lib/chess-locks";
import { getModelCatalog } from "../lib/chess-models";
import {
  chessDigest,
  officialCommitment,
  officialFilter,
  officialFilterInput,
  officialLeaderboard,
} from "../lib/chess-official";
import { spectatorEvaluationsFor } from "../lib/chess-spectator";
import { chessStatsColumns, STOPPED_ENDING } from "../lib/chess-stats";
import {
  type ChessTurnColumns,
  chessTurnFromColumns,
  chessTurnMetadata,
  chessTurnSelect,
} from "../lib/chess-turn";
import { publicReplayWhere } from "../lib/chess-visibility";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { openOwnerOpenRouterKey, providerKeySecrets } from "../lib/provider-key";
import { slugify } from "../lib/slug";

const summary = {
  ...chessTurnSelect,
  id: true,
  slug: true,
  createdAt: true,
  title: true,
  whiteName: true,
  blackName: true,
  status: true,
  published: true,
  hiddenAt: true,
  moderationVersion: true,
  OfficialEntry: { select: { id: true } },
  source: true,
  rulesKey: true,
  rulesVersion: true,
  promptVersion: true,
  promptHash: true,
  contextMode: true,
  identityMode: true,
  ending: true,
} satisfies Prisma.ChessMatchSelect;
const publicSummary = {
  ...summary,
  publicId: true,
  ownerId: true,
  Owner: { select: { deletionRequestedAt: true } },
  whiteModel: true,
  blackModel: true,
  whiteProtocol: true,
  blackProtocol: true,
} satisfies Prisma.ChessMatchSelect;
async function safeCatalogIds() {
  try {
    return new Set((await getModelCatalog()).models.map((model) => model.id));
  } catch {
    // Privacy never depends on the catalog being available.
    return new Set<string>();
  }
}
function publicCard(
  input: Prisma.ChessMatchGetPayload<{ select: typeof publicSummary }>,
  safeModelIds: ReadonlySet<string>,
) {
  const { ownerId, Owner, publicId, whiteModel, blackModel, whiteProtocol, blackProtocol } = input;
  // Explicit response whitelist: adding a private selection later cannot silently
  // turn an archive, owner field or internal row identity into public card data.
  const row = {
    id: publicId,
    slug: input.slug,
    createdAt: input.createdAt,
    title: input.title,
    whiteName: input.whiteName,
    blackName: input.blackName,
    status: input.status,
    published: input.published,
    source: input.source,
    rulesKey: input.rulesKey,
    rulesVersion: input.rulesVersion,
    promptVersion: input.promptVersion,
    promptHash: input.promptHash,
    contextMode: input.contextMode,
    identityMode: input.identityMode,
    ending: input.ending,
    OfficialEntry: input.OfficialEntry,
    turnType: input.turnType,
    turnId: input.turnId,
    turnSide: input.turnSide,
    turnExpectedSeq: input.turnExpectedSeq,
    turnStartedAt: input.turnStartedAt,
    turnDeadline: input.turnDeadline,
    pendingMove: input.pendingMove,
  };
  if (input.hiddenAt || Owner?.deletionRequestedAt) throw new ORPCError("NOT_FOUND");
  if (ownerId !== null) return { ...withEnding({ ...row, id: publicId }), anonymized: false };
  const identity = neutralArchiveId(row.slug);
  if (!identity) throw new ORPCError("NOT_FOUND");
  const name = (model: string | null, protocol: string | null) =>
    protocol === "human"
      ? DELETED_USER
      : protocol === "random"
        ? "Random"
        : model && safeModelIds.has(model)
          ? model.slice(0, 80)
          : UNKNOWN_MODEL;
  return {
    ...withEnding({
      ...row,
      ...chessTurnSelectIdle,
      id: publicId,
      title: DELETED_USER,
      whiteName: name(whiteModel, whiteProtocol),
      blackName: name(blackModel, blackProtocol),
    }),
    anonymized: true,
  };
}
const chessTurnSelectIdle = {
  turnType: "idle",
  turnId: null,
  turnSide: null,
  turnExpectedSeq: null,
  turnStartedAt: null,
  turnDeadline: null,
  pendingMove: null,
};
/** The stored short ending; anything malformed reads as unknown rather than failing the list. */
const cardEnding = endingSummarySchema.nullable().catch(null);
/**
 * A card: the stored short ending, and `oldRules` when the game was played under a
 * ruleset this build no longer reads (it lists, but has no replay).
 */
const withEnding = <
  Row extends ChessTurnColumns & {
    ending: Prisma.JsonValue;
    rulesVersion: string | null;
    OfficialEntry: { id: string } | null;
  },
>(
  input: Row,
) => {
  const {
    rulesVersion,
    OfficialEntry,
    turnType: _turnType,
    turnId: _turnId,
    turnSide: _turnSide,
    turnExpectedSeq: _turnExpectedSeq,
    turnStartedAt: _turnStartedAt,
    turnDeadline: _turnDeadline,
    pendingMove: _pendingMove,
    ...row
  } = input;
  return {
    ...row,
    official: OfficialEntry !== null,
    ending: cardEnding.parse(row.ending),
    oldRules: isOldRulesVersion(rulesVersion),
    turn: chessTurnMetadata(chessTurnFromColumns(input)),
  };
};
const slugInput = z.object({
  slug: z
    .string()
    .min(1)
    .max(180)
    .regex(/^[a-z0-9-]+$/),
});
const spendBudget = createProcedureBudget({
  keyPrefix: "chess:create",
  points: 12,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: () => "Chess match creation allowance exceeded",
  unavailableMessage: "Chess scheduling unavailable",
  unavailableLog: "[chess] Scheduling budget unavailable",
});
const moveBudget = createProcedureBudget({
  keyPrefix: "chess:move",
  points: 120,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Chess move allowance exceeded",
  unavailableMessage: "Chess moves unavailable",
  unavailableLog: "[chess] Move budget unavailable",
});
const moveInput = slugInput
  .extend({
    move: z
      .string()
      .max(6)
      .regex(/^(?:[a-h][1-8][a-h][1-8][qrbn]?|resign)(?![\s\S])/),
    expectedSeq: z.number().int().min(0).max(2_147_483_647),
    turnId: z.uuid(),
  })
  .strict();
const rulesKey = (match: MatchArchive) =>
  createHash("sha256").update(JSON.stringify(match.config.rules)).digest("hex").slice(0, 16);
const metadata = (match: MatchArchive) => ({
  title: match.config.title,
  whiteName: match.config.white.name,
  blackName: match.config.black.name,
  source: match.source,
  rulesKey: rulesKey(match),
  rulesVersion: match.config.rules.version,
  promptVersion: match.config.prompt.version,
  promptHash: match.config.prompt.hash,
  contextMode: match.config.rules.context,
  identityMode: match.config.rules.opponentIdentity,
});
const ARCHIVE_TOO_LARGE = `Game archive exceeds ${MAX_ARCHIVE_BYTES} bytes (2 MB)`;
/**
 * Stored archives were replay-validated once, when they were written (create /
 * worker / importGame). Read paths only re-check the shape (`archiveSchema`) —
 * a full chess.js replay on every 2s spectator poll buys nothing — while
 * untrusted uploads go through `validateArchive` (`replay: true`).
 *
 * Row status is authoritative over the snapshot: stop and reconcile flip only
 * the row, so a running snapshot is normalized here to match it.
 */
function checkedArchive(
  input: unknown,
  status?: string,
  replay = false,
  ending?: Prisma.JsonValue,
) {
  try {
    return replay ? validateArchive(input) : readStoredArchive(input, status, ending);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        error instanceof Error && error.message.startsWith("Unsupported ")
          ? error.message
          : "Invalid chess archive",
    });
  }
}
const ownDraftSelect = {
  id: true,
  archive: true,
  status: true,
  source: true,
  published: true,
} satisfies Prisma.ChessMatchSelect;
const ownInspectSelect = {
  ...ownDraftSelect,
  ending: true,
  rulesVersion: true,
  spectatorEvaluations: true,
  OfficialEntry: { select: { id: true } },
  createdAt: true,
  credentialSource: true,
  hiddenAt: true,
  moderationReason: true,
  moderationNote: true,
  moderationVersion: true,
  ModerationActions: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: { id: true, createdAt: true, hidden: true, reason: true, note: true },
  },
} satisfies Prisma.ChessMatchSelect;
const OLD_RULES_MESSAGE = "Unsupported ruleset/archive";
const ownIdSelect = { id: true } satisfies Prisma.ChessMatchSelect;
async function ownDraft<
  S extends typeof ownDraftSelect | typeof ownInspectSelect | typeof ownIdSelect,
>(slug: string, ownerId: string, select: S) {
  const row = await prisma.chessMatch.findFirst({ where: { slug, ownerId }, select });
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}
/** The operator's per-side limits for a hosted match (server config). */
function hostedLimits() {
  return {
    maxCostMicros: Math.round(env.CHESS_MAX_COST_USD * 1_000_000),
    maxTokens: env.CHESS_MAX_TOKENS,
  };
}
/**
 * Why `chess.create` refused a match, as `error.data.reason`: the web client turns it
 * into a sentence that says what to do next. Messages stay fixed English.
 */
export type ChessCreateRefusal =
  | "hosted-disabled"
  | "user-matches-disabled"
  | "operator-billing-admin-only"
  | "operator-key-missing"
  | "openrouter-unavailable"
  | "not-connected"
  | "reconnect"
  | "active-match"
  | "daily-limit"
  | "queue-full";
const refuse = (
  code:
    | "SERVICE_UNAVAILABLE"
    | "FORBIDDEN"
    | "PRECONDITION_FAILED"
    | "CONFLICT"
    | "TOO_MANY_REQUESTS",
  reason: ChessCreateRefusal,
  message: string,
) => new ORPCError(code, { message, data: { reason } });
/** One lock for every create: the queue, active and daily counts are read and written under it. */
const createInput = matchConfigSchema.extend({
  /**
   * Who pays the players: "operator" (the server's key, admins only) or "openrouter"
   * (the caller's connected key). Omitted: operator for admins, openrouter otherwise.
   */
  billing: z.enum(["operator", "openrouter"]).optional(),
  official: z.boolean().default(false),
  creationKey: z.uuid(),
});
async function isAdminCaller(context: Pick<Context, "session" | "credential">) {
  return (await checkAdminAuthority(context.session, context.credential)).ok;
}
const connectionGateSelect = {
  status: true,
  expiresAt: true,
} satisfies Prisma.OpenRouterConnectionSelect;
/** Inspect/stop/publish of the caller's own match, shared with the CLI's admin surface. */
async function assertLiveOwnerRead(ownerId: string, sessionId: string) {
  return withCliCredentialLockSlot(() =>
    prisma.$transaction(
      async (tx) => {
        await lockCliCredentials(ownerId, tx);
        const live = await tx.session.findFirst({
          where: { id: sessionId, userId: ownerId, expiresAt: { gt: new Date() } },
          select: { id: true },
        });
        if (!live || !(await ownerActiveInTransaction(tx, ownerId)))
          throw new ORPCError("UNAUTHORIZED");
      },
      { isolationLevel: "ReadCommitted", timeout: 30_000 },
    ),
  );
}
async function inspectOwnMatch(slug: string, ownerId: string, sessionId: string) {
  const row = await ownDraft(slug, ownerId, ownInspectSelect);
  // Studio offers no preview of an old-rules game; the CLI gets a reason, not "invalid".
  if (isOldRulesVersion(row.rulesVersion))
    throw new ORPCError("BAD_REQUEST", { message: OLD_RULES_MESSAGE });
  const archive = checkedArchive(row.archive, row.status, false, row.ending);
  const queuePosition =
    row.status === "queued"
      ? (await prisma.chessMatch.count({
          where: {
            status: "queued",
            OR: [
              { createdAt: { lt: row.createdAt } },
              { createdAt: row.createdAt, id: { lt: row.id } },
            ],
          },
        })) + 1
      : null;
  // Queue IO may outlive the session/deletion state sampled at procedure entry.
  await assertLiveOwnerRead(ownerId, sessionId);
  return {
    archive,
    turn: chessTurnMetadata(archive.turn),
    status: row.status,
    published: row.published,
    official: row.OfficialEntry !== null,
    credentialSource: row.credentialSource === "owner-openrouter" ? "openrouter" : "operator",
    queuePosition,
    hiddenAt: row.hiddenAt,
    moderationReason: row.moderationReason,
    moderationNote: row.moderationNote,
    moderationVersion: row.moderationVersion,
    ModerationActions: row.ModerationActions,
    spectatorEvaluations: spectatorEvaluationsFor(
      { ...row, archive },
      { purpose: "owner", ownerId },
    ),
  } as const;
}
async function publishOwnMatch(slug: string, ownerId: string, published: boolean) {
  return withCliCredentialLockSlot(() =>
    prisma.$transaction(async (tx) => {
      await lockCliCredentials(ownerId, tx);
      if (!(await ownerActiveInTransaction(tx, ownerId))) throw new ORPCError("UNAUTHORIZED");
      const row = await tx.chessMatch.findFirst({ where: { slug, ownerId }, select: ownIdSelect });
      if (!row) throw new ORPCError("NOT_FOUND");
      await tx.chessMatch.update({
        where: { id: row.id },
        data: { published },
        select: { id: true },
      });
      return { published };
    }),
  );
}
const capacityMatchSelect = {
  slug: true,
  title: true,
  status: true,
  createdAt: true,
  Owner: { select: { name: true } },
} satisfies Prisma.ChessMatchSelect;
const CAPACITY_LIST = 50;
const isP2002 = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
export const chessRouter = {
  info: publicProcedure.handler(() => ({
    hostedEnabled: env.CHESS_HOSTED_ENABLED,
    /** Signed-in users may connect OpenRouter and run hosted matches on their own key. */
    userMatchesEnabled:
      env.CHESS_HOSTED_ENABLED && env.CHESS_USER_MATCHES_ENABLED && providerKeySecrets().length > 0,
    /** Hosted matches one user may start per rolling 24 hours (one active at a time). */
    dailyLimit: env.CHESS_USER_DAILY_MATCHES,
    format: "cockpit-chess/v1",
    currentPromptVersion: CURRENT_PROMPT_VERSION,
    promptVersions: PROMPT_BUNDLES,
    /** Per-side operator limits, so the create form's maxima follow the server. */
    limits: hostedLimits(),
    /** The running code's public source (AGPL-3.0 section 13). */
    sourceCodeUrl: sourceCodeUrl(serverEnv.SOURCE_CODE_URL),
  })),
  /** The models a hosted match can use, for the create form's picker (cached; see chess-models). */
  models: authenticatedProcedure.handler(async () => {
    try {
      return await getModelCatalog();
    } catch (error) {
      console.error("[chess] Model catalog unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Model catalog unavailable" });
    }
  }),
  list: publicProcedure.input(cursorPageInput).handler(async ({ input }) => {
    const readPage = () =>
      prisma.chessMatch.findMany({
        where: withCursor(publicReplayWhere, "createdAt", input.cursor, "desc", "publicId"),
        select: publicSummary,
        orderBy: [{ createdAt: "desc" }, { publicId: "desc" }],
        take: pageTake(input.limit),
      });
    let rows = await readPage();
    let safeIds = new Set<string>();
    if (rows.some((row) => row.ownerId === null)) {
      safeIds = await safeCatalogIds();
      // Catalog IO can take seconds. Only this final, visibility-constrained
      // query may supply response data or the page boundary.
      rows = await readPage();
    }
    // Cursor stays anchored to the database order; public cards use only the new identity.
    const page = cursorPage(
      rows.map((row) => ({ ...row, id: row.publicId })),
      input.limit,
      "createdAt",
    );
    return {
      ...page,
      items: page.items.flatMap((row) => {
        if (
          row.hiddenAt ||
          row.Owner?.deletionRequestedAt ||
          (row.ownerId === null && !neutralArchiveId(row.slug))
        )
          return [];
        return [publicCard(row, safeIds)];
      }),
    };
  }),
  get: publicProcedure.input(slugInput).handler(async ({ input }) => {
    const readReplay = () =>
      prisma.chessMatch.findFirst({
        where: { ...publicReplayWhere, slug: input.slug },
        select: { ...publicSummary, archive: true, spectatorEvaluations: true },
      });
    let row = await readReplay();
    if (!row) throw new ORPCError("NOT_FOUND");
    let safeIds = new Set<string>();
    if (row.ownerId === null) {
      safeIds = await safeCatalogIds();
      row = await readReplay();
      if (!row) throw new ORPCError("NOT_FOUND");
    }
    const { spectatorEvaluations, archive: stored, ...rest } = row;
    const card = publicCard(rest, safeIds);
    // An old-rules game has no replay: say so with its card instead of failing the read.
    if (isOldRulesVersion(row.rulesVersion))
      return { ...card, archive: null, spectatorEvaluations: null };
    const checked = checkedArchive(stored, row.status, false, row.ending);
    const neutralId = row.ownerId === null ? neutralArchiveId(row.slug) : null;
    const archive = neutralId ? anonymizeReplay(checked, neutralId, safeIds) : checked;
    return {
      ...card,
      archive,
      turn: chessTurnMetadata(archive.turn),
      spectatorEvaluations: spectatorEvaluationsFor(
        {
          ...row,
          archive,
          spectatorEvaluations: neutralId
            ? anonymizeSpectatorEvaluations(archive, row.spectatorEvaluations)
            : row.spectatorEvaluations,
        },
        { purpose: "public", version: row.moderationVersion },
      ),
    };
  }),
  studio: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.chessMatch.findMany({
      where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      // Moderation statements must remain accessible even when replay parsing
      // rejects an unsupported archive. This projection is owner-only.
      select: {
        ...summary,
        moderationReason: true,
        moderationNote: true,
        ModerationActions: ownInspectSelect.ModerationActions,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
    });
    await assertLiveOwnerRead(context.session.user.id, context.session.session.id);
    return cursorPage(rows.map(withEnding), input.limit, "createdAt");
  }),
  inspect: protectedProcedure
    .input(slugInput)
    .handler(({ input, context }) =>
      inspectOwnMatch(input.slug, context.session.user.id, context.session.session.id),
    ),
  create: hostedPlayerProcedure.input(createInput).handler(async ({ input: request, context }) => {
    const { billing: requested, official, creationKey, ...input } = request;
    const ownerId = context.session.user.id;
    const admin = await isAdminCaller(context);
    const billing = requested ?? (admin ? "operator" : "openrouter");
    // The receipt binds the normalized accepted configuration, including consent.
    // Resolve before IO so a lost response can be replayed after disconnect/flag changes.
    const archive = createMatch(input, "hosted");
    const requestedConfig = {
      title: archive.config.title,
      white: archive.config.white,
      black: archive.config.black,
      rules: archive.config.rules,
      initialFen: archive.config.initialFen,
    };
    const configDigest = chessDigest({
      config: requestedConfig,
      promptVersion: input.promptVersion ?? null,
      billing: requested ?? null,
      official,
    });
    const creationId = chessDigest([ownerId, creationKey]);
    const receiptSelect = {
      configDigest: true,
      Match: { select: { slug: true, id: true } },
    } satisfies Prisma.ChessCreationSelect;
    const receiptResult = (
      receipt: Prisma.ChessCreationGetPayload<{ select: typeof receiptSelect }>,
    ) => {
      if (receipt.configDigest !== configDigest)
        throw new ORPCError("CONFLICT", {
          message: "Creation key was already used with different settings",
        });
      if (!receipt.Match)
        throw new ORPCError("NOT_FOUND", {
          message: "This accepted match was deleted; the creation key cannot be reused",
        });
      return receipt.Match;
    };
    const accepted = await prisma.chessCreation.findUnique({
      where: { id: creationId },
      select: receiptSelect,
    });
    if (accepted) return { slug: receiptResult(accepted).slug };
    if (!env.CHESS_HOSTED_ENABLED)
      throw refuse("SERVICE_UNAVAILABLE", "hosted-disabled", "Hosted inference is disabled");
    if (!admin && !env.CHESS_USER_MATCHES_ENABLED)
      throw refuse("FORBIDDEN", "user-matches-disabled", "Hosted matches are admin-only here");
    if (billing === "operator" && !admin)
      throw refuse(
        "FORBIDDEN",
        "operator-billing-admin-only",
        "Only admins may bill the operator key",
      );
    const humans = [archive.config.white, archive.config.black].filter(
      (player) => player.protocol === "human",
    );
    if (
      humans.length > 0 &&
      (humans.length !== 1 ||
        ![archive.config.white, archive.config.black].some((player) =>
          MODEL_PROTOCOLS.some((protocol) => protocol === player.protocol),
        ) ||
        official ||
        archive.config.rules.context !== "fresh")
    )
      throw new ORPCError("BAD_REQUEST", {
        message: "Hosted human play requires one model, fresh context and practice mode",
      });
    // No move cap: the rules engine's own draws, the archive limit and these budgets end
    // every game; the clock bounds are the schema's own. See README.md § Rules and endings
    const limits = hostedLimits();
    if (
      input.rules.costBudgetMicros > limits.maxCostMicros ||
      input.rules.tokenBudget > limits.maxTokens
    )
      throw new ORPCError("BAD_REQUEST", { message: "Hosted match exceeds the operator limits" });
    if (billing === "operator") {
      if (
        [input.white, input.black].some((player) => player.protocol !== "random") &&
        !env.OPENROUTER_API_KEY
      )
        throw refuse(
          "SERVICE_UNAVAILABLE",
          "operator-key-missing",
          "The operator key is not configured",
        );
    } else {
      if (!providerKeySecrets().length)
        throw refuse(
          "SERVICE_UNAVAILABLE",
          "openrouter-unavailable",
          "This server cannot store OpenRouter keys",
        );
      const connection = await prisma.openRouterConnection.findUnique({
        where: { userId: ownerId },
        select: connectionGateSelect,
      });
      if (!connection)
        throw refuse("PRECONDITION_FAILED", "not-connected", "Connect OpenRouter first");
      if (
        connection.status !== "active" ||
        (connection.expiresAt && connection.expiresAt.getTime() <= Date.now())
      )
        throw refuse("PRECONDITION_FAILED", "reconnect", "Reconnect OpenRouter first");
      // A row this server can no longer open (its sealing secret was rotated away) would
      // only fail at claim time; refuse now (the check marks it invalid for Settings).
      if ((await openOwnerOpenRouterKey(ownerId)).state !== "ok")
        throw refuse("PRECONDITION_FAILED", "reconnect", "Reconnect OpenRouter first");
    }
    // Untrusted display names never become trusted opponent instructions, for practice
    // or official play. Requested model IDs must resolve in the server catalog.
    const players = [archive.config.white, archive.config.black];
    if (players.some((player) => player.protocol !== "human" && player.protocol !== "random")) {
      const catalog = await getModelCatalog().catch(() => {
        throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Model catalog unavailable" });
      });
      for (const player of players) {
        if (player.protocol === "human" || player.protocol === "random") continue;
        const model = catalog.models.find((item) => item.id === player.model);
        if (!model) throw new ORPCError("BAD_REQUEST", { message: "Unknown hosted model" });
        player.name = model.id.slice(0, 80);
      }
    }
    for (const player of players)
      if (player.protocol === "random") {
        player.name = "Random baseline";
        player.model = "random";
      } else if (player.protocol === "human") {
        player.name = "Human";
        player.model = "human";
      }
    const credentialSource = billing === "operator" ? "operator" : "owner-openrouter";
    const commitment = official ? officialCommitment(archive, credentialSource) : null;
    await spendBudget(ownerId);
    const slug = `${slugify(input.title).slice(0, 110) || "match"}-${archive.id.slice(0, 8)}`;
    // Matches billed to the caller's own key carry the per-user caps; admin matches on
    // the operator key only the queue cap. One lock serializes every create, so the
    // counts below cannot be raced past (creation is rare: 12 per user per hour).
    const capped = billing === "openrouter";
    const row = await withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        // Reset/delete holds this same per-user lock. A request authorized before
        // revocation must not create new spending after its cancellation sweep.
        await lockCliCredentials(ownerId, tx);
        const live = await tx.session.findFirst({
          where: { id: context.session.session.id, userId: ownerId, expiresAt: { gt: new Date() } },
          select: { id: true },
        });
        if (!live) throw new ORPCError("UNAUTHORIZED");
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CHESS_CREATE_LOCK}))::text AS locked`;
        const previous = await tx.chessCreation.findUnique({
          where: { id: creationId },
          select: receiptSelect,
        });
        if (previous) return { ...receiptResult(previous), duplicate: true };
        await admitHostedMatch(tx, {
          ownerId,
          ownKey: capped,
          queueMax: env.CHESS_QUEUE_MAX,
          dailyMax: env.CHESS_USER_DAILY_MATCHES,
        });
        const created = await tx.chessMatch.create({
          data: {
            ...metadata(archive),
            ownerId,
            slug,
            status: "queued",
            published: false,
            credentialSource,
            ...(commitment ? { OfficialEntry: { create: commitment } } : {}),
            Creation: { create: { id: creationId, configDigest } },
            heartbeatAt: new Date(),
            ...chessTurnData(archive.turn),
            archive,
          },
          select: { id: true, slug: true },
        });
        return { ...created, duplicate: false };
      }),
    );
    // A retry never resurrects or re-enqueues an accepted terminal/withdrawn start.
    if (row.duplicate) return { slug: row.slug };
    await wakeHostedMatch(row.id, archive);
    return { slug };
  }),
  move: hostedPlayerProcedure.input(moveInput).handler(async ({ input, context }) => {
    const ownerId = context.session.user.id;
    await moveBudget(ownerId);
    const accepted = await withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        await lockCliCredentials(ownerId, tx);
        const live = await tx.session.findFirst({
          where: { id: context.session.session.id, userId: ownerId, expiresAt: { gt: new Date() } },
          select: { id: true },
        });
        if (!live || !(await ownerActiveInTransaction(tx, ownerId)))
          throw new ORPCError("UNAUTHORIZED");
        const row = await tx.chessMatch.findFirst({
          where: { slug: input.slug, ownerId, source: "hosted" },
          select: {
            ...chessTurnSelect,
            id: true,
            ownerId: true,
            source: true,
            status: true,
            runToken: true,
            archive: true,
          },
        });
        if (!row || row.ownerId !== ownerId || row.source !== "hosted")
          throw new ORPCError("NOT_FOUND");
        if (row.status !== "running" || row.runToken !== null) throw new ORPCError("CONFLICT");
        // Budget/credential/database waits never preserve an earlier browser-side
        // deadline decision. Only server time after those waits can authorize input.
        const receivedAt = new Date();
        const archive = checkedArchive(row.archive, undefined, true);
        const turn = chessTurnFromColumns(row);
        if (
          archive.status !== "running" ||
          archive.source !== "hosted" ||
          archive.config.rules.context !== "fresh" ||
          turn.type !== "human" ||
          !isDeepStrictEqual(turn, archive.turn) ||
          turn.turnId !== input.turnId ||
          turn.expectedSeq !== input.expectedSeq ||
          turn.expectedSeq !== archive.events.length ||
          archive.config[turn.side === "w" ? "white" : "black"].protocol !== "human" ||
          !MODEL_PROTOCOLS.some(
            (protocol) =>
              protocol === archive.config[turn.side === "w" ? "black" : "white"].protocol,
          ) ||
          receivedAt.getTime() < Date.parse(turn.startedAt)
        )
          throw new ORPCError("CONFLICT");
        const expired = receivedAt.getTime() >= Date.parse(turn.deadline);
        if (!endAtArchiveLimit(archive))
          playHostedHumanTurn(archive, receivedAt, expired ? undefined : input.move);
        endAtArchiveLimit(archive);
        // A rejected attempt gets a fresh CAS identity but keeps the original
        // chess-turn deadline, so repeated illegal input cannot buy thinking time.
        // Model turns remain idle/queued until a worker owns their runToken.
        if (archive.status === "running" && boardAt(archive).turn() === turn.side) {
          beginHostedTurn(archive, receivedAt);
          if (
            archive.turn.type === "human" &&
            Date.parse(archive.turn.deadline) > Date.parse(turn.deadline)
          )
            archive.turn.deadline = turn.deadline;
        }
        const status =
          archive.status === "running"
            ? archive.turn.type === "human"
              ? "running"
              : "queued"
            : archive.status;
        const updated = await tx.chessMatch.updateMany({
          where: {
            id: row.id,
            ownerId,
            source: "hosted",
            status: "running",
            runToken: null,
            turnType: "human",
            turnId: input.turnId,
            turnExpectedSeq: input.expectedSeq,
            turnDeadline: expired ? { lte: receivedAt } : { gt: receivedAt },
          },
          data: {
            archive,
            status,
            runToken: null,
            heartbeatAt: receivedAt,
            ...chessTurnData(archive.turn),
            ...chessStatsColumns(archive),
          },
        });
        if (updated.count !== 1) throw new ORPCError("CONFLICT");
        return { id: row.id, archive, status };
      }),
    );
    if (accepted.status === "queued") await wakeHostedMatch(accepted.id, accepted.archive);
    return {
      status: accepted.status,
      turn: chessTurnMetadata(accepted.archive.turn),
      seq: accepted.archive.events.length,
    };
  }),
  importGame: adminOr404Procedure
    // UTF-16 length never exceeds UTF-8 length, so this cheap bound only rejects
    // archives the exact byte check below would reject too.
    .input(z.object({ json: z.string().max(MAX_ARCHIVE_BYTES, ARCHIVE_TOO_LARGE) }))
    .handler(async ({ input, context }) => {
      // The shared interchange limit (MAX_ARCHIVE_BYTES), the same one the runner
      // stays under and the CLI reader enforces.
      if (utf8ByteLength(input.json) > MAX_ARCHIVE_BYTES)
        throw new ORPCError("PAYLOAD_TOO_LARGE", { message: ARCHIVE_TOO_LARGE });
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.json);
      } catch {
        throw new ORPCError("BAD_REQUEST");
      }
      const archive = checkedArchive(parsed, undefined, true);
      if (archive.status === "running")
        throw new ORPCError("BAD_REQUEST", { message: "Stop the local game before importing it" });
      // Imported provenance never confers official standing, regardless of claims in the file.
      archive.source = "local";
      const slug = `${slugify(archive.config.title).slice(0, 110) || "match"}-${archive.id.slice(0, 8)}`;
      const ownerId = context.session.user.id;
      const importUnderLock = (create: boolean) =>
        withCliCredentialLockSlot(() =>
          prisma.$transaction(async (tx) => {
            await lockCliCredentials(ownerId, tx);
            if (!(await ownerActiveInTransaction(tx, ownerId))) throw new ORPCError("UNAUTHORIZED");
            const existing = await tx.chessMatch.findFirst({
              where: { slug },
              select: { ownerId: true },
            });
            if (existing) {
              if (existing.ownerId !== ownerId) throw new ORPCError("CONFLICT");
              return { slug, duplicate: true };
            }
            if (!create) throw new ORPCError("CONFLICT");
            await tx.chessMatch.create({
              data: {
                ...metadata(archive),
                ...chessStatsColumns(archive),
                ownerId,
                slug,
                status: archive.status,
                archive,
                published: false,
              },
              select: { id: true },
            });
            return { slug, duplicate: false };
          }),
        );
      try {
        return await importUnderLock(true);
      } catch (error) {
        // A concurrent import's unique violation rolls its transaction back;
        // reacquire authority in a fresh transaction before returning its receipt.
        if (!isP2002(error)) throw error;
        return importUnderLock(false);
      }
    }),
  publish: protectedProcedure
    .input(slugInput.extend({ published: z.boolean() }))
    .handler(({ input, context }) =>
      publishOwnMatch(input.slug, context.session.user.id, input.published),
    ),
  /**
   * Admin view of hosted capacity: matches running against the worker limit, the queue
   * against its cap, and the engine pool. Counts plus a bounded list of titles and
   * owner names; no keys, archives or other private match data.
   */
  capacity: adminOr404Procedure.handler(async () => {
    const [running, queued, matches, engine] = await Promise.all([
      prisma.chessMatch.count({
        where: { source: "hosted", status: "running", runToken: { not: null } },
      }),
      prisma.chessMatch.count({ where: { status: "queued" } }),
      prisma.chessMatch.findMany({
        where: { status: { in: ["running", "queued"] } },
        select: capacityMatchSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: CAPACITY_LIST,
      }),
      readChessEngineStats(redisConnection).catch(() => null),
    ]);
    return {
      running,
      // Live workers' own limits; zero when none reported, the configured value only
      // when the numbers could not be read at all.
      concurrencyLimit: engine ? engine.concurrency : env.CHESS_RUN_CONCURRENCY,
      queued,
      queueCap: env.CHESS_QUEUE_MAX,
      // No worker published within the expiry: say so instead of showing 0/0.
      engine:
        engine && engine.workers > 0
          ? {
              busy: engine.busy,
              total: engine.total,
              waiting: engine.waiting,
              workers: engine.workers,
            }
          : null,
      matches: matches.map(({ Owner, ...match }) => ({ ...match, ownerName: Owner?.name ?? null })),
    };
  }),
  stop: protectedProcedure.input(slugInput).handler(async ({ input, context }) => {
    const row = await ownDraft(input.slug, context.session.user.id, ownIdSelect);
    await prisma.chessMatch.updateMany({
      where: { id: row.id, status: { in: ["queued", "running"] } },
      // Leave the last durable event snapshot intact: a read-modify-write here
      // could erase a move persisted between the lookup and cancellation.
      data: {
        status: "stopped",
        runToken: null,
        ...chessTurnData({ type: "idle" }),
        ending: STOPPED_ENDING,
        terminalCause: "owner-stop",
      },
    });
    return { stopped: true };
  }),
  officialEntries: publicProcedure.input(officialFilterInput).handler(async ({ input }) => {
    const rows = await prisma.chessOfficialEntry.findMany({
      where: withCursor(officialFilter(input), "startedAt", input.cursor, "desc"),
      select: {
        id: true,
        startedAt: true,
        promptVersion: true,
        promptHash: true,
        rulesKey: true,
        rules: true,
        initialFen: true,
        initialPositionHash: true,
        billingCohort: true,
        opponentType: true,
        whiteModel: true,
        whiteProtocol: true,
        blackModel: true,
        blackProtocol: true,
        state: true,
        cause: true,
        settledAt: true,
        result: true,
        finalFen: true,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
    });
    return cursorPage(rows, input.limit, "startedAt");
  }),
  leaderboard: publicProcedure
    .input(officialFilterInput)
    .handler(({ input }) => officialLeaderboard(input)),
};

/**
 * The CLI's copies of inspect and publish (packages/api/src/routers/cli.ts): the same
 * owner-scoped work, kept behind the admin gate the CLI surface documents.
 */
export const chessCliProcedures = {
  inspect: adminOr404Procedure
    .input(slugInput)
    .handler(({ input, context }) =>
      inspectOwnMatch(input.slug, context.session.user.id, context.session.session.id),
    ),
  publish: adminOr404Procedure
    .input(slugInput.extend({ published: z.boolean() }))
    .handler(({ input, context }) =>
      publishOwnMatch(input.slug, context.session.user.id, input.published),
    ),
};
