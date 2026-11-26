import { createFileRoute } from "@tanstack/react-router";

import { OpenRouterSettings } from "@/components/openrouter/openrouter-settings";
import { callbackNotice, parseOpenRouterSearch } from "@/lib/openrouter-connect";

/**
 * Settings → OpenRouter: connect the user's own OpenRouter account (OAuth PKCE,
 * apps/server/src/openrouter-routes.ts) so hosted matches bill their key. The
 * callback redirects here with `?connected=1` or `?error=<code>`.
 */
export const Route = createFileRoute("/$lang/_app/_auth/settings/openrouter")({
  staticData: { pendingShape: "form" },
  validateSearch: parseOpenRouterSearch,
  component: OpenRouterSettingsPage,
});

function OpenRouterSettingsPage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <OpenRouterSettings
      lang={lang}
      notice={callbackNotice(search)}
      onDismissNotice={() => void navigate({ search: {}, replace: true, resetScroll: false })}
    />
  );
}
