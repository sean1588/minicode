import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import Anthropic from "@anthropic-ai/sdk";

import type {
  AgentConfig,
  ModelClient,
  ModelInfo,
  ModelResponse,
  OutputSchema,
  ReasoningEffort,
  SessionMessage,
  ToolCall,
  ToolSchema,
} from "../agent/types.js";
import {
  extractStructuredOutput,
  synthesizeRespondTool,
  validateOutputSchema,
} from "../agent/structured-output.js";

const DEFAULT_MODEL_START_TIMEOUT_SECONDS = 60;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/**
 * If the caller supplied an `outputSchema`, look for the synthetic
 * respond-tool's call in the parsed response, validate it, and surface
 * it via `ModelResponse.output`. The synthetic call is removed from
 * `toolCalls` so the agent loop does not try to dispatch it. When the
 * model didn't call the synthetic tool, the response is unchanged.
 */
function applyStructuredOutput(
  response: ModelResponse,
  outputSchema: OutputSchema | undefined,
): ModelResponse {
  if (!outputSchema) return response;
  const extracted = extractStructuredOutput(outputSchema, response.toolCalls);
  if (!extracted) return response;
  return {
    ...response,
    output: extracted.output,
    toolCalls: extracted.remainingToolCalls,
  };
}

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

  // Anthropic reports `cache_read_input_tokens` (cache hits) separately
  // from `input_tokens` (uncached portion that still got billed at the
  // standard rate). Surface the cache hits so callers can show savings
  // and so the rolled-up totals are honest about how much was billable.
  const cacheReadTokens = (response.usage as {
    cache_read_input_tokens?: number;
  }).cache_read_input_tokens;

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
      ...(cacheReadTokens !== undefined && cacheReadTokens > 0
        ? { cachedInputTokens: cacheReadTokens }
        : {}),
    },
  };
}

class ModelStartTimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds: number) {
    super(`Model request did not start responding within ${timeoutSeconds}s.`);
    this.name = "ModelStartTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

class OpenAICompatibleHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`OpenAI-compatible request failed (${status}): ${bodyText}`);
    this.name = "OpenAICompatibleHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    error instanceof Anthropic.APIUserAbortError
  );
}

function isOpenAICompatibleNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /fetch failed|network|socket|timed out|econnreset|econnrefused|enotfound|eai_again|terminated|und_err/i.test(
      error.message,
    )
  );
}

function isRetryableOpenAICompatibleError(error: unknown): boolean {
  if (error instanceof ModelStartTimeoutError) {
    return true;
  }

  if (error instanceof OpenAICompatibleHttpError) {
    return (
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }

  return isOpenAICompatibleNetworkError(error);
}

function isRetryableAnthropicError(error: unknown): boolean {
  return (
    error instanceof ModelStartTimeoutError ||
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) {
        throw error;
      }
      if (options.shouldRetry && !options.shouldRetry(error)) {
        throw error;
      }
      if (attempt === attempts) {
        break;
      }

      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function createTimeoutSignal(timeoutSeconds: number, parentSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  // Forward-declared because the returned `cleanup` closure references
  // it before the setTimeout call below assigns the handle.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = timeoutSeconds * 1000;

  const handleParentAbort = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", handleParentAbort, { once: true });
  }

  // eslint-disable-next-line prefer-const -- forward-declared above
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort(new ModelStartTimeoutError(timeoutSeconds));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      parentSignal?.removeEventListener("abort", handleParentAbort);
    },
    didTimeout: () => timedOut,
  };
}

