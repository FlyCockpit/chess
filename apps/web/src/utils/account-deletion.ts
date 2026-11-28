const RECENT_AUTHENTICATION_MS = 5 * 60_000;

/** UI guidance only: the committing transaction checks the live proof again. */
export function hasRecentDeletionProof(value: Date | string | null | undefined, now = Date.now()) {
  if (value === null || value === undefined) return false;
  const authenticatedAt = value instanceof Date ? value.getTime() : Date.parse(value);
  return (
    Number.isFinite(authenticatedAt) &&
    authenticatedAt <= now &&
    authenticatedAt >= now - RECENT_AUTHENTICATION_MS
  );
}

export type AccountDeletionIssue =
  | "reauth"
  | "admin"
  | "unavailable"
  | "notReady"
  | "rateLimit"
  | "unknown";

/** Only public refusal reasons select copy; never render raw server errors. */
export function accountDeletionIssue(error: unknown): AccountDeletionIssue {
  if (typeof error !== "object" || error === null) return "unknown";
  const status = "status" in error ? error.status : undefined;
  const code = "code" in error ? error.code : undefined;
  const data = "data" in error ? error.data : undefined;
  const reason = typeof data === "object" && data !== null && "reason" in data ? data.reason : null;
  if (reason === "REAUTH_REQUIRED" || status === 412 || code === "PRECONDITION_FAILED")
    return "reauth";
  if (reason === "ADMIN_TRANSFER_REQUIRED") return "admin";
  if (reason === "CLEANUP_UNAVAILABLE") return "unavailable";
  if (reason === "DELETION_NOT_READY") return "notReady";
  if (status === 429 || code === "TOO_MANY_REQUESTS") return "rateLimit";
  return "unknown";
}

/** A display hint after acceptance, never a receipt or a status capability. */
export function accountDeletionAcknowledgement(
  value: unknown,
): "pending" | "unconfirmed" | undefined {
  return value === "pending" || value === "unconfirmed" ? value : undefined;
}
