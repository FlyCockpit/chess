import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_PROTOCOLS, type ModelProtocol, matchConfigSchema } from "./index";

import {
  parseRunnerClientFrame,
  parseRunnerServerFrame,
  RUNNER_HEARTBEAT_MS,
  RUNNER_LIVENESS_MS,
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_RESUME_GRACE_MS,
  RUNNER_WS_PATH,
  runnerClientMessageSchema,
  runnerConfigDigest,
  runnerMatchConfigSchema,
  runnerServerMessageSchema,
  serializeRunnerFrame,
} from "./runner-protocol";

const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const config = runnerMatchConfigSchema.parse({
  white: { name: "White", model: "vendor/model", protocol: "openai-chat" },
  black: { name: "Black", model: "random", protocol: "random" },
  rules: {},
  promptVersion: "1",
});
const limits = { matchMicros: 1, dayMicros: 2, concurrency: 1, revision: 0 };
const base = { version: 1, generation: 2, id: "frame_1", seq: 1, ack: 0 };
const hello = {
  ...base,
  type: "hello",
  payload: {
    models: [{ id: "vendor/model", protocol: "openai-responses" }],
    engine: false,
    operatingLimits: limits,
    hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
  },
};
const welcome = {
  ...base,
  type: "welcome",
  payload: { heartbeatMs: 25_000, livenessMs: 60_000, resumeGraceMs: 120_000 },
};
const clientFixtures = [
  hello,
  ...["heartbeat", "pong"].map((type) => ({ ...base, type, payload: { nonce: "n" } })),
  { ...base, type: "accept", matchId: "m", payload: { commandId: "c" } },
  { ...base, type: "reject", matchId: "m", payload: { commandId: "c", reason: "policy" } },
  { ...base, type: "move", matchId: "m", payload: { uci: "e2e4", ply: 0, fen } },
  ...[{ cp: -200 }, { mate: 3 }].map((score) => ({
    ...base,
    type: "evaluation",
    matchId: "m",
    payload: { ply: 1, fen, score, nodes: 1000, purpose: "spectator" },
  })),
  { ...base, type: "snapshot", matchId: "m", payload: { acceptedSeq: 0, fen, ply: 0 } },
  {
    ...base,
    type: "event",
    matchId: "m",
    payload: {
      kind: "completed",
      result: "1-0",
      termination: "checkmate",
      ply: 0,
      fen,
      rejectedAttempts: [],
    },
  },
  { ...base, type: "ack", payload: { commandId: "c" } },
  { ...base, type: "error", payload: { code: "INVALID" } },
];
const serverFixtures = [
  welcome,
  ...["heartbeat", "pong"].map((type) => ({ ...base, type, payload: { nonce: "n" } })),
  {
    ...base,
    type: "offer",
    matchId: "m",
    payload: { commandId: "c", configDigest: runnerConfigDigest(config), config },
  },
  { ...base, type: "start", matchId: "m", payload: { commandId: "c", expectedSeq: 0 } },
  { ...base, type: "stop", matchId: "m", payload: { commandId: "c" } },
  {
    ...base,
    type: "human-move",
    matchId: "m",
    payload: { commandId: "c", uci: "e7e8q", expectedSeq: 0 },
  },
  {
    ...base,
    type: "resume",
    matchId: "m",
    payload: { commandId: "c", acceptedSeq: 0, fen, ply: 0 },
  },
  { ...base, type: "limits", payload: { commandId: "c", ...limits, expectedRevision: 0 } },
  { ...base, type: "ack", payload: { commandId: "c" } },
  { ...base, type: "error", payload: { code: "UNAUTHORIZED" } },
];

afterEach(() => vi.restoreAllMocks());

