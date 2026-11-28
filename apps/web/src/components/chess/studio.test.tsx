import { beginHostedTurn, createMatch } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  moveDenied: false,
  humanBlocked: false,
  humanPhase: undefined as "pending" | "uncertain" | undefined,
  admitted: true,
  items: [] as Record<string, unknown>[],
  enabled: [] as unknown[],
  auth: {
    state: { status: "authenticated", session: { user: { role: "admin" } } } as {
      status: string;
      session?: { user: { role: string } };
    },
  },
  info: { hostedEnabled: false, userMatchesEnabled: false, dailyLimit: 20 } as Record<
    string,
    unknown
  >,
  key: {
    data: { available: true, connected: false } as unknown,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  detail: {
    data: undefined as unknown,
    error: undefined as unknown,
    isPending: true,
    isError: false,
    refetch: vi.fn(),
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ surface, enabled }: { surface: string; enabled?: boolean }) => {
    if (surface !== "info") fixture.enabled.push(enabled);
    return surface === "info"
      ? { data: fixture.info }
      : surface === "key"
        ? fixture.key
        : fixture.detail;
  },
  useInfiniteQuery: ({ enabled }: { enabled?: boolean }) => {
    fixture.enabled.push(enabled);
    return {
      data: { pages: [{ items: fixture.items }] },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    };
  },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      key: () => ["chess"],
      studio: { infiniteOptions: () => ({}) },
      info: { queryOptions: () => ({ surface: "info" }) },
      inspect: { queryOptions: () => ({ surface: "detail" }) },
      publish: { mutationOptions: () => ({}) },
      stop: { mutationOptions: () => ({}) },
      create: { mutationOptions: () => ({}) },
      importGame: { mutationOptions: () => ({}) },
    },
    openrouter: { status: { queryOptions: () => ({ surface: "key" }) } },
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({ useAuthSession: () => fixture.auth }));
vi.mock("@/hooks/use-document-admits", () => ({ useDocumentAdmits: () => fixture.admitted }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => Date.now() }));
vi.mock("@/hooks/use-hosted-human-turn", () => ({
  useHostedHumanTurn: ({
    match,
    blocked,
  }: {
    match?: { config: { white: { protocol: string }; black: { protocol: string } } };
    blocked: boolean;
  }) => {
    fixture.humanBlocked = blocked;
    return {
      humanSide:
        match?.config.white.protocol === "human"
          ? "w"
          : match?.config.black.protocol === "human"
            ? "b"
            : undefined,
      disabled: blocked || Boolean(fixture.humanPhase),
      accessDenied: fixture.moveDenied,
      playable: true,
      phase: fixture.humanPhase,
      online: true,
      submit: vi.fn(),
      resync: vi.fn(),
    };
  },
}));
vi.mock("./game-board", () => ({
  GameBoard: ({ disabled, flipped }: { disabled: boolean; flipped: boolean }) => (
    <div data-play-board data-disabled={String(disabled)} data-flipped={String(flipped)} />
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a data-to={to}>{children}</a>,
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial === "" ? "selected" : initial, vi.fn()],
}));
vi.mock("./create-match-dialog", () => ({
  CreateMatchDialog: ({
    billingOptions,
    ownKeyRemainingMicros,
    disabled,
  }: {
    billingOptions?: string[];
    ownKeyRemainingMicros?: number | null;
    disabled: boolean;
  }) => (
    <div
      data-create={(billingOptions ?? ["operator"]).join(",")}
      data-remaining={String(ownKeyRemainingMicros)}
      data-disabled={String(disabled)}
    />
  ),
}));
vi.mock("./replay", () => ({
  MatchReplay: ({ match }: { match: { config: { title: string } } }) => (
    <div>{match.config.title}</div>
  ),
}));

import { Studio } from "./studio";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
function render() {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Studio onWatch={vi.fn()} />
    </I18nextProvider>,
  );
}
it("renders a selected-preview skeleton while its first request is pending", () => {
  fixture.detail = { ...fixture.detail, data: undefined, isPending: true, isError: false };
  expect(render()).toContain("h-96");
});
it("offers direct preview retry when no detail loaded", () => {
  fixture.detail = {
    ...fixture.detail,
    data: undefined,
    isPending: false,
    isError: true,
    error: new Error("offline"),
  };
  const html = render();
  expect(html).toContain("Try again");
  expect(html).not.toContain("h-96");
});
it("retains a private preview during transient failure and hides it on denial", () => {
  const archive = createMatch(
    {
      title: "Private preview",
      rules: {},
      white: { name: "White", model: "random", protocol: "random" },
      black: { name: "Black", model: "random", protocol: "random" },
    },
    "local",
  );
  fixture.detail = {
    ...fixture.detail,
    data: { archive, published: false },
    isPending: false,
    isError: true,
    error: new Error("offline"),
  };
  expect(render()).toContain("Private preview");
  fixture.detail.error = { code: "FORBIDDEN" };
  expect(render()).not.toContain("Private preview");
});

