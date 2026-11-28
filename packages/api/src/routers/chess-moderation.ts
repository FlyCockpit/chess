import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { ownerActiveInTransaction } from "@cockpit-chess/auth/account-deletion";
import {
  lockCliCredentials,
  withCliCredentialLockSlot,
} from "@cockpit-chess/auth/device-redemption-lock";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Context } from "../context";
import { adminOr404Procedure, publicProcedure } from "../index";
import { assertLiveMutationActor } from "../lib/admin-presence";
import { neutralArchiveId } from "../lib/chess-anonymization";
import { publicReplayWhere } from "../lib/chess-visibility";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import { entityId } from "../lib/schemas";

const reportReason = z.enum(["privacy", "harassment", "illegal_content", "spam", "other"]);
const decisionReason = z.enum([
  "privacy",
  "harassment",
  "illegal_content",
  "spam",
  "other",
  "no_violation",
]);
const slugInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(180)
      .regex(/^[a-z0-9-]+$/),
  })
  .strict();
const note = z.string().trim().max(1000);
const reportInput = slugInput.extend({ reason: reportReason, note: note.optional() }).strict();
const decisionInput = z
  .object({ id: entityId, hidden: z.boolean(), reason: decisionReason, note: note.min(1) })
  .strict()
  .refine((input) => !input.hidden || input.reason !== "no_violation");

const consumeReportIp = createProcedureBudget({
  keyPrefix: "rl:chess-report-ip",
  points: 10,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: () => "Too many reports. Please try again later.",
  unavailableMessage: "Reporting is temporarily unavailable. Please try again later.",
  unavailableLog: "[chess] report IP limiter unavailable, failing closed:",
});
const consumeReportMatchIp = createProcedureBudget({
  keyPrefix: "rl:chess-report-match-ip",
  points: 3,
  durationSeconds: 86_400,
  failClosed: true,
  overBudgetMessage: () => "Too many reports for this replay. Please try again later.",
  unavailableMessage: "Reporting is temporarily unavailable. Please try again later.",
  unavailableLog: "[chess] report replay limiter unavailable, failing closed:",
});
const consumeModeration = createProcedureBudget({
  keyPrefix: "rl:chess-moderation",
  points: 120,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: () => "Too many moderation changes. Please try again later.",
  unavailableMessage: "Moderation is temporarily unavailable. Please try again later.",
  unavailableLog: "[chess] moderation limiter unavailable, failing closed:",
});

/** Domain-separated hashes avoid storing raw addresses or correlating reporter identities across days. */
function digest(purpose: string, ...values: string[]) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(JSON.stringify(["chess-replay-moderation/v1", purpose, ...values]))
    .digest("hex");
}

const visibilitySelect = {
  id: true,
  slug: true,
  ownerId: true,
  moderationVersion: true,
  updatedAt: true,
} satisfies Prisma.ChessMatchSelect;
const statementSelect = {
  id: true,
  hiddenAt: true,
  moderationReason: true,
  moderationNote: true,
  moderationVersion: true,
} satisfies Prisma.ChessMatchSelect;
const moderationSelect = {
  ...statementSelect,
  slug: true,
  title: true,
  createdAt: true,
  published: true,
  Reports: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: { id: true, createdAt: true, reason: true, note: true, reviewedAt: true },
  },
  ModerationActions: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: { id: true, createdAt: true, hidden: true, reason: true, note: true },
  },
  _count: { select: { Reports: true } },
} satisfies Prisma.ChessMatchSelect;

/** The shared actor fence locks live account/session rows and reuses canonical admin policy. */
async function liveAdmin(tx: Prisma.TransactionClient, context: Context) {
  const session = context.session;
  if (!session) throw new ORPCError("NOT_FOUND");
  await assertLiveMutationActor(tx, session.user.id, {
    kind: "admin",
    userId: session.user.id,
    sessionId: session.session.id,
    credential: context.credential,
  });
}

