import { readdirSync, readFileSync } from "node:fs";
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
  // A scope may span several blocks (the shadcn tokens, then the --cc-* arena
  // palette); the last declaration wins, as in the cascade.
  const blocks = postcss
    .parse(css)
    .nodes.filter((node) => node.type === "rule" && node.selector === scope);
  if (blocks.length === 0) throw new Error(`Missing theme ${scope}`);
  const declaration = blocks
    .flatMap((block) => (block.type === "rule" ? block.nodes : []))
    .findLast((node) => node.type === "decl" && node.prop === `--${name}`);
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

  it.each(scopes)("%s the brand accent is one green, readable as a fill and as ink", (scope) => {
    // The signed-in shell and the arena share one accent: the arena's --cc-accent*
    // alias the shadcn tokens instead of carrying their own values.
    const declared = (name: string) =>
      postcss
        .parse(css)
        .nodes.filter((node) => node.type === "rule" && node.selector === scope)
        .flatMap((block) => (block.type === "rule" ? block.nodes : []))
        .findLast((node) => node.type === "decl" && node.prop === `--${name}`);
    const value = (name: string) => {
      const decl = declared(name);
      return decl?.type === "decl" ? decl.value : "";
    };
    expect(value("cc-accent")).toBe("var(--primary)");
    expect(value("cc-accent-fg")).toBe("var(--primary-foreground)");
    expect(value("cc-accent-text")).toBe("var(--primary-ink)");
    expect(value("ring")).toBe("var(--primary-ink)");
    expect(value("sidebar-primary")).toBe("var(--primary)");
    // A green, not the old blue: the hue sits in the green band.
    const hue = Number(/^oklch\([\d.]+ [\d.]+ ([\d.]+)\)$/.exec(value("primary"))?.[1]);
    expect(hue).toBeGreaterThan(130);
    expect(hue).toBeLessThan(170);
    // Text on a filled accent (buttons, a checked checkbox's mark).
    expect(
      contrast(token(scope, "primary-foreground"), token(scope, "primary")),
      `${scope} primary-foreground on primary`,
    ).toBeGreaterThanOrEqual(4.5);
    // The accent on its own (links, the active tab, switch and slider fills,
    // focus rings) is text-grade on every surface it sits on.
    const surfaces = ["background", "card", "popover", "muted", "cc-bg", "cc-surface", "cc-raised"];
    for (const surface of surfaces) {
      expect(
        contrast(token(scope, "primary-ink"), token(scope, surface)),
        `${scope} primary-ink on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    if (scope === ".dark")
      expect(
        contrast(token(scope, "primary-ink"), token(".dark .cc-public-shell", "muted")),
        ".dark primary-ink on arena muted",
      ).toBeGreaterThanOrEqual(4.5);
    // A checked switch's thumb on its accent track: bg-background in light,
    // bg-primary-foreground in dark (components/switch.tsx).
    const thumb = token(scope, scope === ".dark" ? "primary-foreground" : "background");
    expect(
      contrast(thumb, token(scope, "primary-ink")),
      `${scope} switch thumb`,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(scopes)(
    "%s field outlines (--input) reach 3:1 on every surface a field sits on",
    (scope) => {
      // WCAG 1.4.11 non-text contrast: the border is what shows where to type.
      // --border is decorative (dividers, cards) and is not held to this.
      // Shared fields also sit on the arena's page and panels (--cc-*).
      const surfaces = [
        "background",
        "card",
        "popover",
        "muted",
        "cc-bg",
        "cc-surface",
        "cc-raised",
      ].map((name): [string, Rgb] => [name, token(scope, name)]);
      // The dark arena repaints --muted (`.dark .cc-public-shell`).
      if (scope === ".dark")
        surfaces.push(["arena muted", token(".dark .cc-public-shell", "muted")]);
      for (const [name, surface] of surfaces) {
        expect(
          contrast(token(scope, "input"), surface),
          `${scope} input on ${name}`,
        ).toBeGreaterThanOrEqual(3);
      }
      // The dark field fill (bg-input/30) must keep placeholder text readable.
      if (scope === ".dark") {
        for (const surface of ["background", "card", "popover"]) {
          const fill = over(token(scope, "input"), 0.3, token(scope, surface));
          expect(
            contrast(token(scope, "muted-foreground"), fill),
            `${scope} placeholder on input fill over ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it("rejects the original low-contrast --input", () => {
    // The original light --input was 1.25:1 on white.
    expect(contrast(oklchToSrgb(0.925, 0.005, 214.3), token(":root", "background"))).toBeLessThan(
      3,
    );
  });

  it("draws the accent on the page in --primary-ink, never the light --primary fill", () => {
    // --primary (the arena's light green) is a fill under dark text, about 1.7:1
    // on a white page; a track, thumb outline or text in it would not read.
    const read = (path: string) => readFileSync(resolve(ui, path), "utf8");
    const web = (path: string) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
    expect(read("components/switch.tsx")).toContain("data-checked:bg-primary-ink ");
    const range = read("components/range-field.tsx");
    expect(range).toContain('Indicator className="h-full bg-primary-ink"');
    expect(range).toContain("border-2 border-primary-ink ");
    expect(read("components/button.tsx")).toContain('link: "text-primary-ink ');
    expect(web("components/bottom-nav.tsx")).toContain(" text-primary-ink ");
    expect(web("components/chess/video/video-export-dialog.tsx")).toContain("bg-primary-ink ");
    for (const source of [read("components/button.tsx"), web("components/bottom-nav.tsx")])
      expect(source).not.toMatch(/(?<![\w-])text-primary(?![\w-])/);
  });

  it.each(["switch.tsx", "checkbox.tsx", "toggle.tsx"])(
    "%s draws an opaque --ring when focused (a half-opacity ring is about 2.2:1 on white)",
    (file) => {
      // These have no border of their own that turns --ring on focus (a checked
      // switch's border would match its --primary-ink track), so the ring is the
      // whole indicator; opaque --ring is --primary-ink, checked at 4.5:1 above.
      const source = readFileSync(resolve(ui, "components", file), "utf8");
      expect(source).toContain("focus-visible:ring-2 ");
      expect(source).toMatch(/focus-visible:ring-ring(?![\w/-])/);
      expect(source).not.toMatch(/focus-visible:ring-ring\/\d+/);
    },
  );

  it("the global focus outline is the opaque --ring", () => {
    // Links and nav items show only the browser outline; at 50% it was ~2.2:1 on white.
    expect(css).toContain("@apply border-border outline-ring;");
    expect(css).not.toMatch(/outline-ring\/\d+/);
  });

  it.each(scopes)("%s the eval-graph cursor has a dark edge on the light graph fill", (scope) => {
    // The mint cursor is ~1.5:1 on the fixed White fill; an opaque --cc-accent-fg
    // line 1px wider on each side is drawn under it (components/chess/eval-bar.tsx).
    const arena = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
    const rule = (name: string) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(arena)?.[1] ?? "";
    const width = (body: string) => Number(/stroke-width: (\d+);/.exec(body)?.[1]);
    const cursor = rule("cc-eval-graph-cursor");
    const edge = rule("cc-eval-graph-cursor-edge");
    expect(cursor).toContain("stroke: var(--cc-accent);");
    expect(edge).toContain("stroke: var(--cc-accent-fg);");
    for (const body of [cursor, edge]) expect(body).toContain("vector-effect: non-scaling-stroke;");
    expect(width(edge) - width(cursor)).toBeGreaterThanOrEqual(2);
    const svg = readFileSync(
      resolve(import.meta.dirname, "../components/chess/eval-bar.tsx"),
      "utf8",
    );
    expect(svg.indexOf('className="cc-eval-graph-cursor-edge"')).toBeGreaterThan(-1);
    expect(svg.indexOf('className="cc-eval-graph-cursor-edge"')).toBeLessThan(
      svg.indexOf('className="cc-eval-graph-cursor"'),
    );
    const fill = /\.cc-eval-graph-white \{[^}]*fill: oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(
      arena,
    );
    expect(fill).not.toBeNull();
    const whiteFill = oklchToSrgb(Number(fill?.[1]), Number(fill?.[2]), Number(fill?.[3]));
    expect(contrast(token(scope, "cc-accent-fg"), whiteFill)).toBeGreaterThanOrEqual(3);
  });

  it("an Off switch fills its track with the opaque --input, which the 3:1 checks cover", () => {
    // A translucent track (dark:bg-input/80) composites below 3:1 on a card.
    const source = readFileSync(resolve(ui, "components/switch.tsx"), "utf8");
    expect(source).toContain("data-unchecked:bg-input ");
    expect(source).not.toMatch(/data-unchecked:bg-input\/\d+/);
  });

  it("draws dropdown menus on an opaque popover surface", () => {
    // A translucent menu (bg-popover/70 + blur) let a banner tint it.
    const menu = readFileSync(resolve(ui, "components/dropdown-menu.tsx"), "utf8");
    expect(menu).toContain(" bg-popover ");
    expect(menu).not.toMatch(/bg-popover\/\d+|backdrop-blur/);
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
    // A long title must not outgrow sileo's 350px pill (the icon ended up
    // half outside it): the header row is capped and the title ellipsised.
    expect(
      declarations(":root [data-sileo-viewport] [data-sileo-header-inner]").get("max-width"),
    ).toBe("calc(var(--sileo-width) - 1rem - 10px)");
    expect(
      declarations(":root [data-sileo-viewport] [data-sileo-header-inner] [data-sileo-title]").get(
        "text-overflow",
      ),
    ).toBe("ellipsis");
    // The action button ("Try again") writes --popover-foreground on an 8%
    // (14% on hover) tint of itself over the pill.
    const button = declarations(":root [data-sileo-viewport] [data-sileo-button][data-state]");
    expect(alias(button.get("--sileo-btn-color"))).toBe("popover-foreground");
    for (const key of ["--sileo-btn-bg", "--sileo-btn-bg-hover"]) {
      const mix = /^color-mix\(in oklch, var\(--popover-foreground\) (\d+)%, transparent\)$/.exec(
        button.get(key) ?? "",
      );
      expect(mix, key).not.toBeNull();
      const fillColor = over(token(scope, "popover-foreground"), Number(mix?.[1]) / 100, surface);
      expect(
        contrast(token(scope, "popover-foreground"), fillColor),
        `${scope} toast button text on ${key}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("search fields in menus and pickers", () => {
  it.each(scopes)("%s muted-foreground reaches 4.5:1 on muted", (scope) => {
    const pairs: [string, Rgb, Rgb][] = [
      ["muted", token(scope, "muted-foreground"), token(scope, "muted")],
    ];
    // The dark arena repaints --muted and --muted-foreground (`.dark .cc-public-shell`).
    if (scope === ".dark")
      pairs.push([
        "arena muted",
        token(".dark .cc-public-shell", "muted-foreground"),
        token(".dark .cc-public-shell", "muted"),
      ]);
    for (const [name, ink, fill] of pairs) {
      expect(contrast(ink, fill), `${scope} muted-foreground on ${name}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it.each(["command.tsx", "async-combobox.tsx", "multi-async-combobox.tsx"])(
    "%s: the placeholder is muted-foreground on an opaque muted fill",
    (file) => {
      // Tailwind's default placeholder is the text colour at 50%, and a
      // translucent bg-input fill moves with the --input outline token: the
      // Create Match model search fell to ~4.23:1 in dark when --input
      // reached 3:1.
      const source = readFileSync(resolve(ui, "components", file), "utf8");
      expect(source).toContain("placeholder:text-muted-foreground");
      // Unprefixed and dark: InputGroup's own `dark:bg-input/30` would
      // otherwise win in the dark theme.
      expect(source).toMatch(/InputGroup className="[^"]*(?<![\w:-])bg-muted[^"]*dark:bg-muted/);
      expect(source).not.toMatch(/InputGroup className="[^"]*bg-input\/\d+/);
    },
  );
});

describe("hovered field fills", () => {
  it("keep placeholder text readable on every hovered --input fill", () => {
    // Select and outline triggers hover to a stronger `bg-input/NN` while they
    // still show a muted placeholder; at /50 the dark fill fell below 4.5:1
    // once --input reached 3:1. Every `hover:bg-input/NN` in the ui package
    // and the app is checked in the themes it applies to.
    const roots = [ui, resolve(import.meta.dirname, "..")];
    const fills: string[] = [];
    for (const root of roots) {
      for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        const source = readFileSync(resolve(root, file), "utf8");
        for (const match of source.matchAll(/(?<![\w-])((?:[\w-]+:)*hover:)bg-input\/(\d+)/g)) {
          const alpha = Number(match[2]) / 100;
          fills.push(`${file}: ${match[0]}`);
          const themes = (match[1] ?? "").split(":").includes("dark")
            ? [".dark"]
            : [":root", ".dark"];
          for (const scope of themes) {
            // Triggers also sit in the arena (the header's language switcher),
            // whose dark theme repaints --muted-foreground.
            const inks: [string, Rgb][] = [["", token(scope, "muted-foreground")]];
            if (scope === ".dark")
              inks.push([" (arena)", token(".dark .cc-public-shell", "muted-foreground")]);
            for (const surface of ["background", "card", "popover", "cc-bg", "cc-surface"]) {
              const fill = over(token(scope, "input"), alpha, token(scope, surface));
              for (const [where, ink] of inks) {
                expect(
                  contrast(ink, fill),
                  `${scope} placeholder${where} on ${match[0]} over ${surface} (${file})`,
                ).toBeGreaterThanOrEqual(4.5);
              }
            }
          }
        }
      }
    }
    // The select, outline-button and language-switcher hovers.
    expect(fills.length).toBeGreaterThanOrEqual(3);
  });

  it("measures the old /50 dark hover as failing, so the check discriminates", () => {
    const fill = over(token(".dark", "input"), 0.5, token(".dark", "card"));
    expect(contrast(token(".dark", "muted-foreground"), fill)).toBeLessThan(4.5);
  });
});