it("shows the uploader's statement of reasons while retaining private inspection and excluding report details", () => {
  const archive = createMatch({
    title: "Moderated replay",
    rules: {},
    white: { name: "White", model: "random", protocol: "random" },
    black: { name: "Black", model: "random", protocol: "random" },
  });
  fixture.detail = {
    ...fixture.detail,
    isPending: false,
    isError: false,
    error: undefined,
    data: {
      archive,
      published: true,
      hiddenAt: "2026-11-28T00:00:00Z",
      moderationReason: "privacy",
      moderationNote: "Remove the <private> contact detail.",
      Reports: [{ note: "Confidential reporter details" }],
    },
  };
  const html = render();
  expect(html).toContain(enChess.moderation.ownerTitle);
  expect(html).toContain(enChess.moderation.reasons.privacy);
  expect(html).toContain("Remove the &lt;private&gt; contact detail.");
  expect(html).toContain("Moderated replay");
  expect(html).not.toContain("Confidential reporter details");
});
it("retains hide and restoration statements for an uploader who returns after restoration", () => {
  const archive = createMatch({
    title: "Restored replay",
    rules: {},
    white: { name: "White", model: "random", protocol: "random" },
    black: { name: "Black", model: "random", protocol: "random" },
  });
  fixture.detail = {
    ...fixture.detail,
    isPending: false,
    isError: false,
    error: undefined,
    data: {
      archive,
      published: true,
      hiddenAt: null,
      moderationReason: "no_violation",
      moderationNote: "Contact detail was removed.",
      ModerationActions: [
        {
          id: "restore",
          createdAt: "2026-11-28T01:00:00Z",
          hidden: false,
          reason: "no_violation",
          note: "Contact detail was removed.",
        },
        {
          id: "hide",
          createdAt: "2026-11-28T00:00:00Z",
          hidden: true,
          reason: "privacy",
          note: "Original privacy concern.",
        },
      ],
    },
  };
  const html = render();
  expect(html).toContain(enChess.moderation.ownerRestoredTitle);
  expect(html).toContain("Contact detail was removed.");
  expect(html).toContain("Original privacy concern.");
  expect(html).not.toContain(enChess.moderation.ownerTitle);
});

it("tells a signed-in non-admin what the studio is, without a Sign In", () => {
  fixture.auth = { state: { status: "authenticated", session: { user: { role: "user" } } } };
  try {
    const html = render();
    expect(html).toContain(enChess.studio.userMatchesOff.replaceAll("'", "&#x27;"));
    expect(html).not.toContain(enChess.studio.signIn);
    expect(html).not.toContain('data-to="/$lang/login"');
  } finally {
    fixture.auth = { state: { status: "authenticated", session: { user: { role: "admin" } } } };
  }
});
it("offers a signed-out visitor the right sign-in prompt and button", () => {
  fixture.auth = { state: { status: "anonymous" } };
  const before = fixture.info;
  try {
    fixture.info = { ...before, userMatchesEnabled: false };
    const adminOnly = render();
    expect(adminOnly).toContain('data-to="/$lang/login"');
    expect(adminOnly).toContain(enChess.studio.signIn);
    expect(adminOnly).toContain(`>${enChess.studio.signInAction}</a>`);
    expect(adminOnly).not.toContain(enChess.studio.userMatchesOff.replaceAll("'", "&#x27;"));

    fixture.info = { ...before, userMatchesEnabled: true };
    const open = render();
    expect(open).toContain(enChess.studio.signInUser);
    expect(open).toContain(`>${enChess.studio.signInAction}</a>`);
    expect(open).not.toContain(enChess.studio.signIn);
  } finally {
    fixture.auth = { state: { status: "authenticated", session: { user: { role: "admin" } } } };
    fixture.info = before;
  }
});
it("shows and loads nothing private until the document has recorded the account", () => {
  // A public tab no session guard covers: until the root watcher (or a guard)
  // has recorded this admin as the document's identity, a switch could go
  // unnoticed and the cache could still hold the previous account's answers.
  const archive = createMatch(
    {
      title: "Earlier account preview",
      rules: {},
      white: { name: "White", model: "random", protocol: "random" },
      black: { name: "Black", model: "random", protocol: "random" },
    },
    "local",
  );
  fixture.detail = {
    ...fixture.detail,
    data: { archive, published: false },
    error: undefined,
    isPending: false,
    isError: false,
  };
  fixture.admitted = false;
  fixture.enabled = [];
  try {
    const html = render();
    expect(html).toContain("h-96");
    expect(html).not.toContain("Earlier account preview");
    expect(html).not.toContain(enChess.studio.userMatchesOff.replaceAll("'", "&#x27;"));
    expect(fixture.enabled.length).toBeGreaterThan(0);
    expect(fixture.enabled.every((enabled) => enabled === false)).toBe(true);
  } finally {
    fixture.admitted = true;
  }
  expect(render()).toContain("Earlier account preview");
});

