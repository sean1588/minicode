import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import Anthropic from "@anthropic-ai/sdk";

import type {
  AgentConfig,
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

interface OpenAICompatibleToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAICompatibleChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAICompatibleToolCall[];
  };
  finish_reason?: string | null;
}

interface OpenAICompatibleCompletionResponse {
  choices?: OpenAICompatibleChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

type OpenAICompatibleMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAICompatibleToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

function toOpenAICompatibleMessages(
  system: string,
  messages: SessionMessage[],
): OpenAICompatibleMessage[] {
  const converted: OpenAICompatibleMessage[] = [
    {
      role: "system",
      content: system,
    },
  ];

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
        tool_calls:
          message.toolCalls?.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input),
            },
          })) ?? undefined,
      });
      continue;
    }

    converted.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    });
  }

  return converted;
}

function toOpenAICompatibleTools(
  tools: ToolSchema[],
): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function parseOpenAICompatibleToolArguments(
  rawArguments: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to empty object when model emits malformed function arguments.
  }
  return {};
}

function parseOpenAICompatibleResponse(
  response: OpenAICompatibleCompletionResponse,
): ModelResponse {
  const firstChoice = response.choices?.[0];
  const message = firstChoice?.message;
  if (!message) {
    throw new Error("OpenAI-compatible response missing choices[0].message.");
  }

  const toolCalls: ToolCall[] =
    message.tool_calls?.map((toolCall, index) => ({
      id: toolCall.id || `tool-call-${index + 1}`,
      name: toolCall.function.name,
      input: parseOpenAICompatibleToolArguments(toolCall.function.arguments),
    })) ?? [];

  const finishReason = firstChoice?.finish_reason ?? null;
  const stopReason: ModelResponse["stopReason"] =
    finishReason === "tool_calls" || finishReason === "function_call"
      ? "tool_use"
      : finishReason === "length"
        ? "max_tokens"
        : toolCalls.length > 0
          ? "tool_use"
          : "end_turn";

  return {
    text: (message.content ?? "").trim(),
    toolCalls,
    stopReason,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new Error("OPENAI_BASE_URL cannot be empty.");
  }
  return trimmed;
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
    const response = await withRetry<Anthropic.Messages.Message>(() =>
      this.client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: toAnthropicMessages(params.messages),
        tools: params.tools as unknown as Anthropic.Messages.ToolUnion[],
        stream: false,
      }) as Promise<Anthropic.Messages.Message>,
    );

    return parseResponse(response);
  }
}

export class OpenAICompatibleModelClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(params?: {
    baseUrl?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
    );
    this.apiKey = params?.apiKey ?? process.env.OPENAI_API_KEY;
    this.fetchImpl = params?.fetchImpl ?? fetch;
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey && this.apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await withRetry(async () => {
      const httpResponse = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: params.model,
          messages: toOpenAICompatibleMessages(params.system, params.messages),
          tools: toOpenAICompatibleTools(params.tools),
          tool_choice: "auto",
          max_tokens: params.maxTokens,
          stream: false,
        }),
      });

      if (!httpResponse.ok) {
        const bodyText = await httpResponse.text();
        throw new Error(
          `OpenAI-compatible request failed (${httpResponse.status}): ${bodyText}`,
        );
      }

      const payload =
        (await httpResponse.json()) as OpenAICompatibleCompletionResponse;
      return parseOpenAICompatibleResponse(payload);
    });

    return response;
  }
}

export function createModelClient(config: AgentConfig): ModelClient {
  if (config.modelProvider === "openai-compatible") {
    return new OpenAICompatibleModelClient({
      baseUrl: config.openAiBaseUrl,
      apiKey: config.openAiApiKey,
    });
  }
  return new AnthropicModelClient();
}

