import { describe, expect, it } from "vitest";
import { followSystemScheme } from "./system-scheme";

/** A fake media query whose `matches` can be flipped, firing its change listeners. */
function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    flip(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}
const fakeRoot = () => {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return Boolean(force);
      },
    },
  };
};

describe("followSystemScheme", () => {
  it("applies the OS scheme at once and follows its changes until stopped", () => {
    const root = fakeRoot();
    const query = fakeQuery(true);
    const stop = followSystemScheme(root, query as unknown as MediaQueryList);
    expect(root.classes.has("dark")).toBe(true);
    query.flip(false);
    expect(root.classes.has("dark")).toBe(false);
    query.flip(true);
    expect(root.classes.has("dark")).toBe(true);
    stop();
    query.flip(false);
    expect(root.classes.has("dark")).toBe(true);
  });
});
