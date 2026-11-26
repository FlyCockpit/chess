import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ info: undefined as unknown }));
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