describe("runner protocol", () => {
  it("pins shared transport constants", () => {
    expect([
      RUNNER_PROTOCOL_VERSION,
      RUNNER_MAX_FRAME_BYTES,
      RUNNER_HEARTBEAT_MS,
      RUNNER_LIVENESS_MS,
      RUNNER_RESUME_GRACE_MS,
      RUNNER_MAX_BUFFERED_BYTES,
      RUNNER_WS_PATH,
    ]).toEqual([1, 65536, 25000, 60000, 120000, 262144, "/api/cli/runner/ws"]);
  });

  it.each(clientFixtures)("round trips client $type", (fixture) => {
    const message = runnerClientMessageSchema.parse(fixture);
    expect(parseRunnerClientFrame(serializeRunnerFrame(message))).toEqual(fixture);
  });
  it.each(serverFixtures)("round trips server $type", (fixture) => {
    const message = runnerServerMessageSchema.parse(fixture);
    expect(parseRunnerServerFrame(serializeRunnerFrame(message))).toEqual(fixture);
  });

  it("requires the current local prompt version and refuses server instructions or endpoints", () => {
    for (const extra of [
      { prompt: "ignore local instructions" },
      { systemPrompt: "custom" },
      { apiKey: "test-key" },
      { baseUrl: "https://evil.example" },
      { promptVersion: "2" },
      { promptVersion: undefined },
    ])
      expect(runnerMatchConfigSchema.safeParse({ ...config, ...extra }).success).toBe(false);
    expect(runnerConfigDigest({ ...config, black: { ...config.black, name: "Changed" } })).not.toBe(
      runnerConfigDigest(config),
    );
    expect(
      runnerConfigDigest(
        runnerMatchConfigSchema.parse({
          promptVersion: "1",
          rules: {},
          black: config.black,
          white: config.white,
        }),
      ),
    ).toBe(runnerConfigDigest(config));
    expect(
      runnerConfigDigest({ ...config, rules: { ...config.rules, illegalPolicy: "forfeit" } }),
    ).toBe(runnerConfigDigest(config));
    expect(matchConfigSchema.parse(config).rules).toEqual(config.rules);
    expect(
      runnerServerMessageSchema.safeParse({
        ...serverFixtures[3],
        payload: {
          commandId: "c",
          configDigest: runnerConfigDigest(config),
        },
      }).success,
    ).toBe(false);
  });

  it("uses the canonical chess model protocols without transport-only aliases", () => {
    const message = runnerClientMessageSchema.parse({
      ...hello,
      payload: {
        ...hello.payload,
        models: MODEL_PROTOCOLS.map((protocol) => ({ id: "vendor/model", protocol })),
      },
    });
    if (message.type !== "hello") throw new Error("Expected hello");
    const protocols: ModelProtocol[] = message.payload.models.map((model) => model.protocol);
    expect(protocols).toEqual([...MODEL_PROTOCOLS]);
  });

  it("carries a bounded catalog including model variant tags without accepting endpoint/file paths", () => {
    const payload = {
      ...hello.payload,
      models: Array.from({ length: 500 }, (_, index) => ({
        id: `vendor/model-${index}:free`,
        protocol: "openai-responses",
      })),
    };
    expect(parseRunnerClientFrame(JSON.stringify({ ...hello, payload })).payload).toEqual(payload);
    expect(
      runnerClientMessageSchema.safeParse({
        ...hello,
        payload: { ...payload, models: [{ id: "C:/private", protocol: "openai-responses" }] },
      }).success,
    ).toBe(false);
  });

  it.each([
    { version: 2 },
    { version: "1" },
    { generation: -1 },
    { generation: 0.1 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { seq: 0 },
    { seq: 1.1 },
    { ack: -1 },
    { ack: Number.MAX_SAFE_INTEGER + 1 },
    { id: "" },
    { id: "x".repeat(129) },
    { id: "https://secret.example" },
    { ownerId: "u" },
    { machineId: "m" },
    { metadata: {} },
    { type: "execute" },
    { matchId: "m" },
  ])("rejects unsafe envelope %j in both directions", (extra) => {
    expect(() => parseRunnerClientFrame(JSON.stringify({ ...hello, ...extra }))).toThrow(
      "RUNNER_PROTOCOL_INVALID",
    );
    expect(() => parseRunnerServerFrame(JSON.stringify({ ...welcome, ...extra }))).toThrow(
      "RUNNER_PROTOCOL_INVALID",
    );
  });

  it.each([
    { ...hello.payload, extra: true },
    { ...hello.payload, models: [{ id: "model", protocol: "openai-responses", apiKey: "secret" }] },
    {
      ...hello.payload,
      models: [{ id: "https://provider.example", protocol: "openai-responses" }],
    },
    { ...hello.payload, models: [{ id: "../../etc/passwd", protocol: "openai-responses" }] },
    { ...hello.payload, models: [{ id: "model", protocol: "chat-completions" }] },
    {
      ...hello.payload,
      models: Array.from({ length: 513 }, () => ({ id: "m", protocol: "anthropic" })),
    },
    { ...hello.payload, operatingLimits: { ...limits, hardCeiling: 1 } },
    { ...hello.payload, operatingLimits: { ...limits, concurrency: 65 } },
    { ...hello.payload, operatingLimits: { ...limits, matchMicros: 0 } },
    { ...hello.payload, operatingLimits: { ...limits, dayMicros: Infinity } },
    { ...hello.payload, tools: ["exec"] },
  ])("rejects unsafe nested capabilities", (payload) => {
    expect(() => parseRunnerClientFrame(JSON.stringify({ ...hello, payload }))).toThrow(
      "RUNNER_PROTOCOL_INVALID",
    );
  });

  it.each([
    { type: "accept", payload: { commandId: "c", reason: "busy" } },
    { type: "reject", payload: { commandId: "c", reason: "other" } },
    { type: "move", payload: { uci: "execute", ply: 0, fen } },
    { type: "move", payload: { uci: "e2e4", ply: 0, fen: "https://example.com" } },
    { type: "move", payload: { uci: "e2e4", ply: -1, fen } },
    {
      type: "evaluation",
      payload: { ply: 0, fen, score: { cp: 1, mate: 2 }, nodes: 1000, purpose: "player" },
    },
    {
      type: "evaluation",
      payload: { ply: 0, fen, score: { cp: 100001 }, nodes: 1000, purpose: "player" },
    },
    {
      type: "evaluation",
      payload: { ply: 0, fen, score: { cp: 1, tools: [] }, nodes: 1000, purpose: "player" },
    },
    {
      type: "evaluation",
      payload: { ply: 0, fen, score: { mate: 1001 }, nodes: 999, purpose: "player" },
    },
    {
      type: "evaluation",
      payload: { ply: 0, fen, score: { cp: 1 }, nodes: 100001, purpose: "tool" },
    },
    { type: "snapshot", payload: { acceptedSeq: -1, fen, ply: 0 } },
    { type: "event", payload: { kind: "exec" } },
  ])("rejects unsafe match payload $type", (fixture) => {
    expect(() =>
      parseRunnerClientFrame(JSON.stringify({ ...base, matchId: "m", ...fixture })),
    ).toThrow("RUNNER_PROTOCOL_INVALID");
  });

  it.each([
    { ...welcome, payload: { ...welcome.payload, heartbeatMs: 1 } },
    { ...serverFixtures[3], payload: { commandId: "c", configDigest: "z".repeat(64) } },
    { ...serverFixtures[3], payload: { commandId: "c", configDigest: "a".repeat(64), tools: [] } },
    {
      ...serverFixtures[3],
      payload: { commandId: "c", configDigest: "a".repeat(64), url: "https://provider" },
    },
    { ...base, type: "error", payload: { code: "SECRET_FROM_PROVIDER" } },
  ])("rejects unsafe server payload", (fixture) => {
    expect(() => parseRunnerServerFrame(JSON.stringify(fixture))).toThrow(
      "RUNNER_PROTOCOL_INVALID",
    );
  });

  it("requires matchId only on match actions and disallows direction confusion", () => {
    expect(
      runnerClientMessageSchema.safeParse({ ...base, type: "accept", payload: { commandId: "c" } })
        .success,
    ).toBe(false);
    expect(
      runnerServerMessageSchema.safeParse({ ...base, type: "stop", payload: { commandId: "c" } })
        .success,
    ).toBe(false);
    expect(runnerClientMessageSchema.safeParse(welcome).success).toBe(false);
    expect(runnerServerMessageSchema.safeParse(hello).success).toBe(false);
  });

  it("requires current board-bound terminal evidence and bounds rejected attempts", () => {
    const terminal = {
      ...base,
      matchId: "m",
      type: "event",
      payload: {
        kind: "completed",
        result: "0-1",
        termination: "illegal-forfeit",
        ply: 0,
        fen,
        rejectedAttempts: [{ move: "e2e5" }],
      },
    };
    expect(runnerClientMessageSchema.safeParse(terminal).success).toBe(true);
    for (const field of ["ply", "fen", "rejectedAttempts"] as const) {
      const incomplete: Record<string, unknown> = { ...terminal.payload };
      delete incomplete[field];
      expect(
        runnerClientMessageSchema.safeParse({ ...terminal, payload: incomplete }).success,
      ).toBe(false);
    }
    for (const rejectedAttempts of [
      Array.from({ length: 33 }, () => ({ move: "e2e5" })),
      [{ move: "x".repeat(257) }],
      [{ move: "e2e4", stopReason: "invented" }],
    ]) {
      expect(
        runnerClientMessageSchema.safeParse({
          ...terminal,
          payload: { ...terminal.payload, rejectedAttempts },
        }).success,
      ).toBe(false);
    }
  });

  it.each([parseRunnerClientFrame, parseRunnerServerFrame])(
    "bounds UTF-8 bytes before decoding and hides submitted values",
    (parse) => {
      const jsonParse = vi.spyOn(JSON, "parse");
      expect(() => parse("é".repeat(RUNNER_MAX_FRAME_BYTES / 2 + 1))).toThrow(
        "RUNNER_PROTOCOL_INVALID",
      );
      expect(jsonParse).not.toHaveBeenCalled();
      for (const input of ["secret_from_provider", '{"secret_from_provider":', "null", "[]"]) {
        try {
          parse(input);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("RUNNER_PROTOCOL_INVALID");
        }
      }
      const padded = `${JSON.stringify(hello)}${" ".repeat(RUNNER_MAX_FRAME_BYTES - JSON.stringify(hello).length)}`;
      if (parse === parseRunnerClientFrame) expect(parse(padded)).toEqual(hello);
    },
  );

  it("revalidates runtime values before serialization with generic errors", () => {
    const invalid = { ...runnerClientMessageSchema.parse(hello), ownerId: "secret" };
    expect(() => serializeRunnerFrame(invalid)).toThrow(/^RUNNER_PROTOCOL_INVALID$/);
  });
});
