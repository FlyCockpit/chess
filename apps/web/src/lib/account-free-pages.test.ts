import { describe, expect, it } from "vitest";

import { holdsNoAccountData } from "./account-free-pages";

const at = (pathname: string, search: Record<string, unknown> = {}) => ({ pathname, search });

describe("holdsNoAccountData (the allowlist)", () => {
  it.each(["arena", "leaderboard", "lab", "methodology"])("the arena home's %s tab", (tab) => {
    expect(holdsNoAccountData(at("/en-US", { tab }))).toBe(true);
    expect(holdsNoAccountData(at("/es-MX/", { tab }))).toBe(true);
  });

  it("the arena home without a tab, with a game, or with a mistyped tab (all land on the arena)", () => {
    expect(holdsNoAccountData(at("/en-US"))).toBe(true);
    expect(holdsNoAccountData(at("/en-US", { tab: "arena", game: "some-game" }))).toBe(true);
    expect(holdsNoAccountData(at("/en-US", { tab: "nope" }))).toBe(true);
  });

  it("never the Studio tab, which shows the account's own games", () => {
    expect(holdsNoAccountData(at("/en-US", { tab: "studio" }))).toBe(false);
  });

  it.each([
    "/en-US/settings",
    "/en-US/admin",
    "/en-US/login",
    "/en-US/device",
    "/en-US/verify-email",
    "/en-US/unknown",
    "/xx-XX",
    "/",
  ])("never any other page: %s", (pathname) => {
    expect(holdsNoAccountData(at(pathname))).toBe(false);
  });
});
