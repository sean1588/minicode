import {
  buildSystemPrompt as defaultBuildSystemPrompt,
  type SystemPromptBuilder,
} from "../prompt/system-prompt.js";
import type { CodeMapResult } from "../indexer/types.js";
import { ensureStepWithinLimit, formatStepLimitMessage } from "../safety/guardrails.js";
import { Session } from "../session/session.js";
import type { CompactionResult } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { FocusTracker } from "../indexer/focus-tracker.js";
import type {
  AgentConfig,
  BeforeToolCallHook,
  ModelClient,
  OutputSchema,
  ToolCall,
} from "./types.js";

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function signatureForToolCall(toolCall: ToolCall): string {
  return `${toolCall.name}:${stableSerialize(toolCall.input)}`;
}

function formatToolCallForProgress(toolCall: ToolCall, maxArgsLen = 100): string {
  const argsStr = JSON.stringify(toolCall.input);
  const truncated =
    argsStr.length > maxArgsLen
      ? argsStr.slice(0, maxArgsLen) + "..."
      : argsStr;
  return `${toolCall.name}(${truncated})`;
}

/** Tools whose "name" input parameter refers to a symbol in the index. */
const SYMBOL_TOOLS = new Set([
  "read_symbol",
  "find_references",
  "get_dependencies",
  "search_code_map",
]);

const MUTATING_TOOLS = new Set([
  "edit_file",
  "write_file",
]);

const STATE_SENSITIVE_TOOLS = new Set([
  "find_path",
  "find_references",
  "get_dependencies",
  "read_file",
  "read_symbol",
  "run_command",
  "search",
  "search_code_map",
]);

function isStateSensitiveFingerprint(fingerprint: string): boolean {
  const separatorIndex = fingerprint.indexOf(":");
  const toolName = separatorIndex === -1 ? fingerprint : fingerprint.slice(0, separatorIndex);
  return STATE_SENSITIVE_TOOLS.has(toolName);
}

/**
 * How many identical tool-call fingerprints in the rolling window before
 * the loop guard fires. Default is 3 — three literal repeats with no
 * variation is a strong "model is stuck" signal for most tools. `search`
 * gets a higher threshold (4) because regex-fishing legitimately emits
 * many pattern variants and occasionally revisits one; a stricter
 * threshold misclassifies real exploration as a loop (Sub-shape C in the
 * failure taxonomy — see refactors/extract-helper traces).
 */
function getRepeatThreshold(toolName: string): number {
  if (toolName === "search") return 4;
  return 3;
}

function clearStateSensitiveFingerprints(fingerprints: string[]): void {
  for (let index = fingerprints.length - 1; index >= 0; index -= 1) {
    if (isStateSensitiveFingerprint(fingerprints[index]!)) {
      fingerprints.splice(index, 1);
    }
  }
}

function clearFingerprint(fingerprints: string[], target: string): void {
  for (let index = fingerprints.length - 1; index >= 0; index -= 1) {
    if (fingerprints[index] === target) {
      fingerprints.splice(index, 1);
    }
  }
}

/**
 * Maximum number of loop-guard fires per turn before the agent hard-stops.
 * A single fire surfaces a nudge to the model and continues — the model
 * usually adjusts. Three fires across one turn signal the model isn't
 * finding a productive path, so the safety valve kicks in.
 */
const MAX_LOOP_GUARD_FIRES_PER_TURN = 3;

const LOOP_GUARD_HARD_STOP_MESSAGE =
  "Stopped due to repeated identical tool calls. The model triggered the loop guard 3 times in this turn without finding a productive path forward.";

function loopGuardNudge(repeatedCalls: number, fireNumber: number): string {
  return (
    `[loop guard: suppressed an identical call after ${repeatedCalls} repeats in a small window. ` +
    `Try a different approach — read a different file or region, search for a more specific pattern, ` +
    `run a command to inspect state, or use find_references / get_dependencies / read_symbol to navigate by structure. ` +
    `This is loop-guard fire ${fireNumber}/${MAX_LOOP_GUARD_FIRES_PER_TURN} for this turn; after the ${MAX_LOOP_GUARD_FIRES_PER_TURN}th the turn will hard-stop.]`
  );
}

