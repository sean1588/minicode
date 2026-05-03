export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Decision returned from a `beforeToolCall` hook. `allow` proceeds with
 * normal execution; `deny` short-circuits the tool call and feeds the
 * `reason` back to the model as the tool's result so it can react
 * (e.g. explain instead of edit).
 */
export type ToolPermissionDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string };

/**
 * Hook invoked before each tool call. Implementations can prompt the user,
 * consult a config flag, or apply any other policy. Returning `allow`
 * proceeds with normal execution; `deny` skips the tool entirely and
 * feeds `reason` back to the model.
 */
export type BeforeToolCallHook = (
  toolCall: { name: string; input: Record<string, unknown> },
) => Promise<ToolPermissionDecision>;

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
  modelTimeoutSeconds: number;
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
  /**
   * Override the model used for LLM-based compaction. Compaction always
   * uses an LLM by default (with `model` as the implicit choice); set this
   * to use a different, typically cheaper or faster, model for the
   * summarization call. Mechanical compaction is the internal fallback
   * if the LLM call fails.
   */
  compactionModel?: string;
  /** Reasoning effort level for models that support reasoning tokens. When unset, no reasoning parameters are sent. */
  reasoningEffort?: ReasoningEffort;
  /** Rebuild the system prompt (including code map) every agent step. Disabling improves KV cache hit rates for local models. Default: false */
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
  /**
   * Set when the caller supplied an `outputSchema` and the model
   * called the synthetic respond tool with arguments matching the
   * schema. The synthetic tool call is stripped from `toolCalls` so
   * the agent loop does not try to dispatch it.
   */
  output?: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /**
     * Tokens served from the provider's prompt cache, when reported.
     * Anthropic exposes `cache_read_input_tokens`; OpenAI / OpenRouter /
     * DeepSeek / Gemini expose `prompt_tokens_details.cached_tokens`.
     * Both clients normalise to this field. Useful for surfacing cache
     * effectiveness in the UI without callers needing to know the
     * provider-specific shape.
     */
    cachedInputTokens?: number;
  };
}

/**
 * Schema for structured-output turns. When passed to `runTurn` or
 * `ModelClient.chat`, the SDK registers a synthetic tool with this
 * shape; the model "calling" it delivers a structured answer that the
 * SDK validates and returns as `ModelResponse.output` /
 * `runTurn().output`.
 */
export interface OutputSchema {
  /**
   * Tool-facing name. Must match `^[a-zA-Z0-9_-]{1,64}$` (the tool-name
   * pattern both providers accept). Pick a descriptive name —
   * the model sees it.
   */
  name: string;
  /** JSON Schema (draft 2020-12 subset) describing the desired output. */
  schema: Record<string, unknown>;
  /** Description shown to the model on the synthetic tool. */
  description?: string;
}

/**
 * Thrown when the model's structured-output call fails JSON Schema
 * validation. Carries the raw arguments and the validator's error
 * list so consumers can log, retry, or surface diagnostics.
 */
export class OutputValidationError extends Error {
  readonly raw: unknown;
  readonly errors: ReadonlyArray<{ path: string; message: string }>;

  constructor(
    message: string,
    raw: unknown,
    errors: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "OutputValidationError";
    this.raw = raw;
    this.errors = errors;
  }
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
    /**
     * When true (default), the client tells the provider to cache the
     * stable prefix of the request (system prompt + tools). Set to false
     * when the system prompt is rebuilt on every step (e.g. with
     * `enableDynamicPrompt: true`) so the cache isn't constantly
     * invalidated and re-written. Tools are always cacheable separately.
     */
    cacheableSystem?: boolean;
    /**
     * When supplied, the client appends a synthetic tool with this
     * schema to the request. If the model calls that tool, the
     * arguments are validated against the schema and surfaced via
     * `ModelResponse.output`; the synthetic call is stripped from
     * `toolCalls`. A schema mismatch throws `OutputValidationError`.
     */
    outputSchema?: OutputSchema;
  }): Promise<ModelResponse>;

  /** List models available from the provider. Returns empty array on failure. */
  listModels?(): Promise<ModelInfo[]>;
}
