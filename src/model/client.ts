import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import Anthropic from "@anthropic-ai/sdk";

import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolCall,
  ToolSchema,
} from "../agent/types.js";

function toAnthropicMessages(
  messages: SessionMessage[],
): Anthropic.MessageParam[] {
  const converted: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content.trim().length > 0) {
        content.push({
          type: "text",
          text: message.content,
        });
      }

      for (const toolCall of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }

      converted.push({
        role: "assistant",
        content: content.length > 0 ? content : "",
      });
      continue;
    }

    converted.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    });
  }

  return converted;
}

function parseResponse(response: Anthropic.Messages.Message): ModelResponse {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    text: textParts.join("\n").trim(),
    toolCalls,
    stopReason:
      response.stop_reason === "tool_use"
        ? "tool_use"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn",
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }

      const delayMs = 500 * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set a key.",
      );
    }

    this.client = new Anthropic({ apiKey });
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    const response = await withRetry(() =>
      this.client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: toAnthropicMessages(params.messages),
        tools: params.tools,
      }),
    );

    return parseResponse(response);
  }
}

