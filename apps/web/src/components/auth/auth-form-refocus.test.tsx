import enAuth from "@cockpit-chess/locales/src/en-US/auth.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enErrors from "@cockpit-chess/locales/src/en-US/errors.json";
import enNav from "@cockpit-chess/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A signed-out visitor's typed email and password survive the tab regaining
 * focus and the connection coming back. Better Auth 1.7 refetches the session
 * on both (the same `fetchSession` path) and marks every
 * request of an empty session `isPending` again (`dist/client/query.mjs`,
 * `onRequest`: `isPending: currentValue.data === null`), the same snapshot as
 * the first load. These tests drive the real `useAuthSession` through that
 * snapshot sequence with the real sign-in and sign-up pages:
 * - mounted with the real React DOM client (into the small in-memory DOM
 *   below, as the repo has no DOM library), a typed email and password stay
 *   in the same TanStack form instance and the same input nodes across the
 *   refetch and a failed refetch, so React kept the form mounted;
 * - server-rendered, each snapshot gives byte-identical markup, and only the
 *   first load shows the skeleton. Same for the header's account control.
 */
type Snapshot = {
  data: { user: { id: string; name: string } } | null;
  isPending: boolean;
  isRefetching: boolean;
  error: unknown | null;
};

const fixture = vi.hoisted(() => ({
  snapshot: {
    data: null,
    isPending: true,
    isRefetching: false,
    error: null,
  } as Snapshot,
  config: { signupEnabled: true, adminBootstrapSignupEnabled: false, emailEnabled: true },
  online: true,
  search: {} as Record<string, unknown>,
  /** The appConfig query's outcome flags, as TanStack Query reports them. */
  configState: "success" as "success" | "refetch-error" | "load-error",
}));

/** Every TanStack form instance the pages created: a remount makes a new one. */
const formApis = vi.hoisted(() => new Set<unknown>());
vi.mock("@tanstack/react-form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-form")>();
  const useForm: typeof actual.useForm = (options) => {
    const form = actual.useForm(options);
    formApis.add(form);
    return form;
  };
  return { ...actual, useForm };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route files' code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => fixture.search,
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn() }),
  useParams: () => ({ lang: "en-US" }),
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({
    // A failed refetch keeps the data; only a failed first load has none.
    data: fixture.configState === "load-error" ? undefined : fixture.config,
    isPending: false,
    isError: fixture.configState !== "success",
    isLoadingError: fixture.configState === "load-error",
    isRefetchError: fixture.configState === "refetch-error",
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: { queryOptions: () => ({}), queryKey: () => ["appConfig"], call: async () => ({}) },
  },
}));
const signUpEmail = vi.hoisted(() => vi.fn());
const signInEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ ...fixture.snapshot, refetch: vi.fn() }),
    signUp: { email: signUpEmail },
    signIn: { email: signInEmail },
  },
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@cockpit-chess/ui/components/sileo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cockpit-chess/ui/components/sileo")>()),
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => fixture.online }));
// The peer channel (a real BroadcastChannel in Node) is not part of this test.
vi.mock("@/hooks/use-peer-session-change", () => ({ usePeerSessionChange: () => {} }));
vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(async () => ({ status: "resolved", session: null })),
  getSessionCookieHint: vi.fn(async () => false),
}));

const { resetAuthSessionMemoryForTests } = await import("@/hooks/use-auth-session");
const { Route: LoginRoute } = await import("@/routes/$lang/_app/login");
const { Route: SignupRoute } = await import("@/routes/$lang/_app/signup");
const { default: UserMenu } = await import("@/components/user-menu");

type LazyComponent = (() => ReactNode) & { preload?: () => Promise<void> };
const page = (route: unknown) => (route as { options: { component: LazyComponent } }).options;
// Route components are code-split: load the real ones before rendering them.
await page(LoginRoute).component.preload?.();
await page(SignupRoute).component.preload?.();
const SignupPage = page(SignupRoute).component;

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { auth: enAuth, common: enCommon, nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  // The hook only remembers browser snapshots (the server's never settle).
  vi.stubGlobal("window", {});
  resetAuthSessionMemoryForTests();
  fixture.online = true;
  fixture.search = {};
  fixture.configState = "success";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const FIRST_LOAD: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
const ANONYMOUS: Snapshot = { data: null, isPending: false, isRefetching: false, error: null };
const REFETCH: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
const FAILED_REFETCH: Snapshot = {
  data: null,
  isPending: false,
  isRefetching: false,
  error: { status: 503 },
};

function render(Component: () => ReactNode, snapshot: Snapshot) {
  fixture.snapshot = snapshot;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Component />
    </I18nextProvider>,
  );
}

