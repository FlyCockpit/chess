import enAuth from "@cockpit-chess/locales/src/en-US/auth.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, defaultParseSearch } from "@tanstack/react-router";
import { createInstance } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  hash: "",
  lang: "en-US",
  userId: "A",
  pending: false,
  settingsPending: false,
  settingsError: false,
  anonymous: false,
  holdSession: undefined as Promise<void> | undefined,
  fail: false,
  claims: [] as { token: string; userId: string }[],
  reload: vi.fn(),
  reloadUrls: [] as string[],
  sessionLayout: () => {},
  listeners: new Set<() => void>(),
  history: undefined as ReturnType<typeof createBrowserHistory> | undefined,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@tanstack/react-router")>()),
    createFileRoute: () => (options: unknown) => ({
      options,
      useParams: () => ({ lang: fixture.lang }),
      useRouteContext: () => ({
        session: { user: { id: fixture.userId, email: `${fixture.userId}@example.test` } },
      }),
    }),
    useLocation: () =>
      useSyncExternalStore(
        (notify) => {
          fixture.listeners.add(notify);
          return () => fixture.listeners.delete(notify);
        },
        () => fixture.hash,
      ),
    useRouter: () => ({ history: fixture.history }),
    Outlet: () => <Page />,
    Link: ({ children }: { children: ReactNode }) => <a href="/en-US/settings/cli">{children}</a>,
  };
});
vi.mock("@/hooks/use-auth-session", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    useAuthSession: () => {
      useLayoutEffect(() => fixture.sessionLayout());
      return {
        state: { status: "authenticated", session: { user: { id: fixture.userId } } },
        meta: { isRefetching: fixture.pending, isDegraded: false, isOffline: false },
      };
    },
    readSessionIdentity: () => fixture.userId,
  };
});
vi.mock("@/utils/orpc", () => ({
  orpc: {
    settings: { getAll: { queryOptions: () => ({}) } },
    cliAccess: {
      runners: {
        claim: {
          mutationOptions: () => ({
            mutationFn: async ({ token }: { token: string }) => {
              fixture.claims.push({ token, userId: fixture.userId });
              if (fixture.fail) throw new Error("interrupted request");
              return { claimed: true };
            },
          }),
        },
      },
    },
  },
}));
vi.mock("@/components/page-shell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: {},
    isPending: fixture.settingsPending,
    isError: fixture.settingsError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/route-session", () => ({
  resolveRouteSession: async () => {
    const id = fixture.userId;
    await fixture.holdSession;
    return {
      status: "resolved",
      session: fixture.anonymous ? null : { user: { id, email: `${id}@example.test` } },
    };
  },
}));
vi.mock("@/components/route-content-skeleton", () => ({
  RouteContentSkeleton: () => <div>Waiting for settings</div>,
}));
vi.mock("@/components/inline-retry", () => ({ InlineRetry: () => <div>Retry settings</div> }));

const { Route } = await import("@/routes/$lang/_app/_auth/runner/claim");
const Page = (
  Route as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
await Page.preload?.();
const { Route: AuthRoute } = await import("@/routes/$lang/_app/_auth");
const authOptions = (
  AuthRoute as unknown as {
    options: {
      component: (() => ReactNode) & { preload?: () => Promise<void> };
      beforeLoad: (input: {
        context: { queryClient: QueryClient };
        location: { pathname: string; href: string; hash: string };
        params: { lang: string };
        preload: boolean;
      }) => Promise<unknown>;
    };
  }
).options;
const AuthPage = authOptions.component;
await AuthPage.preload?.();
const { Route: LoginRoute } = await import("@/routes/$lang/_app/login");
const loginOptions = (
  LoginRoute as unknown as {
    options: {
      validateSearch: (search: Record<string, unknown>) => { redirectTo?: string };
      beforeLoad: (input: {
        location: { pathname: string; hash: string };
        params: { lang: string };
        search: { redirectTo?: string };
      }) => Promise<unknown>;
    };
  }
).options;
const { resetRunnerClaimContinuationForTests, rememberedRunnerClaim } = await import(
  "@/lib/runner-claim-link"
);
const {
  observeDocumentIdentity,
  replaceDocument,
  guardIdentityResponse,
  resetDocumentIdentityForTests,
} = await import("@/lib/document-identity");
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { auth: enAuth, common: enCommon } },
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
  });
});

