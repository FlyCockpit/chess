import {
  beginHostedTurn,
  createMatch,
  finishMatch,
  type MatchArchive,
  playHostedHumanTurn,
} from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import esChess from "@cockpit-chess/locales/src/es-MX/chess.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  archives: new Map<string, MatchArchive>(),
  move: vi.fn(),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { id: "owner", role: "user" } } },
  }),
}));
vi.mock("@/hooks/use-document-admits", () => ({ useDocumentAdmits: () => true }));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      key: () => ["chess"],
      info: {
        queryOptions: () => ({
          queryKey: ["info"],
          queryFn: async () => ({ userMatchesEnabled: false }),
        }),
      },
      studio: {
        infiniteOptions: () => ({
          initialPageParam: undefined,
          getNextPageParam: () => undefined,
          queryKey: ["studio"],
          queryFn: async () => ({
            items: ["first", "second", "model"].map((slug) => ({
              id: slug,
              slug,
              title: slug,
              status: "running",
              whiteName: "White",
              blackName: "Black",
            })),
            nextCursor: undefined,
          }),
        }),
      },
      inspect: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["inspect", input.slug],
          queryFn: async () => ({
            archive: structuredClone(fixture.archives.get(input.slug)),
            status: "running",
            queuePosition: null,
            published: false,
            spectatorEvaluations: null,
          }),
        }),
      },
      list: {
        infiniteOptions: () => ({
          queryKey: ["arena-list"],
          initialPageParam: undefined,
          getNextPageParam: () => undefined,
          queryFn: async () => ({ items: [], nextCursor: undefined }),
        }),
      },
      get: { queryOptions: () => ({ queryKey: ["public-game"], queryFn: async () => null }) },
      move: { mutationOptions: () => ({ mutationFn: fixture.move }) },
      publish: { mutationOptions: () => ({}) },
      stop: { mutationOptions: () => ({}) },
    },
    chessModeration: {
      visibility: {
        queryOptions: () => ({
          queryKey: ["visibility"],
          queryFn: async () => ({ version: 1 }),
        }),
      },
    },
    openrouter: {
      status: {
        queryOptions: () => ({
          queryKey: ["key"],
          queryFn: async () => ({ connected: false }),
        }),
      },
    },
  },
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  ClientOnly: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./create-match-dialog", () => ({ CreateMatchDialog: () => null }));
vi.mock("./local-lab", () => ({ LocalLab: () => null }));
// Keep Studio, its human controls/hook, GameBoard, playback, replay, clocks, query
// observers real. Replace the layout/gesture-heavy board leaf; mount the real
// Arena tab in place of Studio on exit (Vite strips ClientOnly children in tests).
vi.mock("./chess-board", () => ({
  ChessBoard: ({
    onMove,
    disabled,
    flipped,
    fen,
  }: {
    onMove?: (move: string) => void;
    disabled?: boolean;
    flipped?: boolean;
    fen: string;
  }) => (
    <button
      type="button"
      data-board={onMove ? "owner" : "replay"}
      data-flipped={String(Boolean(flipped))}
      data-fen={fen}
      disabled={disabled}
      onClick={() => onMove?.("e2e4")}
    />
  ),
}));
vi.mock("./hero-board", () => ({ HeroBoard: () => null }));
vi.mock("./video/video-export-dialog", () => ({ VideoExportDialog: () => null }));

import { ArenaPage } from "./arena-page";
import { Studio } from "./studio";