async function withResponseStartTimeout<T>(
  timeoutSeconds: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutState = createTimeoutSignal(timeoutSeconds, parentSignal);
  try {
    return await fn(timeoutState.signal);
  } catch (error) {
    if (error instanceof ModelStartTimeoutError) {
      throw error;
    }
    if (timeoutState.didTimeout() && isAbortError(error)) {
      throw new ModelStartTimeoutError(timeoutSeconds);
    }
    throw error;
  } finally {
    timeoutState.cleanup();
  }
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
    /**
     * Prompt-caching stats. OpenAI, OpenRouter, DeepSeek, Gemini, Groq,
     * and others all report cache hits via this nested shape; we normalise
     * to `ModelResponse.usage.cachedInputTokens` for callers.
     */
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
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

const MISSING_TOOL_RESULT_CONTENT =
  "Tool result unavailable because the previous minicode run ended before recording output.";

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
  let pendingToolCalls: ToolCall[] = [];

  const flushMissingToolResults = () => {
    for (const toolCall of pendingToolCalls) {
      converted.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: MISSING_TOOL_RESULT_CONTENT,
      });
    }
    pendingToolCalls = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      flushMissingToolResults();
      converted.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      flushMissingToolResults();
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
      pendingToolCalls = [...(message.toolCalls ?? [])];
      continue;
    }

    const pendingToolCallIndex = pendingToolCalls.findIndex(
      (toolCall) => toolCall.id === message.toolCallId,
    );
    if (pendingToolCallIndex === -1) {
      continue;
    }

    converted.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    });
    pendingToolCalls.splice(pendingToolCallIndex, 1);
  }

  flushMissingToolResults();

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

  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens;

  return {
    text: (message.content ?? "").trim(),
    toolCalls,
    stopReason,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      ...(cachedTokens !== undefined && cachedTokens > 0
        ? { cachedInputTokens: cachedTokens }
        : {}),
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
  private readonly timeoutSeconds: number;

  constructor(
    apiKey = process.env.ANTHROPIC_API_KEY,
    options?: { timeoutSeconds?: number; client?: Anthropic },
  ) {
    if (!apiKey && !options?.client) {
      throw new Error(
        "Missing ANTHROPIC_API_KEY. Set the environment variable or pass it to the constructor.",
      );
    }

    this.timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_MODEL_START_TIMEOUT_SECONDS;
    this.client =
      options?.client ??
      new Anthropic({
        apiKey,
        maxRetries: 0,
      });
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
    cacheableSystem?: boolean;
    outputSchema?: OutputSchema;
  }): Promise<ModelResponse> {
    // Structured output: append a synthetic respond-tool with the
    // caller's schema so the model can "call" it with a typed answer.
    // Validated early to surface name collisions before the request.
    const effectiveTools = params.tools;
    const toolsForRequest: ToolSchema[] = (() => {
      if (!params.outputSchema) return effectiveTools;
      validateOutputSchema(params.outputSchema, effectiveTools);
      return [...effectiveTools, synthesizeRespondTool(params.outputSchema)];
    })();
    // Anthropic prompt caching: mark stable parts of the prefix with
    // `cache_control: { type: "ephemeral" }` so the provider serves
    // them at the cache-read rate (~10% of input cost) on subsequent
    // calls within ~5 minutes.
    //   - System prompt: cacheable when the caller signals it's stable
    //     across calls (i.e. not rebuilt every step). Skipped under
    //     `cacheableSystem: false` to avoid constant cache writes.
    //   - Tools: marking the LAST tool also caches every preceding
    //     tool, so a single breakpoint covers the whole tool set.
    //     Tools change rarely; always cache.
    const cacheableSystem = params.cacheableSystem !== false;
    const systemBlocks = cacheableSystem && params.system.length > 0
      ? [
          {
            type: "text" as const,
            text: params.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : params.system;
    const toolsWithCache =
      toolsForRequest.length > 0
        ? (toolsForRequest as unknown as Anthropic.Messages.ToolUnion[]).map(
            (tool, i) =>
              i === toolsForRequest.length - 1
                ? { ...tool, cache_control: { type: "ephemeral" } }
                : tool,
          )
        : toolsForRequest;
    const baseParams = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: systemBlocks,
      messages: toAnthropicMessages(params.messages),
      tools: toolsWithCache as unknown as Anthropic.Messages.ToolUnion[],
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
    const requestOptions = params.signal ? { signal: params.signal } : undefined;

    return withRetry(async () => {
      const stream = this.client.messages.stream(requestParams, requestOptions);
      if (params.onStream) {
        stream.on("text", (text) => {
          params.onStream?.(text);
        });
      }

      await withResponseStartTimeout(this.timeoutSeconds, params.signal, async (signal) => {
        const abortStream = () => stream.abort();
        if (signal.aborted) {
          abortStream();
        } else {
          signal.addEventListener("abort", abortStream, { once: true });
        }
        try {
          await stream.emitted("connect");
        } finally {
          signal.removeEventListener("abort", abortStream);
        }
      });

      const finalMessage = await stream.finalMessage();
      return applyStructuredOutput(parseResponse(finalMessage), params.outputSchema);
    }, {
      shouldRetry: isRetryableAnthropicError,
    });
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

async function parseOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onStream?: (chunk: string) => void,
): Promise<ModelResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallsAcc: Array<{ id: string; name: string; arguments: string }> = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
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
          usage.cached_tokens =
            chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
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
    usage: {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      ...(usage.cached_tokens > 0
        ? { cachedInputTokens: usage.cached_tokens }
        : {}),
    },
  };
}

