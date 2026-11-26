import prisma, { type Prisma } from "@cockpit-chess/db";

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
