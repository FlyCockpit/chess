import prisma, { type Prisma } from "@cockpit-chess/db";
import { BASE_ERROR_CODES, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { ownerActiveInTransaction } from "./account-deletion.js";
import { revokeCredentialsAfterPasswordReset } from "./credential-revocation.js";
import { lockCliCredentials } from "./device-redemption-lock.js";
import { withLockSlot } from "./lock-slots.js";
import { admitResetSpend } from "./password-reset-links.js";
import {
  assertPasswordWriteLocked,
  isResetPasswordWrite,
  passwordWriteLockKey,
} from "./password-write-lock.js";
import {
  deleteResetLinks,
  lockSetPasswordLinks,
  RESET_PASSWORD_IDENTIFIER_PREFIX,
} from "./set-password-link-lock.js";
import { clearPendingInvitePassword } from "./sso-invite-activation.js";
import { authorizeAdminInvite, getAllowedUserCreationMode } from "./user-creation-policy.js";

type Adapter = ReturnType<ReturnType<typeof prismaAdapter>>;

/** One client, one acyclic order. No separate/nested lock connection. */
async function lockActivation(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passwordWriteLockKey(userId)}))`;
  await lockCliCredentials(userId, tx);
  await lockSetPasswordLinks(userId, tx);
  if (!(await ownerActiveInTransaction(tx, userId))) throw new APIError("UNAUTHORIZED");
}

/**
 * Global transactions stay OFF. Only the reset's existing adapter transaction
 * is real. Verification writes, IdP inserts and token updates use short local transactions;
 * signup locale reads, SMTP and callback network work never sit inside one.
 */
export function createCredentialSetupAdapter(database = prisma) {
  return (options: BetterAuthOptions): Adapter => {
    const make = (client: typeof prisma | Prisma.TransactionClient) =>
      prismaAdapter(client, { provider: "postgresql" })(options);
    const bind = (inner: Adapter, tx?: Prisma.TransactionClient): Adapter => {
      const verificationWrite = async <T>(
        args: Parameters<Adapter["update"]>[0],
        write: (adapter: Adapter) => Promise<T>,
      ): Promise<T> => {
        // /verify-email uses updateUserByEmail; IdP activation uses id.
        // Email is immutable. Require scalar, case-sensitive equality before
        // lookup, locks or writes: one selector must identify exactly one user.
        if (
          args.where.length !== 1 ||
          !["id", "email"].includes(args.where[0]!.field) ||
          (args.where[0]!.operator && args.where[0]!.operator !== "eq") ||
          args.where[0]!.mode === "insensitive" ||
          typeof args.where[0]!.value !== "string"
        ) {
          throw new Error("Activation requires an exact user selector");
        }
        const target = await inner.findOne<{ id: string }>({ model: "user", where: args.where });
        if (!target) return write(inner);
        const userId = target.id;
        if (tx) {
          // Reset already holds password-write/credential; never reacquire them.
          await lockSetPasswordLinks(userId, tx);
          const result = await write(inner);
          await deleteResetLinks(userId, tx);
          return result;
        }
        return withLockSlot(() =>
          database.$transaction(async (client) => {
            await lockActivation(client, userId);
            const result = await write(make(client));
            await deleteResetLinks(userId, client);
            return result;
          }),
        );
      };
      /** Existing linked IdP callbacks update tokens before creating a session. */
      const idpAccountWrite = async <T>(
        args: Parameters<Adapter["update"]>[0],
        write: (adapter: Adapter) => Promise<T>,
      ): Promise<T> => {
        const selector = args.where[0];
        if (
          args.where.length !== 1 ||
          selector?.field !== "id" ||
          (selector.operator && selector.operator !== "eq") ||
          selector.mode === "insensitive" ||
          typeof selector.value !== "string"
        )
          throw new Error("IdP account updates require an exact account selector");
        type Binding = { userId: string; providerId: string; accountId: string; issuer?: string };
        const target = await inner.findOne<Binding>({
          model: "account",
          where: args.where,
        });
        if (!target) throw new APIError("UNAUTHORIZED");
        if (target.providerId === "credential") return write(inner);
        // Identity binding is not writable through token refresh/callback updates.
        const identityFields = ["userId", "providerId", "accountId", "issuer"] as const;
        if (identityFields.some((key) => key in args.update && args.update[key] !== target[key]))
          throw new Error("IdP account identity cannot change during token update");
        if (tx) throw new Error("IdP token updates cannot nest inside a reset transaction");
        return withLockSlot(() =>
          database.$transaction(
            async (client) => {
              await lockCliCredentials(target.userId, client);
              if (!(await ownerActiveInTransaction(client, target.userId)))
                throw new APIError("UNAUTHORIZED");
              const writer = make(client);
              const current = await writer.findOne<Binding>({
                model: "account",
                where: args.where,
              });
              if (!current || identityFields.some((key) => current[key] !== target[key]))
                throw new APIError("UNAUTHORIZED");
              return write(writer);
            },
            { isolationLevel: "ReadCommitted", timeout: 20_000 },
          ),
        );
      };
      return {
        ...inner,
        // BA consults this AFTER transaction failure to decide whether queued
        // hooks must run for writes that could not roll back. Advertise the
        // selective reset truth per request, without mutating shared options.
        options: inner.options && {
          ...inner.options,
          adapterConfig: {
            ...inner.options.adapterConfig,
            get transaction() {
              return isResetPasswordWrite() ? inner.transaction : false;
            },
          },
        },
        transaction: async (callback) => {
          if (tx || !isResetPasswordWrite()) return callback(bind(inner, tx));
          // The outer password-write holder reserved this nested slot before
          // opening its lock connection. Hooks flush after this returns/releases.
          return withLockSlot(() =>
            database.$transaction(async (client) => {
              return callback(bind(make(client), client));
            }),
          );
        },
        consumeOne: async (args) => {
          if (args.model.toLowerCase() !== "verification") return inner.consumeOne(args);
          const row = await inner.findOne<{ identifier: string; value: string }>({ ...args });
          if (row?.identifier.startsWith(RESET_PASSWORD_IDENTIFIER_PREFIX)) {
            if (!tx || !isResetPasswordWrite())
              throw new Error("Reset consumption requires its password transaction");
            assertPasswordWriteLocked();
            await lockCliCredentials(row.value, tx);
            if (
              !(await admitResetSpend(
                tx,
                row.identifier.slice(RESET_PASSWORD_IDENTIFIER_PREFIX.length),
              ))
            ) {
              throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_TOKEN);
            }
          }
          return inner.consumeOne(args);
        },
        update: async <T>(args: Parameters<Adapter["update"]>[0]): Promise<T | null> => {
          if (args.model.toLowerCase() === "account")
            return idpAccountWrite(args, (writer) => writer.update<T>(args));
          if (args.model.toLowerCase() !== "user" || args.update.emailVerified !== true)
            return inner.update<T>(args);
          return verificationWrite(args, (writer) => writer.update<T>(args));
        },
        updateMany: async (args) => {
          if (args.model.toLowerCase() === "account") {
            // Pinned Better Auth's updatePassword is the only bulk account writer.
            // Its password-write/reset hooks already own that authorization path.
            const credential = args.where.find((selector) => selector.field === "providerId");
            const user = args.where.find((selector) => selector.field === "userId");
            const account = args.where.find((selector) => selector.field === "accountId");
            const passwordWrite =
              args.where.length === 3 &&
              credential?.value === "credential" &&
              typeof user?.value === "string" &&
              account?.value === user.value &&
              args.where.every(
                (selector) =>
                  (!selector.operator || selector.operator === "eq") &&
                  selector.mode !== "insensitive" &&
                  (!selector.connector || selector.connector === "AND"),
              ) &&
              typeof args.update.password === "string" &&
              Object.keys(args.update).every((key) => key === "password" || key === "updatedAt");
            if (passwordWrite) return inner.updateMany(args);
            return idpAccountWrite(args, (writer) => writer.updateMany(args));
          }
          if (args.model.toLowerCase() !== "user" || args.update.emailVerified !== true)
            return inner.updateMany(args);
          return verificationWrite(args, (writer) => writer.updateMany(args));
        },
        create: async <T extends Record<string, unknown>, R = T>(args: {
          model: string;
          data: Omit<T, "id">;
          select?: string[];
          forceAllowId?: boolean;
        }): Promise<R> => {
          if (
            args.model.toLowerCase() === "user" &&
            getAllowedUserCreationMode() === "admin-invite"
          ) {
            if (tx) throw new Error("Admin invite cannot nest inside a reset transaction");
            return withLockSlot(() =>
              database.$transaction(
                async (client) => {
                  await authorizeAdminInvite(client);
                  return make(client).create<T, R>(args);
                },
                { isolationLevel: "ReadCommitted", timeout: 20_000 },
              ),
            );
          }
          if (args.model.toLowerCase() !== "account" || args.data.providerId === "credential")
            return inner.create<T, R>(args);
          if (tx) throw new Error("IdP linking cannot nest inside a reset transaction");
          const userId = args.data.userId;
          if (typeof userId !== "string") throw new Error("IdP link requires a user id");
          const { result, pending } = await withLockSlot(() =>
            database.$transaction(async (client) => {
              await lockActivation(client, userId);
              // Capture before account insertion or a subsequent verifying user write.
              const pending = await clearPendingInvitePassword(client, userId);
              const result = await make(client).create<T, R>(args);
              await deleteResetLinks(userId, client);
              return { result, pending };
            }),
          );
          // Credential fingerprints now see null. Sweep rows inserted while the
          // clearing transaction was uncommitted, before BA mints the IdP session.
          if (pending) await revokeCredentialsAfterPasswordReset(userId);
          return result;
        },
      };
    };
    return bind(make(database));
  };
}
