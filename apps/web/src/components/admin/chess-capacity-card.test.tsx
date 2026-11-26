import enAdmin from "@cockpit-chess/locales/src/en-US/admin.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

vi.mock("@/utils/orpc", () => ({ orpc: { chess: { capacity: { queryOptions: () => ({}) } } } }));

import { type ChessCapacity, ChessCapacityView } from "./chess-capacity-card";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { admin: enAdmin } },
    defaultNS: "admin",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (capacity: ChessCapacity) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ChessCapacityView capacity={capacity} />
    </I18nextProvider>,
  );
const base: ChessCapacity = {
  running: 3,
  concurrencyLimit: 512,
  queued: 2,
  queueCap: 200,
  engine: { busy: 1, total: 4, waiting: 0, workers: 1 },
  matches: [
    {
      slug: "a-1",
      title: "Opus vs Nano",
      status: "running",
      createdAt: new Date("2026-11-26T12:00:00Z"),
      ownerName: "Ada",
    },
    {
      slug: "b-2",
      title: "Queued one",
      status: "queued",
      createdAt: new Date("2026-11-26T12:05:00Z"),
      ownerName: "Grace",
    },
  ],
};

it("shows running against the limit, queued against the cap and the engine pool", () => {
  const html = render(base);
  expect(html).toContain("3 of 512");
  expect(html).toContain("2 of 200");
  expect(html).toContain("1 of 4 busy");
  expect(html).toContain("0 waiting · 1 worker");
  expect(html).toContain("Opus vs Nano");
  expect(html).toContain("Ada · Running");
  expect(html).toContain("Grace · Queued");
  expect(html).not.toContain("No worker reported");
});
it("warns when no worker reported, and says when nothing is running", () => {
  const html = render({ ...base, running: 0, queued: 0, engine: null, matches: [] });
  expect(html).toContain(enAdmin.capacity.noWorker.replaceAll("'", "&#x27;"));
  expect(html).toContain(enAdmin.capacity.empty);
});
