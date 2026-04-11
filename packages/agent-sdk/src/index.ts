// Core types
export type {
  AgentConfig,
  AssistantMessage,
  ModelClient,
  ModelInfo,
  ModelResponse,
  ReasoningEffort,
  SessionMessage,
  ToolCall,
  ToolDefinition,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from "./agent/types.js";

// Agent runtime
export {
  CodingAgent,
  type UiUpdate,
  type UiUpdateThinking,
  type UiUpdateStreamingChunk,
  type UiUpdateStep,
  type UiUpdateToolCallStart,
  type UiUpdateToolCallEnd,
  type UiUpdateContextStatus,
} from "./agent/agent.js";

// Session
export { Session, type SessionSnapshot, type CompactionResult } from "./session/session.js";

// Model clients
export {
  AnthropicModelClient,
  OpenAICompatibleModelClient,
  createModelClient,
} from "./model/client.js";

// Tool registry
export { ToolRegistry, type CoreToolHooks } from "./tools/registry.js";

// Individual tool factories
export { createReadFileTool } from "./tools/read-file.js";
export { createWriteFileTool, type WriteFileHooks } from "./tools/write-file.js";
export { createEditFileTool, type EditFileHooks } from "./tools/edit-file.js";
export { createSearchTool } from "./tools/search.js";
export { createListFilesTool } from "./tools/list-files.js";
export { createRunCommandTool, type RunCommandHooks } from "./tools/run-command.js";

// Tool helpers
export {
  expectNonEmptyString,
  expectOptionalBoolean,
  expectOptionalNumber,
  formatWithLineNumbers,
  toJson,
} from "./tools/helpers.js";

// Safety / guardrails
export {
  ensureStepWithinLimit,
  isDestructiveCommand,
  isWithinWorkspacePath,
  normalizeWorkspaceRoot,
  resolveWorkspacePath,
  validateCommand,
  validateFileReadSize,
  validatePath,
} from "./safety/guardrails.js";

// System prompt
export {
  buildSystemPrompt,
} from "./prompt/system-prompt.js";

// Focus tracker
export { FocusTracker } from "./indexer/focus-tracker.js";

// Indexer / plugin types
export type {
  CodeMapResult,
  DependencyEdge,
  DependencyEdgeKind,
  IndexedSymbol,
  LanguagePlugin,
  ProjectIndex,
  SymbolKind,
} from "./indexer/types.js";
