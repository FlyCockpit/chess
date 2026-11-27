import { isUserBanned } from "@cockpit-chess/auth/ban";
import { hasRole } from "@cockpit-chess/auth/roles";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { ORPCError } from "@orpc/server";

/**
 * "Admin" here means the same thing as `isAdminRole` in
 * packages/auth/src/roles.ts: the comma-separated `User.role` string holds an
 * `admin` token, case- and whitespace-insensitive. The SQL below mirrors that
 * so a multi-role value such as `"user, Admin"` counts, while `"superadmin"`
 * does not. The `ILIKE` prefilter only narrows the scan; the token match
 * decides.
 */

/**
 * Whether any user holds the admin role. Pass a transaction client to read
 * inside it (./admin-bootstrap.ts does, under its lock).
 */
export async function adminUserExists(
  db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "user" u
      WHERE u.role ILIKE '%admin%'
        AND EXISTS (
          SELECT 1 FROM unnest(string_to_array(u.role, ',')) AS r(token)
          WHERE r.token ~* '^\\s*admin\\s*$'
        )
    ) AS "exists"`;
  return rows[0]?.exists === true;
}

/**
 * Admins who can still sign in: the same token match as adminUserExists,
 * excluding unverified accounts and current bans/archives (isUserBanned).
 * Expired bans are active.
 * Role-change guards must read this fresh inside their transaction.
 */
export async function activeAdminUserCount(
  db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma,
  now = new Date(),
): Promise<number> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS "count" FROM "user" u
    WHERE u.role ILIKE '%admin%'
      AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(u.role, ',')) AS r(token)
        WHERE r.token ~* '^\\s*admin\\s*$'
      )
      AND u."emailVerified" IS TRUE
      AND (u.banned IS NOT TRUE OR u."banExpires" <= ${now})`;
  return rows[0]?.count ?? 0;
}

const ADMIN_REMOVAL_SELECT = {
  id: true,
  role: true,
  emailVerified: true,
  banned: true,
  banExpires: true,
} satisfies Prisma.UserSelect;

type AdminRemovalTarget = Prisma.UserGetPayload<{ select: typeof ADMIN_REMOVAL_SELECT }>;

/**
 * Every admin-removing write shares this transaction: read the target, count
 * usable admins, then mutate. Serializable isolation prevents write skew when
 * two admins concurrently demote, archive, or delete each other. nextRole is
 * supplied for role writes; omitting it means archive/delete.
 */
export async function withAdminRemovalGuard<T>(
  userId: string,
  mutate: (tx: Prisma.TransactionClient, target: AdminRemovalTarget) => Promise<T>,
  nextRole?: string,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: userId },
          select: ADMIN_REMOVAL_SELECT,
        });
        if (!target) {
          throw new ORPCError("NOT_FOUND", {
            message: "User not found",
            data: { reason: "USER_NOT_FOUND" },
          });
        }
        if (
          !hasRole(nextRole, "admin") &&
          hasRole(target.role, "admin") &&
          target.emailVerified &&
          !isUserBanned(target) &&
          (await activeAdminUserCount(tx)) <= 1
        ) {
          throw new ORPCError("FORBIDDEN", {
            message:
              "You cannot remove the last active admin. Make another verified, active user an admin first.",
            data: { reason: "LAST_ACTIVE_ADMIN" },
          });
        }
        return mutate(tx, target);
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034") {
      throw new ORPCError("CONFLICT", {
        message: "Another user change happened at the same time. Review the users and try again.",
        data: { reason: "USER_CHANGE_CONFLICT" },
      });
    }
    throw error;
  }
}

/**
 * How long a "yes, an admin exists" answer is reused by
 * {@link adminExistsForAppConfig}. Only the positive answer is cached.
 */
const ADMIN_PRESENCE_TTL_MS = 60_000;

let adminKnownUntil = 0;

/**
 * {@link adminUserExists} for the public `appConfig` procedure, which the
 * sign-in and sign-up pages and the header's account controls ask: once an
 * admin exists the answer is reused for a minute, so an established server
 * does not run this query per page view. "No admin yet" is never cached: that
 * is the bootstrap state, where the operator must see the way in the moment it
 * applies, and it flips to "closed" on the first call after the first admin is
 * created. A demoted or deleted last admin re-opens bootstrap within the TTL.
 *
 * Never use this for an authorization decision; `admin-bootstrap.ts` reads
 * {@link adminUserExists} fresh, inside its lock.
 */
export async function adminExistsForAppConfig(now = Date.now()): Promise<boolean> {
  if (now < adminKnownUntil) return true;
  const exists = await adminUserExists();
  adminKnownUntil = exists ? now + ADMIN_PRESENCE_TTL_MS : 0;
  return exists;
}

/** Forget the cached answer (tests). */
export function resetAdminPresenceCache(): void {
  adminKnownUntil = 0;
}
