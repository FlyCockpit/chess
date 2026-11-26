import enAdmin from "@cockpit-chess/locales/src/en-US/admin.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The 2FA nudge holds its slot while the app settings load, so the admin
 * skeleton (which renders it too) and the page have the same band, and the
 * page does not jump down when it replaces the skeleton.
 */
const fixture = vi.hoisted(() => ({
  settings: undefined as Record<string, string> | undefined,
  isPending: true,
  twoFactorEnabled: false as boolean | null,
  role: "admin",
  queryEnabled: undefined as boolean | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled?: boolean }) => {
    fixture.queryEnabled = options.enabled;
    return { data: fixture.settings, isPending: fixture.isPending };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: { settings: { getAll: { queryOptions: () => ({}) } } },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      status: "authenticated",
      session: {
        user: {
          role: fixture.role,
          twoFactorEnabled: fixture.twoFactorEnabled,
          createdAt: new Date(Date.now() - 60_000),
        },
        session: { id: "s1" },
      },
    },
  }),
}));

const { TwoFactorNudge } = await import("./two-factor-nudge");
const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { admin: enAdmin } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

beforeEach(() => {
  fixture.settings = undefined;
  fixture.isPending = true;
  fixture.twoFactorEnabled = false;
  fixture.role = "admin";
  fixture.queryEnabled = undefined;
});

function render(): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TwoFactorNudge />
    </I18nextProvider>,
  );
}

describe("TwoFactorNudge", () => {
  it("shows nothing to a non-admin (the skeleton renders before the admin guard) and asks for no admin settings", () => {
    fixture.role = "user";
    expect(render()).toBe("");
    expect(fixture.queryEnabled).toBe(false);
  });

  it("reserves the band, hidden from assistive tech, while the settings load", () => {
    const html = render();
    expect(html).toContain("data-nudge-placeholder");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="alert"');
    // Same copy shape as the real band, so it wraps to the same height.
    expect(html).toContain(enAdmin.twoFactorNudge.configurable);
  });

  it("shows the real band once the settings arrive", () => {
    fixture.settings = {};
    fixture.isPending = false;
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain(enAdmin.twoFactorNudge.requiredTitle);
    expect(html).not.toContain("data-nudge-placeholder");
  });

  it("reserves nothing for an enrolled admin or after a failed load", () => {
    fixture.twoFactorEnabled = true;
    expect(render()).toBe("");
    fixture.twoFactorEnabled = false;
    fixture.isPending = false;
    expect(render()).toBe("");
  });
});
