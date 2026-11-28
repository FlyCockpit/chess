import prisma, { type Prisma } from "@cockpit-chess/db";
import { isAccountDeletionPending } from "./account-state.js";
import { isUserBanned } from "./ban.js";
import { lockCliCredentials } from "./device-redemption-lock.js";
import { withLockSlot } from "./lock-slots.js";
import { isAdminRole } from "./roles.js";

/** A stored operator-funded game never acquires another funding source. */
export class OperatorFundingRevokedError extends Error {
  constructor() {
    super("Operator billing requires an admin owner");
    this.name = "OperatorFundingRevokedError";
  }
}

/** Shared durable account authority; absence and storage failure both fail closed. */
export async function isOwnerActive(userId: string): Promise<boolean> {
  try {
    return await ownerActiveInTransaction(prisma, userId);
  } catch {
    return false;
  }
}

/** Caller may already hold the credential lock; never query through another client. */
export async function ownerActiveInTransaction(
  db: Pick<Prisma.TransactionClient, "user">,
  userId: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { deletionRequestedAt: true, banned: true, banExpires: true },
  });
  return !!user && !isAccountDeletionPending(user) && !isUserBanned(user);
}

/**
 * Serialize actual provider request admission with deletion. Operator-funded
 * requests also hold SHARE on the owner row, conflicting with every role UPDATE
 * until HTTP headers arrive. Keep credential -> user-row order: role mutations
 * must not acquire a second user's credential lock (reciprocal admin writes).
 * The request begins
 * while the same CLI-credential lock as the tombstone is held. Waiting for headers
 * keeps the critical section bounded by the existing provider abort/deadline; a
 * transaction timeout may release it, but no new request can then begin here.
 * The caller's synchronous lease/signal checks belong INSIDE dispatch.
 */
export function dispatchForActiveOwner(
  userId: string,
  dispatch: () => Promise<Response>,
  funding?: "operator",
): Promise<Response> {
  return withLockSlot(() =>
    prisma.$transaction(
      async (tx) => {
        const deadline = performance.now() + 25_000;
        await tx.$executeRaw`SELECT set_config('statement_timeout', '25000ms', true)`;
        await lockCliCredentials(userId, tx);
        if (funding === "operator") {
          await tx.$executeRaw`SELECT id FROM "user" WHERE id = ${userId} FOR SHARE`;
          const owner = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
          if (!owner || !isAdminRole(owner.role)) throw new OperatorFundingRevokedError();
        }
        if (!(await ownerActiveInTransaction(tx, userId)) || performance.now() >= deadline)
          throw new Error("Account authority is no longer active");
        return dispatch();
      },
      { isolationLevel: "ReadCommitted", timeout: 30_000 },
    ),
  );
}
