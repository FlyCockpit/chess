import { isSupportedLocale } from "@/i18n/config";
import { homeSearchSchema } from "@/lib/home-search";

/**
 * The pages that hold no account data, as an explicit allowlist: the arena
 * home (`/$lang/`, `routes/$lang/_public/index.tsx`) on its public tabs. They
 * render only public procedures (`chess.list`, `chess.get`,
 * `chess.leaderboard`: the same answer for every visitor), the session-cookie
 * hint and device-local state such as the Lab's imported archive. The Studio
 * tab is not on it (it shows the signed-in account's own games), nor is any
 * other page.
 *
 * When a different identity is confirmed while such a page is open, the
 * document drops its account state in place instead of reloading, so the
 * visitor's device-local work survives (lib/document-identity.ts,
 * `replaceDocument`). Add a page here only if nothing on it reads account data.
 * docs/auth-and-routing.md § Query cache follows identity.
 */
const ACCOUNT_FREE_TABS: ReadonlySet<string> = new Set([
  "arena",
  "leaderboard",
  "lab",
  "methodology",
]);

type LocationLike = { pathname: string; search: unknown };

export function holdsNoAccountData(location: LocationLike): boolean {
  const segments = location.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || !isSupportedLocale(segments[0])) return false;
  // The page's own search contract: a missing or mistyped tab lands on the arena.
  const parsed = homeSearchSchema.safeParse(location.search ?? {});
  const tab = (parsed.success ? parsed.data.tab : undefined) ?? "arena";
  return ACCOUNT_FREE_TABS.has(tab);
}
