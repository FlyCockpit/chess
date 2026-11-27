import { createHash } from "node:crypto";
import {
  createMatch,
  finishMatch,
  isOldRulesVersion,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  matchConfigSchema,
  parseArchive,
  utf8ByteLength,
  validateArchive,
} from "@cockpit-chess/chess";
import { endingSummarySchema } from "@cockpit-chess/chess/ending";
import { CURRENT_PROMPT_VERSION, PROMPT_BUNDLES } from "@cockpit-chess/chess/prompts";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env as serverEnv } from "@cockpit-chess/env/server";
import { env } from "@cockpit-chess/env/shared";
import { chessRunQueue, ensureRunnableJob, redisConnection } from "@cockpit-chess/queue";
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
import { admitHostedMatch } from "../lib/chess-locks";
import { getModelCatalog } from "../lib/chess-models";
import { spectatorEvaluationsFor } from "../lib/chess-spectator";
import { chessStatsColumns, INTERRUPTED_ENDING, STOPPED_ENDING } from "../lib/chess-stats";
import {
  type ChessTurnColumns,
  chessTurnFromColumns,
  chessTurnMetadata,
  chessTurnSelect,
} from "../lib/chess-turn";
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
  official: true,
  source: true,
  rulesKey: true,
  rulesVersion: true,
  promptVersion: true,
  promptHash: true,
  contextMode: true,
  identityMode: true,
  ending: true,
} satisfies Prisma.ChessMatchSelect;
/** The stored short ending; anything malformed reads as unknown rather than failing the list. */
const cardEnding = endingSummarySchema.nullable().catch(null);
/**
 * A card: the stored short ending, and `oldRules` when the game was played under a
 * ruleset this build no longer reads (it lists, but has no replay).
 */
const withEnding = <
  Row extends ChessTurnColumns & { ending: Prisma.JsonValue; rulesVersion: string | null },
