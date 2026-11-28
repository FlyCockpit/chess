import type { MatchConfig } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enErrors from "@cockpit-chess/locales/src/en-US/errors.json";
import { useForm } from "@tanstack/react-form";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({
  meta: undefined as unknown,
  state: { isError: false, error: null as unknown },
  mutate:
    vi.fn<
      (input: MatchConfig & { billing: string; official: boolean; creationKey: string }) => void
    >(),
  success: undefined as undefined | ((result: { slug: string }) => void),
}));
const sheet = vi.hoisted(() => ({
  changeOpen: undefined as undefined | ((open: boolean) => void),
}));
vi.mock("@tanstack/react-form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-form")>();
  return { ...actual, useForm: vi.fn(actual.useForm) };
});
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
      create: {
        mutationOptions: (options: { onSuccess: typeof mutation.success }) => {
          mutation.success = options.onSuccess;
          return options;
        },
      },
    },
  },
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: (options: { meta?: unknown }) => {
    mutation.meta = options.meta;
    return { isPending: false, mutate: mutation.mutate, reset: vi.fn(), ...mutation.state };
  },
}));
// Render the dialog as if open: the static renderer cannot open a portal.
vi.mock("@cockpit-chess/ui/components/sheet", () => {
  const Pass = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  return {
    Sheet: ({
      children,
      onOpenChange,
    }: {
      children: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => {
      sheet.changeOpen = onOpenChange;
      return <>{children}</>;
    },
    SheetTrigger: () => null,
    SheetContent: Pass,
    SheetBody: Pass,
    SheetHeader: Pass,
    SheetFooter: Pass,
    SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  };
});

import { CreateMatchDialog } from "./create-match-dialog";
import { type CreateMatchValues, DEFAULT_VALUES } from "./create-match-form";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.state = { isError: false, error: null };
});
const render = (limits?: { maxCostMicros: number; maxTokens: number }) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <CreateMatchDialog disabled={false} limits={limits} onCreated={vi.fn()} />
    </I18nextProvider>,
  );
function formOptions() {
  const options = vi.mocked(useForm).mock.calls.at(-1)?.[0];
  if (!options) throw new Error("No create form rendered");
  return options as {
    onSubmit: (props: { value: CreateMatchValues }) => void;
    listeners: { onChange: () => void };
  };
}
const models = [
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    provider: "OpenAI",
    contextLength: 1047576,
    maxOutputTokens: 32768,
    promptPerMillion: 0.1,
    completionPerMillion: 0.4,
    tools: true,
    protocol: "openai-chat",
  },
];

