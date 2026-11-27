import enAuth from "@cockpit-chess/locales/src/en-US/auth.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enNav from "@cockpit-chess/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every auth page has exactly one h1, its card's title (`AuthCard`), in each
 * of its states, and no `role="heading"` stand-in: sign-in, sign-up, forgot
 * and reset password, verify email, the "unable to connect" card, the forced
 * 2FA takeover and the CLI device approval page. Route files cannot hold
 * tests, so the routes are rendered from here.
 */
const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route files' code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => fixture.search,
    useRouteContext: () => ({ session: { user: { id: "u1", role: "admin" } } }),
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn() }),
  useParams: () => ({ lang: "en-US" }),
  Outlet: () => null,
  Link: ({ className, children }: { className?: string; children: ReactNode }) => (
    <a className={className ?? ""}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: fixture.config, isPending: false, isError: false, refetch: vi.fn() }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: { queryOptions: () => ({}), queryKey: () => ["appConfig"], call: async () => ({}) },
    settings: { getAll: { queryOptions: () => ({}) } },
    setup: { claimFirstAdmin: { mutationOptions: () => ({}) } },
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" }, actions: { retry: vi.fn() } }),
}));
vi.mock("@/hooks/use-peer-session-change", () => ({ usePeerSessionChange: () => {} }));
vi.mock("@/utils/two-factor-policy", () => ({
  twoFactorEnrollmentState: () => ({ status: "blocked" }),
}));
vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(async () => ({ status: "resolved", session: null })),
  getSessionCookieHint: vi.fn(async () => false),
}));

const { AuthConfigGate } = await import("@/components/auth/auth-config-gate");
const routes = {
  login: (await import("@/routes/$lang/_app/login")).Route,
  signup: (await import("@/routes/$lang/_app/signup")).Route,
  forgot: (await import("@/routes/$lang/_app/forgot-password")).Route,
  reset: (await import("@/routes/$lang/_app/reset-password")).Route,
  verify: (await import("@/routes/$lang/_app/verify-email")).Route,
  auth: (await import("@/routes/$lang/_app/_auth")).Route,
  device: (await import("@/routes/$lang/_app/_auth/device")).Route,
};

type LazyComponent = (() => ReactNode) & { preload?: () => Promise<void> };
const component = (route: unknown) =>
  (route as { options: { component: LazyComponent } }).options.component;
// Route components are code-split: load the real ones before rendering them.
for (const route of Object.values(routes)) await component(route).preload?.();

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { auth: enAuth, common: enCommon, nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.config = undefined;
  fixture.search = {};
});

function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

/** The text of every h1 in the markup; no ARIA stand-ins for a heading. */
function h1s(html: string): string[] {
  expect(html).not.toContain('role="heading"');
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(([, inner = ""]) =>
    inner.replace(/<[^>]*>/g, ""),
  );
}

const OPEN = { signupEnabled: true, adminBootstrapSignupEnabled: false, emailEnabled: true };
const FORCE_SSO = { signupEnabled: true, forceSso: true, ssoEnabled: true };

describe("one h1 per auth page: the card's title", () => {
  it.each([
    ["sign-in", routes.login, OPEN, {}, enAuth.login.signinTitle],
    ["sign-up", routes.signup, OPEN, {}, enAuth.login.createAccount],
    ["sign-up, SSO required", routes.signup, FORCE_SSO, {}, enAuth.login.ssoRequiredTitle],
    ["forgot password", routes.forgot, OPEN, {}, enAuth.forgotPassword.title],
    ["reset password", routes.reset, OPEN, { token: "t" }, enAuth.resetPassword.title],
    ["reset password, bad link", routes.reset, OPEN, {}, enAuth.resetPassword.invalidTitle],
    [
      "set password, bad link",
      routes.reset,
      OPEN,
      { setup: 1 },
      enAuth.resetPassword.setup.invalidTitle,
    ],
    ["verify email", routes.verify, OPEN, {}, enAuth.verifyEmail.pendingTitle],
    ["verify email, done", routes.verify, OPEN, { ok: 1 }, enAuth.verifyEmail.successTitle],
    ["forced 2FA takeover", routes.auth, {}, {}, enAuth.twoFactor.requiredTitle],
    ["CLI device approval", routes.device, OPEN, {}, enAuth.device.title],
  ])("%s", (_name, route, config, search, title) => {
    fixture.config = config;
    fixture.search = search;
    const Page = component(route);
    expect(h1s(render(<Page />))).toEqual([title]);
  });

  it("unable to connect", () => {
    const html = render(
      <AuthConfigGate isPending={false} isError onRetry={() => {}}>
        <p>form</p>
      </AuthConfigGate>,
    );
    expect(h1s(html)).toEqual([enAuth.login.unableToConnect]);
  });
});
