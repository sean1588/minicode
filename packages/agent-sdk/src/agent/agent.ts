import { buildSystemPrompt } from "../prompt/system-prompt.js";
import type { CodeMapResult } from "../prompt/system-prompt.js";
import { ensureStepWithinLimit } from "../safety/guardrails.js";
import { Session } from "../session/session.js";
import type { CompactionResult } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentConfig, ModelClient, ToolCall } from "./types.js";

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
const MAX_FOCUS_SYMBOLS = 30;

/**
 * Content-aware truncation for tool outputs.
 * Different tools benefit from different truncation strategies:
 * - read_file: No truncation — the model needs exact text for edits
 * - run_command: Keep tail (errors/results are at the end)
 * - search: Keep head with a match count footer
 * - default: Keep head (existing behavior)
 */
function truncateToolOutput(
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
  const overflowNote = `\n\n[... truncated, ${totalLen - maxChars} more chars ...]`;

  if (toolName === "run_command") {
    // Keep tail — errors and results are usually at the end
    const tailChars = Math.floor(maxChars * 0.8);
    const headChars = maxChars - tailChars;
    const head = output.slice(0, headChars);
    const tail = output.slice(totalLen - tailChars);
    return `${head}\n\n[... ${totalLen - headChars - tailChars} chars omitted ...]\n\n${tail}`;
  }

  if (toolName === "search") {
    // Keep head with match count
    const lines = output.split("\n");
    const truncated = output.slice(0, maxChars);
    const shownLines = truncated.split("\n").length;
    return `${truncated}\n\n[... showing ~${shownLines} of ${lines.length} match lines, ${totalLen - maxChars} more chars ...]`;
  }

  // Default: head-only (existing behavior)
  return `${output.slice(0, maxChars)}${overflowNote}`;
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
export type UiUpdate =
  | UiUpdateThinking
  | UiUpdateStreamingChunk
  | UiUpdateStep
  | UiUpdateToolCallStart
  | UiUpdateToolCallEnd;

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
  private readonly config: AgentConfig;
  private readonly modelClient: ModelClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly getCodeMap: ((focusSymbols?: Set<string>) => CodeMapResult | undefined) | undefined;
  private readonly verbose: boolean;
  private readonly onProgress: ((message: string) => void) | undefined;
  private readonly onUiUpdate: ((event: UiUpdate) => void) | undefined;

  /**
   * Tracks symbol names the user/agent has been working with.
   * Persists across turns so the code map stays focused on the
   * current area of interest.
   */
  private readonly focusedSymbols: Map<string, number> = new Map();
  private focusGeneration = 0;

  /**
   * Cache of recently read file paths (key: "path:offset:limit") to avoid
   * sending duplicate full file contents through the context window.
   * Maps to the step number when the file was last read.
   */
  private readonly fileReadCache: Map<string, number> = new Map();

  constructor(params: {
    config: AgentConfig;
    modelClient: ModelClient;
    toolRegistry: ToolRegistry;
    session?: Session;
    getCodeMap?: (focusSymbols?: Set<string>) => CodeMapResult | undefined;
    verbose?: boolean;
    onProgress?: (message: string) => void;
    onUiUpdate?: (event: UiUpdate) => void;
  }) {
    this.config = params.config;
    this.modelClient = params.modelClient;
    this.toolRegistry = params.toolRegistry;
    this.session = params.session ?? new Session();
    this.getCodeMap = params.getCodeMap;
    this.verbose = params.verbose ?? false;
    this.onProgress = params.onProgress;
    this.onUiUpdate = params.onUiUpdate;
  }

  getSession(): Session {
    return this.session;
  }

  /**
   * Manually compact the conversation context.
   * Uses LLM-based summarization when compactionModel is configured,
   * otherwise falls back to mechanical compaction.
   */
  async compactContext(): Promise<CompactionResult | null> {
    const keepRecent = this.config.keepRecentMessages;
    const compactionModel = this.config.compactionModel;
    return compactionModel
      ? this.session.compactWithLlm(keepRecent, this.modelClient, compactionModel)
      : this.session.compact(keepRecent);
  }

  private addFocusSymbol(name: string): void {
    this.focusGeneration += 1;
    this.focusedSymbols.set(name, this.focusGeneration);

    // Evict oldest if over limit
    if (this.focusedSymbols.size > MAX_FOCUS_SYMBOLS) {
      let oldestKey: string | null = null;
      let oldestGen = Infinity;
      for (const [key, gen] of this.focusedSymbols) {
        if (gen < oldestGen) {
          oldestGen = gen;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.focusedSymbols.delete(oldestKey);
      }
    }
  }

  private getFocusSet(): Set<string> | undefined {
    return this.focusedSymbols.size > 0
      ? new Set(this.focusedSymbols.keys())
      : undefined;
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

  async runTurn(
    userMessage: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    text: string;
    usage?: { inputTokens: number; outputTokens: number };
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
      // When compactionModel is set, use LLM-based summarization for higher
      // quality summaries. Otherwise, fall back to mechanical compaction.
      const compactionThreshold = this.config.compactionThreshold;
      if (compactionThreshold !== undefined && this.session.shouldCompact(this.config.maxContextTokens, compactionThreshold)) {
        const compactionModel = this.config.compactionModel;
        const result = compactionModel
          ? await this.session.compactWithLlm(effectiveKeepRecent, this.modelClient, compactionModel)
          : this.session.compact(effectiveKeepRecent);
        if (result && this.onProgress) {
          const method = compactionModel ? "LLM" : "mechanical";
          this.onProgress(
            `context compacted (${method}): ${result.removedMessages} messages summarized, ` +
            `${result.previousTokens} → ${result.newTokens} tokens`,
          );
        }
        if (result && this.onUiUpdate) {
          const method = compactionModel ? "LLM" : "mechanical";
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

      // Rebuild system prompt each step with the latest focus set,
      // so the code map dynamically adapts as the agent explores symbols.
      const codeMapResult = this.getCodeMap?.(this.getFocusSet());
      const systemPrompt = buildSystemPrompt(
        this.config,
        toolSchemas,
        codeMapResult,
      );

      const messages = this.session.getMessages();
      if (this.verbose) {
        console.error(`\n${VERBOSE_SEP}`);
        console.error(`[verbose] Request (step ${step})`);
        console.error(`${VERBOSE_SEP}`);
        console.error("\n[System Prompt]\n", systemPrompt);
        console.error("\n[Messages]\n", JSON.stringify(messages, null, 2));
        console.error(VERBOSE_SEP);
      }

      const response = await this.modelClient.chat({
        model: this.config.model,
        system: systemPrompt,
        messages,
        tools: toolSchemas,
        maxTokens: this.config.maxTokens,
        ...(this.onUiUpdate
          ? {
              onStream: (chunk: string) => {
                this.onUiUpdate!({ type: "streaming_chunk", content: chunk });
              },
            }
          : {}),
        ...(options?.signal && { signal: options.signal }),
      });

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      if (this.verbose) {
        console.error(`\n${VERBOSE_SEP}`);
        console.error("[verbose] Response");
        console.error(`${VERBOSE_SEP}`);
        console.error("Text:", response.text);
        console.error("Tool calls:", response.toolCalls.length);
        if (response.toolCalls.length > 0) {
          console.error(
            "Tools:",
            response.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(", "),
          );
        }
        console.error("Usage:", response.usage);
        console.error(VERBOSE_SEP);
      }

      if (response.toolCalls.length === 0) {
        const finalText =
          response.text.length > 0
            ? response.text
            : "The model returned no response or tool calls. If you asked for code changes or other work, try rephrasing your request or using a model with stronger tool-use support.";
        this.session.addMessage({
          role: "assistant",
          content: finalText,
        });
        const streamed =
          this.config.modelProvider === "openai-compatible" && !!this.onUiUpdate;
        return {
          text: finalText,
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
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

      for (const toolCall of response.toolCalls) {
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
        if (repeatedCalls >= 3) {
          const loopMessage =
            "Stopped due to repeated identical tool calls. Please refine the prompt or provide additional constraints.";
          this.session.addMessage({
            role: "assistant",
            content: loopMessage,
          });
          return {
            text: loopMessage,
            usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
            streamed: false,
          };
        }

        // Track symbol focus from symbol-aware tool calls
        const focusSymbol = extractFocusSymbol(toolCall);
        if (focusSymbol) {
          this.addFocusSymbol(focusSymbol);
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
          console.error(`\n${VERBOSE_SEP}`);
          console.error(`[verbose] Tool: ${toolCall.name}`);
          console.error("Arguments:", JSON.stringify(toolCall.input, null, 2));
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
            toolResult = await this.toolRegistry.execute(
              toolCall.name,
              toolCall.input,
            );
            this.fileReadCache.set(cacheKey, step);
          }
        } else {
          toolResult = await this.toolRegistry.execute(
            toolCall.name,
            toolCall.input,
          );
        }

        // Apply content-aware truncation when enabled, otherwise
        // fall back to simple head-only truncation.
        if (this.config.enableToolOutputTruncation) {
          toolResult = truncateToolOutput(
            toolCall.name,
            toolResult,
            this.config.maxToolOutputChars,
          );
        } else {
          const maxChars = this.config.maxToolOutputChars;
          if (maxChars > 0 && toolResult.length > maxChars) {
            toolResult = `${toolResult.slice(0, maxChars)}\n\n[... truncated, ${toolResult.length - maxChars} more chars ...]`;
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
          console.error("Output:", toolResult);
          console.error(VERBOSE_SEP);
        }
        this.session.addMessage({
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: toolResult,
        });
      }
    }

    const stepLimitMessage =
      "Reached the maximum number of steps for this turn. I stopped to avoid an infinite loop.";
    this.session.addMessage({
      role: "assistant",
      content: stepLimitMessage,
    });
    return {
      text: stepLimitMessage,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      streamed: false,
    };
  }
}
