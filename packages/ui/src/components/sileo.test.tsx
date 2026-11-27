import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { sileo as realSileo } from "sileo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sileo/styles.css", () => ({}));

const {
  Toaster,
  toast,
  invokeToastAction,
  titleOverflowsPill,
  pillTitleBudget,
  defaultToastPosition,
} = await import("./sileo");

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(
    readonly ownerDocument: FakeDocument | null,
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(ref);
    if (index === -1) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: {
    type: string;
    bubbles?: boolean;
    target?: unknown;
    currentTarget?: unknown;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) {
    if (!event.target) Object.defineProperty(event, "target", { value: this, configurable: true });
    let cur: FakeNode | null = this;
    while (cur) {
      Object.defineProperty(event, "currentTarget", { value: cur, configurable: true });
      for (const listener of cur.listeners.get(event.type) ?? []) listener(event);
      cur = event.bubbles ? cur.parentNode : null;
    }
    return true;
  }
  closest(selector: string): FakeElement | null {
    let cur: FakeNode | null = this;
    while (cur instanceof FakeElement) {
      if (matchesSimpleAttr(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelector(selector: string): FakeElement | null {
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        if (matchesSimpleAttr(child, selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }
}

class FakeText extends FakeNode {
  nodeValue: string;
  constructor(ownerDocument: FakeDocument, text: string, nodeType = 3) {
    super(ownerDocument, nodeType, nodeType === 3 ? "#text" : "#comment");
    this.nodeValue = text;
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(value: string) {
    this.nodeValue = value;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> & {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  } = {
    setProperty: (name: string, value: string) => {
      this.style[name] = value;
    },
    removeProperty: (name: string) => {
      delete this.style[name];
    },
  };
  scrollWidth = 120;
  scrollHeight = 40;
  readonly tagName: string;
  constructor(
    ownerDocument: FakeDocument,
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super(ownerDocument, 1, localName.toUpperCase());
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string, name: string, value: unknown) {
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
  addEventListener() {}
  removeEventListener() {}
  closest(selector: string): FakeElement | null {
    let cur: FakeNode | null = this;
    while (cur instanceof FakeElement) {
      if (matchesSimpleAttr(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelector(selector: string): FakeElement | null {
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        if (matchesSimpleAttr(child, selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }
  get textContent(): string {
    return this.childNodes
      .map((child) =>
        child instanceof FakeText || child instanceof FakeElement ? child.textContent : "",
      )
      .join("");
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument!.createTextNode(value));
  }
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
  createElementNS(ns: string, tag: string) {
    return new FakeElement(this, tag, ns);
  }
  createTextNode(text: string) {
    return new FakeText(this, text);
  }
  createComment(text: string) {
    return new FakeText(this, text, 8);
  }
}

function matchesSimpleAttr(el: FakeElement, selector: string): boolean {
  for (const part of selector.split(",").map((s) => s.trim())) {
    const attr = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const val = el.getAttribute(attr[1]!);
      if (attr[2] !== undefined ? val === attr[2] : val !== null) return true;
      continue;
    }
    if (el.localName === part) return true;
  }
  return false;
}

function findElements(root: FakeNode, attr: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (root instanceof FakeElement && root.hasAttribute(attr)) out.push(root);
  for (const child of root.childNodes) out.push(...findElements(child, attr));
  return out;
}

describe("toast facade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    realSileo.clear();
  });

  it("maps each method and its options onto sileo", () => {
    const successSpy = vi.spyOn(realSileo, "success");
    const errorSpy = vi.spyOn(realSileo, "error");
    const showSpy = vi.spyOn(realSileo, "show");
    const onClick = vi.fn();

    toast.success("Saved");
    toast.error("Failed", { duration: 5000, action: { label: "Retry", onClick } });
    toast.message("Heads up");

    expect(successSpy).toHaveBeenCalledWith({ id: expect.any(String), title: "Saved" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        title: "Failed",
        duration: 5000,
        autopilot: { expand: 0, collapse: 0 },
        description: expect.anything(),
      }),
    );
    expect(errorSpy.mock.calls[0]?.[0]).not.toHaveProperty("button");
    expect(showSpy).toHaveBeenCalledWith({ id: expect.any(String), title: "Heads up" });
  });

  it("gives every toast its own id so two toasts stack instead of merging", () => {
    const errorSpy = vi.spyOn(realSileo, "error");
    const first = toast.error("That wasn't found.");
    const second = toast.error("That wasn't found.");

    expect(first).not.toBe(second);
    expect(first).not.toBe("sileo-default");
    expect(errorSpy.mock.calls.map(([options]) => (options as { id?: string }).id)).toEqual([
      first,
      second,
    ]);
  });

  it("repeats a long message in the description so the clipped pill loses nothing", () => {
    const errorSpy = vi.spyOn(realSileo, "error");
    const successSpy = vi.spyOn(realSileo, "success");
    const long = "That code didn't work. Check your authenticator and try again.";

    toast.error(long);
    toast.success("Saved");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: long,
        description: long,
        autopilot: { expand: 0, collapse: 0 },
      }),
    );
    expect(successSpy.mock.calls[0]?.[0]).not.toHaveProperty("description");
  });

  it("decides by the measured width, not the character count", () => {
    const at16 = (perChar: number) => (m: string) => ({
      width: m.length * perChar,
      budget: pillTitleBudget(16),
    });
    expect(pillTitleBudget(16)).toBe(292);
    expect(titleOverflowsPill("a".repeat(36), at16(6.5))).toBe(false);
    expect(titleOverflowsPill("W".repeat(30), at16(11))).toBe(true);
    const at24 = (m: string) => ({ width: m.length * 6.5 * 1.5, budget: pillTitleBudget(24) });
    expect(titleOverflowsPill("We've emailed you a verification code", at24)).toBe(true);
  });

  it("falls back to a length rule when nothing can be measured", () => {
    expect(titleOverflowsPill("Saved", () => null)).toBe(false);
    expect(titleOverflowsPill("x".repeat(41), () => null)).toBe(true);
  });
});

describe("Toaster expansion with real sileo", () => {
  let container: FakeElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const classes = {
      Node: FakeNode,
      Element: FakeElement,
      HTMLElement: FakeElement,
      HTMLIFrameElement: class {},
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    };
    const win = {
      ...classes,
      document: doc,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 0),
      cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
      getComputedStyle: () => ({
        paddingLeft: "8",
        paddingRight: "8",
        fontSize: "16px",
        fontFamily: "sans-serif",
      }),
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
    doc.defaultView = win;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("getComputedStyle", win.getComputedStyle);
    vi.stubGlobal("requestAnimationFrame", win.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", win.cancelAnimationFrame);
    for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    container = doc.body.appendChild(doc.createElement("div"));
    root = createRoot(container as unknown as Element);
    act(() => {
      root.render(<Toaster position="bottom-right" />);
    });
  });

  afterEach(() => {
    act(() => {
      realSileo.clear();
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens action toasts immediately and keeps Undo visible past 4 seconds", () => {
    const onUndo = vi.fn();

    act(() => {
      toast.success("Game deleted", {
        duration: 10_000,
        action: { label: "Undo", onClick: onUndo },
      });
    });

    const toastEl = () => findElements(container, "data-sileo-toast")[0];
    const contentEl = () => findElements(container, "data-sileo-content")[0];
    const actionEl = () => findElements(container, "data-sileo-button")[0];

    expect(toastEl()?.getAttribute("data-expanded")).toBe("true");
    expect(contentEl()?.getAttribute("data-visible")).toBe("true");
    expect(actionEl()?.textContent).toBe("Undo");
    expect(actionEl()?.tagName).toBe("SPAN");
    expect(toastEl()?.getAttribute("aria-label")).toBe("Game deleted — Undo");
    expect(toastEl()?.querySelector("a, button, [role='button'], [tabindex]")).toBeNull();

    const actionId = actionEl()?.getAttribute("data-toast-action-id");
    expect(actionId).toBeTruthy();
    invokeToastAction(actionId!);
    expect(onUndo).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(4500);
    });

    expect(toastEl()?.getAttribute("data-expanded")).toBe("true");
    expect(contentEl()?.getAttribute("data-visible")).toBe("true");
    expect(actionEl()?.textContent).toBe("Undo");
  });

  it("opens overflowing body messages immediately and keeps them visible past 4 seconds", () => {
    const long = "That code didn't work. Check your authenticator and try again.";

    act(() => {
      toast.error(long);
    });

    const toastEl = () => findElements(container, "data-sileo-toast")[0];
    const contentEl = () => findElements(container, "data-sileo-content")[0];
    const descEl = () => findElements(container, "data-sileo-description")[0];

    expect(toastEl()?.getAttribute("data-expanded")).toBe("true");
    expect(contentEl()?.getAttribute("data-visible")).toBe("true");
    expect(descEl()?.textContent).toBe(long);

    act(() => {
      vi.advanceTimersByTime(4500);
    });

    expect(toastEl()?.getAttribute("data-expanded")).toBe("true");
    expect(contentEl()?.getAttribute("data-visible")).toBe("true");
    expect(descEl()?.textContent).toBe(long);
  });
});

describe("defaultToastPosition", () => {
  it("keeps phones centred and moves wide screens off centred form actions", () => {
    expect(defaultToastPosition(false)).toBe("bottom-center");
    expect(defaultToastPosition(true)).toBe("bottom-right");
  });
});
