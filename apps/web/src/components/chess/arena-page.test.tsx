import { createMatch } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    error: undefined as unknown,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  list: {
    data: { pages: [{ items: [] as Record<string, unknown>[] }] },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => fixture.query,
  useInfiniteQuery: () => fixture.list,
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      list: { infiniteOptions: () => ({}) },
      get: { queryOptions: () => ({}) },
      leaderboard: { queryOptions: () => ({}) },
    },
  },
}));
vi.mock("./replay", () => ({
  MatchReplay: ({ match }: { match: { config: { title: string } } }) => (
    <div>{match.config.title}</div>
  ),
}));
vi.mock("./chess-board", () => ({ ChessBoard: () => null }));
vi.mock("./local-lab", () => ({ LocalLab: () => null }));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => null,
}));

import { ArenaPage } from "./arena-page";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.query = {
    ...fixture.query,
    data: undefined,
    error: undefined,
    isPending: false,
    isError: false,
  };
});
function render(tab: "arena" | "leaderboard", slug?: string) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ArenaPage tab={tab} slug={slug} onNavigate={vi.fn()} />
    </I18nextProvider>,
  );
}
function loadedReplay() {
  const archive = createMatch(
    {
      title: "Loaded replay",
      rules: {},
      white: { name: "White", model: "random", protocol: "random" },
      black: { name: "Black", model: "random", protocol: "random" },
    },
    "local",
  );
  fixture.query.data = { id: "loaded", archive };
  fixture.query.error = new Error("offline");
  fixture.query.isError = true;
}
it("retains a selected replay during a failed poll and exposes retry", () => {
  loadedReplay();
  const html = render("arena", "published");
  expect(html).toContain("Loaded replay");
  expect(html).toContain(enChess.arena.retry);
});
it("hides a selected replay on not-found or access loss", () => {
  loadedReplay();
  fixture.query.error = { code: "NOT_FOUND" };
  const html = render("arena", "published");
  expect(html).not.toContain("Loaded replay");
  expect(html).toContain(enChess.arena.retry);
});
it("retains a leaderboard table during transient refetch errors", () => {
  fixture.query.data = {
    items: [
      {
        model: "Loaded model",
        protocol: "openai-chat",
        rulesKey: "rules",
        games: 1,
        wins: 1,
        draws: 0,
        illegalAttempts: 0,
      },
    ],
    windowLimit: 100,
    sampleSize: 1,
  };
  fixture.query.isError = true;
  fixture.query.error = new Error("offline");
  const html = render("leaderboard");
  expect(html).toContain("Loaded model");
  expect(html).toContain("Try again");
});
function listWith(...slugs: string[]) {
  fixture.list = {
    ...fixture.list,
    data: {
      pages: [
        {
          items: slugs.map((slug) => ({
            id: slug,
            slug,
            title: `Card ${slug}`,
            status: "finished",
            whiteName: "W",
            blackName: "B",
            ending: null,
            contextMode: "fresh",
            official: false,
          })),
        },
      ],
    },
  };
}
it("shows an open game right under the section bar, before the other games, and marks its card", () => {
  loadedReplay();
  fixture.query.error = undefined;
  fixture.query.isError = false;
  listWith("other", "published");
  const html = render("arena", "published");
  const replay = html.indexOf("Loaded replay");
  expect(replay).toBeGreaterThan(html.indexOf(enChess.arena.title));
  expect(replay).toBeLessThan(html.indexOf("Card other"));
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-current="true"[^>]*>(?:(?!<\/button>).)*Card published/);
});
it("leads with the list and follows with the demonstration when no game is open", () => {
  listWith("other");
  const html = render("arena");
  expect(html.indexOf("Card other")).toBeLessThan(html.indexOf(enChess.arena.demoTitle));
  expect(html).not.toContain('aria-current="true"');
});
it("puts a pending or failed open game (skeleton, retry) above the list too", () => {
  listWith("other", "published");
  fixture.query = { ...fixture.query, data: undefined, isPending: true };
  let html = render("arena", "published");
  expect(html.indexOf("h-96")).toBeGreaterThan(-1);
  expect(html.indexOf("h-96")).toBeLessThan(html.indexOf("Card other"));
  fixture.query = { ...fixture.query, isPending: false, error: { code: "NOT_FOUND" } };
  html = render("arena", "published");
  expect(html.indexOf(enChess.arena.retry)).toBeGreaterThan(-1);
  expect(html.indexOf(enChess.arena.retry)).toBeLessThan(html.indexOf("Card other"));
});
