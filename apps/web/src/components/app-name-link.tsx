import { env } from "@cockpit-chess/env/web";
import { Link } from "@tanstack/react-router";

/**
 * The app shell header's brand: the app icon and the app name, linking home.
 * (The arena's `.cc-header` brand in `$lang/_public/route.tsx` follows the same
 * rule in plain CSS: `.cc-brand` in `index.css`.)
 *
 * The brand only takes the room the rest of the row leaves it, so it is the
 * first thing to give way and the controls never run past the header's
 * trailing line, whatever the name's length, the width or the locale. Its flex
 * basis is 0 (`basis-0 grow`): it grows into what is left after the controls,
 * up to its own width (`max-w-fit`), and never below 88px (`min-w-22`: the
 * 36px icon, its 10px gap and about "Co…", so a squeezed name is never a lone
 * clipped letter, and the 44px target always holds). A shrink factor cannot
 * do this: CSS has no shrink order, and any factor still hands the controls a
 * fraction of a pixel, enough to cut the account name short. Below that floor
 * the header row wraps, as it always has: the controls move to their own
 * line, and the name gets the first line. With a MainNav in the row the two
 * share what is left. The span's caps (160px, 224px from `sm:`, 320px from `lg:`)
 * keep a long name from taking the MainNav's room. A name that does not fit
 * ends in an ellipsis (the `truncate` span: an ellipsis needs a block box, and
 * `truncate` on the inline-flex link only clips), and the full name is the
 * link's `title` and accessible name.
 */
export function AppNameLink({ lang }: { lang: string }) {
  const appName = env.VITE_APP_NAME;
  return (
    <Link
      to="/$lang"
      params={{ lang }}
      className="inline-flex min-h-11 min-w-22 max-w-fit grow basis-0 items-center gap-2.5 font-semibold text-lg"
      title={appName}
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
      <span className="min-w-0 max-w-40 truncate sm:max-w-56 lg:max-w-80">{appName}</span>
    </Link>
  );
}