>(
  input: Row,
) => {
  const {
    rulesVersion,
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
    const archive = replay ? validateArchive(input) : parseArchive(input);
    if (status === "stopped") {
      finishMatch(archive, "*", "cancelled", "stopped");
    }
    const parsedEnding =
      status === "error" && ending !== undefined ? cardEnding.parse(ending) : null;
    if (status === "error" && parsedEnding?.kind === "credential-revoked") {
      finishMatch(archive, "*", "credential-revoked", "error");
    } else if (status === "error" && archive.status === "running") {
      finishMatch(archive, "*", "interrupted", "error");
    }
    return archive;
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
  official: true,
  createdAt: true,
  credentialSource: true,
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
const leaderboardSelect = {
  rulesKey: true,
  result: true,
  whiteModel: true,
  whiteProtocol: true,
  blackModel: true,
  blackProtocol: true,
  whiteIllegal: true,
  blackIllegal: true,
  whiteTruncated: true,
  blackTruncated: true,
  whiteCostMicros: true,
  blackCostMicros: true,
  moveFormat: true,
} satisfies Prisma.ChessMatchSelect;
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
});
async function isAdminCaller(context: Pick<Context, "session" | "credential">) {
  return (await checkAdminAuthority(context.session, context.credential)).ok;
}
const connectionGateSelect = {
  status: true,
  expiresAt: true,
} satisfies Prisma.OpenRouterConnectionSelect;
/** Inspect/stop/publish of the caller's own match, shared with the CLI's admin surface. */
async function inspectOwnMatch(slug: string, ownerId: string) {
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
  return {
    archive,
    turn: chessTurnMetadata(archive.turn),
    status: row.status,
    published: row.published,
    official: row.official,
    credentialSource: row.credentialSource === "owner-openrouter" ? "openrouter" : "operator",
    queuePosition,
    spectatorEvaluations: spectatorEvaluationsFor({ ...row, archive }),
  } as const;
}
async function publishOwnMatch(slug: string, ownerId: string, published: boolean) {
  const row = await ownDraft(slug, ownerId, ownIdSelect);
  await prisma.chessMatch.update({
    where: { id: row.id },
    data: { published },
    select: { id: true },
  });
  return { published };
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
    const rows = await prisma.chessMatch.findMany({
      where: withCursor({ published: true }, "createdAt", input.cursor, "desc"),
      select: summary,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
    });
    return cursorPage(rows.map(withEnding), input.limit, "createdAt");
  }),
  get: publicProcedure.input(slugInput).handler(async ({ input }) => {
    const row = await prisma.chessMatch.findFirst({
      where: { slug: input.slug, published: true },
      select: { ...summary, archive: true, spectatorEvaluations: true },
    });
    if (!row) throw new ORPCError("NOT_FOUND");
    const { spectatorEvaluations, archive: stored, ...rest } = row;
    // An old-rules game has no replay: say so with its card instead of failing the read.
    if (isOldRulesVersion(row.rulesVersion))
      return { ...withEnding(rest), archive: null, spectatorEvaluations: null };
    const archive = checkedArchive(stored, row.status, false, row.ending);
    return {
      ...withEnding(rest),
      archive,
      turn: chessTurnMetadata(archive.turn),
      spectatorEvaluations: spectatorEvaluationsFor({ ...row, archive }),
    };
  }),
  studio: protectedProcedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.chessMatch.findMany({
      where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      select: summary,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
    });
    return cursorPage(rows.map(withEnding), input.limit, "createdAt");
  }),
  inspect: protectedProcedure
    .input(slugInput)
    .handler(({ input, context }) => inspectOwnMatch(input.slug, context.session.user.id)),
  create: hostedPlayerProcedure.input(createInput).handler(async ({ input: request, context }) => {
    const { billing: requested, ...input } = request;
    const ownerId = context.session.user.id;
    if (!env.CHESS_HOSTED_ENABLED)
      throw refuse("SERVICE_UNAVAILABLE", "hosted-disabled", "Hosted inference is disabled");
    const admin = await isAdminCaller(context);
    if (!admin && !env.CHESS_USER_MATCHES_ENABLED)
      throw refuse("FORBIDDEN", "user-matches-disabled", "Hosted matches are admin-only here");
    const billing = requested ?? (admin ? "operator" : "openrouter");
    if (billing === "operator" && !admin)
      throw refuse(
        "FORBIDDEN",
        "operator-billing-admin-only",
        "Only admins may bill the operator key",
      );
    if ([input.white, input.black].some((player) => player.protocol === "human"))
      throw new ORPCError("BAD_REQUEST");
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
    await spendBudget(ownerId);
    const archive = createMatch(input, "hosted");
    const slug = `${slugify(input.title).slice(0, 110) || "match"}-${archive.id.slice(0, 8)}`;
    // Matches billed to the caller's own key carry the per-user caps; admin matches on
    // the operator key only the queue cap. One lock serializes every create, so the
    // counts below cannot be raced past (creation is rare: 12 per user per hour).
    const capped = billing === "openrouter";
    const row = await prisma.$transaction(async (tx) => {
      await admitHostedMatch(tx, {
        ownerId,
        ownKey: capped,
        queueMax: env.CHESS_QUEUE_MAX,
        dailyMax: env.CHESS_USER_DAILY_MATCHES,
      });
      return tx.chessMatch.create({
        data: {
          ...metadata(archive),
          ownerId,
          slug,
          status: "queued",
          // Only the operator's curated runs count on the leaderboard by default; an
          // admin promotes others with `setOfficial`.
          official: billing === "operator",
          published: false,
          credentialSource: billing === "operator" ? "operator" : "owner-openrouter",
          heartbeatAt: new Date(),
          archive,
        },
        select: { id: true },
      });
    });
    try {
      await ensureRunnableJob(chessRunQueue, "chess-run", { matchId: row.id }, `chess-${row.id}`);
    } catch (error) {
      console.error("[chess] Failed to enqueue hosted match", {
        matchId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await prisma.chessMatch.updateMany({
        where: { id: row.id, status: "queued" },
        data: { status: "error", ending: INTERRUPTED_ENDING },
      });
      throw new ORPCError("SERVICE_UNAVAILABLE");
    }
    return { slug };
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
      const duplicate = async () => {
        const existing = await prisma.chessMatch.findFirst({
          where: { slug },
          select: { ownerId: true },
        });
        if (!existing) return null;
        if (existing.ownerId !== context.session.user.id) throw new ORPCError("CONFLICT");
        return { slug, duplicate: true };
      };
      const existing = await duplicate();
      if (existing) return existing;
      try {
        await prisma.chessMatch.create({
          data: {
            ...metadata(archive),
            ...chessStatsColumns(archive),
            ownerId: context.session.user.id,
            slug,
            status: archive.status,
            archive,
            published: false,
            official: false,
          },
          select: { id: true },
        });
      } catch (error) {
        // A concurrent import of the same archive won the unique slug.
        if (!isP2002(error)) throw error;
        const raced = await duplicate();
        if (!raced) throw new ORPCError("CONFLICT");
        return raced;
      }
      return { slug, duplicate: false };
    }),
  publish: protectedProcedure
    .input(slugInput.extend({ published: z.boolean() }))
    .handler(({ input, context }) =>
      publishOwnMatch(input.slug, context.session.user.id, input.published),
    ),
  /** Admin curation of the leaderboard: whether a published hosted game counts. */
  setOfficial: adminOr404Procedure
    .input(slugInput.extend({ official: z.boolean() }))
    .handler(async ({ input }) => {
      const result = await prisma.chessMatch.updateMany({
        where: { slug: input.slug, published: true, source: "hosted" },
        data: { official: input.official },
      });
      if (result.count !== 1) throw new ORPCError("NOT_FOUND");
      return { official: input.official };
    }),
  /**
   * Admin view of hosted capacity: matches running against the worker limit, the queue
   * against its cap, and the engine pool. Counts plus a bounded list of titles and
   * owner names; no keys, archives or other private match data.
   */
  capacity: adminOr404Procedure.handler(async () => {
    const [running, queued, matches, engine] = await Promise.all([
      prisma.chessMatch.count({ where: { status: "running" } }),
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
      matches: matches.map(({ Owner, ...match }) => ({ ...match, ownerName: Owner.name })),
    };
  }),
  stop: protectedProcedure.input(slugInput).handler(async ({ input, context }) => {
    const row = await ownDraft(input.slug, context.session.user.id, ownIdSelect);
    await prisma.chessMatch.updateMany({
      where: { id: row.id, status: { in: ["queued", "running"] } },
      // Leave the last durable event snapshot intact: a read-modify-write here
      // could erase a move persisted between the lookup and cancellation.
      data: { status: "stopped", runToken: null, ending: STOPPED_ENDING },
    });
    return { stopped: true };
  }),
  leaderboard: publicProcedure
    .input(cursorPageInput.extend({ rulesKey: z.string().max(32).optional() }))
    .handler(async ({ input }) => {
      const rows = await prisma.chessMatch.findMany({
        where: {
          published: true,
          official: true,
          source: "hosted",
          status: "completed",
          // Rows finished before stats columns existed carry none; skip them.
          result: { not: null },
          ...(input.rulesKey ? { rulesKey: input.rulesKey } : {}),
        },
        select: leaderboardSelect,
        take: 500,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const table = new Map<
        string,
        {
          model: string;
          protocol: string;
          rulesKey: string;
          /** Constant per rulesKey (it is part of the rules); null only for unlabeled rows. */
          moveFormat: string | null;
          games: number;
          wins: number;
          draws: number;
          losses: number;
          illegalAttempts: number;
          /** Of those, replies cut off before a move (rows from before the column count 0). */
          truncatedAttempts: number;
          estimatedCostMicros: number | null;
        }
      >();
      let sampleSize = 0;
      for (const row of rows) {
        const { result, whiteModel, whiteProtocol, blackModel, blackProtocol } = row;
        const { whiteIllegal, blackIllegal } = row;
        if (
          result === null ||
          whiteModel === null ||
          whiteProtocol === null ||
          blackModel === null ||
          blackProtocol === null ||
          whiteIllegal === null ||
          blackIllegal === null
        )
          continue;
        sampleSize += 1;
        const sides = [
          {
            win: "1-0",
            model: whiteModel,
            protocol: whiteProtocol,
            illegal: whiteIllegal,
            truncated: row.whiteTruncated ?? 0,
            cost: row.whiteCostMicros,
          },
          {
            win: "0-1",
            model: blackModel,
            protocol: blackProtocol,
            illegal: blackIllegal,
            truncated: row.blackTruncated ?? 0,
            cost: row.blackCostMicros,
          },
        ];
        for (const side of sides) {
          // Random baselines are opponents, not leaderboard entrants.
          if (side.protocol === "random") continue;
          const key = `${row.rulesKey}:${side.protocol}:${side.model}`;
          const record = table.get(key) ?? {
            model: side.model,
            protocol: side.protocol,
            rulesKey: row.rulesKey,
            moveFormat: row.moveFormat,
            games: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            illegalAttempts: 0,
            truncatedAttempts: 0,
            estimatedCostMicros: 0,
          };
          record.games += 1;
          if (result === "1/2-1/2") record.draws += 1;
          else if (result === side.win) record.wins += 1;
          else record.losses += 1;
          record.illegalAttempts += side.illegal;
          record.truncatedAttempts += side.truncated;
          record.estimatedCostMicros =
            record.estimatedCostMicros === null || side.cost === null
              ? null
              : record.estimatedCostMicros + Number(side.cost);
          table.set(key, record);
        }
      }
      return {
        items: [...table.values()]
          .sort((a, b) => (b.wins + b.draws / 2) / b.games - (a.wins + a.draws / 2) / a.games)
          .slice(0, input.limit),
        nextCursor: undefined,
        sampleSize,
        windowLimit: 500,
      };
    }),
};

/**
 * The CLI's copies of inspect and publish (packages/api/src/routers/cli.ts): the same
 * owner-scoped work, kept behind the admin gate the CLI surface documents.
 */
export const chessCliProcedures = {
  inspect: adminOr404Procedure
    .input(slugInput)
    .handler(({ input, context }) => inspectOwnMatch(input.slug, context.session.user.id)),
  publish: adminOr404Procedure
    .input(slugInput.extend({ published: z.boolean() }))
    .handler(({ input, context }) =>
      publishOwnMatch(input.slug, context.session.user.id, input.published),
    ),
};
