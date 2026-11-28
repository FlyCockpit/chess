import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  lang: "en-US",
  info: undefined as { sourceCodeUrl: string } | undefined,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: fixture.lang }),
  }),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params: { lang: string };
    children: ReactNode;
  }) => <a href={to.replace("$lang", params.lang)}>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: fixture.info }) }));
vi.mock("@/utils/orpc", () => ({ orpc: { chess: { info: { queryOptions: () => ({}) } } } }));

const routes = {
  terms: (await import("@/routes/$lang/_public/terms")).Route,
  privacy: (await import("@/routes/$lang/_public/privacy")).Route,
  licenses: (await import("@/routes/$lang/_public/licenses")).Route,
};
type LazyComponent = (() => ReactNode) & { preload?: () => Promise<void> };
const options = (route: unknown) =>
  (route as { options: { component: LazyComponent; beforeLoad?: unknown } }).options;
for (const route of Object.values(routes)) await options(route).component.preload?.();
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { common: enCommon }, "es-MX": { common: esCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

async function render(page: keyof typeof routes, lang: string) {
  fixture.lang = lang;
  await i18n.changeLanguage(lang);
  const Page = options(routes[page]).component;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Page />
    </I18nextProvider>,
  );
}

describe.each([
  ["en-US", enCommon],
  ["es-MX", esCommon],
] as const)("public legal pages in %s", (lang, copy) => {
  it.each(["terms", "privacy", "licenses"] as const)(
    "renders %s without auth or another scroller",
    async (page) => {
      fixture.info = undefined;
      const html = await render(page, lang);
      expect(html).toContain(copy.legal[page].title);
      expect(html).toContain(copy.legal.reviewNotice);
      expect(html).toContain(copy.legal.updated);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toContain("<article");
      expect(html).not.toMatch(/<main\b|<nav\b|overflow-y|PENDING|OWNER\/COUNSEL/);
      expect(html).not.toMatch(/legal\.[a-z]+\.(title|body)/);
      expect(options(routes[page]).beforeLoad).toBeUndefined();
    },
  );

  it("provides a real single contact and locale-preserving cross-links", async () => {
    const html = await render("terms", lang);
    expect(html).toContain('href="mailto:contact@flycockpit.app"');
    expect(html).toContain(`href="/${lang}/privacy"`);
    expect(html).toContain(`href="/${lang}/licenses"`);
    expect(await render("privacy", lang)).toContain(`href="/${lang}/terms"`);
  });

  it("serves engine source and GPL links even before the API answers", async () => {
    fixture.info = undefined;
    const html = await render("licenses", lang);
    expect(html).toContain('href="/third-party/stockfish/stockfish-19.0.1-source.tar.gz"');
    expect(html).toContain('href="/third-party/stockfish/Copying.txt"');
    expect(html).toContain('href="/third-party/stockfish/AUTHORS"');
    fixture.info = { sourceCodeUrl: "https://github.com/FlyCockpit/chess/tree/0123abc" };
    expect(await render("licenses", lang)).toContain(`href="${fixture.info.sourceCodeUrl}"`);
  });
});

it("has complete parallel legal locale keys and interpolation placeholders", () => {
  const leaves = (value: unknown, prefix = ""): Record<string, string> => {
    if (typeof value === "string") return { [prefix]: value };
    if (!value || typeof value !== "object") throw new Error(`Invalid locale leaf: ${prefix}`);
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        Object.entries(leaves(child, `${prefix}.${key}`)),
      ),
    );
  };
  const en = leaves(enCommon.legal);
  const es = leaves(esCommon.legal);
  expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    expect(es[key]?.trim()).toBeTruthy();
    expect(es[key]?.match(/\{\{[^}]+\}\}/g) ?? []).toEqual(value.match(/\{\{[^}]+\}\}/g) ?? []);
  }
});
