import { createMatch, type MatchArchive } from "@cockpit-chess/chess";
import type prismaInstance from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { officialCommitment, officialFilterInput, officialLeaderboard } = await import(
  "./chess-official"
);
const { decodeCursor } = await import("./pagination");
const model = {
  name: "Private display label",
  model: "vendor/model",
  protocol: "openai-chat" as const,
};
const random = { name: "Random baseline", model: "random", protocol: "random" as const };
const hosted = () => createMatch({ white: model, black: random, rules: {} }, "hosted");

beforeEach(() => {
  mockReset(db);
  db.$queryRaw.mockResolvedValue([]);
  db.chessOfficialEntry.count.mockResolvedValue(0);
});

describe("officialCommitment", () => {
  it.each(["operator", "owner-openrouter"])("pins safe hosted settings for %s", (billing) => {
    const match = hosted();
    match.config.title = "Private title canary";
    const commitment = officialCommitment(match, billing);
    expect(commitment).toEqual({
      promptVersion: match.config.prompt.version,
      promptHash: match.config.prompt.hash,
      rulesKey: expect.stringMatching(/^[a-f0-9]{16}$/),
      rules: match.config.rules,
      initialFen: match.config.initialFen,
      initialPositionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      billingCohort: billing,
      opponentType: "model-v-random",
      whiteModel: model.model,
      whiteProtocol: model.protocol,
      blackModel: "random",
      blackProtocol: "random",
      moveFormat: "strict",
    });
    expect(JSON.stringify(commitment)).not.toMatch(/Private display label|Private title canary/);
    for (const key of [
      "ownerId",
      "matchId",
      "title",
      "name",
      "archive",
      "slug",
      "key",
      "system",
      "events",
    ])
      expect(commitment).not.toHaveProperty(key);
  });

  it("allows model-v-model and rejects local, human, random-only and invalid billing", () => {
    expect(
      officialCommitment(
        createMatch({ white: model, black: model, rules: {} }, "hosted"),
        "operator",
      ),
    ).toMatchObject({ opponentType: "model-v-model" });
    const human = { name: "Human", model: "human", protocol: "human" as const };
    const invalid: [MatchArchive, string][] = [
      [createMatch({ white: model, black: random, rules: {} }, "local"), "operator"],
      [createMatch({ white: human, black: model, rules: {} }, "hosted"), "operator"],
      [createMatch({ white: model, black: human, rules: {} }, "hosted"), "operator"],
      [createMatch({ white: random, black: random, rules: {} }, "hosted"), "operator"],
      [hosted(), "runner"],
      [hosted(), "openrouter"],
    ];
    for (const [match, billing] of invalid)
      expect(() => officialCommitment(match, billing)).toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
  });

  it("separates prompt version/hash, settings, start position, billing and opponent type", () => {
    const original = hosted();
    const scope = officialCommitment(original, "operator").scopeKey;
    const changed = [
      (match: MatchArchive) => {
        Object.assign(match.config.prompt, { version: "2" });
      },
      (match: MatchArchive) => {
        match.config.prompt.hash = "a".repeat(64);
      },
      (match: MatchArchive) => {
        match.config.rules.moveFormat = "lenient";
      },
      (match: MatchArchive) => {
        match.config.initialFen = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
      },
      (match: MatchArchive) => {
        match.config.black = model;
      },
    ];
    for (const change of changed) {
      const match = structuredClone(original);
      change(match);
      expect(officialCommitment(match, "operator").scopeKey).not.toBe(scope);
    }
    expect(officialCommitment(original, "owner-openrouter").scopeKey).not.toBe(scope);
  });

  it("keeps comparison scope independent of title, display labels and entrant identity", () => {
    const original = hosted();
    const changed = structuredClone(original);
    changed.config.title = "Different private title";
    changed.config.white = { ...model, name: "Other private label", model: "vendor/other" };
    expect(officialCommitment(changed, "operator").scopeKey).toBe(
      officialCommitment(original, "operator").scopeKey,
    );
    expect(officialCommitment(changed, "operator").whiteModel).toBe("vendor/other");
  });
});

const aggregate = (scopeKey = "group-a") => ({
  scopeKey,
  model: "vendor/model",
  protocol: "openai-chat",
  rulesKey: "a".repeat(16),
  initialPositionHash: "b".repeat(64),
  promptVersion: "1",
  promptHash: "c".repeat(64),
  billingCohort: "operator",
  opponentType: "model-v-random",
  moveFormat: "strict",
  games: 10n,
  wins: 2n,
  draws: 1n,
  losses: 1n,
  withdrawals: 1n,
  pending: 2n,
  providerErrors: 1n,
  accountErrors: 1n,
  infrastructureErrors: 1n,
  illegalAttempts: 3n,
  truncatedAttempts: 2n,
  estimatedCostMicros: 123n,
});

