import { cn } from "@cockpit-chess/ui/lib/utils";
import { useParams } from "@tanstack/react-router";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

import { AppNameLink } from "./app-name-link";
import { LanguageSwitcher } from "./language-switcher";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
  // `strict: false` lets this component render under any route (including the
  // top-level `/` redirect) without throwing when the `lang` param is absent.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const isAuthenticated = useAuthSession().state.status === "authenticated";

  return (
    <header>
      <div className="flex min-w-0 flex-row flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        {/* The first thing in the row to give way (see AppNameLink). */}
        <AppNameLink lang={lang} />
        <MainNav />
        {/* The app name gives way first; once it is at its floor, the group
            moves to a line of its own. Signed in, the group stays on one line
            and the account trigger shrinks (to 44px) if even that line is too
            narrow. Signed out, Sign Up and Sign In cannot shrink, so the group
            wraps. */}
        <div
          className={cn(
            "ml-auto flex items-center gap-2",
            isAuthenticated ? "min-w-0" : "max-w-full flex-wrap justify-end",
          )}
        >
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
      <hr />
    </header>
  );
}
