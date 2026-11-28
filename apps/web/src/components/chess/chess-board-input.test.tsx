import { Chess, DEFAULT_POSITION } from "@cockpit-chess/chess";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the real component's event handlers while retaining its hook state across renders.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    memo: (component: unknown) => component,
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = hooks.index++;
      const previous = hooks.values[index] as { value: unknown; deps: unknown[] } | undefined;
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i])))
        hooks.values[index] = { value: factory(), deps };
      return (hooks.values[index] as { value: unknown }).value;
    },
    useRef: (initial: unknown) => {
      const index = hooks.index++;
      hooks.values[index] ??= { current: initial };
      return hooks.values[index];
    },
    useState: (initial: unknown) => {
      const index = hooks.index++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [
        hooks.values[index],
        (value: unknown) => {
          hooks.values[index] = value;
        },
      ];
    },
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { square?: string }) => options?.square ?? key,
  }),
}));
vi.mock("@/components/wide-content", () => ({ WideContent: () => null }));

import { ChessBoard } from "./chess-board";

type Props = Parameters<typeof ChessBoard>[0];
type Element = ReactElement<{ children?: unknown; [key: string]: unknown }>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function setup(overrides: Partial<Props> = {}) {
  const onMove = vi.fn();
  const onInteract = vi.fn();
  let props: Props = {
    fen: DEFAULT_POSITION,
    onMove,
    onInteract,
    ...overrides,
  };
  let tree: Element[] = [];
  function render(changes: Partial<Props> = {}) {
    props = { ...props, ...changes };
    hooks.index = 0;
    tree = elements((ChessBoard as unknown as (props: Props) => ReactElement)(props));
    const root = tree.find((element) => element.props.role === "group");
    if (!root) throw new Error("Missing board");
    (root.props.ref as (node: unknown) => unknown)({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }
  function square(name: string) {
    const result = tree.find(
      (element) => element.type === "button" && element.props["aria-label"] === name,
    );
    if (!result) throw new Error(`Missing square ${name}`);
    return result;
  }
  function fire(element: Element, name: string, event: object = {}) {
    (element.props[name] as (event: object) => void)(event);
  }
  function click(name: string, detail = 1) {
    fire(square(name), "onClick", { detail });
    render();
  }
  const board = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 800,
      width: 800,
      height: 800,
    }),
  };
  const target = { parentElement: board, setPointerCapture: vi.fn() };
  function point(
    name: string,
    x: number,
    y: number,
    phase: "Down" | "Move" | "Up" | "Cancel" | "LostPointerCapture",
  ) {
    fire(square(name), `onPointer${phase}`, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      currentTarget: target,
    });
    render();
  }
  function promotion(piece: string) {
    const button = tree.find(
      (element) => element.type === "button" && element.props.children === `pieces.${piece}`,
    );
    if (!button) throw new Error(`Missing promotion ${piece}`);
    return button;
  }
  render();
  return {
    onMove,
    onInteract,
    render,
    click,
    point,
    promotion,
    fire,
    square,
    tree: () => tree,
  };
}

beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});

