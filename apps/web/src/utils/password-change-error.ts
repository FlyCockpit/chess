import type { useTranslation } from "react-i18next";
import { friendly, isRateLimit } from "./friendly-error";

const PASSWORD_CHANGE_ERROR_KEYS: Record<
  string,
  "currentPasswordMismatch" | "passwordWriteUnconfirmed" | "passwordWriteBusy"
> = {
  INVALID_PASSWORD: "currentPasswordMismatch",
  PASSWORD_WRITE_UNCONFIRMED: "passwordWriteUnconfirmed",
  PASSWORD_WRITE_BUSY: "passwordWriteBusy",
};

/**
 * Resolves the user-facing toast message for a failed `/api/auth/change-password`
 * call, covering wrong current password, 409 quarantine, 503 lock contention, and rate limits.
 */
export function resolvePasswordChangeErrorMessage(
  error: unknown,
  t: ReturnType<typeof useTranslation<"settings">>["t"],
): string {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const key = code ? PASSWORD_CHANGE_ERROR_KEYS[code] : undefined;
  if (key) return t(`settings:security.${key}`);
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  if (status === 409) return t("settings:security.passwordWriteUnconfirmed");
  if (status === 503) return t("settings:security.passwordWriteBusy");
  return isRateLimit(error)
    ? friendly(error, t("settings:security.passwordChangeError"))
    : t("settings:security.passwordChangeError");
}
