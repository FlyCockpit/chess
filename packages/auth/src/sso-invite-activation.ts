import type { Prisma } from "@cockpit-chess/db";
import { revokeCredentialsInTransaction } from "./credential-revocation.js";
import { inviteStateSelect, isInvitePending } from "./password-reset-links.js";

/** Called under password-write -> credential -> setup, BEFORE the IdP insert. */
export async function clearPendingInvitePassword(tx: Prisma.TransactionClient, userId: string) {
  const state = await tx.user.findUnique({
    where: { id: userId },
    select: inviteStateSelect(new Date()),
  });
  if (!state || !isInvitePending(state)) return false;
  await tx.account.updateMany({
    where: { userId, providerId: "credential" },
    data: { password: null },
  });
  await revokeCredentialsInTransaction(tx, userId);
  return true;
}