/**
 * Extract the symbol name from a tool call input if the tool is symbol-aware.
 */
function extractFocusSymbol(toolCall: ToolCall): string | undefined {
  if (!SYMBOL_TOOLS.has(toolCall.name)) {
    return undefined;
  }
  const name = toolCall.input.name ?? toolCall.input.symbol ?? toolCall.input.query;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

const VERBOSE_SEP = "\u2500".repeat(60);
const PROGRESS_THINKING_MAX = 200;

/**
 * Content-aware truncation for tool outputs.
 * Different tools benefit from different truncation strategies:
 * - read_file: No truncation — the model needs exact text for edits
 * - run_command: Keep head + tail (50/50). Errors live at the end of
 *   normal failures, but pathological cases (infinite loops, runaway
 *   recursion, excessive logging) reveal themselves at the start. A
 *   tail-heavy split hides the diagnostic bytes for the runaway case.
 * - search: Keep head with a match count footer
 * - default: Keep head (existing behavior)
 */
export function truncateToolOutput(
  toolName: string,
  output: string,
  maxChars: number,
): string {
  // Never truncate read_file — the model needs exact content for edits
  if (toolName === "read_file") {
    return output;
  }

  if (maxChars <= 0 || output.length <= maxChars) {
    return output;
  }

  const totalLen = output.length;

  if (toolName === "run_command") {
    // Balanced head + tail. See doc comment above for the runaway-output
    // rationale: with a tail-heavy split, an infinite-loop trace gets
    // truncated such that both the visible head AND tail are inside the
    // loop pattern, so the model can't see the start that would reveal
    // the bug. 50/50 surfaces enough of both ends to spot either errors
    // at the tail OR pathological patterns at the head.
    const headChars = Math.floor(maxChars / 2);
    const tailChars = maxChars - headChars;
    const head = output.slice(0, headChars);
    const tail = output.slice(totalLen - tailChars);
    const omitted = totalLen - headChars - tailChars;
    const ratioHint =
      omitted > 10 * maxChars
        ? " The omitted region is unusually large — suspect runaway output (infinite loop, recursion, excessive logging) and examine the head, not just the tail."
        : "";
    return `${head}\n\n[... agent-level truncation: ${omitted} chars omitted from middle of run_command output to keep head + tail.${ratioHint}]\n\n${tail}`;
  }

  if (toolName === "search") {
    // Keep head with match count
    const lines = output.split("\n");
    const truncated = output.slice(0, maxChars);
    const shownLines = truncated.split("\n").length;
    return `${truncated}\n\n[... agent-level truncation: showing ~${shownLines} of ${lines.length} match lines, ${totalLen - maxChars} more chars elided. Narrow the search with a more specific path or include glob.]`;
  }

  // Default: head-only (existing behavior, with a layer-identifying footer)
  return `${output.slice(0, maxChars)}\n\n[... agent-level truncation: showed ${maxChars} of ${totalLen} chars from ${toolName}; ${totalLen - maxChars} more chars elided.]`;
}

export type UiUpdateThinking = { type: "thinking"; content: string };
export type UiUpdateStreamingChunk = { type: "streaming_chunk"; content: string };
export type UiUpdateStep = { type: "step"; step: number };
export type UiUpdateToolCallStart = {
  type: "tool_call_start";
  name: string;
  input: Record<string, unknown>;
};
export type UiUpdateToolCallEnd = {
  type: "tool_call_end";
  name: string;
  input: Record<string, unknown>;
  result: string;
  elapsedMs: number;
};
export type UiUpdateContextStatus = {
  type: "context_status";
  contextTokens: number;
  maxContextTokens: number;
};
export type UiUpdate =
  | UiUpdateThinking
  | UiUpdateStreamingChunk
  | UiUpdateStep
  | UiUpdateToolCallStart
  | UiUpdateToolCallEnd
  | UiUpdateContextStatus;

/**
 * Compute an effective keepRecentMessages that scales proportionally
 * with context fullness. When context is lightly used, keep the full
 * configured amount. As context fills up, reduce to allow more
 * aggressive trimming/compaction.
 *
 * At ≤50% usage: keep full configured value (e.g. 12)
 * At 100% usage: keep minimum of 4
 */
function computeEffectiveKeepRecent(
  configKeepRecent: number,
  currentTokens: number,
  maxTokens: number,
): number {
  const MIN_KEEP = 4;
  const usageRatio = Math.min(currentTokens / maxTokens, 1);

  if (usageRatio <= 0.5) {
    return configKeepRecent;
  }

  // Linear scale from configKeepRecent at 50% → MIN_KEEP at 100%
  const scale = 1 - (usageRatio - 0.5) / 0.5;
  return Math.max(
    MIN_KEEP,
    Math.round(MIN_KEEP + (configKeepRecent - MIN_KEEP) * scale),
  );
}

export class CodingAgent {
  private readonly session: Session;
  private config: AgentConfig;
  private readonly modelClient: ModelClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly getCodeMap: ((focusSymbols?: Set<string>) => CodeMapResult | undefined) | undefined;
  private readonly verbose: boolean;
  private readonly onProgress: ((message: string) => void) | undefined;
  private readonly onUiUpdate: ((event: UiUpdate) => void) | undefined;
  private readonly onVerbose: ((message: string) => void) | undefined;
  private readonly getSystemPromptSuffix: (() => string | undefined) | undefined;
  private readonly buildSystemPrompt: SystemPromptBuilder;
  private readonly beforeToolCall: BeforeToolCallHook | undefined;

  /**
   * Tracks symbol names the user/agent has been working with.
   * Persists across turns so the code map stays focused on the
   * current area of interest.
   */
  private readonly focusTracker = new FocusTracker();

  /**
   * Cache of recently read file paths (key: "path:offset:limit") to avoid
   * sending duplicate full file contents through the context window.
   * Maps to the step number when the file was last read.
   */
  private readonly fileReadCache: Map<string, number> = new Map();

  /** Cached system prompt for when dynamic prompts are disabled. */
  private cachedSystemPrompt: string | undefined;

  constructor(params: {
    config: AgentConfig;
    modelClient: ModelClient;
    toolRegistry: ToolRegistry;
    session?: Session;
    getCodeMap?: (focusSymbols?: Set<string>) => CodeMapResult | undefined;
    verbose?: boolean;
    onProgress?: (message: string) => void;
    onUiUpdate?: (event: UiUpdate) => void;
    onVerbose?: (message: string) => void;
    getSystemPromptSuffix?: () => string | undefined;
    /**
     * Replace the default system-prompt builder. Receives the agent's
     * config, the active tools, and the current code-map snippet (when
     * available). Return a string or a Promise<string>. When omitted,
     * minicode's default coding-agent prompt is used.
     *
     * Use this to point the agent at a different domain (review bot,
     * RAG assistant, non-coding use case) without rewriting the rest
     * of the SDK. Import `buildSystemPrompt` from `@sean.holung/minicode-sdk`
     * and call it from your builder to extend the default rather than
     * replace it.
     */
    buildSystemPrompt?: SystemPromptBuilder;
    /**
     * Called before each tool call. Return `{outcome: "deny", reason}` to
     * skip execution; the reason is fed back to the model as the tool's
     * result. Hosts use this to implement permission prompts (web UI
     * modal, CLI confirmation, etc.).
     */
    beforeToolCall?: BeforeToolCallHook;
  }) {
    this.config = params.config;
    this.modelClient = params.modelClient;
    this.toolRegistry = params.toolRegistry;
    this.session = params.session ?? new Session();
    this.getCodeMap = params.getCodeMap;
    this.verbose = params.verbose ?? false;
    this.onProgress = params.onProgress;
    this.onUiUpdate = params.onUiUpdate;
    this.onVerbose = params.onVerbose;
    this.buildSystemPrompt = params.buildSystemPrompt ?? defaultBuildSystemPrompt;
    this.getSystemPromptSuffix = params.getSystemPromptSuffix;
    this.beforeToolCall = params.beforeToolCall;
  }

  private verboseLog(...args: unknown[]): void {
    const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ");
    if (this.onVerbose) {
      this.onVerbose(msg);
    } else {
      console.error(msg);
    }
  }

  getSession(): Session {
    return this.session;
  }

  getReasoningEffort(): AgentConfig["reasoningEffort"] {
    return this.config.reasoningEffort;
  }

  getContextStatus(): { contextTokens: number; maxContextTokens: number } {
    return {
      contextTokens: this.session.getTokenEstimate(),
      maxContextTokens: this.config.maxContextTokens,
    };
  }

  setReasoningEffort(effort: AgentConfig["reasoningEffort"]): void {
    const rest = { ...this.config };
    delete rest.reasoningEffort;
    this.config = effort ? { ...rest, reasoningEffort: effort } : { ...rest };
  }

  /**
   * Manually compact the conversation context. Uses LLM-based
   * summarization with `config.compactionModel` if set, otherwise the
   * agent's primary model (`config.model`). Mechanical compaction is
   * the internal fallback inside `compactWithLlm` when the LLM call
   * fails — the result's `method` field tells you which strategy
   * actually ran.
   */
  async compactContext(): Promise<CompactionResult | null> {
    const keepRecent = this.config.keepRecentMessages;
    const model = this.config.compactionModel ?? this.config.model;
    return this.session.compactWithLlm(keepRecent, this.modelClient, model);
  }

  private getFocusSet(): Set<string> | undefined {
    const symbols = this.focusTracker.getFocusedSymbols();
    return symbols.size > 0 ? symbols : undefined;
  }

  /**
   * Check whether a previously-read file's content is still present in the
   * session context (i.e. hasn't been trimmed/compacted away). We look for
   * a tool message from "read_file" whose content still contains the file
   * path and hasn't been replaced with a summary stub.
   */
  private isFileReadStillInContext(filePath: string): boolean {
    const messages = this.session.getMessages();
    for (const msg of messages) {
      if (
        msg.role === "tool" &&
        msg.toolName === "read_file" &&
        msg.content.includes(filePath) &&
        !msg.content.startsWith("[summary:")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Run a tool call, gated through `beforeToolCall` if a hook was provided.
   * A `deny` decision short-circuits execution and feeds the hook's reason
   * back to the model as the tool's result, so the model sees the rejection
   * in-band and can choose how to respond.
   */
  private async executeToolCall(toolCall: ToolCall): Promise<string> {
    if (this.beforeToolCall) {
      const decision = await this.beforeToolCall({
        name: toolCall.name,
        input: toolCall.input,
      });
      if (decision.outcome === "deny") {
        return `Tool call denied by user: ${decision.reason}`;
      }
    }
    return this.toolRegistry.execute(toolCall.name, toolCall.input);
  }

  async runTurn(
    userMessage: string,
    options?: { signal?: AbortSignal; outputSchema?: OutputSchema },
  ): Promise<{
    text: string;
    output?: unknown;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
    };
    /**
     * Most recent step's reasoning content, when the model provided any
     * (Anthropic extended thinking blocks or OpenRouter `message.reasoning`).
     * Surfaced so callers can include it when re-prompting after a failed
     * attempt — e.g. benchmark mode's retry path can feed the model's own
     * prior thinking back so it sees what it was about to do.
     */
    reasoningContent?: string;
    streamed?: boolean;
  }> {
    this.session.addMessage({
      role: "user",
      content: userMessage,
    });

    const toolSchemas = this.toolRegistry.getToolSchemas();
    const recentToolCallFingerprints: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedInputTokens = 0;
    let totalReasoningTokens = 0;
    let lastReasoningContent: string | undefined;
    let loopGuardFires = 0;

    for (let step = 0; step < this.config.maxSteps; step += 1) {
      ensureStepWithinLimit(step, this.config.maxSteps);
      if (this.onUiUpdate) {
        this.onUiUpdate({ type: "step", step });
      }
      // Compute effective keepRecentMessages based on context fullness
      // (only when adaptive scaling is enabled).
      const effectiveKeepRecent = this.config.enableAdaptiveKeepRecent
        ? computeEffectiveKeepRecent(
            this.config.keepRecentMessages,
            this.session.getTokenEstimate(),
            this.config.maxContextTokens,
          )
        : this.config.keepRecentMessages;

      // Auto-compact when context exceeds the configured threshold.
      // Always uses LLM-based summarization (with `compactionModel` if
      // set, otherwise the agent's primary model). `compactWithLlm`
      // falls back to mechanical compaction internally on error; the
      // `method` field on the result tells us which actually ran.
      const compactionThreshold = this.config.compactionThreshold;
      if (compactionThreshold !== undefined && this.session.shouldCompact(this.config.maxContextTokens, compactionThreshold)) {
        const compactionModel = this.config.compactionModel ?? this.config.model;
        const result = await this.session.compactWithLlm(
          effectiveKeepRecent,
          this.modelClient,
          compactionModel,
        );
        if (result && this.onProgress) {
          const method = result.method === "llm" ? "LLM" : "mechanical";
          this.onProgress(
            `context compacted (${method}): ${result.removedMessages} messages summarized, ` +
            `${result.previousTokens} → ${result.newTokens} tokens`,
          );
        }
        if (result && this.onUiUpdate) {
          const method = result.method === "llm" ? "LLM" : "mechanical";
          this.onUiUpdate({
            type: "thinking",
            content:
              `Context compacted (${method}): ${result.removedMessages} messages summarized, ` +
              `${result.previousTokens} → ${result.newTokens} tokens`,
          });
        }
      }

      this.session.trim(
        this.config.maxContextTokens,
        effectiveKeepRecent,
      );

      // Broadcast current context size so UIs can display a fill indicator.
      if (this.onUiUpdate) {
        this.onUiUpdate({
          type: "context_status",
          contextTokens: this.session.getTokenEstimate(),
          maxContextTokens: this.config.maxContextTokens,
        });
      }

      // When enableDynamicPrompt is true, rebuild the system prompt each step
      // with the latest focus set so the code map dynamically adapts.
      // By default this stays false, so we build once and cache to keep the
      // prompt prefix stable across turns and improve KV cache hit rates.
      // NB: explicit `=== true` so that an absent field (undefined) routes
      // to false, matching the documented default. PR #138 flipped the CLI
      // loader's parseBoolean fallback to false but missed this line, which
      // left every SDK consumer that didn't explicitly set the field
      // running with dynamic prompts on.
      const dynamicPrompt = this.config.enableDynamicPrompt === true;
      let systemPrompt: string;
      if (dynamicPrompt || !this.cachedSystemPrompt) {
        const codeMap = this.getCodeMap?.(dynamicPrompt ? this.getFocusSet() : undefined);
        const basePrompt = await this.buildSystemPrompt({
          config: this.config,
          tools: toolSchemas,
          codeMap,
        });
        const suffix = this.getSystemPromptSuffix?.();
        systemPrompt = suffix ? basePrompt + "\n\n" + suffix : basePrompt;
        if (!dynamicPrompt) {
          this.cachedSystemPrompt = systemPrompt;
        }
      } else {
        systemPrompt = this.cachedSystemPrompt;
      }

      const messages = this.session.getMessages();
      if (this.verbose) {
        this.verboseLog(`\n${VERBOSE_SEP}`);
        this.verboseLog(`[verbose] Request (step ${step})`);
        this.verboseLog(VERBOSE_SEP);
        this.verboseLog("\n[System Prompt]\n", systemPrompt);
        this.verboseLog("\n[Messages]\n", JSON.stringify(messages, null, 2));
        this.verboseLog(VERBOSE_SEP);
      }

      const response = await this.modelClient.chat({
        model: this.config.model,
        system: systemPrompt,
        messages,
        tools: toolSchemas,
        maxTokens: this.config.maxTokens,
        // Caching is always-on for the stable prefix EXCEPT when
        // dynamic prompts are enabled — then the system prompt rebuilds
        // every step (focus-adaptive code map), so caching it would just
        // burn cache writes that never get hit.
        cacheableSystem: !this.config.enableDynamicPrompt,
        ...(this.config.reasoningEffort
          ? { reasoningEffort: this.config.reasoningEffort }
          : {}),
        ...(this.config.reasoningMaxTokens !== undefined
          ? { reasoningMaxTokens: this.config.reasoningMaxTokens }
          : {}),
        ...(this.onUiUpdate
          ? {
              onStream: (chunk: string) => {
                this.onUiUpdate!({ type: "streaming_chunk", content: chunk });
              },
            }
          : {}),
        ...(options?.signal && { signal: options.signal }),
        ...(options?.outputSchema && { outputSchema: options.outputSchema }),
      });

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
      totalCachedInputTokens += response.usage.cachedInputTokens ?? 0;
      totalReasoningTokens += response.usage.reasoningTokens ?? 0;
      if (
        typeof response.reasoningContent === "string" &&
        response.reasoningContent.trim().length > 0
      ) {
        lastReasoningContent = response.reasoningContent;
      }

      if (this.verbose) {
        this.verboseLog(`\n${VERBOSE_SEP}`);
        this.verboseLog("[verbose] Response");
        this.verboseLog(VERBOSE_SEP);
        this.verboseLog("Text:", response.text);
        this.verboseLog("Tool calls:", response.toolCalls.length);
        if (response.toolCalls.length > 0) {
          this.verboseLog(
            "Tools:",
            response.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(", "),
          );
        }
        this.verboseLog("Usage:", response.usage);
        this.verboseLog(VERBOSE_SEP);
      }

      // Structured-output turn: the model called the synthetic respond
      // tool. The validated value is on `response.output`; the synthetic
      // call has already been stripped from `toolCalls`. Terminate the
      // loop immediately. Any other tool calls in the same step are
      // ignored — when the model has decided on a final answer we don't
      // try to fold side-effects back into history.
      if (response.output !== undefined) {
        this.session.addMessage({
          role: "assistant",
          content: response.text,
        });
        const streamed =
          this.config.modelProvider === "openai-compatible" && !!this.onUiUpdate;
        return {
          text: response.text,
          output: response.output,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ...(totalCachedInputTokens > 0
              ? { cachedInputTokens: totalCachedInputTokens }
              : {}),
            ...(totalReasoningTokens > 0
              ? { reasoningTokens: totalReasoningTokens }
              : {}),
          },
          ...(lastReasoningContent !== undefined
            ? { reasoningContent: lastReasoningContent }
            : {}),
          streamed,
        };
      }

      if (response.toolCalls.length === 0) {
        // Pure-thinking collapse: some reasoning-capable models (Gemini
        // 2.5/3 via OpenRouter, occasionally Claude with extended thinking)
        // burn their full reasoning budget and return empty content +
        // empty tool_calls. Previously we replaced this with a generic
        // "no response" fallback, throwing away the reasoning entirely.
        // If the provider forwarded reasoning content, prefer surfacing
        // it — at least the user/trace can see what the model thought.
        const reasoning = response.reasoningContent?.trim() ?? "";
        const finalText =
          response.text.length > 0
            ? response.text
            : reasoning.length > 0
              ? `[model produced only reasoning content, no visible reply or tool calls]\n\n${reasoning}`
              : "The model returned no response or tool calls. If you asked for code changes or other work, try rephrasing your request or using a model with stronger tool-use support.";
        this.session.addMessage({
          role: "assistant",
          content: finalText,
        });
        const streamed =
          this.config.modelProvider === "openai-compatible" && !!this.onUiUpdate;
        return {
          text: finalText,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ...(totalCachedInputTokens > 0
              ? { cachedInputTokens: totalCachedInputTokens }
              : {}),
            ...(totalReasoningTokens > 0
              ? { reasoningTokens: totalReasoningTokens }
              : {}),
          },
          ...(lastReasoningContent !== undefined
            ? { reasoningContent: lastReasoningContent }
            : {}),
          streamed,
        };
      }

      if (response.text.length > 0) {
        const truncated =
          response.text.length > PROGRESS_THINKING_MAX
            ? response.text.slice(0, PROGRESS_THINKING_MAX) + "..."
            : response.text;
        if (this.onProgress) {
          this.onProgress(`thinking: ${truncated}`);
        }
        if (this.onUiUpdate) {
          this.onUiUpdate({ type: "thinking", content: truncated });
        }
      }

      // Cap thinking text stored in context. The model's reasoning before
      // a tool call is not useful on subsequent steps — only the intent
      // matters. Keep the opening (which captures the decision) and trim
      // the tail. The UI already received the full text via onUiUpdate.
      const thinkingContent =
        response.text.length > PROGRESS_THINKING_MAX
          ? response.text.slice(0, PROGRESS_THINKING_MAX) + "..."
          : response.text;

      this.session.addMessage({
        role: "assistant",
        content: thinkingContent,
        toolCalls: response.toolCalls,
      });

      for (let toolCallIndex = 0; toolCallIndex < response.toolCalls.length; toolCallIndex += 1) {
        const toolCall = response.toolCalls[toolCallIndex]!;
        const fingerprint = signatureForToolCall(toolCall);
        recentToolCallFingerprints.push(fingerprint);
        if (
          recentToolCallFingerprints.length >
          this.config.loopDetectionWindow
        ) {
          recentToolCallFingerprints.shift();
        }

        const repeatedCalls = recentToolCallFingerprints.filter(
          (value) => value === fingerprint,
        ).length;
        if (repeatedCalls >= getRepeatThreshold(toolCall.name)) {
          loopGuardFires += 1;
          if (loopGuardFires >= MAX_LOOP_GUARD_FIRES_PER_TURN) {
            // Safety valve: the model has triggered the guard three times
            // in this turn without redirecting. Skip the offending call,
            // hard-terminate the turn, and surface the stop reason.
            this.session.addMessage({
              role: "tool",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: `Tool skipped: ${LOOP_GUARD_HARD_STOP_MESSAGE}`,
            });
            for (const skippedToolCall of response.toolCalls.slice(toolCallIndex + 1)) {
              this.session.addMessage({
                role: "tool",
                toolCallId: skippedToolCall.id,
                toolName: skippedToolCall.name,
                content: `Tool skipped: ${LOOP_GUARD_HARD_STOP_MESSAGE}`,
              });
            }
            this.session.addMessage({
              role: "assistant",
              content: LOOP_GUARD_HARD_STOP_MESSAGE,
            });
            return {
              text: LOOP_GUARD_HARD_STOP_MESSAGE,
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                ...(totalCachedInputTokens > 0
                  ? { cachedInputTokens: totalCachedInputTokens }
                  : {}),
                ...(totalReasoningTokens > 0
                  ? { reasoningTokens: totalReasoningTokens }
                  : {}),
              },
              ...(lastReasoningContent !== undefined
                ? { reasoningContent: lastReasoningContent }
                : {}),
              streamed: false,
            };
          }

          // Soft path: skip this single call, inject an actionable nudge
          // as its tool result, clear this fingerprint from the window
          // (so the next unrelated call doesn't re-trip), and continue
          // processing remaining calls in the batch.
          this.session.addMessage({
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: loopGuardNudge(repeatedCalls, loopGuardFires),
          });
          clearFingerprint(recentToolCallFingerprints, fingerprint);
          continue;
        }

        // Track symbol focus from symbol-aware tool calls
        const focusSymbol = extractFocusSymbol(toolCall);
        if (focusSymbol) {
          this.focusTracker.addSymbol(focusSymbol);
        }

        if (this.onProgress) {
          this.onProgress(`tool_call: ${formatToolCallForProgress(toolCall)}`);
        }
        if (this.onUiUpdate) {
          this.onUiUpdate({
            type: "tool_call_start",
            name: toolCall.name,
            input: toolCall.input,
          });
        }
        if (this.verbose) {
          this.verboseLog(`\n${VERBOSE_SEP}`);
          this.verboseLog(`[verbose] Tool: ${toolCall.name}`);
          this.verboseLog("Arguments:", JSON.stringify(toolCall.input, null, 2));
        }
        let toolResult: string;
        const toolStartMs = Date.now();

        // Optionally deduplicate read_file calls when enabled.
        if (this.config.enableFileReadDedup && toolCall.name === "read_file") {
          const cacheKey = `${toolCall.input.path}:${toolCall.input.offset ?? ""}:${toolCall.input.limit ?? ""}`;
          const cachedStep = this.fileReadCache.get(cacheKey);
          const canDedup = cachedStep !== undefined && this.isFileReadStillInContext(String(toolCall.input.path));
          if (canDedup) {
            toolResult = `[File "${toolCall.input.path}" was already read at step ${cachedStep}. Refer to that earlier output.]`;
          } else {
            toolResult = await this.executeToolCall(toolCall);
            this.fileReadCache.set(cacheKey, step);
          }
        } else {
          toolResult = await this.executeToolCall(toolCall);
        }

        // Apply content-aware truncation when enabled, otherwise
        // fall back to simple head-only truncation. Footers identify
        // the truncation *layer* — without that, the agent can't tell
        // whether a tool's own footer was already there and an agent-
        // level cut chopped it off, vs. the tool returned everything
        // and the agent simply clipped to the char cap.
        if (this.config.enableToolOutputTruncation) {
          toolResult = truncateToolOutput(
            toolCall.name,
            toolResult,
            this.config.maxToolOutputChars,
          );
        } else {
          const maxChars = this.config.maxToolOutputChars;
          if (maxChars > 0 && toolResult.length > maxChars) {
            const remaining = toolResult.length - maxChars;
            toolResult = `${toolResult.slice(0, maxChars)}\n\n[... agent-level truncation: showed ${maxChars} of ${toolResult.length} chars from ${toolCall.name}; ${remaining} more chars elided. The tool may have already truncated above this footer. To read more, retry with a narrower scope (e.g. read_file with offset/limit, search with --include, list_files with skip/limit).]`;
          }
        }
        if (this.onUiUpdate) {
          this.onUiUpdate({
            type: "tool_call_end",
            name: toolCall.name,
            input: toolCall.input,
            result: toolResult,
            elapsedMs: Date.now() - toolStartMs,
          });
        }
        if (this.verbose) {
          this.verboseLog("Output:", toolResult);
          this.verboseLog(VERBOSE_SEP);
        }
        this.session.addMessage({
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: toolResult,
        });
        if (MUTATING_TOOLS.has(toolCall.name)) {
          clearStateSensitiveFingerprints(recentToolCallFingerprints);
        }
      }
    }

    const stepLimitMessage = formatStepLimitMessage(this.config.maxSteps);
    this.session.addMessage({
      role: "assistant",
      content: stepLimitMessage,
    });
    return {
      text: stepLimitMessage,
      usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ...(totalCachedInputTokens > 0
              ? { cachedInputTokens: totalCachedInputTokens }
              : {}),
            ...(totalReasoningTokens > 0
              ? { reasoningTokens: totalReasoningTokens }
              : {}),
          },
      ...(lastReasoningContent !== undefined
        ? { reasoningContent: lastReasoningContent }
        : {}),
      streamed: false,
    };
  }
}