describe("CreateMatchDialog", () => {
  it.each(["white", "black"] as const)(
    "offers play as %s as practice with a single model picker",
    (playAs) => {
      const previous = DEFAULT_VALUES.playAs;
      DEFAULT_VALUES.playAs = playAs;
      try {
        const html = render();
        expect(html).toContain(enChess.human.mode);
        expect(html).toContain(enChess.human.practice);
        expect(html).toContain(enChess.human.createHint);
        expect(html).toContain(enChess.human.you);
        expect(html).not.toContain(`>${enChess.create.official}</button>`);
        formOptions().onSubmit({ value: { ...DEFAULT_VALUES } });
        expect(mutation.mutate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            official: false,
            [playAs]: expect.objectContaining({ protocol: "human", model: "human" }),
            rules: expect.objectContaining({ context: "fresh" }),
          }),
        );
      } finally {
        DEFAULT_VALUES.playAs = previous;
      }
    },
  );
  it("explains the conservative remaining-key cap without claiming the human spends", () => {
    const previous = DEFAULT_VALUES.playAs;
    DEFAULT_VALUES.playAs = "white";
    try {
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <CreateMatchDialog
            disabled={false}
            billingOptions={["openrouter"]}
            ownKeyRemainingMicros={3_000_000}
            onCreated={vi.fn()}
          />
        </I18nextProvider>,
      );
      expect(html).toContain("only the model spends");
      expect(html).not.toContain("both players bill it");
    } finally {
      DEFAULT_VALUES.playAs = previous;
    }
  });
  it("puts the two model pickers, the summary and Start first", () => {
    catalog.state = { data: { models }, isError: false, refetch: () => undefined };
    const html = render();
    expect(html).toContain("White model");
    expect(html).toContain("Black model");
    expect(html).toContain(
      "Untimed · Fresh context · Legal-move tool · Strict format · $1.00 budget",
    );
    // The time control is on the quick path, before the advanced sections.
    expect(html.indexOf("Time control")).toBeLessThan(html.indexOf("<h3>Advanced settings"));
    for (const preset of [">Untimed<", ">5 min<", ">10 min<", ">30 min<", ">Custom<"])
      expect(html).toContain(preset);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("No clock: only the per-move safety limit applies.");
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
  it.each(["operator", "openrouter"] as const)(
    "defaults %s billing to practice and explains publication independently",
    (billing) => {
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <CreateMatchDialog disabled={false} billingOptions={[billing]} onCreated={vi.fn()} />
        </I18nextProvider>,
      );
      expect(html).toMatch(/aria-pressed="true"[^>]*>Practice \(default\)</);
      expect(html).toContain(enChess.create.practiceCommitment);
      expect(html).toContain(enChess.create.practiceSubmitHint);
      expect(html.indexOf(enChess.create.practiceCommitment)).toBeLessThan(
        html.indexOf(">Start match<"),
      );
      const { onSubmit } = formOptions();
      onSubmit({ value: { ...DEFAULT_VALUES } });
      expect(mutation.mutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ official: false, billing }),
      );
    },
  );
  it("puts the permanent accepted-queue commitment beside the official submit action", () => {
    const previous = DEFAULT_VALUES.official;
    DEFAULT_VALUES.official = true;
    try {
      const html = render();
      expect(html).toMatch(/aria-pressed="true"[^>]*>Official</);
      expect(html).toContain(enChess.create.officialCommitment);
      expect(html).toContain(enChess.create.officialSubmitHint);
      expect(html.indexOf(enChess.create.officialSubmitHint)).toBeGreaterThan(
        html.indexOf("cc-create-footer"),
      );
      expect(html.indexOf(enChess.create.officialCommitment)).toBeLessThan(
        html.indexOf(">Start match<"),
      );
      expect(html).not.toContain(enChess.create.practiceCommitment);
      formOptions().onSubmit({ value: { ...DEFAULT_VALUES } });
      expect(mutation.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ official: true }));
    } finally {
      DEFAULT_VALUES.official = previous;
    }
  });
  it("reuses the exact UUID and payload after failed or lost responses, and clears it on edits", () => {
    render();
    const options = formOptions();
    options.onSubmit({ value: { ...DEFAULT_VALUES, official: true } });
    const first = mutation.mutate.mock.calls[0]?.[0];
    expect(first?.creationKey).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    mutation.state = { isError: true, error: new TypeError("Failed to fetch") };
    options.onSubmit({ value: { ...DEFAULT_VALUES, official: true } });
    expect(mutation.mutate.mock.calls[1]?.[0]).toBe(first);
    options.listeners.onChange();
    options.onSubmit({ value: { ...DEFAULT_VALUES, official: true, budget: 2 } });
    const edited = mutation.mutate.mock.calls[2]?.[0];
    expect(edited?.creationKey).not.toBe(first?.creationKey);
    expect(edited?.rules.costBudgetMicros).toBe(2_000_000);
    // Even returning to the earlier configuration represents a new intent after editing.
    options.listeners.onChange();
    options.onSubmit({ value: { ...DEFAULT_VALUES, official: true } });
    expect(mutation.mutate.mock.calls[3]?.[0].creationKey).not.toBe(first?.creationKey);
  });
  it("uses a fresh UUID after closing/reopening or a successful acceptance", () => {
    render();
    const { onSubmit } = formOptions();
    onSubmit({ value: { ...DEFAULT_VALUES } });
    const first = mutation.mutate.mock.calls[0]?.[0].creationKey;
    sheet.changeOpen?.(false);
    sheet.changeOpen?.(true);
    onSubmit({ value: { ...DEFAULT_VALUES } });
    const second = mutation.mutate.mock.calls[1]?.[0].creationKey;
    expect(second).not.toBe(first);
    mutation.success?.({ slug: "accepted" });
    onSubmit({ value: { ...DEFAULT_VALUES } });
    expect(mutation.mutate.mock.calls[2]?.[0].creationKey).not.toBe(second);
  });
  it("groups advanced settings into collapsed, labelled sections with explanations", () => {
    const html = render();
    const sections = html.match(/<details[^>]*>/g) ?? [];
    expect(sections).toHaveLength(3);
    for (const tag of sections) expect(tag).not.toContain("open");
    for (const name of ["Players", "Rules", "Limits"])
      expect(html).toContain(`<strong>${name}</strong>`);
    expect(html).toContain("Automatic (OpenAI Chat Completions)");
    // Protocol options name the protocol, never its raw id.
    expect(html).toContain(">OpenAI Responses<");
    expect(html).not.toContain("· openai-responses");
    expect(html).toContain("Neither side is told which model it is playing.");
    expect(html).toContain("The model can call a tool that lists the legal moves.");
    expect(html).toContain(
      "No Stockfish for the players. Spectators still see an evaluation bar, scored separately.",
    );
    expect(html).not.toContain("half-moves");
    // The remark tone is one choice with an explanation of the selected tone.
    expect(html).toContain(">Remarks<");
    for (const tone of [">No remarks<", ">Commentary<", ">Trash talk<"])
      expect(html).toContain(tone);
    expect(html).toContain("Players send only their move.");
    expect(html).toContain(
      "A safety limit for one move. Blank uses 1 min: one minute, never longer than a side&#x27;s clock. 1–300 seconds.",
    );
    // Raw ids live only in the advanced part.
    const quick = html.slice(0, html.indexOf("<h3>Advanced settings"));
    expect(quick).not.toContain("openai-chat");
  });
  it("keeps the hosted bounds on the inputs, with budget maxima from the server", () => {
    const html = render({ maxCostMicros: 25_000_000, maxTokens: 10_000_000 });
    expect(html).not.toMatch(/max="200"/);
    expect(html).toMatch(/min="1" max="300"/);
    expect(html).toContain("in US dollars ($0.01 to $25.00)");
    expect(html).toContain("(256 to 10,000,000)");
    // The budgets are sliders with a typed value: $1 and 1M tokens per side by default.
    expect(html).toContain('value="1 USD"');
    expect(html).toContain('value="1 M"');
    expect(html).toContain('maxLength="140"');
    const small = render({ maxCostMicros: 5_000_000, maxTokens: 200_000 });
    expect(small).toContain("in US dollars ($0.01 to $5.00)");
    expect(small).toContain("(256 to 200,000)");
    // Defaults above a lower server cap start at the cap.
    expect(small).toContain('value="200 k"');
  });
  it("offers keep trying or forfeit-after-N for illegal moves in the rules section", () => {
    const html = render();
    expect(html).toContain("On repeated illegal moves");
    expect(html).toContain(">Forfeit after repeated illegal moves<");
    expect(html).toContain(">Keep trying until a legal move<");
    expect(html).toContain("After this many rejected moves on one turn, that side loses the game.");
    expect(html).toContain("Illegal moves before a forfeit");
    expect(html).toContain("Forfeits after 3 illegal moves");
    // The rules section holds the option; the quick path keeps the default.
    expect(html.indexOf("On repeated illegal moves")).toBeGreaterThan(
      html.indexOf('data-section="rules"'),
    );
    expect(html.indexOf("On repeated illegal moves")).toBeLessThan(
      html.indexOf('data-section="limits"'),
    );
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
  it("is a wide side sheet: the quick path in one column, the summary and Advanced in the other", () => {
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    const html = render();
    expect(html).toContain('class="cc-dialog-content cc-create-dialog"');
    const quick = html.indexOf('class="cc-create-quick"');
    const side = html.indexOf('class="cc-create-side"');
    expect(quick).toBeGreaterThan(-1);
    expect(side).toBeGreaterThan(quick);
    const between = html.slice(quick, side);
    for (const text of [
      "White model",
      "Black model",
      "Time control",
      "Match title (optional)",
      ">Remarks<",
      ">Trash talk<",
    ])
      expect(between).toContain(text);
    const after = html.slice(side);
    expect(after).toContain(enChess.create.summaryLabel);
    expect(after).toContain(enChess.create.advanced);
    // The primary action stays in the sticky footer, outside the scrolling body.
    expect(after.indexOf("cc-create-footer")).toBeGreaterThan(
      after.indexOf(enChess.create.advanced),
    );
  });
  it("explains a failed start beside the action bar instead of a toast over it", () => {
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    mutation.state = { isError: true, error: { code: "SERVICE_UNAVAILABLE" } };
    let html = render().replaceAll("&#x27;", "'");
    expect(mutation.meta).toEqual({ skipGlobalErrorToast: true });
    expect(html).toContain(enChess.create.errors.unavailable);
    mutation.state = { isError: true, error: { code: "TOO_MANY_REQUESTS" } };
    html = render().replaceAll("&#x27;", "'");
    expect(html).toContain(enChess.create.errors.rateLimited);
    mutation.state = { isError: true, error: new Error("network") };
    html = render().replaceAll("&#x27;", "'");
    expect(html).toContain(enChess.studio.error);
    mutation.state = { isError: false, error: null };
  });
  it("says you're offline when the start failed for want of a network", () => {
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    vi.stubGlobal("navigator", { onLine: false });
    mutation.state = { isError: true, error: new TypeError("Failed to fetch") };
    const html = render().replaceAll("&#x27;", "'");
    vi.unstubAllGlobals();
    mutation.state = { isError: false, error: null };
    expect(html).toContain(enErrors.offline);
    expect(html).not.toContain(enChess.studio.error);
  });
  it("says what to do for each refusal the server explains", () => {
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    for (const reason of ["active-match", "daily-limit", "queue-full", "not-connected"] as const) {
      mutation.state = { isError: true, error: { code: "CONFLICT", data: { reason } } };
      expect(render().replaceAll("&#x27;", "'")).toContain(enChess.create.errors[reason]);
    }
    mutation.state = { isError: false, error: null };
  });
  it("bills a user's own key and stops the budget at half of what it has left", () => {
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <CreateMatchDialog
          disabled={false}
          billingOptions={["openrouter"]}
          ownKeyRemainingMicros={3_000_000}
          onCreated={vi.fn()}
        />
      </I18nextProvider>,
    ).replaceAll("&#x27;", "'");
    expect(html).toContain("Billed to your OpenRouter key · $3.00 left");
    expect(html).toContain("so each budget stops at $1.50");
    // No billing choice to make: only one payer.
    expect(html).not.toContain(enChess.create.billingLabel);
  });
  it("lets an admin with a connected key pick who pays, the server key first", () => {
    catalog.state = { data: { models, stale: false }, isError: false, refetch: () => undefined };
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <CreateMatchDialog
          disabled={false}
          billingOptions={["operator", "openrouter"]}
          ownKeyRemainingMicros={null}
          onCreated={vi.fn()}
        />
      </I18nextProvider>,
    ).replaceAll("&#x27;", "'");
    expect(html).toContain(enChess.create.billingLabel);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Server key</);
    expect(html).toContain(enChess.create.billingHint.operator);
  });
});
