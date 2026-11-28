import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ info: undefined as unknown, lang: "en-US" }));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: fixture.lang }),
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: { lang: string };
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to.replace("$lang", params.lang)} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: fixture.info }) }));
vi.mock("@/utils/orpc", () => ({ orpc: { chess: { info: { queryOptions: () => ({}) } } } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => null,
}));

const { PublicFooter } = await import("./public-footer");

it("links the running commit's source (AGPL-3.0 section 13) in a new tab", () => {
  fixture.info = { sourceCodeUrl: "https://github.com/FlyCockpit/chess/tree/0123abc" };
  const html = renderToStaticMarkup(<PublicFooter />);
  expect(html).toContain(
    '<a href="https://github.com/FlyCockpit/chess/tree/0123abc" target="_blank" rel="noopener noreferrer">common:sourceCode</a>',
  );
});
it("renders the footer without the link until the server answers", () => {
  fixture.info = undefined;
  expect(renderToStaticMarkup(<PublicFooter />)).not.toContain("sourceCode");
});

it.each(["en-US", "es-MX"])(
  "keeps legal links available in %s before configuration loads",
  (lang) => {
    fixture.lang = lang;
    fixture.info = undefined;
    const html = renderToStaticMarkup(<PublicFooter />);
    for (const page of ["terms", "privacy", "licenses"]) {
      expect(html).toContain(`href="/${lang}/${page}"`);
    }
    expect(html).toContain('aria-label="common:legal.navigation"');
    expect(html.match(/min-h-11/g)).toHaveLength(3);
  },
);