export const chessModerationRouter = {
  /** Lightweight finished-replay refresh: never fetches a transcript or triggers an engine job. */
  visibility: publicProcedure.input(slugInput).handler(async ({ input }) => {
    const row = await prisma.chessMatch.findFirst({
      where: { ...publicReplayWhere, slug: input.slug },
      select: visibilitySelect,
    });
    if (!row || (row.ownerId === null && !neutralArchiveId(row.slug)))
      throw new ORPCError("NOT_FOUND");
    return { version: row.moderationVersion, updatedAt: row.updatedAt };
  }),

  /** Anonymous and signed-in notices share one IP budget and replay/day dedup identity. */
  report: publicProcedure.input(reportInput).handler(async ({ input, context }) => {
    if (!context.clientIp || !isIP(context.clientIp)) throw new ORPCError("SERVICE_UNAVAILABLE");
    const day = new Date().toISOString().slice(0, 10);
    const ipIdentity = digest("daily-ip", day, context.clientIp);
    const budgetIdentity = digest("budget-ip", context.clientIp);
    await consumeReportIp(budgetIdentity);
    await consumeReportMatchIp(digest("match-ip-budget", input.slug, budgetIdentity));
    return withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        const reporterId = context.session?.user.id;
        if (reporterId) await lockCliCredentials(reporterId, tx);
        let retainedReporter: string | null = null;
        if (reporterId) {
          await tx.$executeRaw`
            SELECT u.id FROM "user" u JOIN "session" s ON s."userId" = u.id
            WHERE u.id = ${reporterId} AND s.id = ${context.session?.session.id}
            FOR SHARE OF u, s`;
          if (!(await ownerActiveInTransaction(tx, reporterId)))
            throw new ORPCError("UNAUTHORIZED");
          const liveSession = await tx.session.findFirst({
            where: {
              id: context.session?.session.id,
              userId: reporterId,
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          });
          if (!liveSession) throw new ORPCError("UNAUTHORIZED");
          retainedReporter = reporterId;
        }
        // Locking the target serializes visibility checks with hide/unpublish and physical deletion.
        await tx.$queryRaw`SELECT "id" FROM "chess_match" WHERE "slug" = ${input.slug} FOR UPDATE`;
        const row = await tx.chessMatch.findFirst({
          where: { ...publicReplayWhere, slug: input.slug },
          select: visibilitySelect,
        });
        if (!row || (row.ownerId === null && !neutralArchiveId(row.slug)))
          throw new ORPCError("NOT_FOUND");
        // Empty update preserves the first notice: retries cannot overwrite a reviewed report or notes.
        await tx.chessReplayReport.upsert({
          where: { dedupKey: digest("notice", row.id, ipIdentity) },
          create: {
            matchId: row.id,
            reporterId: retainedReporter,
            dedupKey: digest("notice", row.id, ipIdentity),
            reason: input.reason,
            note: input.note || null,
          },
          update: {},
          select: { id: true },
        });
        return { accepted: true as const };
      }),
    );
  }),

  list: adminOr404Procedure
    .input(
      cursorPageInput
        .extend({ status: z.enum(["reported", "hidden", "all"]).default("reported") })
        .strict(),
    )
    .handler(async ({ input, context }) => {
      const where: Prisma.ChessMatchWhereInput =
        input.status === "hidden"
          ? { hiddenAt: { not: null } }
          : input.status === "reported"
            ? { Reports: { some: { reviewedAt: null } } }
            : { OR: [{ Reports: { some: {} } }, { ModerationActions: { some: {} } }] };
      return withCliCredentialLockSlot(() =>
        prisma.$transaction(async (tx) => {
          await lockCliCredentials(context.session.user.id, tx);
          await liveAdmin(tx, context);
          const rows = await tx.chessMatch.findMany({
            where: withCursor(where, "createdAt", input.cursor, "desc"),
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: pageTake(input.limit),
            select: moderationSelect,
          });
          await liveAdmin(tx, context);
          return cursorPage(rows, input.limit, "createdAt");
        }),
      );
    }),

  setHidden: adminOr404Procedure.input(decisionInput).handler(async ({ input, context }) => {
    await consumeModeration(context.session.user.id);
    return withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        await lockCliCredentials(context.session.user.id, tx);
        await liveAdmin(tx, context);
        await tx.$queryRaw`SELECT "id" FROM "chess_match" WHERE "id" = ${input.id} FOR UPDATE`;
        const row = await tx.chessMatch.findUnique({
          where: { id: input.id },
          select: { id: true },
        });
        if (!row) throw new ORPCError("NOT_FOUND");
        const now = new Date();
        const decision = await tx.chessMatch.update({
          where: { id: row.id },
          data: {
            hiddenAt: input.hidden ? now : null,
            moderationReason: input.reason,
            moderationNote: input.note,
            moderationVersion: { increment: 1 },
          },
          select: statementSelect,
        });
        await tx.chessModerationAction.create({
          data: {
            matchId: row.id,
            actorId: context.session.user.id,
            hidden: input.hidden,
            reason: input.reason,
            note: input.note,
          },
          select: { id: true },
        });
        await tx.chessReplayReport.updateMany({
          where: { matchId: row.id, reviewedAt: null },
          data: { reviewedAt: now },
        });
        return decision;
      }),
    );
  }),
};