describe.each([
  ["sign-in", page(LoginRoute).component],
  ["sign-up", page(SignupRoute).component],
])("%s page across a refocus refetch", (_name, Page) => {
  it("shows the skeleton only while the first load is pending", () => {
    const html = render(Page, FIRST_LOAD);
    expect(html).not.toContain('type="email"');
    expect(html).toContain('data-slot="skeleton"');
  });

  it("server-renders byte-identical markup while Better Auth refetches", () => {
    const settled = render(Page, ANONYMOUS);
    expect(settled).toContain('type="email"');
    expect(settled).toContain('type="password"');

    expect(render(Page, REFETCH)).toBe(settled);
    expect(render(Page, FAILED_REFETCH)).toBe(settled);
    expect(render(Page, ANONYMOUS)).toBe(settled);
  });

  it("keeps the form through a failed config refetch; a failed first load offers a retry", () => {
    const settled = render(Page, ANONYMOUS);
    fixture.configState = "refetch-error";
    expect(render(Page, ANONYMOUS)).toBe(settled);

    fixture.configState = "load-error";
    const failed = render(Page, ANONYMOUS);
    expect(failed).not.toContain('type="email"');
    expect(failed).toContain(enAuth.login.unableToConnect);
  });
});

describe("header account control across a refocus refetch", () => {
  it("is a skeleton only on the first load", () => {
    const first = render(UserMenu, FIRST_LOAD);
    expect(first).toContain('data-slot="skeleton"');

    const settled = render(UserMenu, ANONYMOUS);
    expect(settled).toContain('data-to="/$lang/login"');
    expect(render(UserMenu, REFETCH)).toBe(settled);
  });

  it("a sign-in in another tab still replaces the anonymous state", () => {
    render(UserMenu, ANONYMOUS);
    const signedIn = render(UserMenu, {
      data: { user: { id: "u1", name: "Ada" } },
      isPending: false,
      isRefetching: false,
      error: null,
    });
    expect(signedIn).toContain("Ada");
    expect(signedIn).not.toContain('data-to="/$lang/login"');
  });
});

// A minimal in-memory DOM: just what React DOM's client needs to create,
// update and move nodes. Enough to prove node identity across renders; it
// does no layout, events or selectors.
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

function findInput(node: FakeNode, type: string): FakeElement | undefined {
  if (node instanceof FakeElement && node.localName === "input" && node.type === type) return node;
  for (const child of node.childNodes) {
    const found = findInput(child, type);
    if (found) return found;
  }
  return undefined;
}

type FormApi = {
  setFieldValue: (name: string, value: string) => void;
  handleSubmit: () => Promise<void>;
};

describe.each([
  ["sign-in", page(LoginRoute).component],
  ["sign-up", page(SignupRoute).component],
])("%s page mounted in React DOM across a refocus refetch", (_name, Page) => {
  let container: FakeElement;
  let root: Root;

  beforeEach(() => {
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
    container = doc.body.appendChild(doc.createElement("div"));
    root = createRoot(container as unknown as Element);
    formApis.clear();
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  async function show(snapshot: Snapshot, online = true) {
    fixture.snapshot = snapshot;
    fixture.online = online;
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <Page />
        </I18nextProvider>,
      );
    });
  }

  /** Types into the mounted form, as the visitor would before leaving the tab. */
  async function type(email: string, password: string) {
    const [form] = [...formApis] as FormApi[];
    await act(async () => {
      form?.setFieldValue("email", email);
      form?.setFieldValue("password", password);
    });
  }

  it("keeps the form instance, its input nodes and the typed values", async () => {
    await show(FIRST_LOAD);
    expect(findInput(container, "email")).toBeUndefined();

    await show(ANONYMOUS);
    expect(formApis.size).toBe(1);
    await type("ada@example.com", "correct horse");
    const email = findInput(container, "email");
    const password = findInput(container, "password");
    expect(email?.value).toBe("ada@example.com");
    expect(password?.value).toBe("correct horse");

    for (const snapshot of [REFETCH, FAILED_REFETCH, ANONYMOUS]) {
      await show(snapshot);
      expect(findInput(container, "email")).toBe(email);
      expect(findInput(container, "password")).toBe(password);
      expect(email?.value).toBe("ada@example.com");
      expect(password?.value).toBe("correct horse");
    }
    expect(formApis.size).toBe(1);
  });

  it("keeps the typed values when the connection drops and comes back", async () => {
    // Better Auth refetches the session on `online` through the same path as
    // a refocus (`dist/client/session-refresh.mjs`, `setupOnlineRefetch`),
    // so coming back online is the refetch snapshot again, here after an
    // offline sign-in attempt left the form filled ("You're offline…").
    await show(FIRST_LOAD);
    await show(ANONYMOUS);
    await type("ada@example.com", "correct horse");
    const email = findInput(container, "email");
    const password = findInput(container, "password");

    for (const [snapshot, online] of [
      [ANONYMOUS, false],
      [REFETCH, true],
      // The first requests after reconnecting can still fail: the session's
      // and the app config's (TanStack refetches stale queries on reconnect).
      [FAILED_REFETCH, true],
      [REFETCH, true],
      [ANONYMOUS, true],
    ] as const) {
      fixture.configState = snapshot === FAILED_REFETCH ? "refetch-error" : "success";
      await show(snapshot, online);
      expect(findInput(container, "email")).toBe(email);
      expect(findInput(container, "password")).toBe(password);
      expect(email?.value).toBe("ada@example.com");
      expect(password?.value).toBe("correct horse");
    }
    expect(formApis.size).toBe(1);
  });

  it("detects a remount: a forgotten anonymity drops the form and its values", async () => {
    await show(ANONYMOUS);
    await type("ada@example.com", "correct horse");
    const email = findInput(container, "email");

    // What every refetch did before the fix: the first-load snapshot again.
    resetAuthSessionMemoryForTests();
    await show(REFETCH);
    expect(findInput(container, "email")).toBeUndefined();

    await show(ANONYMOUS);
    const remounted = findInput(container, "email");
    expect(remounted).toBeDefined();
    expect(remounted).not.toBe(email);
    expect(remounted?.value).toBe("");
    expect(formApis.size).toBe(2);
  });
});

