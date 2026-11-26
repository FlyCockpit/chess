import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enNav from "@cockpit-chess/locales/src/en-US/nav.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public pages' session-cookie hint as one shared query: seeded by the
 * `_public` layout during SSR, read by the arena header (and the 404's).
 * Uses the real React Query, so "seeded" means what SSR does: the data is in
 * the request's QueryClient before the header renders.
 */
const hint = vi.hoisted(() => ({ getSessionCookieHint: vi.fn(async () => false) }));
vi.mock("@/server/auth-session", () => hint);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route file's code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a data-to={to}>{children}</a>,
  Outlet: () => null,
  useParams: () => "en-US",
}));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/public-footer", () => ({ PublicFooter: () => <footer /> }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));

const { ensureSessionHint, sessionHintQueryOptions, setSessionHint, SESSION_HINT_QUERY_KEY } =
  await import("./session-hint");
const { PublicShell } = await import("@/components/public-shell");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  hint.getSessionCookieHint.mockReset();
  hint.getSessionCookieHint.mockResolvedValue(false);
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderHeader(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PublicShell>
          <p>page</p>
        </PublicShell>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const ACCOUNT_LINK = 'data-to="/$lang/settings"';

describe("session hint query", () => {
  it("asks the server once, then reads the cache", async () => {
    hint.getSessionCookieHint.mockResolvedValue(true);
    const queryClient = newClient();
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).toHaveBeenCalledTimes(1);
    expect(sessionHintQueryOptions().queryKey).toEqual(SESSION_HINT_QUERY_KEY);
  });

  it("never decides on a stale answer: it waits for a fresh one", async () => {
    const queryClient = newClient();
    // Signed out a while ago (older than the staleTime) ...
    queryClient.setQueryData(SESSION_HINT_QUERY_KEY, false, { updatedAt: Date.now() - 120_000 });
    // ... and signed in since, in another tab.
    hint.getSessionCookieHint.mockResolvedValue(true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).toHaveBeenCalledTimes(1);
  });

  it("does not pause while the browser reports offline (it fails fast to signed out)", async () => {
    const { onlineManager } = await import("@tanstack/react-query");
    onlineManager.setOnline(false);
    try {
      expect(sessionHintQueryOptions().networkMode).toBe("always");
      hint.getSessionCookieHint.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(ensureSessionHint(newClient())).resolves.toBe(false);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("reads a failed hint as signed out instead of throwing", async () => {
    hint.getSessionCookieHint.mockRejectedValue(new Error("offline"));
    await expect(ensureSessionHint(newClient())).resolves.toBe(false);
  });

  it("follows what the app's session checks learned", async () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });

  it("is seeded by the _public layout's beforeLoad", async () => {
    hint.getSessionCookieHint.mockResolvedValue(true);
    const queryClient = newClient();
    const { beforeLoad } = (
      PublicRoute as unknown as {
        options: { beforeLoad: (ctx: { context: { queryClient: QueryClient } }) => Promise<void> };
      }
    ).options;
    await beforeLoad({ context: { queryClient } });
    expect(queryClient.getQueryData(SESSION_HINT_QUERY_KEY)).toBe(true);
  });
});

describe("arena header, rendered on the server", () => {
  it("with a seeded 'signed in' hint: the account link, and no Sign In", () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    const html = renderHeader(queryClient);
    expect(html).toContain(ACCOUNT_LINK);
    expect(html).not.toContain(enNav.userMenu.signIn);
    expect(html).not.toContain('data-to="/$lang/login"');
  });

  it("with a seeded 'signed out' hint: no account link", () => {
    const queryClient = newClient();
    setSessionHint(queryClient, false);
    expect(renderHeader(queryClient)).not.toContain(ACCOUNT_LINK);
  });

  // The 404 has no `_public` route to seed it: the server renders the
  // anonymous header (identical for everyone) and the client asks afterwards.
  it("without a seed (the 404): the anonymous header, and no server call during the render", () => {
    const html = renderHeader(newClient());
    expect(html).not.toContain(ACCOUNT_LINK);
    expect(html).not.toContain('data-to="/$lang/login"');
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });
});
