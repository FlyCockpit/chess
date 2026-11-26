/**
 * The signed-in home: where a signed-in user lands when they finish signing
 * in, verify their email, or open the old `/$lang/dashboard` URL.
 *
 * In this app the home is the arena itself (`/$lang/`): it is public and the
 * same for everyone, with no per-user objects to list, and Studio, the admins'
 * match-creation surface, is one of its tabs. So a signed-in visitor is never
 * sent away from the landing page; the public header shows them an account
 * link instead of a way to sign in (components/public-shell.tsx).
 *
 * This is the one place to change it. The old `/$lang/dashboard` URL forwards
 * here (`routes/$lang/dashboard.tsx`).
 */
export const APP_HOME = "/$lang" as const;

/** {@link APP_HOME} as a concrete href for one locale, e.g. `/en-US`. */
export function appHomeHref(lang: string): string {
  return APP_HOME.replace("$lang", lang);
}
