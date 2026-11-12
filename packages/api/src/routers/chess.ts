import { createHash } from "node:crypto";
import {
  archiveSchema,
  createMatch,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  matchConfigSchema,
  utf8ByteLength,
  validateArchive,
} from "@cockpit-chess/chess";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/shared";
import { chessRunQueue, ensureRunnableJob } from "@cockpit-chess/queue";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOr404Procedure, publicProcedure } from "../index";
import { chessStatsColumns } from "../lib/chess-stats";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { slugify } from "../lib/slug";

const summary = {
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
  contextMode: true,
  identityMode: true,
} satisfies Prisma.ChessMatchSelect;
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
function checkedArchive(input: unknown, status?: string, replay = false) {
  try {
    const archive = replay ? validateArchive(input) : archiveSchema.parse(input);
    if (status === "stopped") {
      archive.status = "stopped";
      archive.result = "*";
      archive.termination = "cancelled";
    }
    if (status === "error" && archive.status === "running") {
      archive.status = "error";
      archive.result = "*";
      archive.termination = "interrupted";
    }
    return archive;
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Invalid chess archive" });
  }
}
const ownDraftSelect = {
  id: true,
  archive: true,
  status: true,
  source: true,
  published: true,
} satisfies Prisma.ChessMatchSelect;
const ownIdSelect = { id: true } satisfies Prisma.ChessMatchSelect;
async function ownDraft<S extends typeof ownDraftSelect | typeof ownIdSelect>(
  slug: string,
  ownerId: string,
  select: S,
) {
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
  whiteCostMicros: true,
  blackCostMicros: true,
  moveFormat: true,
} satisfies Prisma.ChessMatchSelect;
const isP2002 = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
export const chessRouter = {
  info: publicProcedure.handler(() => ({
    hostedEnabled: env.CHESS_HOSTED_ENABLED,
    models: ["openai/gpt-4.1-nano", "openai/gpt-4.1-mini", "anthropic/claude-haiku-4.5"],
    format: "cockpit-chess/v1",
  })),
  list: publicProcedure.input(cursorPageInput).handler(async ({ input }) => {
    const rows = await prisma.chessMatch.findMany({
      where: withCursor({ published: true }, "createdAt", input.cursor, "desc"),
      select: summary,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
    });
    return cursorPage(rows, input.limit, "createdAt");
  }),
  get: publicProcedure.input(slugInput).handler(async ({ input }) => {
    const row = await prisma.chessMatch.findFirst({
      where: { slug: input.slug, published: true },
      select: { ...summary, archive: true },
    });
    if (!row) throw new ORPCError("NOT_FOUND");
    return { ...row, archive: checkedArchive(row.archive, row.status) };
  }),
  studio: adminOr404Procedure.input(cursorPageInput).handler(async ({ input, context }) => {
    const rows = await prisma.chessMatch.findMany({
      where: withCursor({ ownerId: context.session.user.id }, "createdAt", input.cursor, "desc"),
      select: summary,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(input.limit),
    });
    return cursorPage(rows, input.limit, "createdAt");
  }),
  inspect: adminOr404Procedure.input(slugInput).handler(async ({ input, context }) => {
    const row = await ownDraft(input.slug, context.session.user.id, ownDraftSelect);
    return {
      archive: checkedArchive(row.archive, row.status),
      status: row.status,
      published: row.published,
    };
  }),
  create: adminOr404Procedure.input(matchConfigSchema).handler(async ({ input, context }) => {
    if (!env.CHESS_HOSTED_ENABLED)
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Hosted inference is disabled" });
    if ([input.white, input.black].some((player) => player.protocol === "human"))
      throw new ORPCError("BAD_REQUEST");
    if (
      input.rules.costBudgetMicros > 1000000 ||
      input.rules.maxPlies > 200 ||
      input.rules.tokenBudget > 1000000
    )
      throw new ORPCError("BAD_REQUEST", { message: "Hosted match exceeds the operator limits" });
    if (
      [input.white, input.black].some((player) => player.protocol !== "random") &&
      !env.OPENROUTER_API_KEY
    )
      throw new ORPCError("SERVICE_UNAVAILABLE");
    await spendBudget(context.session.user.id);
    const archive = createMatch(input, "hosted");
    const slug = `${slugify(input.title).slice(0, 110) || "match"}-${archive.id.slice(0, 8)}`;
    const row = await prisma.chessMatch.create({
      data: {
        ...metadata(archive),
        ownerId: context.session.user.id,
        slug,
        status: "queued",
        official: true,
        published: false,
        heartbeatAt: new Date(),
        archive,
      },
      select: { id: true },
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
        data: { status: "error" },
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
  publish: adminOr404Procedure
    .input(slugInput.extend({ published: z.boolean() }))
    .handler(async ({ input, context }) => {
      const row = await ownDraft(input.slug, context.session.user.id, ownIdSelect);
      await prisma.chessMatch.update({
        where: { id: row.id },
        data: { published: input.published },
        select: { id: true },
      });
      return { published: input.published };
    }),
  stop: adminOr404Procedure.input(slugInput).handler(async ({ input, context }) => {
    const row = await ownDraft(input.slug, context.session.user.id, ownIdSelect);
    await prisma.chessMatch.updateMany({
      where: { id: row.id, status: { in: ["queued", "running"] } },
      // Leave the last durable event snapshot intact: a read-modify-write here
      // could erase a move persisted between the lookup and cancellation.
      data: { status: "stopped", runToken: null },
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
            cost: row.whiteCostMicros,
          },
          {
            win: "0-1",
            model: blackModel,
            protocol: blackProtocol,
            illegal: blackIllegal,
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
            estimatedCostMicros: 0,
          };
          record.games += 1;
          if (result === "1/2-1/2") record.draws += 1;
          else if (result === side.win) record.wins += 1;
          else record.losses += 1;
          record.illegalAttempts += side.illegal;
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
