import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fixtureGame } from "./fixture-game";

const state = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: () => ({
    data: state.data,
    isPending: false,
    isError: false,
    refetch: () => undefined,
  }),
  useMutation: () => ({ isPending: false, isError: false, mutate: () => undefined }),
}));
vi.mock("./chess-board", () => ({ ChessBoard: () => null }));
vi.mock("./replay", () => ({ MatchReplay: () => null }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function render() {
  vi.stubGlobal("location", { origin: "http://localhost:3000" });
  state.data = { match: fixtureGame(), busy: false, providerReady: true };
  const { LocalModelLab } = await import("./local-model-lab");
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <LocalModelLab />
    </I18nextProvider>,
  );
}

describe("Local lab: Set up your opponent", () => {
  it("puts the quick path first and every other rule in collapsed Advanced sections", async () => {
    const html = await render();
    const form = html.slice(html.indexOf("cc-lab-form"));
    const at = (text: string) => form.indexOf(text);
    // Quick path: mode, model, time control, remarks, then the summary, then Advanced.
    expect(at("Game mode")).toBeGreaterThan(-1);
    expect(at("Game mode")).toBeLessThan(at("Model identifier"));
    expect(at("Model identifier")).toBeLessThan(at("Time control"));
    expect(at("Time control")).toBeLessThan(at("Remarks"));
    expect(at("Remarks")).toBeLessThan(at("Advanced settings"));
    expect(form).toContain("You versus model · Untimed · Fresh context · No remarks");
    // Three closed sections, each with a one-line summary of its values.
    const sections = form.match(/<details class="cc-settings-section"[^>]*>/g) ?? [];
    expect(sections).toHaveLength(3);
    for (const section of sections) expect(section).not.toContain("open");
    expect(form).toContain("Provider token reservations · 1,000,000 tokens per player");
    for (const label of [
      "Conversation memory",
      "Opponent identity",
      "Move format",
      "Chess-engine assistance",
      "Token accounting",
      "Token allowance per player",
    ]) {
      expect(at(label)).toBeGreaterThan(at("Advanced settings"));
    }
  });

  it("labels wire protocols for people, Automatic first, and never shows the raw ids", async () => {
    const html = await render();
    const form = html.slice(html.indexOf("cc-lab-form"));
    expect(form).toContain("Automatic (OpenAI Chat Completions)");
    expect(form).toContain(">Anthropic Messages<");
    expect(form).not.toMatch(/>openai-chat</);
    expect(form).not.toMatch(/>anthropic</);
  });
});
