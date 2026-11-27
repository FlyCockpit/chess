import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enNav from "@cockpit-chess/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The header's account control (the ws-model-proxy shape): signed out, Sign Up
 * (when sign-up or the admin bootstrap is open) and Sign In are 44px named
 * icons below `sm:` and text from `sm:`; signed in, the trigger is a 44px
 * icon below `md:` and the name from `md:`; while the session is unknown,
 * a skeleton, never a Sign In. Rendered to static markup, so widths are
 * pinned through the breakpoint classes; real widths are checked in a browser.
 */
const fixture = vi.hoisted(() => ({
  offline: false,
  degraded: false,
  config: undefined as Record<string, unknown> | undefined,
  session: "anonymous" as "anonymous" | "authenticated" | "pending" | "error",
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    className,
    "aria-label": ariaLabel,
    children,
  }: {
    to: string;
    className?: string;
    "aria-label"?: string;
    children: ReactNode;
  }) => (
    <a data-to={to} className={className ?? ""} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixture.config, isPending: false }),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () =>
    fixture.session !== "authenticated"
      ? {
          state: { status: fixture.session },
          actions: { retry: vi.fn() },
          meta: { isOffline: fixture.offline, isDegraded: fixture.degraded },
        }
      : {
          meta: { isOffline: fixture.offline, isDegraded: fixture.degraded },
          actions: { retry: vi.fn() },
          state: {
            status: "authenticated",
            session: { user: { id: "u1", name: "Ada" } },
          },
        },
}));

const { default: UserMenu } = await import("./user-menu");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.config = { signupEnabled: true };
  fixture.session = "anonymous";
  fixture.offline = fixture.degraded = false;
});

const render = () =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UserMenu />
    </I18nextProvider>,
  );

function links(html: string) {
  return [...html.matchAll(/<a data-to="([^"]*)" class="([^"]*)" aria-label="([^"]*)">/g)].map(
    ([, to, className, label]) => ({ to, classes: (className ?? "").split(" "), label }),
  );
}

describe("signed out", () => {
  it("shows Sign Up and Sign In: 44px named icons below sm:, text from sm:", () => {
    const found = links(render());
    expect(found.map((link) => [link.to, link.label])).toEqual([
      ["/$lang/signup", enNav.userMenu.signUp],
      ["/$lang/login", enNav.userMenu.signIn],
    ]);
    for (const link of found) {
      expect(link.classes).toEqual(expect.arrayContaining(["w-11", "px-0", "sm:w-auto"]));
      expect(link.classes).not.toContain("hidden");
    }
  });

  it("offers Sign Up while only the admin bootstrap is open", () => {
    fixture.config = { signupEnabled: false, adminBootstrapSignupEnabled: true };
    expect(links(render()).map((link) => link.to)).toContain("/$lang/signup");
  });

  it("offers no Sign Up once sign-up and the bootstrap are closed", () => {
    fixture.config = { signupEnabled: false, adminBootstrapSignupEnabled: false };
    expect(links(render()).map((link) => link.to)).toEqual(["/$lang/login"]);
  });

  it("offers no Sign Up under forced SSO, even with open sign-up or the admin bootstrap", () => {
    for (const config of [
      { forceSso: true, signupEnabled: true, adminBootstrapSignupEnabled: false },
      { forceSso: true, signupEnabled: false, adminBootstrapSignupEnabled: true },
    ]) {
      fixture.config = config;
      expect(links(render()).map((link) => link.to)).toEqual(["/$lang/login"]);
    }
  });
});

describe("signed in", () => {
  it("is a 44px icon below md:, the name from md:, named by its visible name", () => {
    fixture.session = "authenticated";
    const html = render();
    const button = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? "";
    expect(button).toContain('aria-label="Ada, account menu"');
    expect(button).toContain('aria-haspopup="menu"');
    const classes = button.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(classes).toEqual(
      expect.arrayContaining(["w-11", "md:w-auto", "md:min-w-11", "md:max-w-48", "md:shrink"]),
    );
    expect(button).toMatch(/<svg[^>]*md:hidden/);
    expect(button).toContain('class="hidden truncate md:block">Ada<');
  });

  it("shows a skeleton while the session is unknown, never a Sign In", () => {
    for (const session of ["pending", "error"] as const) {
      fixture.session = session;
      expect(links(render())).toEqual([]);
    }
  });
});

describe("session availability", () => {
  it("shows Account unavailable with Retry and Sign out instead of a skeleton", () => {
    fixture.session = "error";
    const html = render();
    expect(html).toContain(enNav.userMenu.accountUnavailable);
    expect(html).toContain(enNav.userMenu.signOut);
    expect(html).not.toContain('data-slot="skeleton"');
  });
});

describe("offline and retained anonymous availability", () => {
  it("offers Retry and Sign out when offline before the first session answer", () => {
    fixture.session = "pending";
    fixture.offline = true;
    const html = render();
    expect(html).toContain(enNav.userMenu.accountUnavailable);
    expect(html).toContain('title="Retry"');
    expect(html).toContain(enNav.userMenu.signOut);
    expect(html).not.toContain('data-slot="skeleton"');
  });
  it("keeps availability controls for an anonymous session whose refetch failed", () => {
    fixture.session = "anonymous";
    fixture.degraded = true;
    const html = render();
    expect(html).toContain(enNav.userMenu.accountUnavailable);
    expect(links(html)).toEqual([]);
  });
});