describe("ChessBoard input", () => {
  it("owns single-finger piece drags without overriding touch-action, empty-square scrolling or pinch zoom", () => {
    const board = setup();
    const root = board.tree().find((element) => element.props.role === "group");
    if (!root) throw new Error("Missing board");
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const cleanup = (root.props.ref as (node: unknown) => () => void)({
      addEventListener,
      removeEventListener,
    });
    expect(addEventListener).toHaveBeenCalledWith("touchmove", expect.any(Function), {
      passive: false,
    });
    const touchmove = addEventListener.mock.calls[0]?.[1] as (event: object) => void;
    const preventDefault = vi.fn();
    touchmove({ touches: [{}], preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    board.point("e2", 450, 650, "Down");
    touchmove({ touches: [{}], preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    touchmove({ touches: [{}, {}], preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    board.render({ disabled: true });
    touchmove({ touches: [{}], preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("touchmove", touchmove);
  });
  it("drags a legal move once, suppresses the resulting click, and allows the next turn", () => {
    const board = setup();
    board.point("e2", 450, 650, "Down");
    board.point("e2", 450, 450, "Move");
    board.point("e2", 450, 450, "Up");
    board.click("e2");
    board.click("e2");
    board.click("e4");
    expect(board.onMove).toHaveBeenCalledTimes(1);
    expect(board.onMove).toHaveBeenCalledWith("e2e4");
    expect(board.onInteract).toHaveBeenCalled();
    const chess = new Chess(DEFAULT_POSITION);
    chess.move("e4");
    board.render({ fen: chess.fen() });
    board.click("e7");
    board.click("e5");
    expect(board.onMove).toHaveBeenLastCalledWith("e7e5");
  });

  it("cancels outside, illegal and cancelled drags; ignores opposing pieces", () => {
    const board = setup();
    board.point("e2", 450, 650, "Down");
    board.point("e2", 900, 450, "Up");
    board.click("e2");
    board.point("e2", 450, 650, "Down");
    board.point("e2", 450, 50, "Up");
    board.click("e2");
    board.point("e2", 450, 650, "Down");
    board.point("e2", 450, 450, "Move");
    board.point("e2", 450, 450, "Cancel");
    board.point("e7", 450, 150, "Down");
    board.point("e7", 450, 350, "Up");
    expect(board.onMove).not.toHaveBeenCalled();
  });

  it("locks immediately across rapid square clicks and uses playFen during playback", () => {
    const chess = new Chess(DEFAULT_POSITION);
    chess.move("e4");
    const board = setup({ playFen: chess.fen() });
    board.click("e7");
    const destination = board.square("e5");
    board.fire(destination, "onClick", { detail: 1 });
    board.fire(destination, "onClick", { detail: 1 });
    expect(board.onMove).toHaveBeenCalledOnce();
    expect(board.onMove).toHaveBeenCalledWith("e7e5");
    expect(board.onInteract).toHaveBeenCalled();
  });

  it("promotes from tap or drag and locks synchronously before rerender", () => {
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const board = setup({ fen });
    board.click("a7");
    board.click("a8");
    const queen = board.promotion("q");
    board.fire(queen, "onClick");
    board.fire(queen, "onClick");
    expect(board.onMove).toHaveBeenCalledOnce();
    expect(board.onMove).toHaveBeenCalledWith("a7a8q");
    board.render({ disabled: true });
    board.render({ disabled: false, flipped: true });
    board.point("a7", 750, 650, "Down");
    board.point("a7", 750, 750, "Up");
    for (const piece of ["q", "r", "b", "n"]) expect(board.promotion(piece)).toBeDefined();
    board.fire(board.promotion("n"), "onClick");
    expect(board.onMove).toHaveBeenLastCalledWith("a7a8n");
  });

  it("discards selections, promotion and active drags after position or disabled changes", () => {
    const board = setup();
    board.click("e2");
    const nextFen = new Chess(DEFAULT_POSITION);
    nextFen.move("e4");
    nextFen.move("e5");
    board.render({ playFen: nextFen.fen() });
    board.click("e4");
    expect(board.onMove).not.toHaveBeenCalled();
    board.render({ playFen: DEFAULT_POSITION });
    board.point("e2", 450, 650, "Down");
    board.point("e2", 450, 450, "Move");
    board.render({ disabled: true });
    board.render({ disabled: false });
    board.point("e2", 450, 450, "Up");
    board.click("e2");
    expect(board.onMove).not.toHaveBeenCalled();
    board.render({ fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", playFen: undefined });
    board.click("a7");
    board.click("a8");
    const stale = board.promotion("q");
    board.render({ disabled: true });
    board.fire(stale, "onClick");
    board.render({ disabled: false });
    expect(board.tree().some((element) => element.props["aria-label"] === "board.promote")).toBe(
      false,
    );
    expect(board.onMove).not.toHaveBeenCalled();
  });

  it("invalidates stale input when another tab changes the turn identity without changing FEN", () => {
    const board = setup({ inputKey: "turn-one" });
    board.click("e2");
    board.render({ inputKey: "turn-two" });
    board.click("e4");
    expect(board.onMove).not.toHaveBeenCalled();
    board.point("e2", 450, 650, "Down");
    board.point("e2", 450, 450, "Move");
    board.render({ inputKey: "turn-three" });
    board.point("e2", 450, 450, "Up");
    expect(board.onMove).not.toHaveBeenCalled();
    board.render({ fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1" });
    board.click("a7"); // Consume the cancelled drag's synthetic click.
    board.click("a7");
    board.click("a8");
    const stalePromotion = board.promotion("q");
    board.render({ inputKey: "turn-four" });
    board.fire(stalePromotion, "onClick");
    expect(board.onMove).not.toHaveBeenCalled();
  });
});
