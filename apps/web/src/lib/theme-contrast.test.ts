import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// The theme's state inks and the toast surface, measured from the tokens in
// packages/ui/src/styles/globals.css (docs/design-system.md § Shell rules).
const ui = resolve(import.meta.dirname, "../../../../packages/ui/src");
const css = readFileSync(resolve(ui, "styles/globals.css"), "utf8");
const scopes = [":root", ".dark"] as const;
type Rgb = [number, number, number];

// Convert OKLCH through linear sRGB, clipping out-of-gamut channels before
// encoding. Contrast and alpha compositing then use the displayed sRGB colors.
function oklchToSrgb(l: number, c: number, hue: number): Rgb {
  const a = c * Math.cos((hue * Math.PI) / 180);
  const b = c * Math.sin((hue * Math.PI) / 180);
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (channel: number) => {
    const v = Math.min(1, Math.max(0, channel));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [
    encode(4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z),
    encode(-1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z),
    encode(-0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z),
  ];
}

function token(scope: string, name: string): Rgb {
  const block = postcss
    .parse(css)
    .nodes.find((node) => node.type === "rule" && node.selector === scope);
  if (block?.type !== "rule") throw new Error(`Missing theme ${scope}`);
  const declaration = block.nodes.find((node) => node.type === "decl" && node.prop === `--${name}`);
  const value = declaration?.type === "decl" ? declaration.value : "";
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  if (alias?.[1]) return token(scope, alias[1]);
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!match) throw new Error(`Unsupported --${name} in ${scope}: ${value}`);
  return oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

function luminance([r, g, b]: Rgb): number {
  const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("theme contrast (WCAG AA)", () => {
  it("calibrates conversion, luminance and compositing against known colors", () => {
    expect(contrast([0, 0, 0], [1, 1, 1])).toBe(21);
    expect(contrast([1, 1, 1], [0, 0, 0])).toBe(21);
    expect(contrast([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBe(1);
    expect(luminance([0.5, 0.5, 0.5])).toBeCloseTo(0.214041, 6);
    expect(oklchToSrgb(0, 0, 0)).toEqual([0, 0, 0]);
    expect(oklchToSrgb(1, 0, 0)[0]).toBeCloseTo(1);
    expect(over([1, 0, 0], 0.5, [0, 0, 1])).toEqual([0.5, 0, 0.5]);
  });

  it.each(scopes)("%s state inks reach 4.5:1 on background, card and popover", (scope) => {
    // Badges, alerts and toasts write in these colours.
    for (const ink of ["state-success", "state-warning", "state-info", "state-loading"]) {
      for (const surface of ["background", "card", "popover"]) {
        expect(
          contrast(token(scope, ink), token(scope, surface)),
          `${scope} ${ink} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(scopes)("%s toasts are a popover surface with 4.5:1 inks", (scope) => {
    // sileo's own palette inverts the theme; globals.css repaints it from the
    // tokens. Every state ink it maps and its text colour must hold up on the
    // fill it maps. See docs/design-system.md § Shell rules
    const rules = postcss.parse(css).nodes.filter((node) => node.type === "rule");
    const declarations = (selector: string) => {
      const rule = rules.find((node) => node.type === "rule" && node.selector === selector);
      if (rule?.type !== "rule") throw new Error(`Missing toast rule ${selector}`);
      return new Map(
        rule.nodes.flatMap((node) => (node.type === "decl" ? [[node.prop, node.value]] : [])),
      );
    };
    const alias = (value: string | undefined) => /^var\(--([\w-]+)\)$/.exec(value ?? "")?.[1];
    const fill = alias(
      declarations(":root [data-sileo-viewport] :is([data-sileo-pill], [data-sileo-body])").get(
        "fill",
      ),
    );
    expect(fill).toBe("popover");
    const surface = token(scope, "popover");
    const viewport = declarations(":root [data-sileo-viewport]");
    const states = ["success", "loading", "error", "warning", "info", "action"];
    for (const state of states) {
      const ink = alias(viewport.get(`--sileo-state-${state}`));
      expect(ink, `--sileo-state-${state} maps to a token`).toBeDefined();
      expect(
        contrast(token(scope, ink ?? ""), surface),
        `${scope} toast ${state} (${ink}) on popover`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // The badge ink sits on the pill itself (contrast above), not on a tint.
    expect(
      declarations(":root [data-sileo-viewport] [data-sileo-badge][data-state]").get(
        "--sileo-tone-bg",
      ),
    ).toBe("transparent");
    for (const selector of [
      ":root [data-sileo-viewport] [data-sileo-title][data-state]",
      ":root [data-sileo-viewport] [data-sileo-description]",
    ]) {
      const text = alias(declarations(selector).get("color"));
      expect(text, selector).toBe("popover-foreground");
    }
    expect(contrast(token(scope, "popover-foreground"), surface)).toBeGreaterThanOrEqual(4.5);
  });
});
