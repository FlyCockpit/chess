import { randomBytes } from "node:crypto";
import { auth } from "@cockpit-chess/auth";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import { withCliCredentialSnapshotLock } from "@cockpit-chess/auth/device-redemption-lock";
import {
  inviteStateSelect,
  isInvitePending,
  recordResetLinkMailed,
} from "@cockpit-chess/auth/password-reset-links";
import { revokeRunnerMachinesInTransaction } from "@cockpit-chess/auth/runner-machine";
import { runWithAllowedUserCreation } from "@cockpit-chess/auth/user-creation-policy";
import { SUPPORTED_LOCALES } from "@cockpit-chess/config/locales";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { isEmailConfigured, renderInviteUser, sendEmail } from "@cockpit-chess/mailer";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOr404Procedure } from "../index";
import { withAdminRemovalGuard } from "../lib/admin-presence";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";
import {
  createSetPasswordLink,
  INVITE_LINK_TTL_DAYS,
  SetPasswordLinkRefusedError,
} from "../lib/set-password-link";

// Roles surfaced in the admin UI. Better-auth itself stores `role` as a free-
// form string (and supports comma-separated lists), but the admin dashboard
// only ever assigns one of these two — anything else came from custom code or
// a database edit and we leave it untouched.
const ASSIGNABLE_ROLES = ["user", "admin"] as const;
const assignableRoleSchema = z.enum(ASSIGNABLE_ROLES);

const userIdInput = z.object({ userId: z.string().min(1) });

const userStatusFilter = z.enum(["all", "active", "archived"]);

function generateUnusablePassword(): string {
  // 48 random bytes, discarded right after hashing: a credential nobody holds.
  return randomBytes(48).toString("base64url");
}

/**
 * Thrown by `resendInvite` (409) when the user is not a pending invite. The
 * admin UI shows its own copy for it and refreshes the list.
 */
const INVITE_NOT_PENDING = "INVITE_NOT_PENDING";

function inviteNotPending() {
  return new ORPCError(INVITE_NOT_PENDING, {
    status: 409,
    message:
      "This user has already set up their account or signs in another way, so there is no invite to resend.",
  });
}

function inviteeArchived() {
  return new ORPCError("BAD_REQUEST", {
    message: "Restore this user before resending their invite.",
  });
}

/** The mint's own (race-free) refusal, as the procedure's error. */
function refusalError(err: SetPasswordLinkRefusedError) {
  if (err.reason === "missing") return new ORPCError("NOT_FOUND", { message: "User not found" });
  if (err.reason === "archived") return inviteeArchived();
  return inviteNotPending();
}

/**
 * Invite mail budgets. Each `invite` / `resendInvite` call writes rows and
 * sends one email, and one batched `/rpc` request carries many calls, so the
 * HTTP limiter cannot meter them. Fail-closed: these are mail-sending writes.
 *
 * - Per admin, shared by both procedures: 30 invite mails an hour covers
 *   onboarding a team in one sitting.
 * - Per invitee, resend only: 5 an hour. Every resend kills the previous link,
 *   so more than that is a stuck mailbox, not progress, and the invitee's
 *   inbox should not be the thing an admin session can flood.
 */
const consumeInviteMailBudget = createProcedureBudget({
  keyPrefix: "rl:users-invite-mail",
  points: 30,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many invites sent. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Invites are temporarily unavailable. Please try again in a moment.",
  unavailableLog: "[users] invite mail limiter unavailable, failing closed:",
});

