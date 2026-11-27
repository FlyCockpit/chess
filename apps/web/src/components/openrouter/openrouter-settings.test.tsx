import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enSettings from "@cockpit-chess/locales/src/en-US/settings.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
import esSettings from "@cockpit-chess/locales/src/es-MX/settings.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  error: undefined as unknown,
  onSuccess: undefined as undefined | ((result: { stopped: string }) => void),
  disconnectOptions: undefined as
    | undefined
    | {
        retry?: (failureCount: number, error: unknown) => boolean;
        onSuccess: (result: { stopped: string }) => void;
      },
  toast: vi.fn(),
  query: {
    data: undefined as unknown,
    error: undefined as unknown,
    isPending: false,
    isError: false,
    refetch: () => undefined,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => fixture.query,
  useMutation: () => ({
    isPending: false,
    isSuccess: false,
    isError: !!fixture.error,
    error: fixture.error,
    mutate: () => {},
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a data-to={to}>{children}</a>,
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    openrouter: {
      key: () => ["openrouter"],
      status: { queryOptions: () => ({}) },
      disconnect: {
        mutationOptions: (options: {
          retry?: (failureCount: number, error: unknown) => boolean;
          onSuccess: (result: { stopped: string }) => void;
        }) => {
          fixture.disconnectOptions = options;
          fixture.onSuccess = options.onSuccess;
          return options;
        },
      },
    },
  },
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ isPending: false, mutate: () => {} }),
}));
vi.mock("@cockpit-chess/ui/components/sileo", () => ({ toast: { success: fixture.toast } }));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));

import { type CallbackNotice, ConnectError } from "@/lib/openrouter-connect";
import { OpenRouterSettings } from "./openrouter-settings";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { common: enCommon, settings: enSettings },
      "es-MX": { common: esCommon, settings: esSettings },
    },
    defaultNS: "settings",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en-US");
});
const copy = enSettings.openrouter;
/** The static renderer escapes apostrophes. */
const esc = (text: string) => text.replaceAll("'", "&#x27;");
const CANARY = "sk-or-v1-CANARY000000000000000000000000000000000000000000000000000000";
function render(data: unknown, notice: CallbackNotice | null = null, extra = {}) {
  fixture.query = { ...fixture.query, data, isPending: false, isError: false, ...extra };
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <OpenRouterSettings lang="en-US" notice={notice} onDismissNotice={() => {}} />
    </I18nextProvider>,
  );
}
const connected = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  connected: true,
  status: "active",
  label: "Cockpit Chess (chess.example)",
  keyHint: "abcd",
  keyHash: "e".repeat(64),
  limitMicros: 10_000_000,
  limitRemainingMicros: 7_500_000,
  usageMicros: 2_500_000,
  usageDailyMicros: 500_000,
  expiresAt: "2027-02-24T00:00:00.000Z",
  connectedAt: "2026-11-26T00:00:00.000Z",
  live: true,
  ...overrides,
});

