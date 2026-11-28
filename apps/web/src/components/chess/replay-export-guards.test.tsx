import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ handlers: new Map<string, () => unknown>() }));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, input: unknown) => {
    const props = input as { children?: unknown; onClick?: () => unknown };
    if (type !== "button" || !props.onClick) return;
    const labels = Array.isArray(props.children) ? props.children : [props.children];
    for (const label of labels)
      if (typeof label === "string") fixture.handlers.set(label, props.onClick);
  };
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      capture(args[0], args[1]);
      return actual.jsx(...args);
    },
    jsxs: (...args: Parameters<typeof actual.jsxs>) => {
      capture(args[0], args[1]);
      return actual.jsxs(...args);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      const [type, input] = args;
      const props = input as { children?: unknown; onClick?: () => unknown };
      if (type === "button" && props.onClick) {
        const labels = Array.isArray(props.children) ? props.children : [props.children];
        for (const label of labels)
          if (typeof label === "string") fixture.handlers.set(label, props.onClick);
      }
      return actual.jsxDEV(...args);
    },
  };
});
vi.mock("./video/video-export-dialog", () => ({ VideoExportDialog: () => null }));

import { fixtureGame } from "./fixture-game";
import { MatchReplay } from "./replay";

const i18n = createInstance();
const anchor = { click: vi.fn(), href: "", download: "" };
const createObjectURL = vi.fn(() => "blob:owned-export");
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.handlers.clear();
  anchor.click.mockClear();
  createObjectURL.mockClear();
  vi.stubGlobal("document", { createElement: () => anchor });
  vi.stubGlobal("location", { origin: "https://chess.example" });
  vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render(beforeExport?: () => Promise<boolean>) {
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MatchReplay match={fixtureGame()} beforeExport={beforeExport} />
    </I18nextProvider>,
  );
}
async function click(label: string) {
  expect(fixture.handlers.has(label)).toBe(true);
  fixture.handlers.get(label)?.();
  await Promise.resolve();
  await Promise.resolve();
}

it.each(["json", "pgn"] as const)(
  "does not create or download a %s file when public visibility refuses or fails",
  async (format) => {
    for (const check of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error("offline");
      }),
    ]) {
      render(check);
      await click(enChess.replay[format]);
      expect(check).toHaveBeenCalledOnce();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(anchor.click).not.toHaveBeenCalled();
    }
  },
);
it("waits for a fresh public visibility response before creating a downloadable file", async () => {
  let allow: (value: boolean) => void = () => {};
  const pending = new Promise<boolean>((resolve) => {
    allow = resolve;
  });
  render(() => pending);
  await click(enChess.replay.json);
  expect(createObjectURL).not.toHaveBeenCalled();
  allow(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(anchor.click).toHaveBeenCalledOnce();
});
it("keeps local and owner-authorized replay exports available without a public visibility check", async () => {
  render();
  await click(enChess.replay.pgn);
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(anchor.click).toHaveBeenCalledOnce();
});