const connectedKey = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  connected: true,
  status: "active",
  label: "Cockpit Chess",
  keyHint: "abcd",
  keyHash: "f".repeat(64),
  limitMicros: 10_000_000,
  limitRemainingMicros: 7_500_000,
  usageMicros: 2_500_000,
  usageDailyMicros: 0,
  expiresAt: null,
  connectedAt: new Date(0).toISOString(),
  live: true,
  ...overrides,
});
function asUser(run: () => void, info: Record<string, unknown> = {}) {
  fixture.auth = { state: { status: "authenticated", session: { user: { role: "user" } } } };
  const before = fixture.info;
  fixture.info = { hostedEnabled: true, userMatchesEnabled: true, dailyLimit: 20, ...info };
  try {
    run();
  } finally {
    fixture.auth = { state: { status: "authenticated", session: { user: { role: "admin" } } } };
    fixture.info = before;
    fixture.key = { ...fixture.key, data: { available: true, connected: false } };
  }
}
it("sends a user without a connection to Settings instead of the form", () => {
  asUser(() => {
    const html = render();
    expect(html).toContain(enChess.studio.connectTitle);
    expect(html).toContain('data-to="/$lang/settings/openrouter"');
    expect(html).not.toContain("data-create");
    expect(html).not.toContain(enChess.studio.userMatchesOff.replaceAll("'", "&#x27;"));
  });
});
it("asks a user whose key OpenRouter refused to reconnect, and explains an unreadable key", () => {
  asUser(() => {
    fixture.key = {
      ...fixture.key,
      data: connectedKey({ status: "invalid", invalidReason: "rejected" }),
    };
    const rejected = render();
    expect(rejected).toContain(enChess.studio.reconnectTitle);
    expect(rejected).toContain(enChess.studio.reconnectBody);
    expect(rejected).not.toContain("data-create");

    fixture.key = {
      ...fixture.key,
      data: connectedKey({ status: "invalid", invalidReason: "unreadable" }),
    };
    const unreadable = render();
    expect(unreadable).toContain(enChess.studio.reconnectTitle);
    expect(unreadable).toContain(enChess.studio.unreadableBody.replaceAll("'", "&#x27;"));
    expect(unreadable).not.toContain(enChess.studio.reconnectBody);
  });
});
it("offers a connected user the form billed to their key, capped by what it has left", () => {
  asUser(() => {
    fixture.key = { ...fixture.key, data: connectedKey() };
    const html = render();
    expect(html).toContain('data-create="openrouter"');
    expect(html).toContain('data-remaining="7500000"');
    expect(html).toContain('data-disabled="false"');
    expect(html).toContain("Billed to your OpenRouter key · $7.50 left");
    expect(html).toContain("One match at a time · up to 20 matches a day");
  });
});
it("disables creating when the key has almost nothing left, and says what to do", () => {
  asUser(() => {
    fixture.key = { ...fixture.key, data: connectedKey({ limitRemainingMicros: 5000 }) };
    const html = render();
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain("Raise its limit or add credits on OpenRouter first.");
  });
});
it("treats a key without a limit as uncapped", () => {
  asUser(() => {
    fixture.key = {
      ...fixture.key,
      data: connectedKey({ limitMicros: null, limitRemainingMicros: null }),
    };
    const html = render();
    expect(html).toContain('data-remaining="null"');
    expect(html).toContain(enChess.studio.billedToUnlimited);
  });
});
it("keeps a user's own matches reachable but offers no create while user matches are off", () => {
  asUser(
    () => {
      fixture.enabled = [];
      const html = render();
      expect(html).toContain(enChess.studio.userMatchesOff.replaceAll("'", "&#x27;"));
      expect(html).not.toContain("data-create");
      // The owner's list still loads, so earlier matches can be stopped or unpublished.
      expect(fixture.enabled).toContain(true);
    },
    { userMatchesEnabled: false },
  );
});
it("lets an admin with a connected key choose who pays", () => {
  fixture.key = { ...fixture.key, data: connectedKey() };
  try {
    expect(render()).toContain('data-create="operator,openrouter"');
  } finally {
    fixture.key = { ...fixture.key, data: { available: true, connected: false } };
  }
  expect(render()).toContain('data-create="operator"');
});
it("shows a queued match's position and the next step after an account-limit ending", () => {
  const archive = createMatch(
    {
      title: "Queued match",
      rules: {},
      white: { name: "White", model: "random", protocol: "random" },
      black: { name: "Black", model: "random", protocol: "random" },
    },
    "hosted",
  );
  fixture.detail = {
    ...fixture.detail,
    data: { archive, published: false, queuePosition: 3, spectatorEvaluations: null },
    isPending: false,
    isError: false,
    error: undefined,
  };
  expect(render()).toContain("Queued · position 3");
  const ended = { ...archive, status: "error", result: "*", termination: "account-limit" };
  fixture.detail = {
    ...fixture.detail,
    data: { ...(fixture.detail.data as object), archive: ended, queuePosition: null },
  };
  const html = render();
  expect(html).not.toContain("Queued · position");
  expect(html).toContain("add credits on OpenRouter, then start a new match");
  expect(html).toContain(enChess.studio.openSettings);
  fixture.detail.data = {
    ...(fixture.detail.data as object),
    archive: { ...ended, termination: "credential-revoked" },
  };
  expect(render()).toContain(enChess.studio.connectAction);
});
it("keeps publishing controls but hides replay controls for old-rules cards", () => {
  fixture.items = [false, true].map((published) => ({
    id: String(published),
    slug: String(published),
    title: `Old ${published}`,
    status: "completed",
    whiteName: "W",
    blackName: "B",
    ending: null,
    oldRules: true,
    published,
  }));
  try {
    const html = render();
    expect(html).toContain(enChess.arena.oldRules);
    expect(html).not.toContain(`>${enChess.studio.preview}</button>`);
    expect(html).not.toContain(`>${enChess.studio.view}</button>`);
    expect(html).toContain(`>${enChess.studio.publish}</button>`);
    expect(html).toContain(`>${enChess.studio.unpublish}</button>`);
  } finally {
    fixture.items = [];
  }
});

