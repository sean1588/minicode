import { buildSystemPrompt } from "../prompt/system-prompt.js";
import { ensureStepWithinLimit } from "../safety/guardrails.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ProjectIndex } from "../indexer/types.js";
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

const VERBOSE_SEP = "─".repeat(60);
const PROGRESS_THINKING_MAX = 200;

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

export class CodingAgent {
  private readonly session: Session;
  private readonly config: AgentConfig;
  private readonly modelClient: ModelClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly projectIndex: ProjectIndex | undefined;
  private readonly verbose: boolean;
  private readonly onProgress: ((message: string) => void) | undefined;
  private readonly onUiUpdate: ((event: UiUpdate) => void) | undefined;

  constructor(params: {
    config: AgentConfig;
    modelClient: ModelClient;
    toolRegistry: ToolRegistry;
    session?: Session;
    projectIndex?: ProjectIndex;
    verbose?: boolean;
    onProgress?: (message: string) => void;
    onUiUpdate?: (event: UiUpdate) => void;
  }) {
    this.config = params.config;
    this.modelClient = params.modelClient;
    this.toolRegistry = params.toolRegistry;
    this.session = params.session ?? new Session();
    this.projectIndex = params.projectIndex;
    this.verbose = params.verbose ?? false;
    this.onProgress = params.onProgress;
    this.onUiUpdate = params.onUiUpdate;
  }

  getSession(): Session {
    return this.session;
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
    const codeMapResult = this.projectIndex?.getCodeMap();
    const systemPrompt = buildSystemPrompt(
      this.config,
      toolSchemas,
      codeMapResult,
    );
    const recentToolCallFingerprints: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let step = 0; step < this.config.maxSteps; step += 1) {
      ensureStepWithinLimit(step, this.config.maxSteps);
      if (this.onUiUpdate) {
        this.onUiUpdate({ type: "step", step });
      }
      this.session.trim(
        this.config.maxContextTokens,
        this.config.keepRecentMessages,
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

      this.session.addMessage({
        role: "assistant",
        content: response.text,
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
        const toolStartMs = Date.now();
        let toolResult = await this.toolRegistry.execute(
          toolCall.name,
          toolCall.input,
        );
        const maxChars = this.config.maxToolOutputChars;
        if (maxChars > 0 && toolResult.length > maxChars) {
          toolResult = `${toolResult.slice(0, maxChars)}\n\n[... truncated, ${toolResult.length - maxChars} more chars ...]`;
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