describe("sign-up page mounted in React DOM when the request cannot be sent", () => {
  let container: FakeElement;
  let root: Root;

  beforeEach(() => {
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
    container = doc.body.appendChild(doc.createElement("div"));
    root = createRoot(container as unknown as Element);
    formApis.clear();
    signUpEmail.mockReset();
    toastError.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  it("says the server could not be reached and keeps the details for a resend", async () => {
    fixture.snapshot = ANONYMOUS;
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <SignupPage />
        </I18nextProvider>,
      );
    });
    const [form] = [...formApis] as FormApi[];
    await act(async () => {
      form?.setFieldValue("name", "Ada");
      form?.setFieldValue("email", "ada@example.com");
      form?.setFieldValue("password", "correct horse battery");
    });
    // What fetch throws when the server is unreachable: no HTTP answer.
    signUpEmail.mockRejectedValue(new TypeError("Failed to fetch"));

    await act(async () => {
      await form?.handleSubmit();
    });

    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(enErrors.unreachable);
    expect(findInput(container, "email")?.value).toBe("ada@example.com");
    expect(findInput(container, "password")?.value).toBe("correct horse battery");
    expect(formApis.size).toBe(1);
  });

  it("carries the intended Studio page in the signup verification email", async () => {
    fixture.snapshot = ANONYMOUS;
    fixture.search = { redirectTo: "/en-US/?tab=studio" };
    signUpEmail.mockResolvedValue({ data: {}, error: null });
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <SignupPage />
        </I18nextProvider>,
      );
    });
    const [form] = [...formApis] as FormApi[];
    await act(async () => {
      form?.setFieldValue("name", "Ada");
      form?.setFieldValue("email", "ada@example.com");
      form?.setFieldValue("password", "correct horse battery");
    });
    await act(async () => {
      await form?.handleSubmit();
    });
    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackURL: "/en-US/verify-email?ok=1&redirectTo=%2Fen-US%2F%3Ftab%3Dstudio",
      }),
    );
  });

  it("keeps sign-in verification mail on Studio without the library redirecting a successful sign-in there", async () => {
    fixture.snapshot = ANONYMOUS;
    fixture.search = { redirectTo: "/en-US/?tab=studio" };
    const assign = vi.fn();
    Object.assign(window, { location: { assign } });
    const answer = { redirect: true, url: "/en-US/verify-email?ok=1" };
    signInEmail.mockImplementation(
      async (options: {
        fetchOptions: { onSuccess: (context: { data: typeof answer }) => void };
      }) => {
        options.fetchOptions.onSuccess({ data: answer });
        return { data: answer, error: null };
      },
    );
    const LoginPage = page(LoginRoute).component;
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <LoginPage />
        </I18nextProvider>,
      );
    });
    const [form] = [...formApis] as FormApi[];
    await act(async () => {
      form?.setFieldValue("email", "ada@example.com");
      form?.setFieldValue("password", "correct horse battery");
    });
    await act(async () => {
      await form?.handleSubmit();
    });
    expect(signInEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackURL: "/en-US/verify-email?ok=1&redirectTo=%2Fen-US%2F%3Ftab%3Dstudio",
      }),
    );
    expect(answer.redirect).toBe(false);
    expect(assign).toHaveBeenCalledWith("/en-US/?tab=studio");
  });
});
