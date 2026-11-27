import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ answers: [] as (() => Promise<unknown>)[], calls: 0 }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: () => {
    probe.calls++;
    const next = probe.answers.shift();
    if (!next) throw new Error("unexpected probe");
    return next();
  },
}));

import {
  connectIdentityPeers,
  documentAdmits,
  isDocumentReplaced,
  observeDocumentIdentity,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";

import { resolveRouteSession } from "./route-session";

const reload = vi.fn();
const resolved = (id: string | null) =>
  ({ status: "resolved", session: id === null ? null : { user: { id } } }) as const;

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  probe.answers = [];
  probe.calls = 0;
  reload.mockReset();
  vi.stubGlobal("window", { location: { reload, assign: vi.fn() } });
  // No app shell in the document: the hydration wait (lib/app-shell-hydration.ts)
  // resolves at once; app-shell-hydration.test.ts covers it.
  vi.stubGlobal("document", {
    documentElement: { style: { visibility: "" } },
    querySelector: () => null,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveRouteSession", () => {
  it("re-probes an answer older than the identity recorded meanwhile, and returns only the fresh one", async () => {
    // A probe goes out while the document's identity is unknown; before it
    // answers (with A, the session at the time), the watcher records B.
    let answerStale!: (value: unknown) => void;
    probe.answers.push(
      () =>
        new Promise((resolve) => {
          answerStale = resolve;
        }),
      async () => resolved("b"),
    );
    connectIdentityPeers(vi.fn());
    const guard = resolveRouteSession();
    await Promise.resolve();
    observeDocumentIdentity("b");
    answerStale(resolved("a"));
    expect(await guard).toEqual(resolved("b"));
    expect(probe.calls).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    expect(isDocumentReplaced()).toBe(false);
    expect(documentAdmits("b")).toBe(true);
  });

  it("a hover preload sent signed out, answered after this tab signed in, reloads nothing", async () => {
    let answerStale!: (value: unknown) => void;
    probe.answers.push(
      () =>
        new Promise((resolve) => {
          answerStale = resolve;
        }),
      async () => resolved("a"),
    );
    observeDocumentIdentity(null);
    const preload = resolveRouteSession();
    await Promise.resolve();
    observeDocumentIdentity("a");
    answerStale(resolved(null));
    expect(await preload).toEqual(resolved("a"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("an up-to-date answer for another account still replaces the document", async () => {
    probe.answers.push(async () => resolved("b"));
    observeDocumentIdentity("a");
    let settled = false;
    void resolveRouteSession().then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
