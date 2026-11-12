import type { AgentMessage } from "@cockpit-chess/agent-runtime";
import { describe, expect, it } from "vitest";
import { countSharedTokens, sharedInputTokens, sharedOutputTokens } from "./tokenizer";

describe("fixed shared benchmark tokenizer", () => {
  it("uses known cl100k_base tokens and treats special-token spellings as ordinary text", () => {
    expect(countSharedTokens("hello world")).toBe(2);
    expect(countSharedTokens("<|endoftext|> ♞")).toBeGreaterThan(2);
  });
  it("ignores transport ids and stream state, while counting tool results as input", () => {
    const message: AgentMessage = {
      id: "one",
      role: "assistant",
      parts: [{ type: "text", content: "e2e4" }],
    };
    expect(sharedInputTokens("chess", [message], [])).toBe(
      sharedInputTokens("chess", [{ ...message, id: "two", createdAt: "later" }], []),
    );
    const tool: AgentMessage = {
      id: "tool",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call",
          name: "board",
          arguments: "{}",
          state: "done",
          output: "e2e4 ".repeat(100),
        },
      ],
    };
    const noResult: AgentMessage = {
      ...tool,
      parts: tool.parts.map((part) => ({ ...part, output: undefined })),
    };
    expect(sharedInputTokens("chess", [tool], [])).toBeGreaterThan(
      sharedInputTokens("chess", [noResult], []),
    );
    expect(sharedOutputTokens([tool])).toBe(sharedOutputTokens([noResult]));
  });
});
