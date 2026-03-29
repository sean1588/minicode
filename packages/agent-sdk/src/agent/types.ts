export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
}

export type SessionMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** Valid reasoning effort levels for models that support reasoning tokens. */
export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

export interface AgentConfig {
  modelProvider: "anthropic" | "openai-compatible";
  model: string;
  maxSteps: number;
  maxTokens: number;
  maxContextTokens: number;
  workspaceRoot: string;
  commandTimeoutMs: number;
  maxFileSizeBytes: number;
  commandDenylist: RegExp[];
  confirmDestructive: boolean;
  keepRecentMessages: number;
  loopDetectionWindow: number;
  maxToolOutputChars: number;
  openAiBaseUrl: string;
  openAiApiKey?: string;

  /** Deduplicate repeated read_file calls for the same file within a turn. Default: false */
  enableFileReadDedup?: boolean;
  /** Scale keepRecentMessages down as context fills up. Default: false */
  enableAdaptiveKeepRecent?: boolean;
  /** Apply content-aware truncation strategies per tool type. Default: false */
  enableToolOutputTruncation?: boolean;
  /** Context fullness ratio (0-1) at which compaction triggers. Default: undefined (no auto-compaction) */
  compactionThreshold?: number;
  /** Model to use for LLM-based compaction. When set, compaction uses an LLM to summarize instead of mechanical truncation. */
  compactionModel?: string;
  /** Reasoning effort level for models that support reasoning tokens. When unset, no reasoning parameters are sent. */
  reasoningEffort?: ReasoningEffort;
  /** Rebuild the system prompt (including code map) every agent step. Disabling improves KV cache hit rates for local models. Default: true */
  enableDynamicPrompt?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Describes a model available from the provider. */
export interface ModelInfo {
  id: string;
  name?: string;
}

export interface ModelClient {
  chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
    reasoningEffort?: ReasoningEffort;
    onStream?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<ModelResponse>;

  /** List models available from the provider. Returns empty array on failure. */
  listModels?(): Promise<ModelInfo[]>;
}
