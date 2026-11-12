import { env } from "@cockpit-chess/env/web";
import { Link, useParams } from "@tanstack/react-router";

import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

import { LanguageSwitcher } from "./language-switcher";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
  const appName = env.VITE_APP_NAME;
  // `strict: false` lets this component render under any route (including the
  // top-level `/` redirect) without throwing when the `lang` param is absent.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;

  return (
    <header>
      <div className="flex min-w-0 flex-row flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <Link
          to="/$lang"
          params={{ lang }}
          className="flex min-h-11 min-w-0 max-w-full items-center gap-2.5 font-semibold text-lg"
        >
          {/* Same artwork as the favicon and PWA icons; 192px stays sharp at 2-3x. */}
          <img
            src="/pwa-192x192.png"
            alt=""
            width={36}
            height={36}
            decoding="async"
            className="size-9 shrink-0"
          />
          <span className="min-w-0 max-w-40 truncate sm:max-w-56 lg:max-w-none">{appName}</span>
        </Link>
        <MainNav />
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
      <hr />
    </header>
  );
}