it("shows unsupported-rules moderation statements independently of refused transcript inspection", () => {
  const beforeItems = fixture.items;
  const beforeDetail = fixture.detail;
  fixture.items = [
    {
      id: "unsupported-id",
      slug: "unsupported-replay",
      title: "Unsupported replay",
      status: "completed",
      whiteName: "White",
      blackName: "Black",
      published: true,
      oldRules: true,
      hiddenAt: null,
      moderationReason: "no_violation",
      moderationNote: "The restriction has been removed.",
      ModerationActions: [
        {
          id: "restore-old",
          createdAt: "2026-11-28T01:00:00Z",
          hidden: false,
          reason: "no_violation",
          note: "The restriction has been removed.",
        },
        {
          id: "hide-old",
          createdAt: "2026-11-28T00:00:00Z",
          hidden: true,
          reason: "privacy",
          note: "Earlier <private> concern.",
        },
      ],
      Reports: [{ note: "Confidential reporter identity" }],
    },
  ];
  fixture.detail = {
    ...fixture.detail,
    data: undefined,
    isPending: false,
    isError: true,
    error: { code: "OLD_RULES" },
  };
  try {
    asUser(() => {
      const restored = render();
      expect(restored).toContain(enChess.arena.oldRules);
      expect(restored).toContain(enChess.moderation.ownerRestoredTitle);
      expect(restored).toContain(enChess.moderation.reasons.no_violation);
      expect(restored).toContain("The restriction has been removed.");
      expect(restored).toContain("Earlier &lt;private&gt; concern.");
      expect(restored).toContain(enChess.moderation.ownerHistoryBound);
      expect(restored).not.toContain("Confidential reporter identity");
      expect(restored).not.toContain(`>${enChess.studio.preview}</button>`);
      expect(restored).not.toContain(`>${enChess.studio.view}</button>`);
      fixture.items = fixture.items.map((game) => ({
        ...game,
        hiddenAt: "2026-11-28T00:00:00Z",
        moderationReason: "privacy",
        moderationNote: "Hidden for a separate privacy concern.",
      }));
      const hidden = render();
      expect(hidden).toContain(enChess.moderation.ownerTitle);
      expect(hidden).toContain("Hidden for a separate privacy concern.");
      expect(hidden).not.toContain(enChess.moderation.ownerRestoredTitle);
      expect(hidden).not.toContain(`>${enChess.studio.preview}</button>`);
      expect(hidden).not.toContain(`>${enChess.studio.view}</button>`);
    });
  } finally {
    fixture.items = beforeItems;
    fixture.detail = beforeDetail;
  }
});

