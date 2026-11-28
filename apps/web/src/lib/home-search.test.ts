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

it("keeps prompt versions parsed as JSON numbers and all comparison filters in shared URLs", () => {
  const rulesKey = "a".repeat(16);
  const initialPositionHash = "b".repeat(64);
  expect(
    fromUrl(
      `?tab=leaderboard&promptVersion=1&rulesKey=${rulesKey}&initialPositionHash=${initialPositionHash}&billingCohort=owner-openrouter&opponentType=model-v-random`,
    ),
  ).toEqual({
    tab: "leaderboard",
    promptVersion: "1",
    rulesKey,
    initialPositionHash,
    billingCohort: "owner-openrouter",
    opponentType: "model-v-random",
  });
  expect(fromUrl("?tab=arena&category=vs-humans")).toEqual({ tab: "arena", category: "vs-humans" });
});
it("drops malformed filters independently without losing the selected tab", () => {
  expect(
    fromUrl(
      "?tab=leaderboard&promptVersion=false&rulesKey=bad&initialPositionHash=bad&billingCohort=runner&opponentType=human&category=private",
    ),
  ).toEqual({
    tab: "leaderboard",
    promptVersion: undefined,
    rulesKey: undefined,
    initialPositionHash: undefined,
    billingCohort: undefined,
    opponentType: undefined,
    category: undefined,
  });
  expect(fromUrl("?promptVersion=2").promptVersion).toBe("2");
  expect(fromUrl("?promptVersion=-1").promptVersion).toBeUndefined();
});
