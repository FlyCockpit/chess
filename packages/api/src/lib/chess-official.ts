import { createHash } from "node:crypto";
import type { MatchArchive } from "@cockpit-chess/chess";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { cursorPageInput, decodeCursor, encodeCursor, pageTake } from "./pagination";

export const chessDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only server-created hosted model runs may enroll, independent of billing or publication. */
export function officialCommitment(match: MatchArchive, billingCohort: string) {
  const { white, black, prompt, rules, initialFen } = match.config;
  if (
    match.source !== "hosted" ||
    [white, black].some((p) => p.protocol === "human") ||
    [white, black].every((p) => p.protocol === "random") ||
    !["operator", "owner-openrouter"].includes(billingCohort)
  )
    throw new ORPCError("BAD_REQUEST", { message: "This match cannot be official" });
  const rulesKey = chessDigest(rules).slice(0, 16);
  const initialPositionHash = chessDigest(initialFen);
  const opponentType = [white, black].some((p) => p.protocol === "random")
    ? "model-v-random"
    : "model-v-model";
  return {
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    rulesKey,
    rules,
    initialFen,
    initialPositionHash,
    scopeKey: chessDigest([
      prompt.version,
      prompt.hash,
      rulesKey,
      initialPositionHash,
      billingCohort,
      opponentType,
    ]),
    billingCohort,
    opponentType,
    whiteModel: white.model,
    whiteProtocol: white.protocol,
    blackModel: black.model,
    blackProtocol: black.protocol,
    moveFormat: rules.moveFormat,
  } satisfies Prisma.ChessOfficialEntryUncheckedCreateWithoutMatchInput;
}

export const officialFilterInput = cursorPageInput.extend({
  rulesKey: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  promptVersion: z.string().max(32).optional(),
  initialPositionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  billingCohort: z.enum(["operator", "owner-openrouter"]).optional(),
  opponentType: z.enum(["model-v-model", "model-v-random"]).optional(),
});

export function officialFilter(input: z.infer<typeof officialFilterInput>) {
  return {
    ...(input.rulesKey ? { rulesKey: input.rulesKey } : {}),
    ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
    ...(input.initialPositionHash ? { initialPositionHash: input.initialPositionHash } : {}),
    ...(input.billingCohort ? { billingCohort: input.billingCohort } : {}),
    ...(input.opponentType ? { opponentType: input.opponentType } : {}),
  } satisfies Prisma.ChessOfficialEntryWhereInput;
}

const count = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const aggregateRow = z.object({
  scopeKey: z.string(),
  model: z.string(),
  protocol: z.string(),
  rulesKey: z.string(),
  initialPositionHash: z.string(),
  promptVersion: z.string(),
  promptHash: z.string(),
  billingCohort: z.string(),
  opponentType: z.string(),
  moveFormat: z.string(),
  games: count,
  wins: count,
  draws: count,
  losses: count,
  withdrawals: count,
  pending: count,
  providerErrors: count,
  accountErrors: count,
  infrastructureErrors: count,
  illegalAttempts: count,
  truncatedAttempts: count,
  estimatedCostMicros: count.nullable(),
});

/**
 * Aggregate every committed start in PostgreSQL, never an archive/recent-game scan.
 * Pages use stable comparison-group IDs, not a fluctuating score as a cursor.
 * Score is earned points / all starts; callers must not advertise a global rank
 * across different settings or hide pending/withdrawn/failed starts.
 */
export async function officialLeaderboard(input: z.infer<typeof officialFilterInput>) {
  const filter = officialFilter(input);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  // pagination:audited — database aggregation over all starts, output bounded by pageTake.
  const raw = await prisma.$queryRaw`
    WITH entries AS (
      SELECT * FROM "chess_official_entry" WHERE
        (${input.rulesKey ?? null}::text IS NULL OR "rulesKey" = ${input.rulesKey ?? null})
        AND (${input.promptVersion ?? null}::text IS NULL OR "promptVersion" = ${input.promptVersion ?? null})
        AND (${input.initialPositionHash ?? null}::text IS NULL OR "initialPositionHash" = ${input.initialPositionHash ?? null})
        AND (${input.billingCohort ?? null}::text IS NULL OR "billingCohort" = ${input.billingCohort ?? null})
        AND (${input.opponentType ?? null}::text IS NULL OR "opponentType" = ${input.opponentType ?? null})
    ), sides AS (
      SELECT e.*, s.model, s.protocol, s.win, s.illegal, s.truncated, s.cost,
        md5(e."scopeKey" || ':' || s.protocol || ':' || s.model) AS "groupKey"
      FROM entries e CROSS JOIN LATERAL (
        VALUES (e."whiteModel", e."whiteProtocol", '1-0', e."whiteIllegal", e."whiteTruncated", e."whiteCostMicros"),
               (e."blackModel", e."blackProtocol", '0-1', e."blackIllegal", e."blackTruncated", e."blackCostMicros")
      ) s(model, protocol, win, illegal, truncated, cost)
      WHERE s.protocol <> 'random'
    )
    SELECT "groupKey" AS "scopeKey", model, protocol, "rulesKey", "initialPositionHash",
      "promptVersion", "promptHash", "billingCohort", "opponentType", "moveFormat",
      count(*) AS games,
      count(*) FILTER (WHERE state = 'scored' AND result = win) AS wins,
      count(*) FILTER (WHERE state = 'scored' AND result = '1/2-1/2') AS draws,
      count(*) FILTER (WHERE state = 'scored' AND result NOT IN (win, '1/2-1/2')) AS losses,
      count(*) FILTER (WHERE state = 'withdrawal') AS withdrawals,
      count(*) FILTER (WHERE state = 'pending') AS pending,
      count(*) FILTER (WHERE state = 'provider-error') AS "providerErrors",
      count(*) FILTER (WHERE state = 'account-error') AS "accountErrors",
      count(*) FILTER (WHERE state = 'infrastructure-error') AS "infrastructureErrors",
      coalesce(sum(illegal), 0) AS "illegalAttempts",
      coalesce(sum(truncated), 0) AS "truncatedAttempts",
      CASE WHEN count(cost) = count(*) THEN sum(cost) ELSE NULL END AS "estimatedCostMicros"
    FROM sides
    WHERE "groupKey" > ${cursor?.id ?? ""}
    GROUP BY "groupKey", model, protocol, "rulesKey", "initialPositionHash",
      "promptVersion", "promptHash", "billingCohort", "opponentType", "moveFormat"
    ORDER BY "groupKey" ASC LIMIT ${pageTake(input.limit)}
  `;
  const rows = z.array(aggregateRow).parse(raw);
  const more = rows.length > input.limit;
  const items = rows.slice(0, input.limit).map((row) => ({
    ...row,
    points: row.wins + row.draws / 2,
    score: (row.wins + row.draws / 2) / row.games,
  }));
  const last = items.at(-1);
  const sampleSize = await prisma.chessOfficialEntry.count({ where: filter });
  return {
    items,
    sampleSize,
    nextCursor: more && last ? encodeCursor({ id: last.scopeKey, sortValue: new Date(0) }) : null,
  };
}