// Reuse the repo's in-memory DOM pattern (reset-password/auth-form-refocus):
// real React reconciliation/effects and Query mutation state, without browser IO.
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
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
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

const first = "a".repeat(64);
const second = "b".repeat(64);
const fragment = (token: string) => `runner-claim=${token}`;
let root: Root;
let container: FakeElement;
let client: QueryClient;
let url: URL;
type HistoryWrite = (state: unknown, title: string, href?: string | URL | null) => void;
let history: {
  state: unknown;
  length: number;
  replaceState: HistoryWrite;
  pushState: HistoryWrite;
  back(): void;
  forward(): void;
  go(): void;
};
let replaceState: HistoryWrite;

beforeEach(() => {
  fixture.lang = "en-US";
  fixture.userId = "A";
  fixture.pending = false;
  fixture.settingsPending = false;
  fixture.settingsError = false;
  fixture.anonymous = false;
  fixture.holdSession = undefined;
  fixture.fail = false;
  fixture.claims = [];
  fixture.reload.mockReset();
  fixture.reloadUrls = [];
  fixture.sessionLayout = () => {};
  fixture.listeners.clear();
  resetRunnerClaimContinuationForTests();
  resetDocumentIdentityForTests(() => undefined);
  const doc = new FakeDocument();
  const classes = {
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: class {},
  };
  url = new URL("https://chess.test/en-US/runner/claim");
  replaceState = vi.fn((state: unknown, _title: string, href?: string | URL | null) => {
    history.state = state;
    if (href != null) url = new URL(String(href), url);
  });
  history = {
    state: {
      __TSR_key: "entry",
      __TSR_index: 0,
      __hashScrollIntoViewOptions: false,
      custom: "retained",
    },
    length: 1,
    replaceState,
    pushState: replaceState,
    back() {},
    forward() {},
    go() {},
  };
  const location = {
    get href() {
      return url.href;
    },
    get hash() {
      return url.hash;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    reload: () => {
      fixture.reloadUrls.push(url.href);
      fixture.reload();
    },
  };
  const win = {
    ...classes,
    document: doc,
    location,
    history,
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("History", { prototype: { replaceState } });
  fixture.history = createBrowserHistory({ window: win as unknown as Window });
  fixture.history.subscribe(({ location }) => {
    fixture.hash = decodeURI(location.hash.slice(1));
    for (const notify of fixture.listeners) notify();
  });
  for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = doc.body.appendChild(doc.createElement("div"));
  root = createRoot(container as unknown as Element);
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  fixture.history?.destroy();
  resetRunnerClaimContinuationForTests();
  resetDocumentIdentityForTests(() => undefined);
  vi.unstubAllGlobals();
});
async function render(hash: string, navigate = true) {
  await act(async () => {
    if (navigate)
      history.replaceState(
        history.state,
        "",
        `/${fixture.lang}/runner/claim${hash ? `#${hash}` : ""}`,
      );
    fixture.hash = decodeURI(hash);
    observeDocumentIdentity(fixture.userId);
    await authOptions.beforeLoad({
      context: { queryClient: client },
      location: {
        pathname: url.pathname,
        href: url.pathname + url.search + (hash ? `#${hash}` : ""),
        hash: fixture.hash,
      },
      params: { lang: fixture.lang },
      preload: false,
    });
    root.render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <AuthPage />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function freshDocumentAsB() {
  await act(async () => root.unmount());
  client.clear();
  resetRunnerClaimContinuationForTests();
  resetDocumentIdentityForTests(() => undefined);
  fixture.userId = "B";
  fixture.anonymous = false;
  fixture.pending = false;
  root = createRoot(container as unknown as Element);
  await render(url.hash.slice(1), false);
}

async function loginAdmission() {
  try {
    await loginOptions.beforeLoad({
      location: { pathname: url.pathname, hash: decodeURI(url.hash.slice(1)) },
      params: { lang: fixture.lang },
      search: loginOptions.validateSearch(defaultParseSearch(url.search)),
    });
    return undefined;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("options" in error)) throw error;
    const options = error.options;
    if (typeof options !== "object" || options === null || !("href" in options)) throw error;
    if (typeof options.href !== "string") throw error;
    return options.href;
  }
}

describe("mounted runner claim continuation", () => {
  it.each([
    { raw: fragment(first), destination: "/en-US/runner/claim" },
    { raw: `%72unner-claim=%61${first.slice(1)}`, destination: "/en-US/runner/claim" },
    { raw: fragment(first), destination: JSON.stringify("/en-US/runner/claim") },
    {
      raw: `%72unner-claim=%61${first.slice(1)}`,
      destination: String.raw`"\u002fen-US\u002frunner\u002fclaim"`,
    },
  ])(
    "disarms login continuation $destination #$raw when A is replaced during its session probe",
    async ({ raw, destination }) => {
      history.replaceState(
        history.state,
        "",
        `/en-US/login?redirectTo=${encodeURIComponent(destination)}#${raw}`,
      );
      observeDocumentIdentity("A");
      let release = () => {};
      fixture.holdSession = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = loginAdmission();
      expect(observeDocumentIdentity("B")).toBe(true);
      replaceDocument();
      expect(new URL(fixture.reloadUrls[0] ?? "").hash).toBe("");
      release();
      await pending;
      fixture.holdSession = undefined;
      resetRunnerClaimContinuationForTests();
      resetDocumentIdentityForTests(() => undefined);
      fixture.userId = "B";
      const target = await loginAdmission();
      expect(target).toBe("/en-US/runner/claim");
      history.replaceState(history.state, "", target);
      await render(url.hash.slice(1), false);
      expect(fixture.claims).toEqual([]);
      await render(fragment(first));
      expect(fixture.claims).toEqual([{ token: first, userId: "B" }]);
    },
  );
  it.each(["A", null, undefined])(
    "preserves intended login continuation with unchanged baseline %s",
    async (baseline) => {
      history.replaceState(
        history.state,
        "",
        `/en-US/login?redirectTo=%2Fen-US%2Frunner%2Fclaim#${fragment(first)}`,
      );
      if (baseline !== undefined) observeDocumentIdentity(baseline);
      let release = () => {};
      fixture.holdSession = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = loginAdmission();
      if (baseline !== "A") {
        replaceDocument();
        expect(new URL(fixture.reloadUrls[0] ?? "").hash).toBe(`#${fragment(first)}`);
      }
      release();
      expect(await pending).toBe(`/en-US/runner/claim#${fragment(first)}`);
      fixture.holdSession = undefined;
      resetRunnerClaimContinuationForTests();
      resetDocumentIdentityForTests(() => undefined);
      history.replaceState(history.state, "", `/en-US/runner/claim#${fragment(first)}`);
      await render(fragment(first), false);
      expect(fixture.claims).toEqual([{ token: first, userId: "A" }]);
    },
  );
  it("keeps the same owner's selected claim through automatic locale switching while settings wait", async () => {
    fixture.settingsPending = true;
    await render(fragment(first));
    fixture.lang = "es-MX";
    await render("");
    expect(rememberedRunnerClaim("A")).toBe(fragment(first));
    fixture.settingsPending = false;
    await render("", false);
    expect(fixture.claims).toEqual([{ token: first, userId: "A" }]);
  });
  it.each(["/en-US/Runner/Claim", "/en-US/runner/claim/", "/%65n-US/runner/claim"])(
    "fences the router-equivalent claim pathname %s before its child mounts",
    async (pathname) => {
      fixture.settingsPending = true;
      history.replaceState(history.state, "", `${pathname}#${fragment(first)}`);
      await render(fragment(first), false);
      expect(rememberedRunnerClaim("A")).toBe(fragment(first));
      expect(url.hash).toBe("");
      history.replaceState(history.state, "", `${pathname}#${fragment(first)}`);
      expect(observeDocumentIdentity("B")).toBe(true);
      replaceDocument();
      expect(fixture.reloadUrls[0]).not.toContain("#");
      await freshDocumentAsB();
      fixture.settingsPending = false;
      await render("", false);
      expect(fixture.claims).toEqual([]);
    },
  );
  it.each([
    `runner-claim=%61${first.slice(1)}`,
    `%72unner-claim=${first}`,
    `runner%2Dclaim=${first}`,
  ])("scrubs a once-encoded native fragment %s before identity reload", async (raw) => {
    fixture.settingsPending = true;
    await render(raw);
    expect(rememberedRunnerClaim("A")).toBe(fragment(first));
    expect(url.hash).toBe("");
    history.replaceState(history.state, "", `/en-US/runner/claim#${raw}`);
    expect(observeDocumentIdentity("B")).toBe(true);
    replaceDocument();
    expect(fixture.reloadUrls[0]).not.toContain("#");
    await freshDocumentAsB();
    fixture.settingsPending = false;
    await render("", false);
    expect(fixture.claims).toEqual([]);
  });
  it.each([
    `runner-claim=%2561${first.slice(1)}`,
    `%72unner-claim%3D${first}`,
    `%23runner-claim=${first}`,
  ])("does not grant a claim by over-decoding the native fragment %s", async (raw) => {
    await render(raw);
    expect(fixture.claims).toEqual([]);
    expect(rememberedRunnerClaim("A")).toBe("");
    expect(container.textContent).toContain(enAuth.runnerClaim.unavailable);
  });
  it("retains the admitted A token until the parent settings query finishes", async () => {
    fixture.settingsPending = true;
    await render(fragment(first));
    expect(url.hash).toBe("");
    expect(fixture.claims).toEqual([]);
    fixture.settingsPending = false;
    await render("", false);
    expect(fixture.claims).toEqual([{ token: first, userId: "A" }]);
  });
  it("fences an identity replacement while the route session probe itself is pending", async () => {
    observeDocumentIdentity("A");
    history.replaceState(history.state, "", `/en-US/runner/claim#${fragment(first)}`);
    let release = () => {};
    fixture.holdSession = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = authOptions.beforeLoad({
      context: { queryClient: client },
      location: { pathname: url.pathname, href: url.pathname + url.hash, hash: fragment(first) },
      params: { lang: "en-US" },
      preload: false,
    });
    expect(observeDocumentIdentity("B")).toBe(true);
    replaceDocument();
    expect(fixture.reloadUrls).toEqual(["https://chess.test/en-US/runner/claim"]);
    release();
    await pending;
    fixture.holdSession = undefined;
    await freshDocumentAsB();
    expect(fixture.claims).toEqual([]);
  });
  it("keeps the signed-out-to-sign-in continuation through a deliberate login reload", async () => {
    fixture.anonymous = true;
    observeDocumentIdentity(null);
    history.replaceState(history.state, "", `/en-US/runner/claim#${fragment(first)}`);
    await expect(
      authOptions.beforeLoad({
        context: { queryClient: client },
        location: { pathname: url.pathname, href: url.pathname + url.hash, hash: fragment(first) },
        params: { lang: "en-US" },
        preload: false,
      }),
    ).rejects.toBeDefined();
    replaceDocument();
    expect(fixture.reloadUrls[0]).toContain(`#${fragment(first)}`);
    await freshDocumentAsB();
    expect(fixture.claims).toEqual([{ token: first, userId: "B" }]);
  });
  it("scrubs a restored raw token before reload while the parent still withholds its Outlet", async () => {
    fixture.settingsPending = true;
    await render(fragment(first));
    history.replaceState(history.state, "", `/en-US/runner/claim#${fragment(first)}`);
    expect(url.hash).toContain(first);
    expect(observeDocumentIdentity("B")).toBe(true);
    replaceDocument();
    expect(fixture.reloadUrls).toEqual(["https://chess.test/en-US/runner/claim"]);
    expect(fixture.claims).toEqual([]);
  });
  it.each(["pending", "error"] as const)(
    "disarms A before the parent settings %s gate can mount its child",
    async (state) => {
      fixture.settingsPending = state === "pending";
      fixture.settingsError = state === "error";
      await render(fragment(first));
      expect(container.textContent).toContain(
        state === "pending" ? "Waiting for settings" : "Retry settings",
      );
      expect(fixture.claims).toEqual([]);
      expect(rememberedRunnerClaim("A")).toBe(fragment(first));
      expect(url.hash).toBe("");
      expect(observeDocumentIdentity("B")).toBe(true);
      replaceDocument();
      await freshDocumentAsB();
      fixture.settingsPending = false;
      fixture.settingsError = false;
      await render(url.hash.slice(1), false);
      expect(fixture.claims).toEqual([]);
      await render(fragment(first));
      expect(fixture.claims).toEqual([{ token: first, userId: "B" }]);
    },
  );
  it("an expected-user 409 during the unresolved parent settings query cannot replay the link", async () => {
    fixture.settingsPending = true;
    await render(fragment(first));
    expect(container.textContent).toContain("Waiting for settings");
    void guardIdentityResponse(Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }));
    await vi.waitFor(() => expect(fixture.reload).toHaveBeenCalledOnce());
    await freshDocumentAsB();
    fixture.settingsPending = false;
    await render(url.hash.slice(1), false);
    expect(fixture.claims).toEqual([]);
    expect(container.textContent).toContain(enAuth.runnerClaim.unavailable);
  });
  it("a preload cannot replace the selected continuation or claim a second token", async () => {
    await render(fragment(first));
    await authOptions.beforeLoad({
      context: { queryClient: client },
      location: {
        pathname: url.pathname,
        href: `/en-US/runner/claim#${fragment(second)}`,
        hash: fragment(second),
      },
      params: { lang: "en-US" },
      preload: true,
    });
    expect(rememberedRunnerClaim("A")).toBe(fragment(first));
    expect(fixture.claims).toEqual([{ token: first, userId: "A" }]);
  });
  it("flushes the real browser-history queue before a same-layout identity reload", async () => {
    fixture.pending = true;
    fixture.sessionLayout = () => {
      fixture.sessionLayout = () => {};
      observeDocumentIdentity("A");
      if (observeDocumentIdentity("B")) replaceDocument();
    };
    await render(fragment(first));
    expect(fixture.reloadUrls).toEqual(["https://chess.test/en-US/runner/claim"]);
    await freshDocumentAsB();
    expect(fixture.claims).toEqual([]);
  });
  it.each([false, true])(
    "starts T2 with fresh attempt/result after T1 failure=%s without reloading",
    async (failed) => {
      fixture.fail = failed;
      await render(fragment(first));
      expect(fixture.claims).toEqual([{ token: first, userId: "A" }]);
      expect(container.textContent).toContain(
        failed ? enAuth.runnerClaim.failed : "This run belongs to A@example.test.",
      );
      fixture.fail = false;
      await render(fragment(second));
      expect(fixture.claims).toEqual([
        { token: first, userId: "A" },
        { token: second, userId: "A" },
      ]);
      expect(container.textContent).toContain("This run belongs to A@example.test.");
      expect(container.textContent).not.toContain(enAuth.runnerClaim.failed);
      expect(fixture.reload).not.toHaveBeenCalled();
    },
  );
  it("disarms a waiting A claim before identity replacement and fresh B mount", async () => {
    fixture.pending = true;
    await render(fragment(first));
    expect(fixture.claims).toEqual([]);
    expect(url.hash).toBe("");
    expect(replaceState).toHaveBeenCalledWith(history.state, "", "/en-US/runner/claim");
    observeDocumentIdentity("A");
    expect(observeDocumentIdentity("B")).toBe(true);
    replaceDocument();
    expect(fixture.reload).toHaveBeenCalledOnce();
    await freshDocumentAsB();
    expect(fixture.claims).toEqual([]);
    expect(container.textContent).toContain(enAuth.runnerClaim.unavailable);
    // Deliberately reopening the terminal link is a new, explicit selection.
    await render(fragment(first));
    expect(fixture.claims).toEqual([{ token: first, userId: "B" }]);
  });
  it("an expected-user 409 reload cannot re-arm a consumed continuation for B", async () => {
    fixture.pending = true;
    await render(fragment(first));
    void guardIdentityResponse(Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }));
    await vi.waitFor(() => expect(fixture.reload).toHaveBeenCalledOnce());
    await freshDocumentAsB();
    expect(fixture.claims).toEqual([]);
    expect(url.hash).toBe("");
  });
  it("re-disarms router-restored hashes on subsequent renders", async () => {
    fixture.pending = true;
    await render(fragment(first));
    url.hash = fragment(first);
    await render(fragment(first), false);
    expect(url.hash).toBe("");
    expect(fixture.claims).toEqual([]);
  });
});
