import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenAICompatibleModelClient,
  createModelClient,
} from "../src/model/client.js";
import { createTestAgentConfig } from "./test-utils.js";

test("openai-compatible client sends tool schemas and parses tool calls", async () => {
  let capturedUrl = "";
  let capturedBody = "";

  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"src/index.ts\"}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const response = await client.chat({
    model: "qwen2.5-coder-7b-instruct",
    system: "System instructions",
    messages: [{ role: "user", content: "Read src/index.ts" }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ],
    maxTokens: 256,
  });

  assert.equal(capturedUrl, "http://localhost:1234/v1/chat/completions");
  assert.equal(response.stopReason, "tool_use");
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, "read_file");
  assert.deepEqual(response.toolCalls[0]?.input, { path: "src/index.ts" });
  assert.equal(response.usage.inputTokens, 10);
  assert.equal(response.usage.outputTokens, 5);

  const parsedBody = JSON.parse(capturedBody) as Record<string, unknown>;
  const messages = parsedBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");

  const tools = parsedBody.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.type, "function");
});

test("openai-compatible client parses end_turn response", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Hello, world!",
            },
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const response = await client.chat({
    model: "test-model",
    system: "Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 256,
  });

  assert.equal(response.text, "Hello, world!");
  assert.equal(response.stopReason, "end_turn");
  assert.equal(response.toolCalls.length, 0);
});

test("openai-compatible client handles malformed tool arguments gracefully", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "some_tool",
                    arguments: "not valid json{{{",
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const response = await client.chat({
    model: "test-model",
    system: "Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 256,
  });

  assert.equal(response.toolCalls[0]?.name, "some_tool");
  assert.deepEqual(response.toolCalls[0]?.input, {});
});

test("openai-compatible client retries transient HTTP failures", async () => {
  let attempts = 0;

  const fetchImpl: typeof fetch = async () => {
    attempts += 1;

    if (attempts < 3) {
      return new Response("temporary outage", { status: 503 });
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Recovered",
            },
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
    timeoutSeconds: 1,
  });

  const response = await client.chat({
    model: "test-model",
    system: "Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 64,
  });

  assert.equal(attempts, 3);
  assert.equal(response.text, "Recovered");
});

test("openai-compatible client does not retry permanent HTTP failures", async () => {
  let attempts = 0;

  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    return new Response("bad request", { status: 400 });
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
    timeoutSeconds: 1,
  });

  await assert.rejects(
    client.chat({
      model: "test-model",
      system: "Test",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      maxTokens: 64,
    }),
    /400/,
  );

  assert.equal(attempts, 1);
});

test("openai-compatible client retries when the model never starts responding", async () => {
  let attempts = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    attempts += 1;
    const signal = init?.signal as AbortSignal | undefined;

    return await new Promise<Response>((_resolve, reject) => {
      const rejectWithAbort = () => {
        reject(signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
      };

      if (signal?.aborted) {
        rejectWithAbort();
        return;
      }

      signal?.addEventListener("abort", rejectWithAbort, { once: true });
    });
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
    timeoutSeconds: 0.01,
  });

  await assert.rejects(
    client.chat({
      model: "test-model",
      system: "Test",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      maxTokens: 64,
    }),
    /did not start responding within 0.01s/,
  );

  assert.equal(attempts, 3);
});

test("openai-compatible client adds top-level cache_control by default (OpenRouter prompt-cache opt-in)", async () => {
  let capturedBody = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });
  await client.chat({
    model: "test-model",
    system: "Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 64,
  });

  const body = JSON.parse(capturedBody) as { cache_control?: { type: string } };
  assert.deepEqual(
    body.cache_control,
    { type: "ephemeral" },
    "default request should include the top-level cache_control marker so OpenRouter caches the stable prefix",
  );
});

test("openai-compatible client omits cache_control when cacheableSystem is false", async () => {
  let capturedBody = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });
  await client.chat({
    model: "test-model",
    system: "Dynamic Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 64,
    cacheableSystem: false,
  });

  const body = JSON.parse(capturedBody) as { cache_control?: { type: string } };
  assert.equal(
    body.cache_control,
    undefined,
    "cacheableSystem: false should suppress cache_control to avoid pointless cache writes when the system prompt rebuilds",
  );
});

test("openai-compatible client surfaces cached_tokens via prompt_tokens_details", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });
  const response = await client.chat({
    model: "test-model",
    system: "Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 64,
  });

  assert.equal(response.usage.inputTokens, 100);
  assert.equal(response.usage.cachedInputTokens, 80);
});

