import prisma from "@cockpit-chess/db";
import { withLockSlot } from "./lock-slots.js";
import { CREDENTIAL_PROVIDER_ID } from "./password-reset-links.js";
import { deleteResetLinks, lockSetPasswordLinks } from "./set-password-link-lock.js";

/**
 * An invited account becomes active when its email is verified or an IdP
 * identity is linked to it. Reset links minted while it was a pending invite
 * (set-password links an admin was shown, or a resend's) must die at that
 * moment, by whatever route it happened: ordinary `/verify-email`, an SSO
 * sign-in that links the account and copies the IdP's verified claim, or a
 * mailed reset link (whose after-hook does the same itself,
 * password-reset-links.ts `verifyEmailIfResetLinkWasMailed`).
 *
 * This is tidy-up, not the guarantee. What stops the holder of a leftover
 * shown link from replacing the active account's password is the
 * `/reset-password` before-hook (password-reset-links.ts
 * `isResetLinkRedeemable`): a link that was not mailed is spendable only
 * while the account is a pending invite. So a failed cleanup is logged, never
 * surfaced: the activation is already committed, and failing the request
 * would only tell the user something went wrong with a verification that
 * worked (a retry returns early anyway, so it would not retry the cleanup).
 *
 * These run as Better-Auth database after-hooks, which fire once the write is
 * committed. Each takes the per-user set-password-link lock that minting takes
 * (packages/api/src/lib/set-password-link.ts) and deletes every reset link of
 * the user. A mint racing the activation therefore either re-reads the user
 * under the lock after the activation committed and refuses (the account is
 * no longer a pending invite), or committed its link before this took the
 * lock, and this deletes it.
 *
 * A forgot-password link the user has out also goes when an IdP identity is
 * linked to an already-verified account; they can request another.
 */

/** Endpoint contexts whose user update set `emailVerified: true`. */
const verificationWrites = new WeakSet<object>();

/** `databaseHooks.user.update.before`: note a write that verifies the email. */
export function noteVerificationWrite(data: Record<string, unknown>, context: unknown): void {
  if (data.emailVerified === true && typeof context === "object" && context !== null) {
    verificationWrites.add(context);
  }
}

/**
 * `databaseHooks.user.update.after`: if this update verified the email, the
 * account is active, so its reset links go. With no endpoint context (a
 * server-side internal write) it cannot tell, so it cleans up whenever the
 * row is verified: fail safe.
 */
export async function afterUserUpdate(
  user: { id?: unknown; emailVerified?: unknown } | null | undefined,
  context: unknown,
): Promise<void> {
  if (user?.emailVerified !== true || typeof user.id !== "string") return;
  const known = typeof context === "object" && context !== null;
  if (known && !verificationWrites.has(context)) return;
  await deleteResetLinksOnActivation(user.id);
}

/**
 * `databaseHooks.account.create.after`: an IdP identity linked to the user
 * (SSO sign-in, implicit linking by verified email) makes the account active;
 * its reset links go. A credential account (an invite's own) changes nothing.
 */
export async function afterAccountCreate(
  account: { userId?: unknown; providerId?: unknown } | null | undefined,
): Promise<void> {
  if (!account || account.providerId === CREDENTIAL_PROVIDER_ID) return;
  if (typeof account.userId !== "string") return;
  await deleteResetLinksOnActivation(account.userId);
}

/** Attempts, and the pause before each retry (ms). */
const ATTEMPTS = 3;
const BACKOFF_MS = [100, 400] as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Under the set-password-link lock (in a lock slot, lock-slots.ts), delete
 * every reset link of `userId`.
 * Idempotent, so it is retried; a final failure is logged (user id and error
 * class only) and swallowed: the leftover links are refused at redemption
 * anyway and expire on their own.
 */
export async function deleteResetLinksOnActivation(
  userId: string,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 400);
    try {
      await withLockSlot(() =>
        prisma.$transaction([lockSetPasswordLinks(userId), deleteResetLinks(userId)]),
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(
    `[auth] deleting reset links on account activation failed after ${ATTEMPTS} attempts; they are refused at redemption and expire on their own.`,
    {
      userId,
      error:
        lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : "unknown error",
    },
  );
}
