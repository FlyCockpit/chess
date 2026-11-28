import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enSettings from "@cockpit-chess/locales/src/en-US/settings.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
import esSettings from "@cockpit-chess/locales/src/es-MX/settings.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunnerRow } from "./revoke-runner-dialog";

const fixture = vi.hoisted(() => {
  // QueryObserver computes its browser timer capability at module load.
  vi.stubGlobal("window", {});
  return {
    admitted: true,
    owner: "owner-a",
    sessionStatus: "authenticated",
    error: undefined as unknown,
    pages: new Map<string | undefined, { items: RunnerRow[]; nextCursor: string | null }>(),
    calls: [] as { limit: number; cursor: string | undefined }[],
    retrySession: vi.fn(),
    formMounts: 0,
  };
});
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: fixture.sessionStatus, session: { user: { id: fixture.owner } } },
    actions: { retry: fixture.retrySession },
  }),
}));
vi.mock("@/hooks/use-document-admits", () => ({ useDocumentAdmits: () => fixture.admitted }));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    cliAccess: {
      runners: {
        list: {
          infiniteOptions: (options: {
            input: (cursor: string | undefined) => { limit: number; cursor: string | undefined };
            initialPageParam: undefined;
            getNextPageParam: (page: { nextCursor: string | null }) => string | undefined;
          }) => ({
            ...options,
            queryKey: ["runners"],
            queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
              fixture.calls.push(options.input(pageParam));
              if (fixture.error) throw fixture.error;
              return structuredClone(
                fixture.pages.get(pageParam) ?? { items: [], nextCursor: null },
              );
            },
          }),
        },
      },
    },
  },
}));
vi.mock("@cockpit-chess/ui/components/copy-field", () => ({
  CopyField: ({ value, copyLabel }: { value: string; copyLabel: string }) => (
    <div data-copy-value={value} aria-label={copyLabel}>
      {value}
    </div>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params: { lang: string };
    search: { tab: string };
    children: ReactNode;
  }) => <a href={`${to.replace("$lang", params.lang)}?tab=${search.tab}`}>{children}</a>,
}));
vi.mock("./runner-limits-sheet", () => ({
  RunnerLimitsSheet: ({ runner, onClose }: { runner: RunnerRow; onClose: () => void }) => {
    const [mount] = useState(() => ++fixture.formMounts);
    return (
      <div data-overlay="limits" data-mount={mount}>
        {runner.displayName}
        <button type="button" onClick={onClose}>
          close limits
        </button>
      </div>
    );
  },
}));
vi.mock("./revoke-runner-dialog", () => ({
  RevokeRunnerDialog: ({
    runner,
    onOpenChange,
  }: {
    runner: RunnerRow;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-overlay="revoke">
      {runner.displayName}
      <button type="button" onClick={() => onOpenChange(false)}>
        close revoke
      </button>
    </div>
  ),
}));

import { RunnersCard } from "./runners-card";

// In-memory DOM follows studio-reconciliation.test.tsx; React owns actual
// mounts/unmounts and state. No browser, services, or new test dependency.
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

const i18n = createInstance();
const now = new Date("2026-11-28T12:00:00Z");
function machine(id = "laptop", overrides: Partial<RunnerRow> = {}): RunnerRow {
  return {
    id,
    displayName: id,
    credentialPrefix: `${id}-prefix`,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}
let dispose: (() => Promise<void>) | undefined;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  fixture.admitted = true;
  fixture.owner = "owner-a";
  fixture.sessionStatus = "authenticated";
  fixture.error = undefined;
  fixture.calls = [];
  fixture.formMounts = 0;
  fixture.retrySession.mockClear();
  fixture.pages = new Map([[undefined, { items: [machine()], nextCursor: null }]]);
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { settings: enSettings, common: enCommon },
      "es-MX": { settings: esSettings, common: esCommon },
    },
    defaultNS: "settings",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
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
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const render = async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={i18n}>
            <RunnersCard />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
    await flush();
  };
  const all = () => elements(container);
  const button = (label: string) =>
    all().find((node) => node.localName === "button" && node.textContent === label);
  const press = async (label: string) => {
    await act(async () => click(button(label)));
    await flush();
  };
  const refresh = async () => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["runners"] });
    });
    await flush();
  };
  dispose = async () => {
    await act(async () => root.unmount());
    client.clear();
  };
  await render();
  return { container, client, render, all, button, press, refresh };
}
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}
const guide = (key: string) => String(i18n.t(`cli.runners.guide.${key}`));

