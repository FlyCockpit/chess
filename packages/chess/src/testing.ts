import { type MatchArchive, type RulesV1, rulesV1Schema } from "./index";

/**
 * Test support: re-files a freshly created (cockpit-v2) match under cockpit-v1, the
 * ruleset older archives carry (a move cap, one shared time allowance, on/off remarks),
 * so tests can exercise how those archives still replay, validate and finish.
 */
export function asCockpitV1(match: MatchArchive, overrides: Partial<RulesV1> = {}) {
  const rules = match.config.rules;
  if (rules.version !== "cockpit-v2") throw new Error("The match is already cockpit-v1");
  const { version: _version, remarks, clock, ...shared } = rules;
  match.config.rules = rulesV1Schema.parse({
    ...shared,
    version: "cockpit-v1",
    trashTalk: remarks !== "off",
    timeBudgetMs: clock?.w ?? 600000,
    ...overrides,
  });
  return match;
}
