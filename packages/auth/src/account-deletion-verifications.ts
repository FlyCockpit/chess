import type { Prisma } from "@cockpit-chess/db";

/**
 * Physical erasure of the current non-FK authentication records. Call while the
 * owner's credential/setup locks are held, BEFORE deleting their machines.
 * A full page means the caller must retry; failures must keep deletion pending.
 *
 * Better Auth 1.7.18 stores email verification in a user-id-bound signed JWT,
 * not a Verification row. Unbound OAuth sign-in state has no account identity.
 * Database-backed account-link state does, under auth-state:<nonce>.
 */
export async function deleteAccountVerifications(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  user: { id: string; email: string },
): Promise<number> {
  return tx.$executeRaw`
    WITH "challenges" AS MATERIALIZED (
      SELECT "identifier" FROM "verification"
      WHERE "value" = ${user.id} AND starts_with("identifier", '2fa-')
    ), "structured" AS MATERIALIZED (
      SELECT "id", "identifier",
        CASE WHEN pg_input_is_valid("value", 'jsonb') THEN "value"::jsonb ELSE NULL END AS data
      FROM "verification"
      WHERE starts_with("identifier", 'reset-password-mailed:')
         OR starts_with("identifier", 'runner-limits:v1:')
         OR starts_with("identifier", 'runner-limit-proof:v1:')
         OR starts_with("identifier", 'auth-state:')
    ), "victims" AS MATERIALIZED (
      SELECT v."id"
      FROM "verification" v
      LEFT JOIN "structured" s ON s."id" = v."id"
      WHERE (
        v."value" = ${user.id} AND (
          starts_with(v."identifier", 'reset-password:')
          OR starts_with(v."identifier", '2fa-')
          OR starts_with(v."identifier", 'trust-device-')
          OR starts_with(v."identifier", 'delete-account-')
          OR starts_with(v."identifier", 'runner-limit-totp:v1:')
        )
      ) OR v."identifier" IN (
        SELECT '2fa-otp-' || "identifier" FROM "challenges"
        UNION ALL
        SELECT '2fa-attempts-' || "identifier" FROM "challenges"
      ) OR starts_with(v."identifier", '2fa-otp-' || ${user.id} || '!')
      OR (
        starts_with(s."identifier", 'reset-password-mailed:')
        AND (s.data->>'userId' = ${user.id} OR lower(s.data->>'email') = ${user.email.toLowerCase()})
      ) OR (
        (starts_with(s."identifier", 'runner-limits:v1:')
         OR starts_with(s."identifier", 'runner-limit-proof:v1:'))
        AND (
          s.data->>'userId' = ${user.id}
          OR s.data->>'sessionId' IN (SELECT "id" FROM "session" WHERE "userId" = ${user.id})
          OR s.data->>'machineId' IN (SELECT "id" FROM "runner_machine" WHERE "userId" = ${user.id})
        )
      ) OR (
        starts_with(v."identifier", 'runner-limits:v1:')
        AND v."identifier" IN (
          SELECT 'runner-limits:v1:' || "id" FROM "runner_machine" WHERE "userId" = ${user.id}
        )
      ) OR (
        starts_with(s."identifier", 'auth-state:')
        AND (s.data->'link'->>'userId' = ${user.id}
             OR lower(s.data->'link'->>'email') = ${user.email.toLowerCase()})
      )
      -- Remove challenge children before their lookup anchor across page boundaries.
      ORDER BY (v."value" = ${user.id} AND starts_with(v."identifier", '2fa-')) ASC, v."id" ASC
      LIMIT 100
    )
    DELETE FROM "verification" WHERE "id" IN (SELECT "id" FROM "victims")`;
}
