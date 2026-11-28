import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import enSettings from "@cockpit-chess/locales/src/en-US/settings.json";
import esCommon from "@cockpit-chess/locales/src/es-MX/common.json";
import esSettings from "@cockpit-chess/locales/src/es-MX/settings.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Values = { match: string; day: string; concurrency: string; password: string; code: string };
const fixture = vi.hoisted(() => ({
  state: {
    available: true,
    operatingLimits: { matchMicros: 1_000_000, dayMicros: 10_000_000, concurrency: 2, revision: 0 },
    hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
    pending: null as null | { revision: number },
    lastResult: null as null | { revision: number; reason: string },
    methods: { password: true, totp: true },
  },
  values: { match: "1", day: "10", concurrency: "2", password: "test-password", code: "123456" },
  submit: undefined as undefined | ((value: { value: Values }) => Promise<void>),
  proved: [] as unknown[],
  sent: [] as unknown[],
  failProof: false,
  queryError: undefined as unknown,
}));
vi.mock("@cockpit-chess/ui/components/sheet", () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Sheet: Box,
    SheetContent: Box,
    SheetBody: Box,
    SheetHeader: Box,
    SheetTitle: Box,
    SheetDescription: Box,
  };
});
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/en-US/settings/security">{children}</a>
  ),
}));
vi.mock("@tanstack/react-form", () => ({
  useForm: (options: { onSubmit: (value: { value: Values }) => Promise<void> }) => {
    fixture.submit = options.onSubmit;
    return {
      handleSubmit: () => options.onSubmit({ value: fixture.values }),
      setFieldValue: (name: keyof Values, value: string) => {
        fixture.values[name] = value;
      },
      Field: ({
        name,
        children,
      }: {
        name: keyof Values;
        children: (field: unknown) => ReactNode;
      }) =>
        children({
          name,
          state: { value: fixture.values[name], meta: { errors: [] } },
          handleBlur() {},
          handleChange() {},
        }),
      Subscribe: ({ children }: { children: (value: Values) => ReactNode }) =>
        children(fixture.values),
    };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: fixture.state,
    isPending: false,
    isError: !!fixture.queryError,
    error: fixture.queryError,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: { kind: string }) => ({
    isPending: false,
    reset: vi.fn(),
    mutateAsync: async (input: unknown) => {
      if (options.kind === "proof") {
        fixture.proved.push(input);
        if (fixture.failProof) throw { code: "FORBIDDEN", message: "DO_NOT_RENDER" };
        return { proof: "a".repeat(64) };
      }
      fixture.sent.push(input);
      return fixture.state;
    },
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    cliAccess: {
      runners: {
        getLimits: { queryOptions: () => ({}), key: () => ["limits"] },
        proveLimits: { mutationOptions: () => ({ kind: "proof" }) },
        setLimits: { mutationOptions: () => ({ kind: "set" }) },
      },
    },
  },
}));

import { RunnerLimitsSheet } from "./runner-limits-sheet";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { settings: enSettings, common: enCommon },
      "es-MX": { settings: esSettings, common: esCommon },
    },
    defaultNS: "settings",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  fixture.values = {
    match: "1",
    day: "10",
    concurrency: "2",
    password: "test-password",
    code: "123456",
  };
  fixture.state.methods = { password: true, totp: true };
  fixture.state.pending = null;
  fixture.state.lastResult = null;
  fixture.state.available = true;
  fixture.proved = [];
  fixture.sent = [];
  fixture.failProof = false;
  fixture.queryError = undefined;
});
const runner = {
  id: "machine",
  displayName: "Laptop",
  credentialPrefix: "prefix",
  createdAt: new Date(),
  expiresAt: new Date(),
  revokedAt: null,
  lastSeenAt: null,
  status: "active" as const,
};
function render() {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RunnerLimitsSheet runner={runner} onClose={() => {}} />
    </I18nextProvider>,
  );
}
async function submit() {
  render();
  expect(fixture.submit).toBeDefined();
  await fixture.submit?.({ value: { ...fixture.values } });
}

describe("runner limit browser policy", () => {
  it("binds a password proof to the exact mixed raise and current revision", async () => {
    fixture.values = { ...fixture.values, match: "2", day: "9" };
    await submit();
    const request = {
      id: "machine",
      expectedRevision: 0,
      limits: { matchMicros: 2_000_000, dayMicros: 9_000_000, concurrency: 2 },
    };
    expect(fixture.proved).toEqual([
      { ...request, verification: { method: "password", password: "test-password" } },
    ]);
    expect(fixture.sent).toEqual([{ ...request, proof: "a".repeat(64) }]);
    expect(fixture.values.password).toBe("");
    expect(fixture.values.code).toBe("");
  });
  it("uses authenticator verification for an account with no password", async () => {
    fixture.state.methods.password = false;
    fixture.values.match = "2";
    await submit();
    expect(fixture.proved).toEqual([
      expect.objectContaining({ verification: { method: "totp", code: "123456" } }),
    ]);
    expect(fixture.sent).toHaveLength(1);
  });
  it("never sends an increase after failed verification", async () => {
    fixture.values.match = "2";
    fixture.failProof = true;
    await submit();
    expect(fixture.proved).toHaveLength(1);
    expect(fixture.sent).toEqual([]);
  });
  it("allows reductions without a proof and gives SSO accounts a setup path for raises", async () => {
    fixture.state.methods = { password: false, totp: false };
    fixture.values.match = "0.5";
    await submit();
    expect(fixture.proved).toEqual([]);
    expect(fixture.sent).toEqual([
      expect.objectContaining({
        limits: { matchMicros: 500_000, dayMicros: 10_000_000, concurrency: 2 },
      }),
    ]);
    fixture.sent = [];
    fixture.values.match = "2";
    expect(render()).toContain(enSettings.cli.runners.limits.setupLink);
    await submit();
    expect(fixture.sent).toEqual([]);
    expect(fixture.proved).toEqual([]);
  });
  it("refuses above-ceiling values and pending overwrites", async () => {
    fixture.values.match = "26";
    expect(render()).toContain(enSettings.cli.runners.limits.ceiling);
    await submit();
    expect(fixture.sent).toEqual([]);
    expect(fixture.proved).toEqual([]);
    fixture.values.match = "2";
    fixture.state.pending = { revision: 1 };
    await submit();
    expect(fixture.sent).toEqual([]);
    expect(fixture.proved).toEqual([]);
  });
  it("shows confirmed, pending and refusal copy in both locales; access failures hide private limits", async () => {
    fixture.state.pending = { revision: 1 };
    fixture.state.lastResult = { revision: 1, reason: "ceiling" };
    expect(render()).toContain("waiting for terminal confirmation");
    expect(render()).toContain("refused by the terminal");
    await i18n.changeLanguage("es-MX");
    expect(render()).toContain("espera la confirmación de la terminal");
    expect(render()).toContain("La terminal rechazó");
    fixture.queryError = { code: "UNAUTHORIZED" };
    const html = render();
    expect(html).not.toContain("Topes locales:");
    expect(html).not.toContain("Contraseña actual");
  });
});
