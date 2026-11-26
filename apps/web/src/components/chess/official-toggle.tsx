import { hasRole } from "@cockpit-chess/auth/roles";
import { Switch } from "@cockpit-chess/ui/components/switch";
import { useTranslation } from "react-i18next";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

/**
 * Admins curate the leaderboard: a published hosted game counts only while it is
 * official (`chess.setOfficial`). Renders nothing for anyone else. Lazy-loaded by the
 * arena so the public landing chunk never carries the auth client.
 */
export function OfficialToggle({ slug, official }: { slug: string; official: boolean }) {
  const { t } = useTranslation("chess");
  const { state } = useAuthSession();
  const admin = state.status === "authenticated" && hasRole(state.session.user.role ?? "", "admin");
  const mutation = useEntityMutation(orpc.chess.setOfficial.mutationOptions(), {
    invalidateKey: orpc.chess.key(),
  });
  if (!admin) return null;
  const checked = mutation.isPending ? Boolean(mutation.variables?.official) : official;
  return (
    <div className="cc-official-toggle">
      <label className="cc-official-switch">
        <Switch
          checked={checked}
          disabled={mutation.isPending}
          onCheckedChange={(next) => mutation.mutate({ slug, official: next })}
        />
        <span>{t("studio.officialLabel")}</span>
      </label>
      <p className="cc-field-hint">
        {mutation.isSuccess
          ? t(mutation.data.official ? "studio.officialOn" : "studio.officialOff")
          : t("studio.officialHint")}
      </p>
      {mutation.isError && (
        <p role="alert" className="cc-error">
          {t("studio.error")}
        </p>
      )}
    </div>
  );
}
