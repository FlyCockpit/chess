import type { Prisma } from "@cockpit-chess/db";

/** Public transcript authority, shared by cards, replay, export, visibility and work admission. */
export const publicReplayWhere = {
  published: true,
  hiddenAt: null,
  OR: [{ ownerId: null }, { Owner: { is: { deletionRequestedAt: null } } }],
} satisfies Prisma.ChessMatchWhereInput;