it("guides empty setup with the exact startup command and terminal authority copy", async () => {
  fixture.pages.set(undefined, { items: [], nextCursor: null });
  const view = await mount();
  expect(
    view
      .all()
      .find((node) => node.attributes.get("data-copy-value"))
      ?.attributes.get("data-copy-value"),
  ).toBe("npx @flycockpit/chess");
  for (const key of ["start", "claim", "studio", "localAuthority", "practice", "limits", "empty"]) {
    expect(view.container.textContent).toContain(guide(key));
  }
  expect(view.container.textContent).toContain(enSettings.cli.runners.emptyTitle);
  expect(fixture.formMounts).toBe(0);
  expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
  expect(view.button(enSettings.cli.runners.limits.edit)).toBeUndefined();
});

it("separates online, stale, connecting, expired and revoked credentials", async () => {
  fixture.pages.set(undefined, {
    items: [
      machine("online"),
      machine("stale", { lastSeenAt: new Date(now.getTime() - 60_000) }),
      machine("connecting", { lastSeenAt: null }),
      machine("expired", { status: "expired" }),
      machine("revoked", { status: "revoked", revokedAt: now }),
      machine("elapsed", { expiresAt: now }),
    ],
    nextCursor: null,
  });
  const view = await mount();
  const rows = view
    .all()
    .filter((node) => node.localName === "li" && node.textContent.includes("prefix"));
  expect(rows).toHaveLength(6);
  for (const [index, status] of [
    "online",
    "offline",
    "connecting",
    "expired",
    "revoked",
    "expired",
  ].entries()) {
    expect(rows[index]?.textContent).toContain(guide(`status.${status}`));
    expect(rows[index]?.textContent).toContain(guide(`next.${status}`));
  }
  const links = view.all().filter((node) => node.localName === "a");
  expect(links).toHaveLength(3);
  expect(links.every((node) => node.attributes.get("href") === "/en-US?tab=studio")).toBe(true);
  expect(
    view
      .all()
      .filter(
        (node) =>
          node.localName === "button" && node.textContent === enSettings.cli.runners.limits.edit,
      ),
  ).toHaveLength(3);
  expect(
    view
      .all()
      .filter(
        (node) => node.localName === "button" && node.textContent === enSettings.cli.runners.revoke,
      ),
  ).toHaveLength(5);
});

it("ages cached contact and expiry locally; polls only while rendered", async () => {
  fixture.pages.set(undefined, {
    items: [machine("soon", { expiresAt: new Date(now.getTime() + 65_000) })],
    nextCursor: null,
  });
  const view = await mount();
  const firstCount = fixture.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fixture.calls.length).toBeGreaterThan(firstCount);
  expect(view.container.textContent).toContain(guide("status.offline"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(view.container.textContent).toContain(guide("status.expired"));
  expect(view.button(enSettings.cli.runners.limits.edit)).toBeUndefined();
  await dispose?.();
  dispose = undefined;
  const stoppedAt = fixture.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(fixture.calls).toHaveLength(stoppedAt);
});

it("keeps cursor pagination bounded and refreshes every loaded page", async () => {
  fixture.pages.set(undefined, { items: [machine("first")], nextCursor: "page-2" });
  fixture.pages.set("page-2", { items: [machine("second")], nextCursor: null });
  const view = await mount();
  await view.press(enCommon.actions.loadMore);
  expect(view.container.textContent).toContain("first-prefix");
  expect(view.container.textContent).toContain("second-prefix");
  expect(fixture.calls).toEqual([
    { limit: 20, cursor: undefined },
    { limit: 20, cursor: "page-2" },
  ]);
  expect(view.button(enCommon.actions.loadMore)).toBeUndefined();
  const at = fixture.calls.length;
  await view.refresh();
  expect(fixture.calls.slice(at)).toEqual([
    { limit: 20, cursor: undefined },
    { limit: 20, cursor: "page-2" },
  ]);
});

it("retries first-load errors and preserves cached content and overlays on transient failure", async () => {
  fixture.error = new Error("DO_NOT_RENDER");
  const view = await mount();
  expect(view.container.textContent).toContain(enSettings.cli.runners.loadFailed);
  expect(view.container.textContent).not.toContain("DO_NOT_RENDER");
  expect(view.container.textContent).not.toContain("laptop-prefix");
  fixture.error = undefined;
  await view.press(enCommon.actions.tryAgain);
  expect(view.container.textContent).toContain("laptop-prefix");
  await view.press(enSettings.cli.runners.limits.edit);
  expect(view.all().some((node) => node.attributes.get("data-overlay") === "limits")).toBe(true);
  const mountedForms = fixture.formMounts;
  fixture.error = new Error("temporary");
  await view.refresh();
  expect(view.container.textContent).toContain(enSettings.cli.runners.loadFailed);
  expect(view.container.textContent).toContain("laptop-prefix");
  expect(view.all().some((node) => node.attributes.get("data-overlay") === "limits")).toBe(true);
  expect(fixture.formMounts).toBe(mountedForms);
});

it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
  "hides cached private content and discards both overlays on %s",
  async (code) => {
    const view = await mount();
    await view.press(enSettings.cli.runners.limits.edit);
    await view.press(enSettings.cli.runners.revoke);
    expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(2);
    fixture.error = { code };
    await view.refresh();
    expect(view.client.getQueryData(["runners"])).toBeDefined();
    expect(view.container.textContent).not.toContain("laptop-prefix");
    expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
    fixture.error = undefined;
    await view.press(enCommon.actions.tryAgain);
    expect(view.container.textContent).toContain("laptop-prefix");
    expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
  },
);

