import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ keyboard: vi.fn() }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: fixture.keyboard }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
  useQuery: () => ({ isPending: true }),
  useMutation: () => ({}),
}));
vi.mock("@tanstack/react-form", () => ({ useForm: () => ({}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./chess-board", () => ({ ChessBoard: () => null }));
vi.mock("./replay", () => ({ MatchReplay: () => null }));

afterEach(() => vi.unstubAllGlobals());

it("mounts keyboard tracking and shares inset spacing with the hosted main scrollers", async () => {
  vi.stubGlobal("location", { origin: "http://localhost:3000" });
  const { LocalModelLab } = await import("./local-model-lab");
  const html = renderToStaticMarkup(<LocalModelLab />);
  expect(fixture.keyboard).toHaveBeenCalledOnce();
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html).toContain('id="main-content"');
  expect(html).toContain("overflow-y-auto overflow-x-clip");
  // CSS is the shared shell contract; server rendering does not compute layout.
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const mainRule = css.match(/#main-content\s*\{([^}]+)\}/)?.[1];
  expect(mainRule).toContain("padding-bottom: var(--keyboard-inset, 0px)");
  expect(mainRule).toContain("scroll-padding-bottom: var(--keyboard-inset, 0px)");
});
