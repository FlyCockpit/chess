import type { ReapedAuthTokens } from "@cockpit-chess/api/lib/auth-token-retention";
import { reapExpiredAuthTokens } from "@cockpit-chess/api/lib/auth-token-retention";
import type { ReapExpiredAuthTokensJobData } from "@cockpit-chess/queue";
import { reapExpiredAuthTokensJobSchema } from "@cockpit-chess/queue";
import type { Job } from "bullmq";

export async function handleReapExpiredAuthTokensJob(
  job: Job<ReapExpiredAuthTokensJobData>,
): Promise<{ reason: "cron"; deleted: ReapedAuthTokens }> {
  const { reason } = reapExpiredAuthTokensJobSchema.parse(job.data);
  const start = Date.now();
  const { deleted } = await reapExpiredAuthTokens();
  console.log(
    `[reap-expired-auth-tokens] Job ${job.id} (${reason}) deleted ` +
      `${deleted.sessions} session(s), ${deleted.verifications} verification(s), ` +
      `${deleted.deviceCodes} device code(s), ${deleted.apiKeys} API key(s) ` +
      `in ${Date.now() - start}ms`,
  );
  return { reason, deleted };
}
