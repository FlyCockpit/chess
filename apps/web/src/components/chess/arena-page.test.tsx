import { createMatch } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import esChess from "@cockpit-chess/locales/src/es-MX/chess.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
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
  visibility: {
    replayOptions: {},
    unavailable: false,
    error: undefined as unknown,
    beforeExport: vi.fn(async () => true),
    retry: vi.fn(),
  },
  executionSource: undefined as string | undefined,
  beforeExport: undefined as (() => Promise<boolean>) | undefined,
  listOptions: undefined as
    | undefined
    | {
        input: (cursor: string | undefined) => {
          cursor?: string;
          limit: number;
          category?: string;
        };
      },
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
      list: {
        infiniteOptions: (options: typeof fixture.listOptions) => {
          fixture.listOptions = options;
          return {};
        },
      },
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
  MatchReplay: ({
    match,
    beforeExport,
    executionSource,
  }: {
    match: { config: { title: string } };
    beforeExport?: () => Promise<boolean>;
    executionSource?: string;
  }) => {
    fixture.executionSource = executionSource;
    fixture.beforeExport = beforeExport;
    return <div data-testid="match-replay">{match.config.title}</div>;
  },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => fixture.online }));
vi.mock("@/hooks/use-replay-visibility", () => ({ useReplayVisibility: () => fixture.visibility }));
vi.mock("./replay-report-dialog", () => ({
  ReplayReportDialog: () => <button type="button">Report replay</button>,
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
    resources: {
      "en-US": { chess: enChess, common: enCommon },
      "es-MX": { chess: esChess, common: esCommon },
    },
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
  fixture.visibility = { ...fixture.visibility, unavailable: false, error: undefined };
  fixture.beforeExport = undefined;
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
function render(
  tab: "arena" | "leaderboard" | "methodology" | "lab",
  slug?: string,
  props: Partial<Parameters<typeof ArenaPage>[0]> = {},
) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ArenaPage tab={tab} slug={slug} onNavigate={vi.fn()} {...props} />
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
it("clears a finished selected replay and report controls when the lightweight visibility check refuses it", () => {
  loadedReplay();
  fixture.visibility.unavailable = true;
  const html = render("arena", "published");
  expect(html).not.toContain("Loaded replay");
  expect(html).not.toContain("Report replay");
  expect(html).toContain(enChess.arena.gameNotFound);
});
it("keeps loaded content on a transient visibility error and requires fresh authority for exports", () => {
  loadedReplay();
  fixture.visibility.error = new Error("network unavailable");
  const html = render("arena", "published");
  expect(html).toContain("Loaded replay");
  expect(html).toContain("Report replay");
  expect(html).toContain(enChess.moderation.visibilityFailed);
  expect(fixture.beforeExport).toBe(fixture.visibility.beforeExport);
});
it("keeps the offline demonstration independent of hosted export authority", () => {
  render("arena");
  expect(fixture.beforeExport).toBeUndefined();
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

it("passes the server runner source to a public replay independently of its local archive source", () => {
  loadedReplay();
  fixture.query.data = { ...(fixture.query.data as object), source: "runner" };
  render("arena", "published");
  expect(fixture.executionSource).toBe("runner");
  fixture.query.data = { ...(fixture.query.data as object), source: "local" };
  render("arena", "published");
  expect(fixture.executionSource).toBe("local");
});

it("passes URL comparison filters into every bounded results page and clears old cursor on a new scope", () => {
  loadedLeaderboard();
  const filter = {
    promptVersion: "1",
    rulesKey: "a".repeat(16),
    initialPositionHash: "b".repeat(64),
    billingCohort: "operator" as const,
    opponentType: "model-v-random" as const,
  };
  const html = render("leaderboard", undefined, { resultsFilter: filter });
  expect(fixture.leaderboardOptions?.input("page-two")).toEqual({
    ...filter,
    cursor: "page-two",
    limit: 25,
  });
  expect(html).toContain(enChess.leaderboard.clearFilters);
  expect(html).toContain(enChess.leaderboard.scopeFiltered);
  render("leaderboard", undefined, { resultsFilter: { promptVersion: "2" } });
  expect(fixture.leaderboardOptions?.input(undefined)).toEqual({
    promptVersion: "2",
    cursor: undefined,
    limit: 25,
  });
});
it("shows bounded registry prompt choices and a retry without hiding loaded results", () => {
  loadedLeaderboard();
  fixture.query.data = { promptVersions: [{ version: "1", hash: "abc" }] };
  const html = render("leaderboard", undefined, { resultsFilter: { promptVersion: "1" } });
  expect(html).toContain('value="1" selected=""');
  expect(html).toContain(enChess.leaderboard.filterPrompt);
  expect(html).toContain(enChess.leaderboard.allPrompts);
  expect(html).toContain(enChess.leaderboard.filterScope);
  fixture.query.error = new Error("network");
  const failed = render("leaderboard");
  expect(failed).toContain(enChess.leaderboard.promptRetry);
  expect(failed).toContain("Loaded model");
});
it("requests a bounded vs-humans list and labels hosted and self-run sources", () => {
  listWith("hosted", "runner");
  fixture.list.data.pages[0]!.items[0]!.source = "hosted";
  fixture.list.data.pages[0]!.items[1]!.source = "runner";
  const html = render("arena", undefined, { category: "vs-humans" });
  expect(fixture.listOptions?.input("page-two")).toEqual({
    category: "vs-humans",
    cursor: "page-two",
    limit: 9,
  });
  for (const key of ["vsHumans", "vsHumansDescription", "hosted", "selfRun"] as const)
    expect(html).toContain(enChess.arena[key]);
  expect(html).toContain('value="vs-humans" selected=""');
});
it("explains empty human results and offers a next step without a permanent skeleton", () => {
  listWith();
  const html = render("arena", undefined, { category: "vs-humans" });
  expect(html).toContain(enChess.arena.humansEmpty);
  expect(html).toContain(enChess.arena.humansEmptyDescription);
  expect(html).not.toContain("h-28");
});
it("explains versioning, independent publication and unverified self-run results", () => {
  const html = render("methodology");
  for (const key of [
    "promptsTitle",
    "promptsBody",
    "selfRunTitle",
    "selfRunBody",
    "privacyBody",
  ] as const)
    expect(html).toContain(enChess.methodology[key]);
});

it("renders Spanish filter, human-source and methodology guidance without English fallback", async () => {
  await i18n.changeLanguage("es-MX");
  try {
    loadedLeaderboard();
    fixture.query.data = { promptVersions: [{ version: "1", hash: "abc" }] };
    const results = render("leaderboard", undefined, { resultsFilter: { promptVersion: "1" } });
    for (const key of ["filterPrompt", "allPrompts", "clearFilters", "filterScope"] as const)
      expect(results).toContain(esChess.leaderboard[key]);
    listWith("runner");
    fixture.list.data.pages[0]!.items[0]!.source = "runner";
    const humans = render("arena", undefined, { category: "vs-humans" });
    expect(humans).toContain(esChess.arena.vsHumans);
    expect(humans).toContain(esChess.arena.vsHumansDescription);
    expect(humans).toContain(esChess.arena.selfRun);
    const methodology = render("methodology");
    expect(methodology).toContain(esChess.methodology.selfRunBody);
    expect(methodology).toContain(esChess.methodology.promptsBody);
  } finally {
    await i18n.changeLanguage("en-US");
  }
});
