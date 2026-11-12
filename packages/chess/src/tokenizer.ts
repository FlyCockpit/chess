import type { AgentMessage } from "@cockpit-chess/agent-runtime";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";

// Benchmark encoding, independent of the model's provider/billing tokenizer.
const encoder = new Tiktoken(ranks);
export function countSharedTokens(text: string): number {
  return encoder.encode(text, [], []).length;
}
/** Omit transport ids, timestamps, stream state and hidden reasoning. */
function sharedMessages(messages: AgentMessage[], includeToolResults = true) {
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.flatMap((part): Array<Record<string, unknown>> => {
      if (part.type === "text" && typeof part.content === "string")
        return [{ type: "text", content: part.content }];
      if (part.type === "tool-call") {
        const parts: Array<Record<string, unknown>> = [
          { type: "tool-call", name: part.name, arguments: part.arguments },
        ];
        if (includeToolResults && part.output !== undefined)
          parts.push({ type: "tool-result", content: part.output });
        return parts;
      }
      if (part.type === "tool-result" && includeToolResults)
        return [{ type: "tool-result", content: part.content }];
      return [];
    }),
  }));
}
export function sharedInputTokens(system: string, messages: AgentMessage[], tools: unknown[]) {
  return countSharedTokens(JSON.stringify({ system, messages: sharedMessages(messages), tools }));
}
/** The exact text `sharedOutputTokens` encodes ("" when nothing is visible). */
export function sharedOutputText(messages: AgentMessage[]) {
  const visible = sharedMessages(messages, false).filter((message) => message.parts.length);
  return visible.length ? JSON.stringify(visible) : "";
}
export function sharedOutputTokens(messages: AgentMessage[]) {
  const text = sharedOutputText(messages);
  return text ? countSharedTokens(text) : 0;
}
