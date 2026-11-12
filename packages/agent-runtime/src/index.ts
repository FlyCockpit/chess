// Public surface: only what code outside this package consumes, plus the type
// contract of `runAgentLoop` itself and the error a tool throws to fail a run.
export { AgentRuntimeError, FatalToolError } from "./errors";
export { runAgentLoop } from "./loop";
export { defineTool } from "./tools";
export type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentMessage,
  AgentMessagePart,
  AgentModel,
  AgentStopReason,
  AgentTool,
  AgentUsage,
  ResultSlice,
  ResultStore,
  StoredResult,
  StreamEvent,
} from "./types";
export { UNTRUSTED_CONTENT_SYSTEM_RULES, wrapUntrustedContent } from "./untrusted";
