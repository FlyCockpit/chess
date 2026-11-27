import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ mutate: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useLayoutEffect: (effect: () => void) => effect(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { id: "a", role: "admin" } } },
  }),
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ mutate: fixture.mutate }),
}));
vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));

import {
  connectIdentityPeers,
  markDocumentIdentityUnverified,
  observeDocumentIdentity,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { orpc } from "@/utils/orpc";
import { OfficialToggle } from "./official-toggle";

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  vi.stubGlobal("fetch", fixture.fetch);
  fixture.fetch.mockReset().mockResolvedValue(Response.json({ json: { official: true } }));
  vi.stubGlobal("window", {});
  fixture.mutate.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it("fresh public leaderboard curation requires admission and keeps the admitted owner on writes", async () => {
  expect(OfficialToggle({ slug: "game", official: false })).toBeNull();
  connectIdentityPeers(vi.fn());
  observeDocumentIdentity("a");
  expect(fixture.fetch).not.toHaveBeenCalled();
  let request: Promise<unknown> | undefined;
  fixture.mutate.mockImplementation((input: { slug: string; official: boolean }) => {
    request = orpc.chess.setOfficial.call(input);
  });
  const toggle = OfficialToggle({ slug: "game", official: false });
  const change = toggle?.props.children[0].props.children[0].props.onCheckedChange;
  expect(change).toBeTypeOf("function");
  change(true);
  expect(fixture.mutate).toHaveBeenCalledWith({ slug: "game", official: true });
  await request;
  const [input, init] = fixture.fetch.mock.calls[0] ?? [];
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  expect(headers.get("X-Expected-User")).toBe("a");
  markDocumentIdentityUnverified();
  change(false); // a retained handler cannot write after admission is revoked
  expect(fixture.mutate).toHaveBeenCalledTimes(1);
});
