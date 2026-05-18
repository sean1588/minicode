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

/**
 * Constrains how the model uses tools on a given chat call.
 *   - `"auto"` (default): model decides whether to call a tool or reply with text.
 *   - `"required"`: model MUST call at least one tool. Useful for forcing
 *     action after a no-action attempt — prevents the model from burning
 *     its budget in extended thinking and returning nothing.
 *   - `"none"`: model may not call tools.
 *
 * If `tools` is empty, `"required"` is silently downgraded to `"auto"` (the
 * provider would otherwise reject the request).
 */
export type ToolChoice = "auto" | "required" | "none";

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
  /**
   * Hard cap on reasoning tokens per turn. When set, sent as
   * `reasoning.max_tokens` on OpenAI-compatible requests and used to
   * clamp Anthropic's `thinking.budget_tokens`. Opt-in; usually unset.
   *
   * Mainly a lever for models like Gemini 2.5 Pro that cannot disable
   * dynamic thinking and can otherwise burn their entire output budget
   * on reasoning without producing visible content or tool calls. Use
   * with caution — capping below what a hard task needs will reduce
   * answer quality.
   */
  reasoningMaxTokens?: number;
  /** Rebuild the system prompt (including code map) every agent step. Disabling improves KV cache hit rates for local models. Default: false */
  enableDynamicPrompt?: boolean;
  /**
   * When set, forwarded to `ModelClient.chat` on every step. Mainly used by
   * the benchmark retry path to set `"required"` on a second attempt after
   * the first attempt produced no action (forces the model to commit to a
   * tool call rather than another pure-thinking collapse). Unset in normal
   * agent operation.
   */
  toolChoice?: ToolChoice;
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
   * Extended-thinking / reasoning content produced by the model, when
   * the provider exposes it. Anthropic surfaces it via `thinking` content
   * blocks on extended-thinking models; OpenRouter forwards Gemini-2.5/3
   * thinking content via `choices[0].message.reasoning` (and some
   * providers via `reasoning_content`). Previously both clients dropped
   * this content on the floor — we only retained the token count. Keep
   * it on the response so:
   *   1. Traces / UIs can display the model's reasoning alongside its
   *      visible output.
   *   2. The agent loop can detect "pure-thinking collapse" (text empty,
   *      toolCalls empty, reasoningContent non-empty) and surface the
   *      reasoning instead of the generic "no response" fallback.
   *
   * Separate from `text` because thinking content is structured side
   * information, not the model's reply to the user.
   */
  reasoningContent?: string;
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
    /**
     * Reasoning ("thinking") tokens reported by reasoning-capable models.
     * For OpenAI-compatible providers these are nested under
     * `completion_tokens_details.reasoning_tokens` and ARE included in
     * the total `completion_tokens`, so they count against `max_tokens`.
     * Surfaced here so traces can show whether reasoning is firing.
     */
    reasoningTokens?: number;
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
    /** See `AgentConfig.reasoningMaxTokens`. */
    reasoningMaxTokens?: number;
    /** See `AgentConfig.toolChoice`. Silently downgraded to `"auto"` when `tools` is empty. */
    toolChoice?: ToolChoice;
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