export class OpenAICompatibleModelClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutSeconds: number;

  constructor(params?: {
    baseUrl?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
    timeoutSeconds?: number;
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
    this.timeoutSeconds = params?.timeoutSeconds ?? DEFAULT_MODEL_START_TIMEOUT_SECONDS;
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
    cacheableSystem?: boolean;
    outputSchema?: OutputSchema;
  }): Promise<ModelResponse> {
    const toolsForRequest: ToolSchema[] = (() => {
      if (!params.outputSchema) return params.tools;
      validateOutputSchema(params.outputSchema, params.tools);
      return [...params.tools, synthesizeRespondTool(params.outputSchema)];
    })();
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
        "Missing OpenRouter API key. Set OPENROUTER_API_KEY in ~/.minicode/.env or your shell environment. Get one at https://openrouter.ai/keys",
      );
    }

    const useStream = params.onStream !== undefined;

    const requestBody: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAICompatibleMessages(params.system, params.messages),
      tools: toOpenAICompatibleTools(toolsForRequest),
      tool_choice: "auto",
      max_tokens: params.maxTokens,
      stream: useStream,
    };

    if (params.reasoningEffort) {
      requestBody.reasoning = { effort: params.reasoningEffort };
    }

    // Prompt caching. Most OpenAI-compatible providers (OpenAI, DeepSeek,
    // Grok, Groq, Moonshot, Gemini) cache automatically and ignore this
    // field. OpenRouter honours the Anthropic-shaped `cache_control` and
    // routes it to underlying Claude models so they cache the stable
    // prefix. We send it as a top-level shortcut: OpenRouter then
    // auto-applies the breakpoint to the last cacheable block (system +
    // tools). Skipped when the system prompt rebuilds every step
    // (`cacheableSystem: false`) to avoid pointless cache writes.
    if (params.cacheableSystem !== false) {
      requestBody.cache_control = { type: "ephemeral" };
    }

    // OpenRouter provider pinning (variance control). When
    // `OPENROUTER_PROVIDER_ORDER` is set, requests are routed to the
    // listed providers in order. Default is `allow_fallbacks: false`
    // so an unavailable pinned provider fails loudly rather than
    // silently routing elsewhere — which would defeat the variance
    // control. Only injected when targeting OpenRouter.
    if (this.baseUrl.includes("openrouter")) {
      const providerOrderRaw = process.env.OPENROUTER_PROVIDER_ORDER;
      if (providerOrderRaw && providerOrderRaw.trim().length > 0) {
        const order = providerOrderRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (order.length > 0) {
          const allowFallbacks =
            process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS === "true";
          requestBody.provider = { order, allow_fallbacks: allowFallbacks };
        }
      }
    }

    const response = await withRetry(
      () =>
        withResponseStartTimeout(this.timeoutSeconds, params.signal, async (signal) => {
          const httpResponse = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal,
          });

          if (!httpResponse.ok) {
            const bodyText = await httpResponse.text();
            throw new OpenAICompatibleHttpError(
              httpResponse.status,
              bodyText || "No response body.",
            );
          }

          if (useStream && httpResponse.body) {
            return applyStructuredOutput(
              await parseOpenAIStream(
                httpResponse.body.getReader(),
                params.onStream,
              ),
              params.outputSchema,
            );
          }

          const payload =
            (await httpResponse.json()) as OpenAICompatibleCompletionResponse;
          return applyStructuredOutput(
            parseOpenAICompatibleResponse(payload),
            params.outputSchema,
          );
        }),
      {
        shouldRetry: isRetryableOpenAICompatibleError,
      },
    );

    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {};
    const apiKey = this.apiKey?.trim();
    if (apiKey && apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    try {
      const response = await withResponseStartTimeout(
        this.timeoutSeconds,
        undefined,
        (signal) => this.fetchImpl(`${this.baseUrl}/models`, { headers, signal }),
      );
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
      timeoutSeconds: config.modelTimeoutSeconds,
      ...(config.openAiApiKey !== undefined
        ? { apiKey: config.openAiApiKey }
        : {}),
    });
  }
  return new AnthropicModelClient(
    process.env.ANTHROPIC_API_KEY,
    { timeoutSeconds: config.modelTimeoutSeconds },
  );
}