test("openai-compatible client omits cachedInputTokens when zero or absent", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "hi" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });
  const response = await client.chat({
    model: "test-model",
    system: "Test",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 64,
  });

  assert.equal(
    response.usage.cachedInputTokens,
    undefined,
    "absent cached_tokens should not surface as 0 or noise",
  );
});

test("createModelClient returns openai-compatible client", () => {
  const config = {
    ...createTestAgentConfig("/tmp"),
    modelProvider: "openai-compatible" as const,
    openAiBaseUrl: "http://localhost:1234/v1",
  };

  const client = createModelClient(config);
  assert.ok(client instanceof OpenAICompatibleModelClient);
});

// ─── OpenRouter provider pinning (variance control) ─────────────────────

function captureRequestBody(): {
  fetchImpl: typeof fetch;
  getBody: () => Record<string, unknown>;
} {
  let captured = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    captured = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    fetchImpl,
    getBody: () => JSON.parse(captured) as Record<string, unknown>,
  };
}

async function runChatStub(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<void> {
  const client = new OpenAICompatibleModelClient({
    baseUrl,
    apiKey: "sk-or-v1-test",
    fetchImpl,
  });
  await client.chat({
    model: "google/gemma-4-26b-a4b-it",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 8,
  });
}

test("OPENROUTER_PROVIDER_ORDER injects provider block when targeting OpenRouter", async () => {
  const { fetchImpl, getBody } = captureRequestBody();
  const original = process.env.OPENROUTER_PROVIDER_ORDER;
  process.env.OPENROUTER_PROVIDER_ORDER = "Novita";
  try {
    await runChatStub(fetchImpl, "https://openrouter.ai/api/v1");
    const body = getBody();
    assert.deepEqual(body.provider, {
      order: ["Novita"],
      allow_fallbacks: false,
    });
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_PROVIDER_ORDER;
    else process.env.OPENROUTER_PROVIDER_ORDER = original;
  }
});

test("OPENROUTER_PROVIDER_ORDER accepts comma-separated lists", async () => {
  const { fetchImpl, getBody } = captureRequestBody();
  const original = process.env.OPENROUTER_PROVIDER_ORDER;
  process.env.OPENROUTER_PROVIDER_ORDER = "Novita, DeepInfra ,Fireworks";
  try {
    await runChatStub(fetchImpl, "https://openrouter.ai/api/v1");
    const body = getBody();
    assert.deepEqual(body.provider, {
      order: ["Novita", "DeepInfra", "Fireworks"],
      allow_fallbacks: false,
    });
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_PROVIDER_ORDER;
    else process.env.OPENROUTER_PROVIDER_ORDER = original;
  }
});

test("OPENROUTER_PROVIDER_ALLOW_FALLBACKS=true opts back into fallbacks", async () => {
  const { fetchImpl, getBody } = captureRequestBody();
  const orderOrig = process.env.OPENROUTER_PROVIDER_ORDER;
  const fallOrig = process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS;
  process.env.OPENROUTER_PROVIDER_ORDER = "Novita";
  process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS = "true";
  try {
    await runChatStub(fetchImpl, "https://openrouter.ai/api/v1");
    const body = getBody();
    assert.deepEqual(body.provider, {
      order: ["Novita"],
      allow_fallbacks: true,
    });
  } finally {
    if (orderOrig === undefined) delete process.env.OPENROUTER_PROVIDER_ORDER;
    else process.env.OPENROUTER_PROVIDER_ORDER = orderOrig;
    if (fallOrig === undefined)
      delete process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS;
    else process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS = fallOrig;
  }
});

test("provider block is NOT injected when baseUrl is not OpenRouter", async () => {
  const { fetchImpl, getBody } = captureRequestBody();
  const original = process.env.OPENROUTER_PROVIDER_ORDER;
  process.env.OPENROUTER_PROVIDER_ORDER = "Novita";
  try {
    await runChatStub(fetchImpl, "http://localhost:1234/v1");
    const body = getBody();
    assert.equal(body.provider, undefined);
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_PROVIDER_ORDER;
    else process.env.OPENROUTER_PROVIDER_ORDER = original;
  }
});

test("provider block is NOT injected when env var is unset", async () => {
  const { fetchImpl, getBody } = captureRequestBody();
  const original = process.env.OPENROUTER_PROVIDER_ORDER;
  delete process.env.OPENROUTER_PROVIDER_ORDER;
  try {
    await runChatStub(fetchImpl, "https://openrouter.ai/api/v1");
    const body = getBody();
    assert.equal(body.provider, undefined);
  } finally {
    if (original !== undefined) process.env.OPENROUTER_PROVIDER_ORDER = original;
  }
});