describe("officialLeaderboard", () => {
  it("uses all starts for points/score, preserving pending, withdrawal and error categories", async () => {
    db.$queryRaw.mockResolvedValue([aggregate()]);
    db.chessOfficialEntry.count.mockResolvedValue(1007);
    const result = await officialLeaderboard({ limit: 20 });
    expect(result).toEqual({
      items: [
        {
          ...aggregate(),
          games: 10,
          wins: 2,
          draws: 1,
          losses: 1,
          withdrawals: 1,
          pending: 2,
          providerErrors: 1,
          accountErrors: 1,
          infrastructureErrors: 1,
          illegalAttempts: 3,
          truncatedAttempts: 2,
          estimatedCostMicros: 123,
          points: 2.5,
          score: 0.25,
        },
      ],
      sampleSize: 1007,
      nextCursor: null,
    });
    expect(db.chessMatch.findMany).not.toHaveBeenCalled();
    expect(db.chessOfficialEntry.count).toHaveBeenCalledWith({ where: {} });
  });

  it("keeps unknown costs null and unscored starts at zero points", async () => {
    db.$queryRaw.mockResolvedValue([
      {
        ...aggregate(),
        games: 1n,
        wins: 0n,
        draws: 0n,
        losses: 0n,
        pending: 1n,
        withdrawals: 0n,
        providerErrors: 0n,
        accountErrors: 0n,
        infrastructureErrors: 0n,
        estimatedCostMicros: null,
      },
    ]);
    expect((await officialLeaderboard({ limit: 1 })).items[0]).toMatchObject({
      points: 0,
      score: 0,
      games: 1,
      pending: 1,
      estimatedCostMicros: null,
    });
  });

  it("aggregates the entire ledger with parameterized filters and only bounds grouped output", async () => {
    const filters = {
      rulesKey: "a".repeat(16),
      promptVersion: "1' OR true --",
      initialPositionHash: "b".repeat(64),
      billingCohort: "owner-openrouter" as const,
      opponentType: "model-v-model" as const,
    };
    await officialLeaderboard({ limit: 7, ...filters });
    const [strings, ...parameters] = db.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain('FROM "chess_official_entry"');
    expect(sql).toContain("GROUP BY");
    expect(sql).toContain('ORDER BY "groupKey" ASC LIMIT ?');
    expect(sql.indexOf("LIMIT")).toBeGreaterThan(sql.indexOf("GROUP BY"));
    expect(sql.match(/LIMIT/g)).toHaveLength(1);
    expect(sql).not.toMatch(/published|chess_match|500/i);
    expect(sql).toContain("s.protocol <> 'random'");
    for (const filter of Object.values(filters)) {
      expect(parameters).toContain(filter);
      expect(sql).not.toContain(filter);
    }
    expect(parameters.at(-1)).toBe(8);
    expect(db.chessOfficialEntry.count).toHaveBeenCalledWith({ where: filters });
    expect(db.chessMatch.findMany).not.toHaveBeenCalled();
  });

  it("pages by stable group identity, using the last returned row rather than lookahead", async () => {
    db.$queryRaw.mockResolvedValueOnce([
      aggregate("group-a"),
      aggregate("group-b"),
      aggregate("group-c"),
    ]);
    const first = await officialLeaderboard({ limit: 2 });
    expect(first.items.map((row) => row.scopeKey)).toEqual(["group-a", "group-b"]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor ?? "";
    expect(decodeCursor(cursor)?.id).toBe("group-b");
    db.$queryRaw.mockResolvedValueOnce([aggregate("group-c")]);
    const next = await officialLeaderboard({ limit: 2, cursor });
    expect(next.items.map((row) => row.scopeKey)).toEqual(["group-c"]);
    expect(next.nextCursor).toBeNull();
    const [, ...parameters] = db.$queryRaw.mock.calls[1] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(parameters).toContain("group-b");
    expect(parameters.at(-1)).toBe(3);
  });

  it("rejects invalid public filter bounds and cursors", () => {
    for (const input of [
      { limit: 101 },
      { limit: 0 },
      { cursor: "bogus" },
      { rulesKey: "invalid" },
      { initialPositionHash: "short" },
      { billingCohort: "arbitrary" },
    ])
      expect(officialFilterInput.safeParse(input).success).toBe(false);
  });
});