it("explains when the server does not offer it, with no connect button", () => {
  const html = render({ available: false, connected: false });
  expect(html).toContain(copy.unavailableTitle);
  expect(html).not.toContain(copy.connect);
});
it("guides a first connection: who pays, a suggested limit and expiry, and what comes next", () => {
  const html = render({ available: true, connected: false });
  expect(html).toContain(copy.how.pay);
  expect(html).toContain(copy.limitLabel);
  expect(html).toContain(copy.expiryLabel);
  // The suggested $10 and 90 days start selected.
  expect(html).toMatch(/aria-pressed="true"[^>]*>\$10\.00</);
  expect(html).toMatch(/aria-pressed="true"[^>]*>90 days</);
  expect(html).toContain(copy.connect);
  expect(html).toContain(copy.connectNext);
});
it("shows OpenRouter's own numbers, management links and the next step once connected", () => {
  const html = render(connected());
  expect(html).toContain(copy.connectedTitle);
  expect(html).toContain("ends in abcd");
  expect(html).toContain("$10.00");
  expect(html).toContain("$2.50");
  expect(html).toContain("$7.50");
  expect(html).toContain(`https://openrouter.ai/keys/${"e".repeat(64)}`);
  expect(html).toContain(copy.disconnect);
  expect(html).toContain('data-to="/$lang"');
  expect(html).toContain(copy.replace);
  expect(html).not.toContain(esc(copy.stale));
});
it("keeps the details and Disconnect but offers no new connection while it is off here", () => {
  const html = render(connected({ available: false }));
  expect(html).toContain(copy.connectedTitle);
  expect(html).toContain(copy.disconnect);
  expect(html).toContain(esc(copy.connectOff));
  expect(html).not.toContain(copy.replace);
});
it("says the numbers may be old when OpenRouter did not answer", () => {
  expect(render(connected({ live: false }))).toContain(esc(copy.stale));
});
it("reads a key without a limit as unlimited", () => {
  const html = render(connected({ limitMicros: null, limitRemainingMicros: null }));
  expect(html).toContain(copy.unlimited);
});
it("asks to reconnect when OpenRouter no longer accepts the key", () => {
  const html = render(connected({ status: "invalid" }));
  expect(html).toContain(copy.invalidTitle);
  expect(html).toContain(copy.reconnect);
  expect(html).not.toContain(copy.nextStep);
});
it("renders the callback's result with what to do next", () => {
  expect(render({ available: true, connected: false }, { kind: "connected" })).toContain(
    copy.result.connected,
  );
  const denied = render({ available: true, connected: false }, { kind: "error", code: "denied" });
  expect(denied).toContain(esc(copy.result.denied));
  expect(denied).toContain('role="alert"');
});
it("offers a retry instead of the page when the status cannot load", () => {
  const html = render(undefined, null, { isError: true, error: new Error("offline") });
  expect(html).toContain(esc(copy.loadFailed));
});
it("never renders key material, even if a response carried some", () => {
  const html = render(connected({ apiKey: CANARY, key: CANARY }));
  expect(html).not.toContain("CANARY");
});

it("explains an unreadable key separately", () => {
  expect(render(connected({ status: "invalid", invalidReason: "unreadable" }))).toContain(
    esc(copy.unreadableDescription),
  );
  expect(render(connected({ status: "invalid", invalidReason: "rejected" }))).toContain(
    esc(copy.invalidDescription),
  );
});
it("shows replay guidance", () => {
  expect(render({ available: true, connected: false }, { kind: "error", code: "used" })).toContain(
    esc(copy.result.used),
  );
});
it("uses the retry window or a fallback", () => {
  fixture.error = new ConnectError("rateLimited", 601);
  expect(render({ available: true, connected: false })).toContain("Try again in 11 minutes.");
  fixture.error = new ConnectError("rateLimited");
  expect(render({ available: true, connected: false })).toContain(copy.connectError.rateLimited);
  fixture.error = undefined;
});
it.each(["none", "stopped", "pending"] as const)("reports disconnect outcome %s", (stopped) => {
  render(connected());
  fixture.onSuccess?.({ stopped });
  expect(fixture.toast).toHaveBeenLastCalledWith(copy.disconnectDialog.toast[stopped]);
});

it("formats the suggested spend limit in the active locale's hint", async () => {
  expect(render({ available: true, connected: false })).toContain("$10.00 is a good start");
  await i18n.changeLanguage("es-MX");
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <OpenRouterSettings lang="es-MX" notice={null} onDismissNotice={() => {}} />
    </I18nextProvider>,
  );
  expect(html).toContain("USD 10.00 es un buen comienzo");
  expect(html).not.toContain("$10");
});

it("retries disconnect once on an online network drop, and never on HTTP errors or offline", () => {
  render(connected());
  const retry = fixture.disconnectOptions?.retry;
  expect(retry).toBeTypeOf("function");

  vi.stubGlobal("navigator", { onLine: true });
  expect(retry?.(0, new TypeError("Failed to fetch"))).toBe(true);
  expect(retry?.(1, new TypeError("Failed to fetch"))).toBe(false);
  expect(retry?.(0, { status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
  expect(retry?.(0, { status: 503, code: "SERVICE_UNAVAILABLE" })).toBe(false);

  vi.stubGlobal("navigator", { onLine: false });
  expect(retry?.(0, new TypeError("Failed to fetch"))).toBe(false);
});
