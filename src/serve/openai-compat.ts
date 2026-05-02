import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentBridge, UiListener } from "./agent-bridge.js";
import type { ServerMessage } from "./types.js";

interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    object: "list",
    data: [
      {
        id: "minicode-agent",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "minicode",
      },
    ],
  });
}

export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: AgentBridge,
): Promise<void> {
  let body: ChatCompletionRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as ChatCompletionRequest;
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
    return;
  }

  const messages = body.messages;
  if (!messages || messages.length === 0) {
    sendJson(res, 400, { error: { message: "messages array is required", type: "invalid_request_error" } });
    return;
  }

  // Extract last user message
  let userMessage: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      userMessage = messages[i]!.content;
      break;
    }
  }

  if (!userMessage) {
    sendJson(res, 400, { error: { message: "No user message found", type: "invalid_request_error" } });
    return;
  }

  if (bridge.isBusy()) {
    sendJson(res, 429, { error: { message: "Agent is busy with another request. Try again later.", type: "rate_limit_error" } });
    return;
  }

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    await handleStreaming(res, bridge, userMessage, completionId, created);
  } else {
    await handleNonStreaming(res, bridge, userMessage, completionId, created);
  }
}

async function handleNonStreaming(
  res: ServerResponse,
  bridge: AgentBridge,
  message: string,
  completionId: string,
  created: number,
): Promise<void> {
  try {
    const result = await bridge.runApiTurn(message);
    sendJson(res, 200, {
      id: completionId,
      object: "chat.completion",
      created,
      model: "minicode-agent",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        },
      ],
      usage: result.usage
        ? {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.inputTokens + result.usage.outputTokens,
          }
        : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: { message: msg, type: "server_error" } });
  }
}

async function handleStreaming(
  res: ServerResponse,
  bridge: AgentBridge,
  message: string,
  completionId: string,
  created: number,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function sendSSE(data: unknown): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Send initial role chunk
  sendSSE({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: "minicode-agent",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  const listener: UiListener = (msg: ServerMessage) => {
    if (msg.type === "streaming_chunk" && msg.content) {
      sendSSE({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: "minicode-agent",
        choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }],
      });
    }
  };

  bridge.addListener(listener);

  try {
    await bridge.runApiTurn(message);

    sendSSE({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: "minicode-agent",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });

    res.write("data: [DONE]\n\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    sendSSE({ error: { message: msg, type: "server_error" } });
  } finally {
    bridge.removeListener(listener);
    res.end();
  }
}
