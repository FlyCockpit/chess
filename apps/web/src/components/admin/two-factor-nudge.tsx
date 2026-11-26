import { isAdminRole } from "@cockpit-chess/auth/roles";
import { buttonVariants } from "@cockpit-chess/ui/components/button";
import { cn } from "@cockpit-chess/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PAGE_COLUMN_CLASS } from "@/components/page-shell";
import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";
import { twoFactorEnrollmentState } from "@/utils/two-factor-policy";

/**
 * Nudges a signed-in admin who has not enrolled a TOTP second factor.
 *
 * Enrollment is REQUIRED for admins unless the owner has explicitly turned
 * `force2faInternalUsers` off, so this banner has three voices:
 *   - inside the enrollment grace window → required, with the deadline;
 *   - past it → the gates are already rejecting them, say so;
 *   - enforcement explicitly disabled → the original advisory nudge.
 * It always names where the policy is configured, because the owner reading
 * this banner is usually the person who can change it.
 *
 * Links to the existing /settings/security enrollment flow rather than
 * duplicating it. Rendered by the admin layout and by its pending skeleton.
 * Whether the band shows depends on the session alone (every unenrolled admin
 * sees one of the three voices); the settings only pick the copy. So while
 * they load (the admin route's loader, i.e. its skeleton) an unenrolled admin
 * gets a placeholder band of the same shape, never the wrong copy, and the
 * page does not jump when the real band replaces it. A failed settings load
 * hides the band, as before.
 */
export function TwoFactorNudge() {
  const { t, i18n } = useTranslation("admin");
  const authSession = useAuthSession();
  const user =
    authSession.state.status === "authenticated" ? authSession.state.session.user : undefined;
  // The pending skeleton renders before the admin guard has decided: a
  // non-admin never sees the admin band, nor asks for the admin settings.
  // Presentation only; the guard and the procedures enforce access.
  const admin = user !== undefined && isAdminRole(user.role);
  const { data: appSettings, isPending } = useQuery({
    ...orpc.settings.getAll.queryOptions(),
    enabled: admin,
  });

  if (!user || !admin) return null;
  if (user.twoFactorEnabled === true) return null;
  if (!appSettings) return isPending ? <NudgePlaceholder /> : null;

  const enrollment = twoFactorEnrollmentState(appSettings, user);
  if (enrollment.status === "enrolled") return null;

  const title =
    enrollment.status === "grace"
      ? t("twoFactorNudge.requiredTitle")
      : enrollment.status === "blocked"
        ? t("twoFactorNudge.blockedTitle")
        : t("twoFactorNudge.title");
  const message =
    enrollment.status === "grace"
      ? t("twoFactorNudge.requiredMessage", {
          deadline: formatRelativeTime(enrollment.deadlineMs, i18n.language),
        })
      : enrollment.status === "blocked"
        ? t("twoFactorNudge.blockedMessage")
        : t("twoFactorNudge.message");

  return <NudgeBand title={title} message={message} />;
}

const BAND_CLASS =
  "border-b border-yellow-300 bg-yellow-100 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100";
const BAND_ROW_CLASS = cn(PAGE_COLUMN_CLASS, "flex flex-col gap-3 sm:flex-row sm:items-start");

function NudgeBand({ title, message }: { title: string; message: string }) {
  const { t } = useTranslation("admin");
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  return (
    <div role="alert" className={BAND_CLASS}>
      <div className={BAND_ROW_CLASS}>
        <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="flex-1 space-y-1">
          <p className="font-medium">{title}</p>
          <p className="max-w-prose text-yellow-900/90 dark:text-yellow-100/90">{message}</p>
          <p className="max-w-prose text-yellow-900/80 dark:text-yellow-100/80">
            {t("twoFactorNudge.configurable")}
          </p>
        </div>
        <Link
          to="/$lang/settings/security"
          params={{ lang }}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-[44px]")}
        >
          {t("twoFactorNudge.cta")}
        </Link>
      </div>
    </div>
  );
}

/**
 * The band's slot while the settings load: the same box with the default
 * (required) copy set in transparent ink on pulsing bars, so it wraps like the
 * real band at every width and font size, and nothing reads it out.
 */
function NudgePlaceholder() {
  const { t } = useTranslation("admin");
  const bar =
    "w-fit max-w-full animate-pulse select-none rounded-md bg-yellow-900/10 text-transparent dark:bg-yellow-100/10";
  return (
    <div aria-hidden="true" data-nudge-placeholder="" className={BAND_CLASS}>
      <div className={BAND_ROW_CLASS}>
        <div className="mt-0.5 size-5 shrink-0" />
        <div className="flex-1 space-y-1">
          <p className={cn(bar, "font-medium")}>{t("twoFactorNudge.requiredTitle")}</p>
          <p className={cn(bar, "max-w-prose")}>{t("twoFactorNudge.message")}</p>
          <p className={cn(bar, "max-w-prose")}>{t("twoFactorNudge.configurable")}</p>
        </div>
        <div
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "invisible min-h-[44px]",
          )}
        >
          {t("twoFactorNudge.cta")}
        </div>
      </div>
    </div>
  );
}
