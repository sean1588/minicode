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

const VERBOSE_SEP = "─".repeat(60);

export class CodingAgent {
  private readonly session: Session;
  private readonly config: AgentConfig;
  private readonly modelClient: ModelClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly projectIndex: ProjectIndex | undefined;
  private readonly verbose: boolean;

  constructor(params: {
    config: AgentConfig;
    modelClient: ModelClient;
    toolRegistry: ToolRegistry;
    session?: Session;
    projectIndex?: ProjectIndex;
    verbose?: boolean;
  }) {
    this.config = params.config;
    this.modelClient = params.modelClient;
    this.toolRegistry = params.toolRegistry;
    this.session = params.session ?? new Session();
    this.projectIndex = params.projectIndex;
    this.verbose = params.verbose ?? false;
  }

  getSession(): Session {
    return this.session;
  }

  async runTurn(userMessage: string): Promise<string> {
    this.session.addMessage({
      role: "user",
      content: userMessage,
    });

    const toolSchemas = this.toolRegistry.getToolSchemas();
    const codeMap = this.projectIndex?.getCodeMap();
    const systemPrompt = buildSystemPrompt(
      this.config,
      toolSchemas,
      codeMap,
    );
    const recentToolCallFingerprints: string[] = [];

    for (let step = 0; step < this.config.maxSteps; step += 1) {
      ensureStepWithinLimit(step, this.config.maxSteps);
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
      });

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
        return finalText;
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
          return loopMessage;
        }

        if (this.verbose) {
          console.error(`\n${VERBOSE_SEP}`);
          console.error(`[verbose] Tool: ${toolCall.name}`);
          console.error("Arguments:", JSON.stringify(toolCall.input, null, 2));
        }
        const toolResult = await this.toolRegistry.execute(
          toolCall.name,
          toolCall.input,
        );
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
    return stepLimitMessage;
  }
}

