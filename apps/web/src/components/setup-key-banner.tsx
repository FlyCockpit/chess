import { isAdminRole } from "@cockpit-chess/auth/roles";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { orpc } from "@/utils/orpc";

/**
 * Tells admins to remove SETUP_KEY once it has done its job. While it is set,
 * the server keeps the first-admin setup route (apps/server/src/setup-routes.ts)
 * mounted; the route refuses once an admin exists, but the key is still a live
 * credential sitting in the deploy's environment.
 *
 * Admin-only on both sides: the query is an admin procedure, and it is not even
 * sent unless the session is a verified admin. Renders nothing while loading or
 * on error — this is a reminder, not a gate.
 */
export function SetupKeyBanner() {
  const { t } = useTranslation("admin");
  const authSession = useAuthSession();
  const user = authSession.state.status === "authenticated" ? authSession.state.session.user : null;
  const isAdmin =
    !authSession.meta.isDegraded && user?.emailVerified === true && isAdminRole(user.role);
  // SETUP_KEY only changes on a redeploy; no need to ask on every navigation.
  const { data } = useQuery({
    ...orpc.settings.setupKeyStatus.queryOptions(),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  if (!isAdmin || !data?.setupKeySet) return null;

  return (
    <div
      role="alert"
      className="border-b border-yellow-300 bg-yellow-100 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
    >
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{t("setupKeyBanner.title")}</p>
          <p className="text-yellow-900/90 dark:text-yellow-100/90">
            <Trans
              i18nKey="setupKeyBanner.message"
              t={t}
              components={[<code key="0" className="font-mono" />]}
            />
          </p>
        </div>
      </div>
    </div>
  );
}
