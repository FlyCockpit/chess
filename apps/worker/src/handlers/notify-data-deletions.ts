import {
  type DataDeletionNotice,
  listUnnotifiedDataDeletions,
  markDataDeletionNotified,
} from "@cockpit-chess/db/data-deletion-notices";
import { isEmailConfigured } from "@cockpit-chess/mailer";
import type { NotifyDataDeletionsJobData } from "@cockpit-chess/queue";
import { notifyDataDeletionsJobSchema } from "@cockpit-chess/queue";
import type { Job } from "bullmq";
import { sendDataDeletedAlert } from "../operational-alerts.js";

/**
 * Email admins once per scheduled data deletion the migration runner carried
 * out (docs/schema-migrations.md § Getting told when data is deleted).
 *
 * Read, send, then mark — at least once. A notice is marked only after an
 * admin was actually emailed; a send that reached nobody (or threw) leaves it
 * unmarked for the next firing, and a crash between send and mark re-sends it
 * (a rare duplicate rather than a lost notice). Only deletions from the last
 * `DATA_DELETION_NOTICE_WINDOW_DAYS` are considered. Without email configured
 * nothing is read, so the notices wait until it is. Every notice is logged
 * before its send, so the log has a record whether or not an admin opted in.
 */
export async function handleNotifyDataDeletionsJob(
  job: Job<NotifyDataDeletionsJobData>,
): Promise<{ reason: "cron"; notified: number; retried: number }> {
  const { reason } = notifyDataDeletionsJobSchema.parse(job.data);
  if (!isEmailConfigured()) return { reason, notified: 0, retried: 0 };

  const notices = await listUnnotifiedDataDeletions();
  let notified = 0;
  let retried = 0;
  for (const notice of notices) {
    console.warn(`[notify-data-deletions] ${describe(notice)}`);
    try {
      await sendDataDeletedAlert(notice);
    } catch (error) {
      retried++;
      console.error(
        `[notify-data-deletions] Alert for ${notice.name} not delivered (${errorMessage(error)}); retrying on the next run.`,
      );
      continue;
    }
    notified++;
    try {
      await markDataDeletionNotified(notice.name);
    } catch (error) {
      console.error(
        `[notify-data-deletions] Alert for ${notice.name} was sent but could not be recorded (${errorMessage(error)}); it may be sent again.`,
      );
    }
  }
  if (notices.length > 0)
    console.log(
      `[notify-data-deletions] Job ${job.id} (${reason}) handled ${notices.length} deletion notice(s).`,
    );
  return { reason, notified, retried };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(notice: DataDeletionNotice): string {
  return (
    `scheduled deletion ${notice.name} ran at ${notice.deletedAt.toISOString()}: ` +
    `${notice.effects ?? "see its contract.sql"} (backup: ${notice.backup ?? "none configured"})`
  );
}