const consumeResendInviteBudget = createProcedureBudget({
  keyPrefix: "rl:users-resend-invite",
  points: 5,
  durationSeconds: 3600,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `This invite was re-sent too often. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Invites are temporarily unavailable. Please try again in a moment.",
  unavailableLog: "[users] resend-invite limiter unavailable, failing closed:",
});

const INVITE_TARGET_SELECT = {
  id: true,
  email: true,
  name: true,
  locale: true,
  banned: true,
  banExpires: true,
} satisfies Prisma.UserSelect;

/**
 * The invite result. The set-password link is returned only when it could not
 * be emailed: the admin then has to pass it on themselves (one-time reveal in
 * the admin UI). When the email went out, the link exists only in the
 * invitee's inbox.
 *
 * Only a mailed link verifies the address when it is spent
 * (@cockpit-chess/auth/password-reset-links): a link the admin passes on sets
 * the password, and the invitee then confirms the address through the mail
 * sign-in sends them. Otherwise anyone holding a revealed link could make an
 * address nobody controls "verified".
 */
type InviteDelivery =
  | { userId: string; emailSent: true }
  | { userId: string; emailSent: false; setPasswordUrl: string; expiresAt: Date };

async function deliverInvite(args: {
  userId: string;
  name: string;
  email: string;
  locale: string;
}): Promise<InviteDelivery> {
  let link: { url: string; expiresAt: Date; token: string };
  try {
    link = await createSetPasswordLink({ userId: args.userId, locale: args.locale });
  } catch (err) {
    if (err instanceof SetPasswordLinkRefusedError) throw refusalError(err);
    console.error(
      "[users.invite] failed to create a set-password link for",
      args.userId,
      err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
    );
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Couldn't create the invite link. Try resending the invite.",
    });
  }

  // Skip the SMTP attempt (and its retries) when email is not configured at
  // all; a configured-but-failing server falls through to the same reveal.
  if (isEmailConfigured()) {
    try {
      const { subject, html } = renderInviteUser({
        name: args.name,
        email: args.email,
        setPasswordUrl: link.url,
        expiresInDays: INVITE_LINK_TTL_DAYS,
        locale: args.locale,
      });
      // The admin is waiting on this response; the mailer's own send deadline
      // bounds it, and a failure falls back to the link reveal.
      await sendEmail({ to: args.email, subject, html });
    } catch (err) {
      // Never log the link: it is a credential until it is spent.
      console.warn(
        "[users.invite] failed to send invite email",
        err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
      );
      return revealLink(args.userId, link);
    }
    // Mailed: spending it proves the inbox. The mail is out either way, so a
    // failed record only means the invitee confirms the address through the
    // mail sign-in sends them; never hand the admin the link after that.
    try {
      await recordResetLinkMailed({ token: link.token, userId: args.userId, email: args.email });
    } catch (err) {
      console.error(
        "[users.invite] failed to record the mailed invite link",
        err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
      );
    }
    return { userId: args.userId, emailSent: true };
  }
  return revealLink(args.userId, link);
}

function revealLink(userId: string, link: { url: string; expiresAt: Date }): InviteDelivery {
  return { userId, emailSent: false, setPasswordUrl: link.url, expiresAt: link.expiresAt };
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
  banned: true,
  banReason: true,
  banExpires: true,
  twoFactorEnabled: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export const usersRouter = {
  list: adminOr404Procedure
    .input(
      cursorPageInput
        .extend({
          limit: z.number().int().min(1).max(100).default(50),
          search: z.string().trim().max(200).optional(),
          status: userStatusFilter.default("all"),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const cursor = input?.cursor;
      const search = input?.search;
      const status = input?.status ?? "all";
      // Status is filtered in the database, not on the client: filtering
      // already-paginated pages makes both the empty state and the "load more"
      // affordance lie (an all-archived first page under the "active" tab would
      // look empty even though later pages hold active users). `banned` is a
      // nullable Boolean, so "active" must match both `false` and NULL.
      const searchWhere: Prisma.UserWhereInput | undefined = search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" as const } },
              { name: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : undefined;
      const now = new Date();
      const statusWhere: Prisma.UserWhereInput | undefined =
        status === "active"
          ? { OR: [{ banned: false }, { banned: null }] }
          : status === "archived"
            ? { banned: true }
            : undefined;
      // Narrowed (not just filtered): `withCursor` ANDs this into an array,
      // where an `undefined` union member would fail typecheck.
      const conditions = [statusWhere, searchWhere].filter(
        (c): c is Prisma.UserWhereInput => c !== undefined,
      );
      const where: Prisma.UserWhereInput =
        conditions.length > 1 ? { AND: conditions } : (conditions[0] ?? {});
      // Cursor (keyset) pagination: no `skip` scan, no per-page `count()`.
      // The admin UI consumes this as an infinite list (LoadMore), so the
      // header total is dropped — it cost a full filtered count per page for
      // a "showing N" nicety. Tie-break on the unique id: `createdAt` alone
      // is not a stable sort key, so two users created in the same
      // millisecond could repeat or vanish across pages.
      const rows = await prisma.user.findMany({
        // The status/search `where` stays the first `AND` member; the keyset
        // narrows it, it never replaces it.
        where: withCursor(where, "createdAt", cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(limit),
        select: { ...USER_SELECT, ...inviteStateSelect(now) },
      });
      const page = cursorPage(rows, limit, "createdAt");
      // The account/session probes decide `invitePending` and go no further:
      // the client gets the verdict, never the user's linked providers.
      const users = page.items.map(({ accounts, sessions, ...user }) => ({
        ...user,
        invitePending: isInvitePending({ emailVerified: user.emailVerified, accounts, sessions }),
      }));
      return { users, nextCursor: page.nextCursor };
    }),

  invite: adminOr404Procedure
    .input(
      z.object({
        email: z.string().email().toLowerCase(),
        name: z.string().trim().min(1).max(100),
        role: assignableRoleSchema.default("user"),
        // The invitee's language: the invite email, the set-password page it
        // links to, and every later email use it, and it is saved as their
        // `User.locale` (they can change it in settings). The admin UI
        // defaults it to the admin's own language.
        locale: z.enum(SUPPORTED_LOCALES),
      }),
    )
    .handler(async ({ input, context }) => {
      await consumeInviteMailBudget(`admin:${context.session.user.id}`);
      // The account is created with a random password that is never stored
      // anywhere, shown, or sent — nobody can sign in with it. The invitee
      // gets a one-time set-password link instead and chooses their own.
      //
      // The account starts unverified, and the invite email is the only mail:
      // createUser sends no verification mail, and sign-in's resend
      // (`sendOnSignIn`) needs the correct password, which nobody has yet.
      // Spending a MAILED link proves the inbox and marks the email verified
      // then (@cockpit-chess/auth/password-reset-links); a link revealed to
      // the admin only sets the password, and sign-in then mails the invitee
      // a verification link. So an invite to a mistyped address never yields
      // a verified account.
      const unusablePassword = generateUnusablePassword();

      // `auth.api.createUser` is the only admin-plugin endpoint that accepts
      // server-side calls without a session in headers (verified in the
      // better-auth source). It hashes the password, enforces email
      // uniqueness, and writes through the Prisma adapter so it stays in
      // sync with any custom databaseHooks (e.g. ADMIN_EMAILS auto-promote).
      let userId: string;
      try {
        // The grant's locale seeds `User.locale` in the user-create hook
        // (packages/auth): a server-side createUser carries no locale header.
        const created = await runWithAllowedUserCreation(
          "admin-invite",
          () =>
            auth.api.createUser({
              body: {
                email: input.email,
                password: unusablePassword,
                name: input.name,
                role: input.role,
              },
            }),
          { locale: input.locale },
        );
        userId = created.user.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to invite user";
        if (/already exists|already in use|duplicate/i.test(message)) {
          throw new ORPCError("CONFLICT", {
            message: "A user with that email already exists.",
          });
        }
        if (/sign-?up.*disabled|disabled.*sign-?up/i.test(message)) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Account creation is disabled by the auth configuration. Ask an admin to check the invite setup.",
          });
        }
        // Log only name+message — the generated password was just passed to
        // auth.api.createUser, so we don't dump the raw error object in case
        // a future better-auth release attaches request context to thrown
        // errors.
        const errLabel = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
        console.error("[users.invite] auth.api.createUser failed:", errLabel);
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message:
            "Couldn't create that account. Try again, or contact an admin if it keeps happening.",
        });
      }

      // A link failure does not roll back the user creation — undoing it would
      // race against any concurrent admin already looking at the new row. The
      // admin can mint a fresh link with "Resend invite".
      return deliverInvite({
        userId,
        name: input.name,
        email: input.email,
        locale: input.locale,
      });
    }),

  /**
   * Mint a fresh set-password link for an invited user who has not finished
   * setting up their account, and email it (or hand it to the admin when it
   * can't be emailed). Every earlier link for the user stops working.
   *
   * Pending is decided server-side by `isInvitePending` (unverified, only a
   * credential account, never signed in) — not by `emailVerified` alone, which
   * an active SSO user can also have. Anything else is refused with
   * INVITE_NOT_PENDING (409).
   *
   * The checks here are a fast path; `createSetPasswordLink` repeats them
   * under the lock a finishing password reset also takes, so an invitee who
   * completes their reset in the meantime never gets a fresh link.
   */
  resendInvite: adminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    await consumeInviteMailBudget(`admin:${context.session.user.id}`);
    await consumeResendInviteBudget(`user:${input.userId}`);
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { ...INVITE_TARGET_SELECT, ...inviteStateSelect(new Date()) },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });
    if (!isInvitePending(target)) throw inviteNotPending();
    if (isUserBanned(target)) throw inviteeArchived();
    return deliverInvite({
      userId: target.id,
      name: target.name,
      email: target.email,
      locale: target.locale,
    });
  }),

  setRole: adminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: assignableRoleSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      // Don't let an admin demote themselves — if they're the only admin
      // they'd lock themselves (and everyone) out of /admin.
      if (input.userId === context.session.user.id && input.role !== "admin") {
        throw new ORPCError("FORBIDDEN", {
          message: "You cannot remove your own admin role.",
          data: { reason: "SELF_DEMOTION" },
        });
      }
      const change = await withAdminRemovalGuard(
        input.userId,
        async (tx, target) => {
          if (target.role === input.role) return null;
          await tx.user.update({
            where: { id: target.id },
            data: { role: input.role },
            select: { id: true },
          });
          return { oldRole: target.role, newRole: input.role };
        },
        input.role,
      );

      if (change) {
        // No audit table in this app: follow the structured audit convention
        // used by setup.first_admin, once after commit.
        console.info(
          `[audit] ${JSON.stringify({
            event: "users.role_changed",
            actorId: context.session.user.id,
            targetId: input.userId,
            ...change,
            timestamp: new Date().toISOString(),
          })}`,
        );
      }
      return { success: true };
    }),

  archive: adminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.userId === context.session.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "You cannot archive your own account.",
        });
      }
      // Set banned=true so better-auth treats the user as locked, and revoke
      // every active session so the next page-load signs them out. We mirror
      // what the admin plugin's banUser endpoint does internally — no expiry
      // (banExpires=null), no auto-unban.
      //
      // If you add a standing credential that authenticates from its own row
      // (an API key, a personal access token), revoke it here too: deleting
      // sessions does not touch it, so it would outlive the ban everywhere a
      // per-surface ban re-check does not reach.
      await withCliCredentialSnapshotLock(input.userId, (timeout) =>
        withAdminRemovalGuard(
          input.userId,
          async (tx) => {
            await tx.user.update({
              where: { id: input.userId },
              data: {
                banned: true,
                banReason: input.reason ?? null,
                banExpires: null,
              },
              select: { id: true },
            });
            await tx.session.deleteMany({ where: { userId: input.userId } });
            await revokeRunnerMachinesInTransaction(tx, input.userId);
          },
          undefined,
          timeout,
        ),
      );
      return { success: true };
    }),

  unarchive: adminOr404Procedure.input(userIdInput).handler(async ({ input }) => {
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    // Lifts the ban only. If you add a standing credential that `archive`
    // revokes, do NOT flip it back on from here: the row records that a
    // credential IS revoked, not who revoked it, so a blanket re-enable would
    // also resurrect one an admin had deliberately killed earlier (a leaked
    // key, a decommissioned integration). Restoring precisely needs a column
    // recording that archive was the revoker.
    await prisma.user.update({
      where: { id: input.userId },
      data: { banned: false, banReason: null, banExpires: null },
      select: { id: true },
    });
    return { success: true };
  }),

  remove: adminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot delete your own account.",
      });
    }
    // Every relation to User cascades today (sessions, accounts, two-factors,
    // CLI credentials and chess matches, published ones included). The
    // constraint mapping below is defensive: a future `onDelete: Restrict`
    // relation would surface as a friendly "archive instead" message.
    try {
      await withCliCredentialSnapshotLock(input.userId, (timeout) =>
        withAdminRemovalGuard(
          input.userId,
          async (tx) => {
            // Cascade removes rows; the ID-only notification also tells
            // runner transports on every replica to close immediately.
            await revokeRunnerMachinesInTransaction(tx, input.userId);
            await tx.user.delete({ where: { id: input.userId } });
          },
          undefined,
          timeout,
        ),
      );
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      const message = err instanceof Error ? err.message : "Failed to delete user";
      if (/foreign key|constraint|restrict/i.test(message)) {
        throw new ORPCError("CONFLICT", {
          message:
            "This user has authored content and cannot be deleted. Archive them instead, or reassign their content first.",
        });
      }
      console.error("[users.remove] prisma delete failed", err);
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message:
          "Couldn't delete that account. Try again, or contact an admin if it keeps happening.",
      });
    }
    return { success: true };
  }),
};
