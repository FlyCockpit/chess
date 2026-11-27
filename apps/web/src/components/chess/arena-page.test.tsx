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
    fetchStatus: "idle" as "fetching" | "paused" | "idle",
    refetch: vi.fn(),
  },
  online: true,
  leaderboardOptions: undefined as
    | undefined
    | {
        input: (cursor: string | undefined) => { cursor?: string; limit: number };
        getNextPageParam: (page: { nextCursor: string | null }) => string | null;
      },
  leaderboard: {
    data: undefined as unknown,
    error: undefined as unknown,
    isPending: false,
    isError: false,
    fetchStatus: "idle" as "fetching" | "paused" | "idle",
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  },
  list: {
    data: { pages: [{ items: [] as Record<string, unknown>[] }] },
    isPending: false,
    isError: false,
    fetchStatus: "idle" as "fetching" | "paused" | "idle",
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => fixture.query,
  useInfiniteQuery: ({ surface }: { surface?: string }) =>
    surface === "leaderboard" ? fixture.leaderboard : fixture.list,
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      list: { infiniteOptions: () => ({}) },
      get: { queryOptions: () => ({}) },
      leaderboard: {
        infiniteOptions: (options: typeof fixture.leaderboardOptions) => {
          fixture.leaderboardOptions = options;
          return { ...options, surface: "leaderboard" };
        },
      },
      info: { queryOptions: () => ({}) },
    },
  },
}));
vi.mock("./replay", () => ({
  MatchReplay: ({ match }: { match: { config: { title: string } } }) => (
    <div data-testid="match-replay">{match.config.title}</div>
  ),
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => fixture.online }));
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
    fetchStatus: "idle",
  };
  fixture.online = true;
  fixture.leaderboard = {
    ...fixture.leaderboard,
    data: undefined,
    error: undefined,
    isPending: false,
    isError: false,
    fetchStatus: "idle",
    hasNextPage: false,
    isFetchingNextPage: false,
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
  expect(html).toContain(enChess.arena.gameRetry);
});
it("hides a selected replay on not-found or access loss and says the game is not available", () => {
  loadedReplay();
  fixture.query.error = { code: "NOT_FOUND" };
  const html = render("arena", "published");
  expect(html).not.toContain("Loaded replay");
  // Not a transient failure: no retry, a clear message and a way back to all games.
  expect(html).not.toContain(enChess.arena.retry);
  expect(html).toContain(enChess.arena.gameNotFound);
  expect(html).toContain(enChess.arena.gameNotFoundDescription);
  expect(html).toContain(`>${enChess.arena.all}</button>`);
});
function officialRow(overrides = {}) {
  return {
    scopeKey: "group-a",
    model: "Loaded model",
    protocol: "openai-chat",
    rulesKey: "a".repeat(16),
    initialPositionHash: "b".repeat(64),
    promptVersion: "1",
    promptHash: "c".repeat(64),
    billingCohort: "operator",
    opponentType: "model-v-model",
    moveFormat: "strict",
    games: 8,
    wins: 1,
    draws: 1,
    losses: 1,
    withdrawals: 1,
    pending: 1,
    providerErrors: 1,
    accountErrors: 1,
    infrastructureErrors: 1,
    points: 1.5,
    score: 1.5 / 8,
    illegalAttempts: 2,
    truncatedAttempts: 1,
    estimatedCostMicros: null,
    ...overrides,
  };
}
function loadedLeaderboard() {
  fixture.leaderboard.data = {
    pages: [{ items: [officialRow()], sampleSize: 8, nextCursor: null }],
  };
}
it("retains a leaderboard table during transient refetch errors", () => {
  loadedLeaderboard();
  fixture.leaderboard.isError = true;
  fixture.leaderboard.error = new Error("offline");
  const html = render("leaderboard");
  expect(html).toContain("Loaded model");
  expect(html).toContain("Try again");
});
it("uses all starts for points and shows withdrawals, pending starts and every error category", () => {
  loadedLeaderboard();
  const html = render("leaderboard");
  expect(html).toContain("18.8%"); // 1.5 points / 8 starts, not the scored-only 50%.
  expect(html).not.toContain("50%");
  expect(html).toContain("1.5 earned points");
  expect(html).toContain(enChess.leaderboard.provisional);
  for (const label of Object.values(enChess.leaderboard.categories)) {
    expect(html).toContain(`<dt>${label}</dt><dd>1</dd>`);
  }
  expect(html).toContain(enChess.leaderboard.costUnknown);
  expect(html).toContain(enChess.leaderboard.paginationNote);
  expect(html).not.toMatch(/latest 500|recent 500|windowLimit/i);
});
it("labels prompt, rules, starting position, payer and opponent type for each comparison group", () => {
  fixture.leaderboard.data = {
    pages: [
      {
        items: [officialRow({ billingCohort: "owner-openrouter", opponentType: "model-v-random" })],
        sampleSize: 8,
        nextCursor: null,
      },
    ],
  };
  const html = render("leaderboard").replaceAll("&#x27;", "'");
  expect(html).toContain("Prompt version 1");
  for (const hash of ["a".repeat(16), "b".repeat(64), "c".repeat(64)]) {
    expect(html).toContain(hash);
  }
  expect(html).toContain(enChess.leaderboard.billing.openrouter);
  expect(html).toContain(enChess.leaderboard.opponents.random);
  expect(html).toContain(enChess.moveFormats.strict);
});
it("loads bounded cursor pages of groups without treating later groups as lower ranks", () => {
  fixture.leaderboard.data = {
    pages: [
      { items: [officialRow()], sampleSize: 40, nextCursor: "next" },
      {
        items: [officialRow({ scopeKey: "group-b", model: "Second model", score: 0.9 })],
        sampleSize: 40,
        nextCursor: "more",
      },
    ],
  };
  fixture.leaderboard.hasNextPage = true;
  const html = render("leaderboard");
  expect(html).toContain("Loaded model");
  expect(html).toContain("Second model");
  expect(html.indexOf("Loaded model")).toBeLessThan(html.indexOf("Second model"));
  expect(html).toContain(enChess.leaderboard.loadMore);
  expect(html).toContain("all 40 accepted official matches");
  expect(fixture.leaderboardOptions?.input("next")).toEqual({ cursor: "next", limit: 25 });
  expect(fixture.leaderboardOptions?.getNextPageParam({ nextCursor: "more" })).toBe("more");
  expect(fixture.leaderboardOptions?.getNextPageParam({ nextCursor: null })).toBeNull();
});
it("hides cached official groups and pagination on access loss", () => {
  loadedLeaderboard();
  fixture.leaderboard.hasNextPage = true;
  fixture.leaderboard.isError = true;
  fixture.leaderboard.error = { code: "FORBIDDEN" };
  const html = render("leaderboard");
  expect(html).not.toContain("Loaded model");
  expect(html).not.toContain(enChess.leaderboard.loadMore);
});
it.each([false, true])(
  "offers no post-result official switch for a published hosted match (official=%s)",
  (official) => {
    loadedReplay();
    fixture.query.isError = false;
    fixture.query.error = undefined;
    fixture.query.data = {
      ...(fixture.query.data as object),
      source: "hosted",
      slug: "finished",
      official,
    };
    const html = render("arena", "finished");
    expect(html).toContain("Loaded replay");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("cc-official-toggle");
    expect(html).not.toContain("Counts on the leaderboard");
  },
);
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
it("puts a pending, failed or missing open game (skeleton, retry, notice) above the list too", () => {
  listWith("other", "published");
  fixture.query = { ...fixture.query, data: undefined, isPending: true };
  let html = render("arena", "published");
  expect(html.indexOf("h-96")).toBeGreaterThan(-1);
  expect(html.indexOf("h-96")).toBeLessThan(html.indexOf("Card other"));
  fixture.query = { ...fixture.query, isPending: false, isError: true, error: new Error("down") };
  html = render("arena", "published");
  expect(html.indexOf(enChess.arena.gameRetry)).toBeGreaterThan(-1);
  expect(html.indexOf(enChess.arena.gameRetry)).toBeLessThan(html.indexOf("Card other"));
  fixture.query = { ...fixture.query, error: { code: "NOT_FOUND" } };
  html = render("arena", "published");
  expect(html.indexOf(enChess.arena.gameNotFound)).toBeGreaterThan(-1);
  expect(html.indexOf(enChess.arena.gameNotFound)).toBeLessThan(html.indexOf("Card other"));
});
it("offline: an open game whose load is paused says so with Try again, not a skeleton forever", () => {
  listWith("other", "published");
  fixture.online = false;
  fixture.query = { ...fixture.query, data: undefined, isPending: true, fetchStatus: "paused" };
  const html = render("arena", "published");
  expect(html).not.toContain("h-96");
  const offline = html.indexOf(enChess.arena.offlineRetry);
  expect(offline).toBeGreaterThan(-1);
  // At the same place: right under the section bar, above the other games.
  expect(offline).toBeGreaterThan(html.indexOf(enChess.arena.title));
  expect(offline).toBeLessThan(html.indexOf("Card other"));
  expect(html).toMatch(/<button class="cc-error" type="button">You’re offline\./);
});
it("a paused load while the browser still reports online also leaves the skeleton", () => {
  fixture.query = { ...fixture.query, data: undefined, isPending: true, fetchStatus: "paused" };
  const html = render("arena", "published");
  expect(html).not.toContain("h-96");
  expect(html).toContain(enChess.arena.offlineRetry);
});
it("offline: a failed open game uses the offline copy too", () => {
  fixture.online = false;
  fixture.query = { ...fixture.query, isError: true, error: new TypeError("Failed to fetch") };
  const html = render("arena", "published");
  expect(html).toContain(enChess.arena.offlineRetry);
  expect(html).not.toContain(enChess.arena.retry);
});
it("offline: a paused first load of the game list says so instead of skeleton cards", () => {
  const list = fixture.list;
  fixture.online = false;
  fixture.list = {
    ...list,
    data: { pages: [] },
    isPending: true,
    fetchStatus: "paused",
  };
  const html = render("arena");
  fixture.list = list;
  expect(html).not.toContain("h-28");
  expect(html).toContain(enChess.arena.offlineRetry);
});

it("renders an old-rules list card without a replay button", () => {
  listWith("old");
  fixture.list.data.pages[0]!.items[0]!.oldRules = true;
  const html = render("arena");
  expect(html).toMatch(/<article[^>]*>(?:(?!<\/article>).)*Card old/);
  expect(html).toContain(enChess.arena.oldRules);
  expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*Card old/);
});
it("shows an old-rules deep link without a replay", () => {
  listWith();
  fixture.query.data = { id: "old", title: "Old game", archive: null, oldRules: true };
  const html = render("arena", "old");
  expect(html).toContain("Old game");
  expect(html).toContain(enChess.arena.oldRules);
  expect(html).toContain(enChess.arena.oldRulesDescription);
  expect(html).toContain(`>${enChess.arena.all}</button>`);
  expect(html).not.toContain('data-testid="match-replay"');
});
