import { expect, it, vi } from "vitest";
import { revealActiveTab } from "./use-reveal-active-tab";

it("moves only the row to reveal its active tab", () => {
  const active = { getBoundingClientRect: () => ({ left: 350, right: 450 }) };
  const row = {
    querySelector: vi.fn(() => active),
    scrollWidth: 600,
    clientWidth: 390,
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, right: 390 }),
  };
  revealActiveTab(row as unknown as HTMLElement);
  expect(row.scrollLeft).toBe(60);
});