it("hides publish for queued private matches but keeps live publish and unpublish", () => {
  const item = {
    id: "a",
    slug: "a",
    title: "Match",
    whiteName: "W",
    blackName: "B",
    ending: null,
    oldRules: false,
    published: false,
    status: "queued",
  };
  fixture.items = [item];
  expect(render()).toContain(enChess.arena.status.queued);
  expect(render()).toContain(enChess.arena.unpublished);
  expect(render()).not.toContain(`>${enChess.studio.publish}</button>`);
  fixture.items = [{ ...item, status: "running" }];
  expect(render()).toContain(`>${enChess.studio.publish}</button>`);
  fixture.items = [{ ...item, published: true }];
  expect(render()).toContain(`>${enChess.studio.unpublish}</button>`);
  fixture.items = [];
});

it("keeps published practice outside official results and displays permanent official commitment without a toggle", () => {
  const previous = fixture.items;
  fixture.items = [false, true].map((official) => ({
    id: String(official),
    slug: String(official),
    title: `Published ${official}`,
    status: "completed",
    published: true,
    official,
    whiteName: "White model",
    blackName: "Black model",
  }));
  try {
    const html = render();
    expect(html).toContain(enChess.studio.publicationHint);
    expect(html).toContain(enChess.studio.practiceRecord);
    expect(html).toContain(enChess.studio.officialRecord);
    expect(html).toContain(`>${enChess.studio.unpublish}</button>`);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Counts on the leaderboard");
  } finally {
    fixture.items = previous;
  }
});

it.each(["white", "black"] as const)(
  "offers %s human controls only in the owner's inspected hosted game",
  (side) => {
    const human = { name: "Human", model: "human", protocol: "human" as const };
    const model = { name: "Model", model: "openai/model", protocol: "openai-chat" as const };
    const archive = createMatch(
      {
        title: "Owner human practice",
        white: side === "white" ? human : model,
        black: side === "black" ? human : model,
        rules: {},
      },
      "hosted",
    );
    beginHostedTurn(archive);
    fixture.detail = {
      ...fixture.detail,
      data: { archive, published: false, queuePosition: null },
      isPending: false,
      isError: false,
      error: undefined,
    };
    try {
      const html = render();
      expect(html).toContain(enChess.human.practice);
      expect(html).toContain(enChess.human.moveLabel);
      expect(html).toContain('autoComplete="off"');
      expect(html).toContain('inputMode="text"');
      expect(html).toContain(`data-flipped="${side === "black"}"`);
      expect(html).toContain(enChess.human.resync);
      expect(html).toContain('role="timer" aria-live="off"');
      fixture.detail.isError = true;
      fixture.detail.error = new Error("offline");
      const cached = render();
      expect(cached).toContain("Owner human practice");
      expect(cached).toContain('data-disabled="true"');
      expect(cached).toContain(enChess.human.stale);
      fixture.detail.error = { code: "FORBIDDEN" };
      expect(render()).not.toContain("data-play-board");
      fixture.detail = { ...fixture.detail, isError: false, error: undefined };
      fixture.moveDenied = true;
      expect(render()).not.toContain("Owner human practice");
      fixture.moveDenied = false;
      fixture.admitted = false;
      expect(render()).not.toContain("data-play-board");
      expect(fixture.humanBlocked).toBe(true);
    } finally {
      fixture.moveDenied = false;
      fixture.admitted = true;
      fixture.detail.data = undefined;
    }
  },
);
