import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
  options: undefined as
    | undefined
    | {
        refetchInterval: (query: {
          state: { data?: { stale?: boolean }; status?: string };
        }) => number | false;
      },
  state: {
    data: undefined as unknown,
    isError: false,
    refetch: () => undefined,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: NonNullable<typeof catalog.options>) => {
    catalog.options = options;
    return catalog.state;
  },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      key: () => ["chess"],
      models: { queryOptions: () => ({}) },
      create: { mutationOptions: () => ({}) },
    },
  },
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ isPending: false, isError: false, mutate: vi.fn(), reset: vi.fn() }),
}));
// Render the dialog as if open: the static renderer cannot open a portal.
vi.mock("@cockpit-chess/ui/components/dialog", () => {
  const Pass = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  return {
    Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
    DialogTrigger: () => null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  };
});

import { CreateMatchDialog } from "./create-match-dialog";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
const render = () =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <CreateMatchDialog disabled={false} onCreated={vi.fn()} />
    </I18nextProvider>,
  );
const models = [
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    provider: "OpenAI",
    contextLength: 1047576,
    promptPerMillion: 0.1,
    completionPerMillion: 0.4,
    tools: true,
    protocol: "openai-chat",
  },
];

describe("CreateMatchDialog", () => {
  it("puts the two model pickers, the summary and Start first", () => {
    catalog.state = { data: { models }, isError: false, refetch: () => undefined };
    const html = render();
    expect(html).toContain("White model");
    expect(html).toContain("Black model");
    expect(html).toContain(
      "Fresh context · Legal-move tool · Strict format · $0.10 budget · 80 plies",
    );
    expect(html).toContain(">Start match<");
    expect(html.indexOf("White model")).toBeLessThan(html.indexOf("<h3>Advanced settings"));
    // Catalog facts for the chosen model: name, provider, context and prices.
    expect(html).toContain("GPT-4.1 Nano");
    expect(html).toContain("1M context");
    expect(html).toContain("$0.10 in · $0.40 out per 1M tokens");
    // A default not in the catalog stays usable as a typed id.
    expect(html).toContain("openai/gpt-4.1-mini (typed id)");
    expect(html).toContain("Left blank, the title is “GPT-4.1 Nano vs openai/gpt-4.1-mini”.");
  });
  it("groups advanced settings into collapsed, labelled sections with explanations", () => {
    const html = render();
    const sections = html.match(/<details[^>]*>/g) ?? [];
    expect(sections).toHaveLength(3);
    for (const tag of sections) expect(tag).not.toContain("open");
    for (const name of ["Players", "Rules", "Limits"])
      expect(html).toContain(`<strong>${name}</strong>`);
    expect(html).toContain("Automatic (OpenAI Chat Completions)");
    expect(html).toContain("OpenAI Responses · openai-responses");
    expect(html).toContain("Neither side is told which model it is playing.");
    expect(html).toContain("The model can call a tool that lists the legal moves.");
    expect(html).toContain("No Stockfish. The game view has no evaluation bar.");
    expect(html).toContain("The game ends as a draw after this many half-moves (2 to 200).");
    // Raw ids live only in the advanced part.
    const quick = html.slice(0, html.indexOf("<h3>Advanced settings"));
    expect(quick).not.toContain("openai-chat");
  });
  it("keeps the hosted bounds on the number inputs", () => {
    const html = render();
    expect(html).toMatch(/min="2" max="200"/);
    expect(html).toContain('min="0.01"');
    expect(html).toContain('max="1"');
    expect(html).toContain('min="256"');
    expect(html).toContain('max="1000000"');
    expect(html).toContain('maxLength="140"');
  });
  it("warns when the server served an older catalog", () => {
    catalog.state = {
      data: { models, stale: true, fetchedAt: "2026-11-25T20:00:00.000Z" },
      isError: false,
      refetch: () => undefined,
    };
    const html = render();
    expect(html).toContain("The model list could not be refreshed; prices are from");
    expect(html).toContain("Nov 25, 2026");
    expect(html).toContain("Retrying automatically.");
    // It polls while the copy is stale, and stops once it is fresh.
    expect(catalog.options?.refetchInterval({ state: { data: { stale: true } } })).toBe(12000);
    expect(catalog.options?.refetchInterval({ state: { data: { stale: false } } })).toBe(false);
    // A failed refresh of a fresh copy also keeps retrying.
    expect(
      catalog.options?.refetchInterval({ state: { data: { stale: false }, status: "error" } }),
    ).toBe(12000);
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    expect(render()).not.toContain("could not be refreshed");
  });
  it("says when the catalog failed and offers a retry and typed ids", () => {
    catalog.state = { data: undefined, isError: true, refetch: () => undefined };
    const html = render();
    expect(html).toContain("The model list is unavailable. You can still type a model id.");
    expect(html).toContain(">Try again<");
    expect(html).toContain("openai/gpt-4.1-nano (typed id)");
  });
});
