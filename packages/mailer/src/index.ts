import { env } from "@cockpit-chess/env/shared";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

let transporter: Transporter | null = null;

/**
 * Sends run inside user requests (sign-up and reset mail, 2FA codes, admin
 * invitations, the transport preflight), so they must give up long before a
 * fronting proxy does: Cloudflare answers 524 after about 100 s without a
 * response, and nodemailer's own defaults (2 min to connect, 10 min of socket
 * idle, both per attempt) would hold the request for minutes.
 *
 * The connection and idle timeouts end a dead relay's attempt early. They
 * bound inactivity, not elapsed time (a relay answering each command just
 * before the idle timeout could keep one attempt going), so every operation
 * also races its own elapsed deadline. A retry starts only inside the retry
 * window. An attempt abandoned at the deadline is not cancelled: its
 * connection stays open until it completes, fails or goes idle, and the
 * message may still go out, so the deadline rejects with `SmtpDeadlineError`
 * (delivery unknown) rather than a plain failure.
 */
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 20_000;
export const SMTP_RETRY_WINDOW_MS = 25_000;
export const SMTP_SEND_DEADLINE_MS = 60_000;
export const SMTP_VERIFY_DEADLINE_MS = 20_000;
const SMTP_ATTEMPTS = 3;

/** The operation was abandoned at its deadline; whether it took effect is unknown. */
export class SmtpDeadlineError extends Error {
  override name = "SmtpDeadlineError";
}

/** Settle with `operation`, or reject with `SmtpDeadlineError` once `ms` have elapsed. */
async function withDeadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpDeadlineError(message)), ms);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env;

  if (!SMTP_HOST) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in your .env file. " +
        "For local dev, run: docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit",
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ?? 587,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
  });

  return transporter;
}

/**
 * Send an email using the SMTP transport configured via env vars.
 *
 * The nodemailer transport is created lazily on the first call so the
 * application boots cleanly even when SMTP is not configured.
 * Shipped callers send account mail. Marketing needs a separate flow with
 * unsubscribe, postal address, and dispatch-time suppression (including
 * retries); do not add promotions to auth mail. See docs/deployment.md.
 */
export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<void> {
  const transport = getTransporter();
  const from = env.SMTP_FROM;
  if (!from) {
    throw new Error(
      "SMTP_FROM is not set. Outgoing email needs an explicit From: address — " +
        'set SMTP_FROM in your .env (e.g. "App Name <no-reply@yourdomain.com>").',
    );
  }

  const send = async (): Promise<void> => {
    const started = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= SMTP_ATTEMPTS; attempt++) {
      try {
        await transport.sendMail({ from, to, subject, html });
        return;
      } catch (err) {
        lastError = err;
        if (attempt === SMTP_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        if (Date.now() - started >= SMTP_RETRY_WINDOW_MS) break;
      }
    }
    throw lastError;
  };
  await withDeadline(send(), SMTP_SEND_DEADLINE_MS, "SMTP send deadline exceeded");
}

/**
 * Whether SMTP is configured at all (env-level check, no network I/O). Drives
 * the `emailEnabled` app-config flag that gates email-dependent UI.
 */
export function isEmailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

/**
 * Best-effort SMTP reachability check (connect + auth handshake via nodemailer's
 * `verify()`). Returns a boolean and NEVER throws: `false` when SMTP is
 * unconfigured or the handshake fails, `true` otherwise.
 *
 * Used as a delivery-aware preflight: Better-Auth's email-OTP `send-otp`
 * endpoint swallows `sendOTP` failures and always returns success, so callers
 * verify the transport is actually reachable before telling a user a code is on
 * the way. This catches the common breakage (wrong host/port/credentials, server
 * down); it cannot guarantee a specific recipient won't bounce after a good
 * handshake — that is inherent to asynchronous email delivery.
 */
export async function verifyTransport(): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    return await withDeadline(
      getTransporter().verify(),
      SMTP_VERIFY_DEADLINE_MS,
      "SMTP verify deadline exceeded",
    );
  } catch {
    return false;
  }
}

// Locale machinery + per-template renderers. The mailer owns email rendering
// (subject + HTML) so callers don't have to think about i18n bundles, just
// pass the recipient's locale and the template-specific data.
export {
  DEFAULT_MAILER_LOCALE,
  isMailerLocale,
  MAILER_LOCALES,
  type MailerLocale,
  resolveMailerLocale,
} from "./locales/index.js";
export { type RenderDataDeletedArgs, renderDataDeleted } from "./templates/data-deleted.js";
export {
  type RenderInviteUserArgs,
  type RenderInviteUserResult,
  renderInviteUser,
} from "./templates/invite-user.js";
export {
  type RenderResetPasswordArgs,
  type RenderResetPasswordResult,
  renderResetPassword,
} from "./templates/reset-password.js";
export {
  type RenderTwoFactorOtpArgs,
  type RenderTwoFactorOtpResult,
  renderTwoFactorOtp,
} from "./templates/two-factor-otp.js";
export {
  type RenderVerifyEmailArgs,
  type RenderVerifyEmailResult,
  renderVerifyEmail,
} from "./templates/verify-email.js";
