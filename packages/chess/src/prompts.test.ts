import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildLoopCycleGuardMessage,
  buildLoopGuardMessage,
} from "../../agent-runtime/src/loop-guard";
import { createMatch, parseArchive, serializeArchive, validateArchive } from "./index";
import { exportPgn } from "./pgn";
import {
  assertPinnedPrompt,
  CURRENT_PROMPT_VERSION,
  PROMPT_BUNDLES,
  promptLoopGuardMessages,
  promptToolInputs,
  resolvePromptBundle,
  systemPromptFor,
} from "./prompts";
import { advanceMatch, matchSystemPrompt, turnPrompt } from "./runner";

const random = { name: "Random", model: "random", protocol: "random" as const };
const model = { name: "Model", model: "vendor/model", protocol: "openai-chat" as const };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

afterEach(() => vi.unstubAllGlobals());
describe("immutable launch prompt bundle", () => {
  it("carries the pinned bundle and response-reported identities through real adapters and archive export", async () => {
    const chunk = {
      id: "completion-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "vendor/resolved",
      provider: "Serving Provider",
    };
    const events = [
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: '{"move":"e2e4"}' },
            finish_reason: null,
          },
        ],
      },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        ...chunk,
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          total_tokens: 107,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    ];
    const http = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", http);
    const match = createMatch({ white: model, black: random, rules: { legalMoves: "provided" } });
    await advanceMatch(match, {
      credentials: {
        w: {
          apiKey: "synthetic-test-key",
          baseUrl: "https://openrouter.ai/api/v1",
          inputMicrosPerMillion: 100,
          outputMicrosPerMillion: 100,
        },
      },
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(match.events.find((event) => event.type === "attempt")).toMatchObject({
      accepted: true,
      move: "e2e4",
    });
    expect(match.events.find((event) => event.type === "reply")).toMatchObject({
      dispatch: 0,
      resolvedModel: "vendor/resolved",
      resolvedProvider: "Serving Provider",
    });
    expect(match.events.find((event) => event.type === "usage")).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 80,
      resolvedModel: "vendor/resolved",
      resolvedProvider: "Serving Provider",
    });
    const replay = validateArchive(JSON.parse(serializeArchive(match)));
    expect(replay.config.prompt).toEqual(match.config.prompt);
    expect(exportPgn(replay)).toContain('[CockpitPromptVersion "1"]');
    expect(exportPgn(replay)).toContain(`[CockpitPromptHash "${match.config.prompt.hash}"]`);
  });
  it("ships exactly version 1 and pins the complete manifest, including tools, retries and remarks", () => {
    const bundle = resolvePromptBundle();
    expect(CURRENT_PROMPT_VERSION).toBe("1");
    expect(PROMPT_BUNDLES).toHaveLength(1);
    expect(bundle.hash).toBe("fdbde19d7cedd632caeaf0204457fc4a6e7fe9cc8eeffc5fd22b909c9950efae");
    expect(hash(JSON.stringify(bundle.manifest))).toBe(bundle.hash);
    for (const name of ["board", "legal_moves", "engine_eval"] as const)
      expect(z.toJSONSchema(promptToolInputs[name])).toEqual(bundle.manifest.tools[name].schema);
    for (const section of [
      "system",
      "turn",
      "remarks",
      "reply",
      "rejection",
      "loopGuard",
      "tools",
    ] as const) {
      const changed = { ...bundle.manifest, [section]: "different fixed instruction" };
      expect(hash(JSON.stringify(changed))).not.toBe(bundle.hash);
    }
    for (const key of ["repeated", "cycle"] as const) {
      const changed = {
        ...bundle.manifest,
        loopGuard: {
          ...bundle.manifest.loopGuard,
          [key]: `${bundle.manifest.loopGuard[key]} changed`,
        },
      };
      expect(hash(JSON.stringify(changed))).not.toBe(bundle.hash);
    }
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.manifest.tools.board.schema)).toBe(true);
    expect(() => resolvePromptBundle("2")).toThrow("Unsupported prompt version");
  });
  it("pins the runtime's repeat and cycle feedback without changing guard instructions", () => {
    const pinned = promptLoopGuardMessages("1");
    for (const names of [[], ["legal_moves", "engine_eval"]]) {
      expect(pinned.repeated("board", names)).toBe(buildLoopGuardMessage("board", names));
      for (const period of [2, 3, 4])
        expect(pinned.cycle("board", names, period)).toBe(
          buildLoopCycleGuardMessage("board", names, period),
        );
    }
  });
  it("preserves the post-cache system reference bytes for launch settings", () => {
    const match = createMatch({ white: model, black: random, rules: {} });
    expect(hash(matchSystemPrompt(match))).toBe(
      "0da56d9b9f5c3e5508bea4b204a3faca1612ecb57905d5ccff871ec6708c7b9c",
    );
  });
  it("pins every creation source, and explicitly marks games without a model unapplied", () => {
    for (const source of ["local", "hosted", "demo"] as const)
      for (const white of [random, { ...random, protocol: "human" as const }, model]) {
        const match = createMatch({ white, black: random, rules: {}, promptVersion: "1" }, source);
        expect(match.config.prompt).toEqual({
          version: "1",
          hash: resolvePromptBundle().hash,
          system: systemPromptFor(match.config.rules, "1"),
          promptApplied: white === model,
        });
        expect(parseArchive(JSON.parse(serializeArchive(match)))).toEqual(match);
        expect(assertPinnedPrompt(match.config).version).toBe("1");
        expect(match.config).not.toHaveProperty("promptVersion");
      }
  });
  it("rejects missing, unknown, changed-text, changed-hash and false-applied archive pins", () => {
    const original = createMatch({ white: model, black: random, rules: {} });
    const json = JSON.parse(serializeArchive(original));
    const pins = [
      undefined,
      { ...json.config.prompt, version: "2" },
      { ...json.config.prompt, hash: "a".repeat(64) },
      { ...json.config.prompt, system: "Client instructions" },
      { ...json.config.prompt, promptApplied: false },
    ];
    for (const prompt of pins) {
      const invalid = { ...json, config: { ...json.config, prompt } };
      expect(() => parseArchive(invalid)).toThrow("Unsupported archive");
      expect(() => validateArchive(invalid)).toThrow("Unsupported archive");
    }
  });
  it("keeps the fixed prefix and one-pass template substitutions independent of changing board data", () => {
    const match = createMatch({
      white: model,
      black: { ...model, name: "{{remaining}}", model: "vendor/{{side}}" },
      rules: { opponentIdentity: "disclosed", remarks: "trash-talk" },
    });
    const system = matchSystemPrompt(match);
    expect(turnPrompt(match, "w")).toContain("Opponent: {{remaining}} (vendor/{{side}}).");
    match.id = crypto.randomUUID();
    match.createdAt = new Date().toISOString();
    expect(matchSystemPrompt(match)).toBe(system);
    expect(system).not.toContain(match.id);
    expect(system).toContain("optional short comment");
    expect(turnPrompt(match, "w")).toContain("<optional remark to your opponent, any tone>");
  });
});
