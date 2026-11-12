import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { homeSearchSchema } from "./home-search";

/** Goes through `defaultParseSearch`, the router's actual parser, like verify-email-search. */
const fromUrl = (search: string) => homeSearchSchema.parse(defaultParseSearch(search));

describe("homeSearchSchema", () => {
  it("keeps valid values", () => {
    expect(fromUrl("?tab=leaderboard&game=agent-showdown-1a2b3c4d")).toEqual({
      tab: "leaderboard",
      game: "agent-showdown-1a2b3c4d",
    });
  });

  it("falls back per field instead of failing on unknown or malformed values", () => {
    expect(fromUrl("?tab=nope&game=agent-showdown-1a2b3c4d")).toEqual({
      tab: undefined,
      game: "agent-showdown-1a2b3c4d",
    });
    // JSON.parse turns `?game=123` into a number; it must not throw either.
    expect(fromUrl("?tab=arena&game=123")).toEqual({ tab: "arena", game: undefined });
    expect(fromUrl(`?game=${"x".repeat(181)}`)).toEqual({ tab: undefined, game: undefined });
  });

  it("treats a bare visit as no selection", () => {
    expect(fromUrl("")).toEqual({});
  });
});
