import { createHash, randomUUID } from "node:crypto";
import { isAdminRole } from "@cockpit-chess/auth/roles";
import prisma from "@cockpit-chess/db";
import type { DataDeletionNotice } from "@cockpit-chess/db/data-deletion-notices";
import { isEmailConfigured, renderDataDeleted, sendEmail } from "@cockpit-chess/mailer";
import { createRedisConnection } from "@cockpit-chess/queue";

type AlertArgs = {
  queue: string;
  jobId: string | number | undefined;
  message: string;
};

const ALERT_COOLDOWN_SECONDS = 60 * 60;
/**
 * Bound on the cooldown reservation. `alertConnection` is created with
 * `maxRetriesPerRequest: null` and no command timeout, so a `set()` issued
 * while Redis is unreachable neither resolves nor rejects — it would hang the
 * alert path (and, on the fatal-error path, the worker's exit) forever.
 */
const RESERVE_TIMEOUT_MS = 2_000;
const ADMIN_PAGE_SIZE = 50;
const EMAIL_CONCURRENCY = 8;
const alertConnection = createRedisConnection();

const operationalAlertRecipientWhere = {
  emailVerified: true,
  operationalAlerts: true,
};

export async function sendOperationalFailureAlert(args: AlertArgs): Promise<void> {
  const jobLabel = args.jobId === undefined ? "unknown" : String(args.jobId);
  await sendOperationalAlert({
    source: args.queue,
    message: args.message,
    subject: `[${args.queue}] background job failed`,
    html: `
    <p>A background job failed permanently.</p>
    <dl>
      <dt>Queue</dt><dd>${escapeHtml(args.queue)}</dd>
      <dt>Job</dt><dd>${escapeHtml(jobLabel)}</dd>
      <dt>Error</dt><dd>${escapeHtml(args.message)}</dd>
    </dl>
  `,
  });
}

type OperationalAlert = {
  /** Cooldown namespace — one alert per (source, normalized message) per window. */
  source: string;
  /** Normalized into the cooldown fingerprint; numbers and ids are masked. */
  message: string;
  subject: string;
  html: string;
  render?: (locale: string) => { subject: string; html: string };
  /** Exact identity for data notices; their timestamped migration names must not be normalized. */
  identity?: string;
  cooldownSeconds?: number;
};

/**
 * Email every admin who opted into operational alerts. Deduplicated in Redis
 * so a failure that repeats every minute produces one email per cooldown
 * window. Safe to call when SMTP is unconfigured (no-op).
 */
export async function sendOperationalAlert(alert: OperationalAlert): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const slot = await reserveAlertSlot(alert);
  if (!slot) return 0;
  let delivered = 0;
  let attempted = 0;
  try {
    let afterId: string | undefined;
    for (;;) {
      const admins = await prisma.user.findMany({
        where: {
          ...operationalAlertRecipientWhere,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: { id: true, email: true, role: true, locale: true },
        orderBy: { id: "asc" },
        take: ADMIN_PAGE_SIZE,
      });
      if (admins.length === 0) break;
      afterId = admins[admins.length - 1]?.id;
      const recipients = admins.filter((admin) => isAdminRole(admin.role));
      for (let i = 0; i < recipients.length; i += EMAIL_CONCURRENCY) {
        const results = await Promise.allSettled(
          recipients.slice(i, i + EMAIL_CONCURRENCY).map(async (admin) => {
            const content = alert.render?.(admin.locale) ?? alert;
            attempted += 1;
            await sendEmail({ to: admin.email, subject: content.subject, html: content.html });
          }),
        );
        delivered += results.filter((result) => result.status === "fulfilled").length;
      }
      if (admins.length < ADMIN_PAGE_SIZE || !afterId) break;
    }
  } finally {
    if (attempted > 0 && delivered === 0) await releaseAlertSlot(slot, alert.source);
  }
  return delivered;
}

/** A notice is delivered only when at least one opted-in, verified admin receives mail. */
export async function sendDataDeletedAlert(notice: DataDeletionNotice): Promise<void> {
  const sent = await sendOperationalAlert({
    source: "data-deleted",
    message: notice.name,
    identity: notice.name,
    ...renderDataDeleted({ ...notice, locale: "en-US" }),
    render: (locale) => renderDataDeleted({ ...notice, locale }),
  });
  if (sent === 0) throw new Error(`no admin was emailed about ${notice.name} this run`);
}

export function closeOperationalAlertConnection(): void {
  alertConnection.disconnect();
}

async function reserveAlertSlot(args: {
  source: string;
  message: string;
  cooldownSeconds?: number;
  identity?: string;
}): Promise<{ key: string; token: string } | null> {
  const fingerprint = createHash("sha256")
    .update(args.source)
    .update("\0")
    .update(args.identity ?? normalizeError(args.message))
    .digest("hex")
    .slice(0, 32);
  const key = `operational-alert:${args.source}:${fingerprint}`;
  const cooldown = args.cooldownSeconds ?? ALERT_COOLDOWN_SECONDS;
  const token = randomUUID();
  try {
    const result = await withTimeout(
      alertConnection.set(key, token, "EX", cooldown, "NX"),
      RESERVE_TIMEOUT_MS,
      "Redis timed out reserving the alert cooldown",
    );
    return result === "OK" ? { key, token } : null;
  } catch (err) {
    // SKIP the alert rather than send it. Redis is what makes an alert
    // once-per-hour instead of once-per-failure; without it, a failure
    // repeating every minute — which is exactly what a Redis outage causes —
    // would mail every admin every minute. A missed email is recoverable; an
    // inbox flood during an incident is not. The failure is still logged here
    // and by whatever raised it.
    console.error(
      `[${args.source}] Skipping operational alert — could not reserve the cooldown in Redis:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Compare-and-delete cannot release a newer sender's reservation after our TTL expires. */
async function releaseAlertSlot(
  slot: { key: string; token: string },
  source: string,
): Promise<void> {
  try {
    await withTimeout(
      alertConnection.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        slot.key,
        slot.token,
      ),
      RESERVE_TIMEOUT_MS,
      "Redis timed out releasing the alert cooldown",
    );
  } catch (error) {
    console.error(
      `[${source}] Could not release the alert cooldown:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Reject after `timeoutMs` rather than waiting on a promise that may never settle. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

function normalizeError(message: string): string {
  return message
    .replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replaceAll(/\b\d+\b/g, "<number>")
    .trim()
    .slice(0, 500);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
