import process from "node:process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "./agent-bridge.js";
import { createWebSocketServer } from "./websocket.js";
import { handleChatCompletions, handleModels } from "./openai-compat.js";
import { formatConfigForDisplay, getConfigMissing } from "../agent/config.js";
import { applyPersistedConfigUpdates, buildStructuredConfigPayload } from "../agent/editable-config.js";
import { sortModelsAlphabetically } from "../model-utils.js";
import { serializeSymbolMatch } from "../shared/symbol-resolution.js";
import type { ServerMessage } from "./types.js";
import type { WebSocketServer } from "ws";
import { handleMcpRequest } from "./mcp-server.js";
import { buildSessionPreview } from "../session/session-preview.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve web dir: always serve from dist/src/web (built by scripts/build-web.mjs)
// In dev (tsx): __dirname = src/serve → go up to project root, then dist/src/web
// In prod (dist): __dirname = dist/src/serve → sibling dir dist/src/web
const webDir = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../web")
  : path.resolve(__dirname, "../../dist/src/web");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

interface WebSettingsPayload {
  configPath: string;
  entries: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "enum";
    description: string;
    envVar: string;
    values?: readonly string[];
    effectiveValue: string | number | boolean | null;
    persistedValue: string | number | boolean | null;
    envValue: string | null;
    envSource: "process" | "home-dotenv" | null;
    envSourcePath: string | null;
    overriddenByEnv: boolean;
  }>;
}

interface OpenRouterConnectRequestBody {
  code?: string;
  codeVerifier?: string;
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

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const fileName = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.join(webDir, fileName);