it.each(["expired", "revoked"] as const)(
  "drops the limits overlay when its machine becomes %s",
  async (status) => {
    const view = await mount();
    await view.press(enSettings.cli.runners.limits.edit);
    await view.press(enSettings.cli.runners.revoke);
    fixture.pages.set(undefined, { items: [machine("laptop", { status })], nextCursor: null });
    await view.refresh();
    expect(view.all().some((node) => node.attributes.get("data-overlay") === "limits")).toBe(false);
    expect(view.button(enSettings.cli.runners.limits.edit)).toBeUndefined();
    if (status === "revoked")
      expect(view.all().some((node) => node.attributes.get("data-overlay") === "revoke")).toBe(
        false,
      );
  },
);

it("does not fetch or show private cached data before identity admission, and resets selections on owner change", async () => {
  fixture.admitted = false;
  const view = await mount();
  expect(fixture.calls).toHaveLength(0);
  expect(view.container.textContent).not.toContain("laptop-prefix");
  fixture.admitted = true;
  await view.render();
  await view.press(enSettings.cli.runners.limits.edit);
  await view.press(enSettings.cli.runners.revoke);
  fixture.owner = "owner-b";
  fixture.admitted = false;
  await view.render();
  expect(view.container.textContent).not.toContain("laptop-prefix");
  expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
  const stoppedAt = fixture.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(fixture.calls).toHaveLength(stoppedAt);
  // The document identity boundary clears caches on confirmed account change.
  view.client.clear();
  fixture.pages.set(undefined, { items: [machine("other-owner")], nextCursor: null });
  fixture.admitted = true;
  await view.render();
  expect(view.container.textContent).toContain("other-owner-prefix");
  expect(view.container.textContent).not.toContain("laptop-prefix");
  expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
});

it("remounts owner selections even if the document boundary changes identity in one render", async () => {
  const view = await mount();
  await view.press(enSettings.cli.runners.limits.edit);
  fixture.owner = "owner-b";
  await view.render();
  expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
});

it("localizes Studio navigation and guidance in Spanish", async () => {
  await i18n.changeLanguage("es-MX");
  const view = await mount();
  expect(
    view
      .all()
      .find((node) => node.localName === "a")
      ?.attributes.get("href"),
  ).toBe("/es-MX?tab=studio");
  expect(view.container.textContent).toContain(guide("claim"));
  expect(view.container.textContent).toContain(guide("localAuthority"));
  expect(view.container.textContent).toContain(guide("practice"));
  expect(view.container.textContent).toContain(guide("status.online"));
});

it.each(["pending", "anonymous", "error"])(
  "does not observe private runners with a %s session",
  async (status) => {
    fixture.sessionStatus = status;
    const view = await mount();
    expect(fixture.calls).toHaveLength(0);
    expect(view.container.textContent).not.toContain("laptop-prefix");
    expect(view.all().filter((node) => node.attributes.has("data-overlay"))).toHaveLength(0);
    if (status === "error") {
      await view.press(enCommon.actions.tryAgain);
      expect(fixture.retrySession).toHaveBeenCalledOnce();
    }
  },
);
