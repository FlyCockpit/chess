import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LOCALES } from "@/i18n/config";
import { LOCALE_LABELS } from "@/i18n/labels";
import { LABEL_HIDDEN_BELOW, type LabelHiddenBelow } from "./language-switcher-label";

/**
 * The arena header's controls (language, theme, Studio and, signed in, the
 * account link) must fit 320px in every locale, and from 651px share the row
 * with the translated tabs. The longest locale name ("Español (México)")
 * would crowd them, so there the language trigger shows only its icon and
 * chevron below `xl` (the app header: below `sm`); the name stays for screen
 * readers. The width budget is in public-shell.tsx's PublicHeader.
 */
const lang = vi.hoisted(() => ({ current: "en-US" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: lang.current }, t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" }, meta: {} }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: { auth: { updateLocale: { mutationOptions: () => ({}) } } },
}));

const { LanguageSwitcher } = await import("./language-switcher");
const { default: LanguageSwitcherSelect } = await import("./language-switcher-select");
const { SelectValue } = await import("@cockpit-chess/ui/components/select");

function findElement(node: ReactNode, type: unknown): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

const CASES = SUPPORTED_LOCALES.flatMap((locale) =>
  (Object.keys(LABEL_HIDDEN_BELOW) as LabelHiddenBelow[]).map((below) => [locale, below] as const),
);

describe.each(CASES)("language trigger (%s, icon-only below %s)", (locale, below) => {
  const hidden = LABEL_HIDDEN_BELOW[below];

  it("the eager trigger hides the locale name visually, keeping it and its label for screen readers", () => {
    lang.current = locale;
    const html = renderToStaticMarkup(<LanguageSwitcher labelHiddenBelow={below} />);
    expect(html).toContain('aria-label="languageLabel"');
    expect(html).toMatch(
      new RegExp(
        `<span data-slot="select-value" class="[^"]*(?<![\\w:-])${hidden}(?![\\w:-])[^"]*">${LOCALE_LABELS[locale].replace(/[()]/g, "\\$&")}</span>`,
      ),
    );
  });

  it("the loaded Select's value hides the same way, so the swap does not widen the row", () => {
    lang.current = locale;
    const value = findElement(LanguageSwitcherSelect({ labelHiddenBelow: below }), SelectValue);
    expect(value?.props).toMatchObject({ className: hidden, children: LOCALE_LABELS[locale] });
  });
});

it("defaults to icon-only below sm (the app header)", () => {
  lang.current = "es-MX";
  expect(renderToStaticMarkup(<LanguageSwitcher />)).toContain("max-sm:sr-only");
  expect(findElement(LanguageSwitcherSelect(), SelectValue)?.props).toMatchObject({
    className: "max-sm:sr-only",
  });
});

it("the arena header's breakpoint is xl, where its tabs, brand and controls fit with the name", () => {
  expect(LABEL_HIDDEN_BELOW.xl).toBe("max-xl:sr-only");
});
