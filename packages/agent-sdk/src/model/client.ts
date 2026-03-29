import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import Anthropic from "@anthropic-ai/sdk";

import type {
  AgentConfig,
  ModelClient,
  ModelInfo,
  ModelResponse,
  ReasoningEffort,
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) {
        throw error;
      }
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
      const toolCalls = message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function" as const,
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input),
        },
      }));

      converted.push({
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
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

/** Map reasoning effort level to a fraction of max_tokens for Anthropic budget_tokens. */
function effortToBudgetFraction(effort: ReasoningEffort): number {
  switch (effort) {
    case "xhigh": return 0.95;
    case "high": return 0.80;
    case "medium": return 0.50;
    case "low": return 0.20;
    case "minimal": return 0.10;
    case "none": return 0;
  }
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "Missing ANTHROPIC_API_KEY. Set the environment variable or pass it to the constructor.",
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
    reasoningEffort?: ReasoningEffort;
    onStream?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<ModelResponse> {
    const baseParams = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
      tools: params.tools as unknown as Anthropic.Messages.ToolUnion[],
    };

    // Build thinking parameter for models that support extended thinking.
    const thinkingParam =
      params.reasoningEffort && params.reasoningEffort !== "none"
        ? {
            thinking: {
              type: "enabled" as const,
              budget_tokens: Math.max(
                1,
                Math.round(params.maxTokens * effortToBudgetFraction(params.reasoningEffort)),
              ),
            },
          }
        : {};

    const requestParams = { ...baseParams, ...thinkingParam };

    if (params.onStream) {
      const onStream = params.onStream;
      return withRetry(async () => {
        const stream = this.client.messages.stream(requestParams);
        if (params.signal) {
          params.signal.addEventListener("abort", () => stream.abort(), { once: true });
        }
        stream.on("text", (text) => {
          onStream(text);
        });

        const finalMessage = await stream.finalMessage();
        return parseResponse(finalMessage);
      });
    }

    const response = await withRetry<Anthropic.Messages.Message>(() =>
      this.client.messages.create({
        ...requestParams,
        stream: false,
      }) as Promise<Anthropic.Messages.Message>,
    );

    return parseResponse(response);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      const models: ModelInfo[] = [];
      for await (const model of response) {
        models.push({ id: model.id, name: model.display_name ?? model.id });
      }
      return models;
    } catch {
      return [];
    }
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function parseOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onStream?: (chunk: string) => void,
): Promise<ModelResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallsAcc: Array<{ id: string; name: string; arguments: string }> = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let finishReason: string | null = null;

  const processLines = (lines: string[]) => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          content += delta.content;
          onStream?.(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" };
            } else {
              if (tc.id) toolCallsAcc[idx].id = tc.id;
              if (tc.function?.name) toolCallsAcc[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage.prompt_tokens = chunk.usage.prompt_tokens ?? 0;
          usage.completion_tokens = chunk.usage.completion_tokens ?? 0;
        }
      } catch {
        // skip malformed chunks
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    processLines(lines);
    if (done) {
      if (buffer.trim()) processLines([buffer]);
      break;
    }
  }

  const toolCalls: ToolCall[] = toolCallsAcc
    .filter((tc) => tc.id || tc.name)
    .map((tc, i) => ({
      id: tc.id || `tool-call-${i + 1}`,
      name: tc.name,
      input: parseOpenAICompatibleToolArguments(tc.arguments),
    }));

  const stopReason: ModelResponse["stopReason"] =
    finishReason === "tool_calls" || finishReason === "function_call"
      ? "tool_use"
      : finishReason === "length"
        ? "max_tokens"
        : toolCalls.length > 0
          ? "tool_use"
          : "end_turn";

  return {
    text: content.trim(),
    toolCalls,
    stopReason,
    usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
  };
}

export class OpenAICompatibleModelClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(params?: {
    baseUrl?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
    );
    const isOpenRouter = this.baseUrl.includes("openrouter");
    this.apiKey =
      params?.apiKey ??
      (isOpenRouter
        ? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY
        : process.env.OPENAI_API_KEY);
    this.fetchImpl = params?.fetchImpl ?? fetch;
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
    reasoningEffort?: ReasoningEffort;
    onStream?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<ModelResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "HTTP-Referer": "https://minicode.seanholung.com",
      "X-Title": "minicode",
    };
    const apiKey = this.apiKey?.trim();
    if (apiKey && apiKey.length > 0) {
      if (
        this.baseUrl.includes("openrouter") &&
        apiKey.startsWith("sk-proj-")
      ) {
        throw new Error(
          "OpenRouter requires an OpenRouter API key (sk-or-v1-...), not an OpenAI key (sk-proj-...). Get one at https://openrouter.ai/keys",
        );
      }
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (this.baseUrl.includes("openrouter")) {
      throw new Error(
        "Missing OpenRouter API key. Set OPENAI_API_KEY or OPENROUTER_API_KEY in .env. Get one at https://openrouter.ai/keys",
      );
    }

    const useStream = params.onStream !== undefined;

    const requestBody: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAICompatibleMessages(params.system, params.messages),
      tools: toOpenAICompatibleTools(params.tools),
      tool_choice: "auto",
      max_tokens: params.maxTokens,
      stream: useStream,
    };

    if (params.reasoningEffort) {
      requestBody.reasoning = { effort: params.reasoningEffort };
    }

    const response = await withRetry(async () => {
      const httpResponse = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        ...(params.signal && { signal: params.signal }),
      });

      if (!httpResponse.ok) {
        const bodyText = await httpResponse.text();
        throw new Error(
          `OpenAI-compatible request failed (${httpResponse.status}): ${bodyText}`,
        );
      }

      if (useStream && httpResponse.body) {
        return parseOpenAIStream(
          httpResponse.body.getReader(),
          params.onStream,
        );
      }

      const payload =
        (await httpResponse.json()) as OpenAICompatibleCompletionResponse;
      return parseOpenAICompatibleResponse(payload);
    });

    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {};
    const apiKey = this.apiKey?.trim();
    if (apiKey && apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, { headers });
      if (!response.ok) return [];
      const payload = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
      return (payload.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
    } catch {
      return [];
    }
  }
}

export function createModelClient(config: AgentConfig): ModelClient {
  if (config.modelProvider === "openai-compatible") {
    return new OpenAICompatibleModelClient({
      baseUrl: config.openAiBaseUrl,
      ...(config.openAiApiKey !== undefined
        ? { apiKey: config.openAiApiKey }
        : {}),
    });
  }
  return new AnthropicModelClient();
}
