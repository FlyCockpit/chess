import { createMatch } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  detail: {
    data: undefined as unknown,
    error: undefined as unknown,
    isPending: true,
    isError: false,
    refetch: vi.fn(),
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ surface }: { surface: string }) =>
    surface === "info" ? { data: { hostedEnabled: false, models: [] } } : fixture.detail,
  useInfiniteQuery: () => ({
    data: { pages: [{ items: [] }] },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  }),
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
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { role: "admin" } } },
  }),
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial === "" ? "selected" : initial, vi.fn()],
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