// Same small in-memory DOM pattern as auth-form-refocus.test.tsx. React DOM owns
// node creation/removal; no SSR snapshots or mocked React hooks can hide orphans.
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(
    readonly ownerDocument: FakeDocument | null,
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) - 1] ?? null) : null;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(new FakeText(this.ownerDocument, text));
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (at < 0) throw new Error("Reference node is not a child");
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error("Removed node is not a child");
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  getRootNode(): FakeNode {
    let node: FakeNode = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument | null,
    public nodeValue: string,
    nodeType = 3,
  ) {
    super(doc, nodeType, nodeType === 3 ? "#text" : "#comment");
  }
  get data() {
    return this.nodeValue;
  }
  override get textContent() {
    return this.nodeValue;
  }
  override set textContent(text: string) {
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = { setProperty() {}, removeProperty() {} };
  /** React DOM writes `value`, `type`, `checked` as properties. */
  [property: string]: unknown;
  constructor(
    doc: FakeDocument,
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super(doc, 1, localName.toUpperCase());
  }
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_namespace: string, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttributeNames() {
    return [...this.attributes.keys()];
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_namespace: string, name: string) {
    this.removeAttribute(name);
  }
  focus() {}
  blur() {}
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly activeElement = null;
  defaultView: unknown = null;
  constructor() {
    super(null, 9, "#document");
    this.documentElement = this.appendChild(this.createElement("html"));
    this.head = this.documentElement.appendChild(this.createElement("head"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string) {
    return new FakeElement(this, tag.toLowerCase(), "http://www.w3.org/1999/xhtml");
  }
  createElementNS(namespace: string, tag: string) {
    return new FakeElement(this, tag, namespace);
  }
  createTextNode(text: string) {
    return new FakeText(this, text);
  }
  createComment(text: string) {
    return new FakeText(this, text, 8);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function elements(node: FakeNode): FakeElement[] {
  return [...(node instanceof FakeElement ? [node] : []), ...node.childNodes.flatMap(elements)];
}
function click(element: FakeElement | undefined) {
  expect(element).toBeDefined();
  const props = Object.entries(element ?? {}).find(([key]) =>
    key.startsWith("__reactProps$"),
  )?.[1] as { onClick?: () => void } | undefined;
  expect(props?.onClick).toBeTypeOf("function");
  props?.onClick?.();
}

it("keeps one owner surface and one read-only replay through polls, moves and tab changes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
  const doc = new FakeDocument();
  const classes = {
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: class {},
  };
  const win = { ...classes, document: doc, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = doc.body.appendChild(doc.createElement("div"));
  const root = createRoot(container as unknown as Element);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, structuralSharing: false } },
  });
  const i18n = createInstance();
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon }, "es-MX": { chess: esChess } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
  const human = { name: "Human", model: "human", protocol: "human" as const };
  const model = { name: "Model", model: "test/model", protocol: "openai-chat" as const };
  for (const slug of ["first", "second", "model"]) {
    const archive = createMatch(
      {
        title: slug,
        white: slug === "model" ? model : human,
        black: model,
        rules: { turnTimeoutMs: 20_000 },
      },
      "hosted",
    );
    beginHostedTurn(archive);
    fixture.archives.set(slug, archive);
  }
  fixture.move.mockReset();
  fixture.move.mockImplementation(async ({ slug, move }: { slug: string; move: string }) => {
    const archive = fixture.archives.get(slug);
    if (!archive) throw new Error("Missing test archive");
    playHostedHumanTurn(archive, new Date(), move);
    beginHostedTurn(archive);
  });
  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }
  async function show(tab: "studio" | "arena") {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            {tab === "studio" ? (
              <Studio onWatch={vi.fn()} />
            ) : (
              <ArenaPage tab="arena" onNavigate={vi.fn()} />
            )}
          </QueryClientProvider>
        </I18nextProvider>,
      ),
    );
    await flush();
  }
  const all = () => elements(container);
  const owners = () =>
    all().filter((node) => node.getAttribute("aria-label") === i18n.t("human.playTitle"));
  const boards = (kind: string) => all().filter((node) => node.getAttribute("data-board") === kind);
  function counts(ownerCount = 1, replayCount = 1) {
    expect(owners().length).toBe(ownerCount);
    expect(boards("owner").length).toBe(ownerCount);
    expect(boards("replay").length).toBe(replayCount);
  }
  async function select(slug: string) {
    const card = all().find(
      (node) =>
        node.localName === "article" &&
        elements(node).some((child) => child.localName === "h3" && child.textContent === slug),
    );
    await act(async () =>
      click(
        card &&
          elements(card).find(
            (node) => node.localName === "button" && node.textContent === i18n.t("studio.preview"),
          ),
      ),
    );
    await flush();
  }
  try {
    await show("studio");
    expect(container.textContent).toContain("first");
    await select("first");
    counts();
    const owner = owners()[0];
    const replay = boards("replay")[0];
    // Polls return a new archive object. Tick the real useNow interval as well;
    // the selected archive ID stays the same throughout.
    for (let poll = 0; poll < 8; poll++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        await client.refetchQueries({ queryKey: ["inspect", "first"], exact: true });
      });
      await flush();
      counts();
      expect(owners()[0] === owner).toBe(true);
      expect(boards("replay")[0] === replay).toBe(true);
    }
    await act(async () => click(boards("owner")[0]));
    await flush();
    expect(fixture.move).toHaveBeenCalledTimes(1);
    expect(fixture.move).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "first", move: "e2e4" }),
      expect.anything(),
    );
    counts();
    expect(owners()[0] === owner).toBe(true);
    expect(container.textContent).toContain(enChess.human.modelTurn);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    counts();
    finishMatch(fixture.archives.get("first") as MatchArchive, "1-0", "move-timeout");
    await act(async () => {
      await client.refetchQueries({ queryKey: ["inspect", "first"], exact: true });
    });
    await flush();
    counts();
    expect(container.textContent).toContain(enChess.human.finished);
    expect(boards("owner")[0]?.hasAttribute("disabled")).toBe(true);

    await select("second");
    counts();
    expect(owners()[0] === owner).toBe(false);
    expect(boards("replay")[0] === replay).toBe(false);
    expect(owner?.parentNode).toBeNull();
    const secondOwner = owners()[0];
    await act(async () => {
      await i18n.changeLanguage("es-MX");
    });
    counts();
    expect(owners()[0] === secondOwner).toBe(true);
    expect(container.textContent).toContain(esChess.human.playTitle);
    await select("model");
    counts(0, 1);
    expect(secondOwner?.parentNode).toBeNull();
    await select("second");
    counts();
    const leavingOwner = owners()[0];
    const leavingReplay = boards("replay")[0];
    await show("arena");
    counts(0, 1);
    expect(container.contains(leavingOwner ?? null)).toBe(false);
    expect(container.contains(leavingReplay ?? null)).toBe(false);
    expect(all().some((node) => node.localName === "form")).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    counts(0, 1);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
