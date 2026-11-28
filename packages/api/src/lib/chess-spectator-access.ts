import { Prisma } from "@cockpit-chess/db";
import type { ChessSpectatorAccess } from "@cockpit-chess/queue";
import { publicReplayWhere } from "./chess-visibility";

/** All server engine backfills are hosted-only; runners supply their own scores. */
export function spectatorAccessWhere(access: ChessSpectatorAccess): Prisma.ChessMatchWhereInput {
  if (access.purpose === "public")
    return { ...publicReplayWhere, source: "hosted", moderationVersion: access.version };
  return {
    source: "hosted",
    ownerId: access.ownerId,
    Owner: {
      is: {
        deletionRequestedAt: null,
        OR: [{ banned: null }, { banned: false }, { banExpires: { lte: new Date() } }],
      },
    },
  };
}

/** Same authority as the read predicate, evaluated atomically by the JSON merge write. */
export function spectatorAccessSql(access: ChessSpectatorAccess): Prisma.Sql {
  const activeOwner = Prisma.sql`EXISTS (SELECT 1 FROM "user" AS u WHERE u."id" = "chess_match"."ownerId" AND u."deletionRequestedAt" IS NULL AND (u."banned" IS NOT TRUE OR u."banExpires" <= CURRENT_TIMESTAMP))`;
  if (access.purpose === "owner")
    return Prisma.sql`"source" = 'hosted' AND "ownerId" = ${access.ownerId} AND ${activeOwner}`;
  return Prisma.sql`"source" = 'hosted' AND "published" = true AND "hiddenAt" IS NULL AND "moderationVersion" = ${access.version} AND (("ownerId" IS NULL AND "slug" ~ '^replay-[a-f0-9]{32}$') OR EXISTS (SELECT 1 FROM "user" AS u WHERE u."id" = "chess_match"."ownerId" AND u."deletionRequestedAt" IS NULL))`;
}
