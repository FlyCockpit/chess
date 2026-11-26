import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enDashboard from "@cockpit-chess/locales/src/en-US/dashboard.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
import esDashboard from "@cockpit-chess/locales/src/es-MX/dashboard.json";
import { createInstance } from "i18next";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_APP_NAME: "Board Lab" } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isPending: false, isError: false, refetch: vi.fn() }),
}));
const user = vi.hoisted(() => ({ role: "user" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useRouteContext: () => ({ session: { user: { id: "u1", name: "Ada", role: user.role } } }),
    useParams: () => ({ lang: "en-US" }),
  }),
  Link: ({ children, search }: { children: ReactNode; search?: { tab?: string } }) => (
    <a data-tab={search?.tab}>{children}</a>
  ),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: { settings: { getAll: { queryOptions: () => ({}) } } },
}));

import { Route } from "./dashboard";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { common: enCommon, dashboard: enDashboard },
      "es-MX": { common: esCommon, dashboard: esDashboard },
    },
    defaultNS: "common",
    react: { useSuspense: false },
  });
});

async function render(lng: string) {
  await i18n.changeLanguage(lng);
  const Component = Route.options.component;
  if (!Component) throw new Error("Missing dashboard component");
  await Component.preload?.();
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{createElement(Component)}</I18nextProvider>,
  );
}

it("titles the dashboard with one interpolated sentence per locale", async () => {
  const en = await render("en-US");
  expect(en).toContain("Welcome to Board Lab");
  expect(en).toContain("Welcome back, Ada");
  const es = await render("es-MX");
  expect(es).toContain("Te damos la bienvenida a Board Lab");
  expect(es).toContain("Bienvenido de vuelta, Ada");
});

it("shows the next step: the arena for everyone, Studio only for admins", async () => {
  user.role = "user";
  let html = await render("en-US");
  expect(html).toContain(enDashboard.next.arenaAction);
  expect(html).not.toContain(enDashboard.next.studioAction);
  user.role = "admin";
  html = await render("en-US");
  expect(html).toMatch(/<a data-tab="studio">Open Studio<\/a>/);
  user.role = "user";
});
