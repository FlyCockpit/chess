import { createMatch } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
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
it("offers a signed-out visitor the administrator sign-in", () => {
  fixture.auth = { state: { status: "anonymous" } };
  try {
    const html = render();
    expect(html).toContain('data-to="/$lang/login"');
    expect(html).not.toContain(enChess.studio.userMatchesOff.replaceAll("'", "&#x27;"));
  } finally {
    fixture.auth = { state: { status: "authenticated", session: { user: { role: "admin" } } } };
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
it("asks a user whose key OpenRouter refused to reconnect", () => {
  asUser(() => {
    fixture.key = { ...fixture.key, data: connectedKey({ status: "invalid" }) };
    const html = render();
    expect(html).toContain(enChess.studio.reconnectTitle);
    expect(html).not.toContain("data-create");
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
