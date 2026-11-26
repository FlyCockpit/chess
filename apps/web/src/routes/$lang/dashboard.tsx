import { createFileRoute, redirect } from "@tanstack/react-router";

import { APP_HOME } from "@/lib/app-home";

/**
 * `/$lang/dashboard` was the signed-in welcome page before the arena became
 * the home for everyone (`APP_HOME`, lib/app-home.ts). Bookmarks and installed
 * shortcuts still point here, so this route only forwards them: no page, no
 * session lookup. It sits under `$lang`, so the redirect happens during SSR.
 */
export const Route = createFileRoute("/$lang/dashboard")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: APP_HOME, params: { lang: params.lang }, replace: true });
  },
});
