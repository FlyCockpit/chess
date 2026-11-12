/**
 * Import-pure backup capability validation. These functions deliberately do
 * not read process.env so a caller can validate its exact profile without
 * booting the shared environment surface.
 */
export type BackupConfig = {
  BACKUP_ENABLED?: boolean | undefined;
  BACKUP_S3_PREFIX?: string | undefined;
  BACKUP_S3_BUCKET?: string | undefined;
  BACKUP_S3_ACCESS_KEY_ID?: string | undefined;
  BACKUP_S3_SECRET_ACCESS_KEY?: string | undefined;
  BACKUP_S3_ENDPOINT?: string | undefined;
  BACKUP_S3_REGION?: string | undefined;
  BACKUP_MONITOR_S3_ACCESS_KEY_ID?: string | undefined;
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY?: string | undefined;
};

/** Shared location settings used by both backup writers and the monitor. */
export function backupCommonConfigWarnings(value: BackupConfig): string[] {
  const warnings: string[] = [];
  if (value.BACKUP_ENABLED && !value.BACKUP_S3_BUCKET) {
    warnings.push(
      "BACKUP_ENABLED=true but BACKUP_S3_BUCKET is not set. Freshness monitoring is enabled but no off-site bucket is configured — set BACKUP_S3_BUCKET and a dedicated BACKUP_MONITOR_S3_* key. Configure backup writing separately with the canonical backup commands and BACKUP_SCHEDULE.",
    );
  }
  if (!value.BACKUP_S3_BUCKET) return warnings;
  if (value.BACKUP_S3_PREFIX !== undefined && !value.BACKUP_S3_PREFIX.replace(/^\/+|\/+$/g, "")) {
    warnings.push("BACKUP_S3_PREFIX must not be empty.");
  }
  if (!value.BACKUP_S3_ENDPOINT && value.BACKUP_S3_REGION === "auto") {
    warnings.push(
      "BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset. " +
        'The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
    );
  }
  return warnings;
}

/** Freshness monitoring needs a distinct ListBucket-only identity. */
export function backupMonitorConfigWarnings(value: BackupConfig): string[] {
  const warnings = backupCommonConfigWarnings(value);
  if (!value.BACKUP_S3_BUCKET) return warnings;
  if (!value.BACKUP_MONITOR_S3_ACCESS_KEY_ID || !value.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY) {
    warnings.push(
      "BACKUP_S3_BUCKET is set but BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY are missing. " +
        "The freshness worker needs a dedicated ListBucket-only monitor key.",
    );
  }
  const monitorKey = value.BACKUP_MONITOR_S3_ACCESS_KEY_ID;
  if (monitorKey && monitorKey === value.BACKUP_S3_ACCESS_KEY_ID) {
    warnings.push(
      "BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness worker needs a separate ListBucket-only key, not the dump read/write key.",
    );
  }
  return warnings;
}
