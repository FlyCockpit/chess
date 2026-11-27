import enErrors from "@cockpit-chess/locales/src/en-US/errors.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The 404's title is the page's one h1 in whichever shell renders it: the
 * public (arena) shell (an unknown URL or a hidden admin page, signed in or
 * not: `$lang`'s notFoundComponent) and the app shell (the router's
 * `defaultNotFoundComponent` for a not-found boundary inside it). The
 * shells' own chrome (header, nav, banners, footer) is rendered for real here
 * and must bring no heading of its own.
 */
const fixture = vi.hoisted(() => ({
  session: "anonymous" as "anonymous" | "authenticated",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route file's code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  Outlet: () => <NotFoundOutlet />,
  redirect: () => undefined,
  useParams: () => ({ lang: "en-US" }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn() }),
  useRouterState: () => undefined,
  useMatch: () => undefined,
  useMatches: () => [],
  useLocation: () => ({ pathname: "/en-US/nope" }),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/utils/orpc", () => {
  // Any `orpc.<router>.<procedure>` path, with the option builders the shell uses.
  const leaf = { queryOptions: () => ({}), queryKey: () => [], call: async () => ({}) };
  const node = (): unknown =>
    new Proxy(leaf, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : node()),
    });
  return { orpc: node() };
});
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(),
  getSessionCookieHint: vi.fn(async () => false),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () =>
    fixture.session === "anonymous"
      ? { state: { status: "anonymous" }, actions: { retry: vi.fn() }, meta: {} }
      : {
          state: {
            status: "authenticated",
            session: { user: { id: "u1", name: "Ada", role: "user", emailVerified: true } },
          },
          actions: { retry: vi.fn() },
          meta: { isDegraded: false },
        },
}));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({ useReloadOnIdentityChange: () => {} }));
vi.mock("@/hooks/use-session-hint-sync", () => ({ useSessionHintSync: () => {} }));
vi.mock("@/hooks/use-peer-session-change", () => ({ usePeerSessionChange: () => {} }));
vi.mock("@/i18n", () => ({ default: {}, loadLocaleInto: async () => {} }));

const { NotFoundPage } = await import("@/components/not-found-page");
function NotFoundOutlet() {
  return <NotFoundPage />;
}
const { PublicNotFoundPage } = await import("@/components/public-shell");
const { Route: AppRoute } = await import("@/routes/$lang/_app/route");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { errors: enErrors } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function h1s(html: string): string[] {
  expect(html).not.toContain('role="heading"');
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(([, inner = ""]) => inner);
}

function render(node: ReactNode) {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

type LazyComponent = (() => ReactNode) & { preload?: () => Promise<void> };
const AppLayout = (AppRoute as unknown as { options: { component: LazyComponent } }).options
  .component;
// Route components are code-split: load the real one before rendering it.
await AppLayout.preload?.();

describe.each(["anonymous", "authenticated"] as const)("404, %s", (session) => {
  it("has exactly one h1 inside the public shell", () => {
    fixture.session = session;
    expect(h1s(render(<PublicNotFoundPage />))).toEqual([enErrors.pageNotFound.title]);
  });

  it("has exactly one h1 inside the app shell", () => {
    fixture.session = session;
    expect(h1s(render(<AppLayout />))).toEqual([enErrors.pageNotFound.title]);
  });
});
