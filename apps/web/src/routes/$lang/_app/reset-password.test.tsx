import enAuth from "@cockpit-chess/locales/src/en-US/auth.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import esAuth from "@cockpit-chess/locales/src/es-MX/auth.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
import { createInstance } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type FormApi = {
  setFieldValue: (name: "newPassword" | "confirmPassword", value: string) => void;
  handleSubmit: () => Promise<void>;
};
const fixture = vi.hoisted(() => ({
  search: { token: "reset-token", error: undefined as string | undefined },
  lang: "en-US",
  configState: "success" as "success" | "refetch-error" | "load-error",
  resetPassword: vi.fn(),
  navigate: vi.fn(),
  markAnonymousOnlyRoute: vi.fn(),
  formApis: new Set<FormApi>(),
  retry: undefined as (() => void) | undefined,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: fixture.lang }),
    useSearch: () => fixture.search,
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => fixture.navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isPending: false,
    isError: fixture.configState !== "success",
    isLoadingError: fixture.configState === "load-error",
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@tanstack/react-form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-form")>();
  const useForm: typeof actual.useForm = (options) => {
    const form = actual.useForm(options);
    fixture.formApis.add(form as unknown as FormApi);
    return form;
  };
  return { ...actual, useForm };
});
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: { queryOptions: () => ({}) },
    setup: { claimFirstAdmin: { mutationOptions: () => ({}) } },
  },
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { resetPassword: fixture.resetPassword } }));
vi.mock("@/lib/document-identity", () => ({
  markAnonymousOnlyRoute: fixture.markAnonymousOnlyRoute,
}));
vi.mock("@/lib/route-session", () => ({ resolveRouteSession: vi.fn() }));
vi.mock("@cockpit-chess/ui/components/sileo", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/utils/friendly-error", () => ({
  friendly: () => "Generic error",
  isRateLimit: () => false,
}));
// Capture the shared retry control's callback to exercise the exact page action
// without adding a browser/DOM dependency. Its message still renders in the DOM.
vi.mock("@/components/inline-retry", () => ({
  InlineRetry: ({ message, onRetry }: { message: string; onRetry: () => void }) => {
    fixture.retry = onRetry;
    return (
      <div>
        {message}
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  },
}));

const { Route } = await import("./reset-password");
const Page = (
  Route as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
await Page.preload?.();
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { auth: enAuth, common: enCommon },
      "es-MX": { auth: esAuth, common: esCommon },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

// Same small in-memory DOM used by auth-form-refocus.test.tsx: real React DOM
// and TanStack Form retain their state and input nodes, with no IO or browser.
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

function inputs(node: FakeNode): FakeElement[] {
  return [
    ...(node instanceof FakeElement && node.localName === "input" ? [node] : []),
    ...node.childNodes.flatMap(inputs),
  ];
}

describe.each([
  ["en-US", enAuth],
  ["es-MX", esAuth],
])("reset password in %s", (lang, messages) => {
  let root: Root;
  let container: FakeElement;
  beforeEach(async () => {
    fixture.lang = lang;
    fixture.configState = "success";
    fixture.search = { token: "reset-token", error: undefined };
    fixture.resetPassword.mockReset();
    fixture.navigate.mockReset();
    fixture.formApis.clear();
    fixture.retry = undefined;
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
    await i18n.changeLanguage(lang);
    await act(async () =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Page />
        </I18nextProvider>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function typeAndSubmit() {
    const [form] = [...fixture.formApis];
    if (!form) throw new Error("form missing");
    await act(async () => {
      form.setFieldValue("newPassword", "new-password-12345");
      form.setFieldValue("confirmPassword", "new-password-12345");
    });
    await act(async () => {
      await form.handleSubmit();
    });
  }

  it("keeps typed passwords after the pre-sweep's 503, explains retry, and retries the same link", async () => {
    fixture.resetPassword
      .mockResolvedValueOnce({ error: { status: 503, message: "private server message" } })
      .mockResolvedValueOnce({ data: { status: true } });
    const originalInputs = inputs(container);
    await typeAndSubmit();
    expect(fixture.resetPassword).toHaveBeenCalledOnce();
    expect(fixture.formApis.size).toBe(1);
    expect(inputs(container)).toEqual(originalInputs);
    expect(inputs(container).map((input) => input.value)).toEqual([
      "new-password-12345",
      "new-password-12345",
    ]);
    expect(container.textContent).toContain(messages.resetPassword.retryable);
    expect(container.textContent).not.toContain(messages.resetPassword.invalidTitle);
    expect(container.textContent).not.toContain("private server message");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.retry).toBeTypeOf("function");
    await act(async () => {
      fixture.retry?.();
    });
    expect(fixture.resetPassword).toHaveBeenCalledTimes(2);
    expect(fixture.resetPassword).toHaveBeenLastCalledWith({
      token: "reset-token",
      newPassword: "new-password-12345",
    });
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it("shows invalid/expired only for a genuinely rejected token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.resetPassword.mockResolvedValue({ error: { status: 400, code: "INVALID_TOKEN" } });
    await typeAndSubmit();
    expect(container.textContent).toContain(messages.resetPassword.invalidTitle);
    expect(container.textContent).toContain(messages.resetPassword.requestNewLink);
    expect(inputs(container)).toHaveLength(0);
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("keeps the form and typed values through a failed config refetch", async () => {
    const [form] = [...fixture.formApis];
    await act(async () => {
      form?.setFieldValue("newPassword", "typed-password-12345");
    });
    const originalInputs = inputs(container);
    fixture.configState = "refetch-error";
    await act(async () =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Page />
        </I18nextProvider>,
      ),
    );
    expect(inputs(container)).toEqual(originalInputs);
    expect(inputs(container)[0]?.value).toBe("typed-password-12345");
    expect(fixture.markAnonymousOnlyRoute).toHaveBeenCalled();
  });
});
