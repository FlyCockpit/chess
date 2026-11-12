import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enSettings from "@cockpit-chess/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  query: {
    data: undefined as { operationalAlerts: boolean } | undefined,
    error: undefined as unknown,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => fixture.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useRouteContext: () => ({
      session: { user: { id: "admin", name: "Admin", email: "admin@example.test", role: "admin" } },
    }),
  }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { updateUser: vi.fn() } }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    settings: {
      myNotificationPreferences: { queryOptions: () => ({}) },
      updateMyNotificationPreferences: { mutationOptions: () => ({}) },
    },
  },
}));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => null,
}));

import { Route } from "./index";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { common: enCommon, settings: enSettings } },
    defaultNS: "common",
    react: { useSuspense: false },
  });
});
async function preferences(data: { operationalAlerts: boolean } | undefined, error?: unknown) {
  fixture.query = { ...fixture.query, data, error, isError: Boolean(error) };
  const Component = Route.options.component;
  if (!Component) throw new Error("Missing profile component");
  await Component.preload?.();
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{createElement(Component)}</I18nextProvider>,
  );
}
it("does not invent editable preferences on a first-load failure", async () => {
  const html = await preferences(undefined, new Error("offline"));
  expect(html).toContain("Try again");
  expect(html).not.toContain('id="operational-alerts"');
});
it("keeps the actual false preference during a transient refetch failure", async () => {
  const html = await preferences({ operationalAlerts: false }, new Error("offline"));
  expect(html).toContain('id="operational-alerts"');
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain("Try again");
});
it("hides cached preferences when access is revoked", async () => {
  expect(await preferences({ operationalAlerts: true }, { status: 403 })).not.toContain(
    'id="operational-alerts"',
  );
});
