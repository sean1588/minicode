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

export class CodingAgent {
  private readonly session: Session;
  private readonly config: AgentConfig;
  private readonly modelClient: ModelClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly projectIndex: ProjectIndex | undefined;

  constructor(params: {
    config: AgentConfig;
    modelClient: ModelClient;
    toolRegistry: ToolRegistry;
    session?: Session;
    projectIndex?: ProjectIndex;
  }) {
    this.config = params.config;
    this.modelClient = params.modelClient;
    this.toolRegistry = params.toolRegistry;
    this.session = params.session ?? new Session();
    this.projectIndex = params.projectIndex;
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

      const response = await this.modelClient.chat({
        model: this.config.model,
        system: systemPrompt,
        messages: this.session.getMessages(),
        tools: toolSchemas,
        maxTokens: this.config.maxTokens,
      });

      if (response.toolCalls.length === 0) {
        const finalText =
          response.text.length > 0
            ? response.text
            : "Task complete. No further tool calls were needed.";
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

        const toolResult = await this.toolRegistry.execute(
          toolCall.name,
          toolCall.input,
        );
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