  // Prevent path traversal
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

async function buildWebSettingsPayload(
  config: ReturnType<AgentBridge["getConfig"]>,
  minicodeHome?: string,
): Promise<WebSettingsPayload> {
  return buildStructuredConfigPayload(config, minicodeHome);
}

interface RequestHandlerOptions {
  minicodeHome?: string;
}

/** Create the HTTP request handler. Exported for testing. */
export function createRequestHandler(
  bridge: AgentBridge,
  emit?: (msg: ServerMessage) => void,
  options: RequestHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const config = bridge.getConfig();
  const emitFn = emit ?? (() => {});
  const minicodeHome = options.minicodeHome;

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    const handle = async () => {
      // MCP (Model Context Protocol) endpoint
      if (pathname === "/mcp") {
        await handleMcpRequest(req, res, bridge, emitFn);
        return;
      }

      // OpenAI-compatible routes
      if (pathname === "/v1/models" && method === "GET") {
        handleModels(req, res);
        return;
      }
      if (pathname === "/v1/chat/completions" && method === "POST") {
        await handleChatCompletions(req, res, bridge);
        return;
      }

      // Minicode REST API
      if (pathname === "/api/status" && method === "GET") {
        const missing = getConfigMissing(config);
        sendJson(res, 200, {
          status: bridge.isBusy() ? "busy" : "ready",
          workspace: config.workspaceRoot,
          model: config.model,
          provider: config.modelProvider,
          needsSetup: missing.length > 0,
          missing,
        });
        return;
      }

      if (pathname === "/api/models" && method === "GET") {
        const models = sortModelsAlphabetically(await bridge.listModels());
        sendJson(res, 200, { models, activeModel: config.model });
        return;
      }

      if (pathname === "/api/openrouter/connect" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as OpenRouterConnectRequestBody;
        if (!body.code || typeof body.code !== "string") {
          sendJson(res, 400, { error: "code is required" });
          return;
        }
        if (!body.codeVerifier || typeof body.codeVerifier !== "string") {
          sendJson(res, 400, { error: "codeVerifier is required" });
          return;
        }

        let exchangeResponse: Response;
        try {
          exchangeResponse = await fetch("https://openrouter.ai/api/v1/auth/keys", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              code: body.code,
              code_verifier: body.codeVerifier,
              code_challenge_method: "S256",
            }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "OpenRouter OAuth exchange failed";
          sendJson(res, 502, { error: message });
          return;
        }

        if (!exchangeResponse.ok) {
          const message = await exchangeResponse.text();
          sendJson(
            res,
            exchangeResponse.status,
            {
              error: message.trim().length > 0
                ? `OpenRouter OAuth exchange failed: ${message}`
                : `OpenRouter OAuth exchange failed (${exchangeResponse.status})`,
            },
          );
          return;
        }

        const payload = await exchangeResponse.json() as { key?: string };
        if (!payload.key || typeof payload.key !== "string") {
          sendJson(res, 502, { error: "OpenRouter OAuth exchange did not return an API key." });
          return;
        }

        try {
          bridge.connectOpenRouter(payload.key);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to configure OpenRouter";
          sendJson(res, message === "busy" ? 409 : 400, { error: message });
          return;
        }

        const missing = getConfigMissing(config);
        const onlyModelMissing = missing.length === 1 && missing[0] === "MODEL is not set";
        sendJson(res, 200, {
          ok: true,
          sessionOnly: true,
          provider: config.modelProvider,
          model: config.model,
          needsSetup: missing.length > 0,
          missing,
          message: onlyModelMissing
            ? "OpenRouter connected for this serve session. Select a model to continue."
            : "OpenRouter connected for this serve session.",
        });
        return;
      }

      if (pathname === "/api/model" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { model?: string };
        if (!body.model || typeof body.model !== "string") {
          sendJson(res, 400, { error: "model is required" });
          return;
        }
        bridge.switchModel(body.model);
        sendJson(res, 200, { model: body.model });
        return;
      }

      if (pathname === "/api/context" && method === "GET") {
        if (!bridge.isReady()) {
          sendJson(res, 200, { contextTokens: 0, maxContextTokens: 0 });
          return;
        }
        const status = bridge.getAgent().getContextStatus();
        sendJson(res, 200, status);
        return;
      }

      if (pathname === "/api/config" && method === "GET") {
        const structured = await buildWebSettingsPayload(config, minicodeHome);
        sendJson(res, 200, {
          config: formatConfigForDisplay(config),
          settings: structured,
          restartRequired: true,
          secretsUiSupported: false,
        });
        return;
      }

      if (pathname === "/api/config" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          updates?: Record<string, string | number | boolean | null>;
        };
        if (!body.updates || typeof body.updates !== "object") {
          sendJson(res, 400, { error: "updates object is required" });
          return;
        }

        try {
          const result = await applyPersistedConfigUpdates({
            updates: body.updates,
            ...(minicodeHome ? { minicodeHome } : {}),
          });
          const structured = await buildWebSettingsPayload(config, minicodeHome);
          sendJson(res, 200, {
            ok: true,
            scope: "global",
            path: result.path,
            saved: result.saved,
            restartRequired: true,
            message: "Persisted config updated. Restart minicode to apply changes to new sessions.",
            settings: structured,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to update config";
          sendJson(res, 400, { error: message });
        }
        return;
      }

      if (pathname === "/api/sessions" && method === "GET") {
        const sessions = await bridge.listSess();
        sendJson(res, 200, {
          sessions,
          currentSessionId: bridge.getCurrentSessionId(),
        });
        return;
      }

      if (pathname === "/api/sessions/save" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { label?: string };
        const meta = await bridge.saveSess(body.label);
        sendJson(res, 200, meta);
        return;
      }

      if (pathname === "/api/sessions/load" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { label: string };
        const result = await bridge.loadSess(body.label);
        if (!result) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }
        sendJson(res, 200, {
          label: result.label,
          messages: buildSessionPreview(result.session.getMessages()),
        });
        return;
      }

      // ── Graph / Index API ──

      if (pathname === "/api/symbols" && method === "GET") {
        if (!bridge.hasIndex()) {
          sendJson(res, 404, { error: "No project index available" });
          return;
        }
        sendJson(res, 200, { symbols: bridge.getSymbols() });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/dependencies") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/dependencies".length));
        const depthParam = url.searchParams.get("depth");
        const depth = depthParam ? Number(depthParam) : undefined;
        const matches = bridge.getSymbolMatches(name);
        if (matches.length === 0) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        if (matches.length > 1) {
          sendJson(res, 409, {
            error: `Symbol "${name}" is ambiguous`,
            candidates: matches.map(serializeSymbolMatch),
          });
          return;
        }
        const result = bridge.getDependencies(matches[0]!.qualifiedName, depth);
        if (!result) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        sendJson(res, 200, { symbol: name, dependencies: result });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/references") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/references".length));
        const matches = bridge.getSymbolMatches(name);
        if (matches.length === 0) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        if (matches.length > 1) {
          sendJson(res, 409, {
            error: `Symbol "${name}" is ambiguous`,
            candidates: matches.map(serializeSymbolMatch),
          });
          return;
        }
        const result = bridge.getReferences(matches[0]!.qualifiedName);
        if (!result) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        sendJson(res, 200, { symbol: name, references: result });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/source") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/source".length));
        const matches = bridge.getSymbolMatches(name);
        if (matches.length === 0) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        if (matches.length > 1) {
          sendJson(res, 409, {
            error: `Symbol "${name}" is ambiguous`,
            candidates: matches.map(serializeSymbolMatch),
          });
          return;
        }
        const sym = matches[0]!;
        try {
          const fileContent = await readFile(path.resolve(config.workspaceRoot, sym.filePath), "utf8");
          const lines = fileContent.split(/\r?\n/);
          const start = Math.max(0, sym.startLine - 1);
          const end = Math.min(lines.length, sym.endLine);
          const source = lines.slice(start, end).join("\n");
          sendJson(res, 200, { symbol: name, filePath: sym.filePath, startLine: sym.startLine, endLine: sym.endLine, source });
        } catch {
          sendJson(res, 500, { error: `Could not read file: ${sym.filePath}` });
        }
        return;
      }

      if (pathname === "/api/code-map" && method === "GET") {
        const budgetParam = url.searchParams.get("budget");
        const budget = budgetParam ? Number(budgetParam) : undefined;
        const result = bridge.getCodeMap(budget);
        if (!result) {
          sendJson(res, 404, { error: "No project index available" });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/api/graph" && method === "GET") {
        const result = bridge.getGraph();
        if (!result) {
          sendJson(res, 404, { error: "No project index available" });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/api/analysis" && method === "GET") {
        const result = bridge.getStructuralAnalysis();
        if (!result) {
          sendJson(res, 404, { error: "No project index available" });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/api/analysis/explain" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { findingId?: string };
        if (!body.findingId || typeof body.findingId !== "string") {
          sendJson(res, 400, { error: "findingId is required" });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const abortController = new AbortController();
        req.on("close", () => abortController.abort());

        try {
          await bridge.explainStructuralFinding(
            body.findingId,
            (event) => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            },
            abortController.signal,
          );
        } catch (error) {
          if (!res.writableEnded) {
            const msg = error instanceof Error ? error.message : "Unknown error";
            res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
          }
        }

        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return;
      }

      if (pathname === "/api/focus" && method === "GET") {
        sendJson(res, 200, { pinned: bridge.getPinnedSymbols() });
        return;
      }

      if (pathname === "/api/focus" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { action: string; symbol: string };
        if (!body.symbol || !body.action) {
          sendJson(res, 400, { error: "action and symbol are required" });
          return;
        }
        if (body.action === "pin") {
          const ok = bridge.pinSymbol(body.symbol);
          if (!ok) {
            sendJson(res, 404, { error: `Symbol "${body.symbol}" not found` });
            return;
          }
          sendJson(res, 200, { pinned: bridge.getPinnedSymbols() });
          return;
        }
        if (body.action === "unpin") {
          bridge.unpinSymbol(body.symbol);
          sendJson(res, 200, { pinned: bridge.getPinnedSymbols() });
          return;
        }
        sendJson(res, 400, { error: `Unknown action "${body.action}". Use "pin" or "unpin".` });
        return;
      }

      // ── Annotations API ──

      if (pathname === "/api/annotations" && method === "GET") {
        sendJson(res, 200, { annotations: bridge.getAnnotations() });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/annotations") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/annotations".length));
        const notes = bridge.getAnnotationsForSymbol(name);
        sendJson(res, 200, { symbol: name, annotations: notes });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/annotations") && method === "POST") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/annotations".length));
        const body = JSON.parse(await readBody(req)) as { text?: string };
        if (!body.text) {
          sendJson(res, 400, { error: "text is required" });
          return;
        }
        const ok = bridge.addAnnotation(name, body.text);
        if (!ok) {
          sendJson(res, 404, { error: `Symbol "${name}" not found or text empty` });
          return;
        }
        sendJson(res, 200, { symbol: name, annotations: bridge.getAnnotationsForSymbol(name) });
        return;
      }

      // DELETE /api/symbols/:name/annotations/:index
      {
        const annoDeleteMatch = pathname.match(/^\/api\/symbols\/(.+)\/annotations\/(\d+)$/);
        if (annoDeleteMatch && method === "DELETE") {
          const name = decodeURIComponent(annoDeleteMatch[1]!);
          const index = Number(annoDeleteMatch[2]);
          const ok = bridge.removeAnnotation(name, index);
          if (!ok) {
            sendJson(res, 404, { error: "Annotation not found" });
            return;
          }
          sendJson(res, 200, { symbol: name, annotations: bridge.getAnnotationsForSymbol(name) });
          return;
        }
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/annotations") && method === "DELETE") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/annotations".length));
        bridge.clearAnnotations(name);
        sendJson(res, 200, { symbol: name, annotations: [] });
        return;
      }

      // ── Explain SSE ──

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/explain") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/explain".length));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const abortController = new AbortController();
        req.on("close", () => abortController.abort());

        try {
          await bridge.explainSymbol(
            name,
            (event) => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            },
            abortController.signal,
          );
        } catch (error) {
          if (!res.writableEnded) {
            const msg = error instanceof Error ? error.message : "Unknown error";
            res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
          }
        }

        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return;
      }

      if (pathname === "/api/chat" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { message: string };
        if (!body.message) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        if (bridge.isBusy()) {
          sendJson(res, 429, { error: "Agent is busy" });
          return;
        }
        try {
          const result = await bridge.runTurn(body.message);
          sendJson(res, 200, { text: result.text, usage: result.usage });
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          sendJson(res, 500, { error: msg });
        }
        return;
      }

      // Static files
      await serveStatic(res, pathname);
    };

    handle().catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : "Unknown error";
      sendJson(res, 500, { error: msg });
    });
  };
}

