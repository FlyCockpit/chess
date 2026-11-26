import { readFileSync } from "node:fs";
import { THEME_INIT_SCRIPT } from "@cockpit-chess/config/theme-init";
import { describe, expect, it } from "vitest";

/**
 * Every page, public arena and sign-in alike, follows one theme rule: the
 * stored choice, else the system preference, applied by THEME_INIT_SCRIPT in
 * the root document head before first paint. These tests pin the rule and that
 * the arena's own stylesheet obeys it instead of hard-coding a dark palette.
 */
function runInit(stored: string | null, systemDark: boolean) {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const documentElement = {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    style,
  };
  const meta = {
    attrs: {} as Record<string, string>,
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
    },
  };
  const fakeDocument = {
    documentElement,
    querySelector: () => meta,
    createElement: () => meta,
    head: { appendChild: () => undefined },
  };
  const run = new Function("localStorage", "matchMedia", "document", THEME_INIT_SCRIPT);
  run(
    { getItem: (key: string) => (key === "vite-ui-theme" ? stored : null) },
    () => ({ matches: systemDark }),
    fakeDocument,
  );
  return { dark: classes.has("dark"), colorScheme: style.colorScheme };
}

describe("theme rule", () => {
  it.each([
    [null, false, false],
    [null, true, true],
    ["system", true, true],
    ["system", false, false],
    ["dark", false, true],
    ["light", true, false],
  ] as const)("stored %s with system dark=%s resolves dark=%s", (stored, system, dark) => {
    expect(runInit(stored, system)).toEqual({ dark, colorScheme: dark ? "dark" : "light" });
  });
});

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** Every top-level block with exactly this selector, merged. */
function block(selector: string) {
  const escaped = selector.replace(".", "\\.");
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g"))]
    .map((match) => match[1])
    .join("\n");
}
const tokens = (body: string) => new Set([...body.matchAll(/(--cc-[a-z-]+):/g)].map((m) => m[1]));

describe("arena palette", () => {
  it("defines every token for light (:root) and dark (.dark)", () => {
    const light = tokens(block(":root"));
    const dark = tokens(block(".dark"));
    expect(light.size).toBeGreaterThan(10);
    expect([...light].sort()).toEqual([...dark].sort());
    const used = new Set([...css.matchAll(/var\((--cc-[a-z-]+)\)/g)].map((m) => m[1]));
    for (const token of used) if (token !== "--cc-panel-inset") expect(light).toContain(token);
  });
  it("takes the shell's colours from the tokens, not a fixed dark palette", () => {
    const shell = block(".cc-public-shell");
    expect(shell).toContain("background: var(--cc-bg)");
    expect(shell).toContain("color: var(--cc-text)");
    expect(shell).not.toMatch(/oklch\(/);
  });
  it("keeps literal colours only on the board, pieces and White/Black depictions", () => {
    const fixed =
      /^\.cc-(hero-board|hero-sticker|square|light|dark|last|selected|white-piece|black-piece|target|capture-target|avatar-light|dot|swatch-[wb]|eval-[a-z-]+|remark-[wb]|remark-bubble\.cc-remark-[wb]|result-[wb])\b/;
    for (const [, selector = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const literal = body
        .split(";")
        .some((line) => line.includes("oklch(") && !line.trim().startsWith("--"));
      const name = selector.trim().split("\n").at(-1)?.trim() ?? "";
      if (literal && name.startsWith(".cc-")) expect(name).toMatch(fixed);
    }
  });
});
