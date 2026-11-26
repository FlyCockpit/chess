import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * With a 32px browser default font (Chrome "Font size: Very large") every rem size
 * doubles, so a 390px phone lays out like a 195px one. Text that cannot break or
 * shrink then runs off the screen. These rules keep the three cases e2e found inside
 * the viewport; `pnpm check:layout` measures geometry in a browser, this pins the
 * rules that make it hold. The header's controls are pinned in header.test.tsx.
 */
const src = import.meta.dirname;
const css = readFileSync(resolve(src, "index.css"), "utf8");
const root = postcss.parse(css);

/** The declarations of the unlayered rule with exactly this selector. */
function declarations(selector: string): Record<string, string> {
  let found: Rule | undefined;
  root.walkRules((rule) => {
    if (rule.selector === selector) found = rule;
  });
  if (!found) throw new Error(`No rule for ${selector}`);
  // Unlayered: it must beat the Tailwind utilities on the shared Button
  // (`whitespace-nowrap`, `shrink-0`, `h-8`), which live in @layer utilities.
  expect(found.parent?.type).toBe("root");
  const out: Record<string, string> = {};
  found.walkDecls((decl) => {
    out[decl.prop] = decl.value;
  });
  return out;
}

describe("a 32px browser font keeps text on screen", () => {
  it("breaks a long game title in the replay sidebar instead of running past it", () => {
    expect(declarations(".cc-match-sidebar h2")["overflow-wrap"]).toBe("anywhere");
  });

  it("keeps the result pill whole and lets the sidebar heading wrap instead", () => {
    expect(declarations(".cc-section-heading .cc-pill")).toMatchObject({
      "white-space": "nowrap",
      "flex-shrink": "0",
    });
    expect(declarations(".cc-match-sidebar .cc-section-heading")["flex-wrap"]).toBe("wrap");
  });

  it("wraps a hero action's label (Studio's Import local archive) inside its row", () => {
    expect(declarations(".cc-hero-actions")["flex-wrap"]).toBe("wrap");
    expect(declarations(".cc-hero-actions > .cc-button")).toMatchObject({
      "flex-shrink": "1",
      "max-width": "100%",
      height: "auto",
      "white-space": "normal",
    });
  });

  it("breaks a long one-word page title (es-MX “Configuración”) inside the page", () => {
    const settings = readFileSync(resolve(src, "routes/$lang/_app/_auth/settings.tsx"), "utf8");
    expect(settings).toMatch(/<h1 className="[^"]*\bbreak-words\b[^"]*">\{t\("title"\)\}<\/h1>/);
    const pageShell = readFileSync(resolve(src, "components/page-shell.tsx"), "utf8");
    expect(pageShell).toMatch(/<h1 className="[^"]*\bbreak-words\b[^"]*">\{title\}<\/h1>/);
  });
});

describe("touch targets", () => {
  it("makes the whole Uneven time row (label beside the switch) a 44px target", () => {
    expect(declarations(".cc-time-uneven label")).toMatchObject({
      "min-height": "44px",
      "align-self": "stretch",
      flex: "1",
    });
  });
});
