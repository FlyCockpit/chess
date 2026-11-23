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