/** Force-shutdown timeout in ms. If graceful close hasn't finished, exit anyway. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Forcefully shut down the serve process. Terminates all WebSocket clients,
 * destroys open HTTP sockets, and stops the server. Exported for testing.
 */
export function shutdownServe(
  server: Server,
  wss: WebSocketServer,
  openSockets: Set<Socket>,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  console.log("\nShutting down...");

  // 1. Terminate every connected WebSocket client immediately.
  //    wss.close() only stops accepting *new* connections — existing clients
  //    stay open, which keeps the HTTP server alive (the root cause of #39).
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();

  // 2. Destroy all open TCP sockets so server.close() can finish.
  for (const socket of openSockets) {
    socket.destroy();
  }
  openSockets.clear();

  // 3. Stop accepting new connections and exit once drained.
  server.close(() => {
    exit(0);
  });

  // 4. Safety net: if something still holds the event loop, force-exit.
  setTimeout(() => {
    console.error("Shutdown timed out — forcing exit.");
    exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

export async function runServe(verbose: boolean, port: number): Promise<void> {
  console.log("Initializing agent...");

  // Set up broadcast plumbing
  let broadcastFn: (msg: ServerMessage) => void = () => {};
  const bridge = new AgentBridge((msg) => broadcastFn(msg), verbose);
  await bridge.init();

  const config = bridge.getConfig();

  const handler = createRequestHandler(bridge, (msg) => broadcastFn(msg));
  const server = createServer(handler);

  // WebSocket server — captures the real broadcast function
  const wss = createWebSocketServer(server, bridge);

  // Wire up the broadcast: WS clients receive all agent events
  const { WebSocket } = await import("ws");
  broadcastFn = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

  // Track open sockets so we can destroy them on shutdown
  const openSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  // Start file watcher for automatic reindexing
  bridge.startFileWatcher();

  // Graceful shutdown
  process.on("SIGINT", () => {
    bridge.stopFileWatcher();
    shutdownServe(server, wss, openSockets);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`\nminicode serve`);
    console.log(`  Workspace: ${config.workspaceRoot}`);
    console.log(`  Model:     ${config.model} (${config.modelProvider})`);
    console.log(`  Web UI:    http://localhost:${port}`);
    console.log(`  OpenAI:    http://localhost:${port}/v1`);
    console.log(`  MCP:       http://localhost:${port}/mcp`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  });

  // Keep alive
  await new Promise(() => {});
}
