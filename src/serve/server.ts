import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBridge } from "./agent-bridge.js";
import { createWebSocketServer } from "./websocket.js";
import { handleChatCompletions, handleModels } from "./openai-compat.js";
import { formatConfigForDisplay } from "../agent/config.js";
import type { ServerMessage } from "./types.js";

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

/** Create the HTTP request handler. Exported for testing. */
export function createRequestHandler(bridge: AgentBridge): (req: IncomingMessage, res: ServerResponse) => void {
  const config = bridge.getConfig();

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    const handle = async () => {
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
        sendJson(res, 200, {
          status: bridge.isBusy() ? "busy" : "ready",
          workspace: config.workspaceRoot,
          model: config.model,
          provider: config.modelProvider,
        });
        return;
      }

      if (pathname === "/api/config" && method === "GET") {
        sendJson(res, 200, { config: formatConfigForDisplay(config) });
        return;
      }

      if (pathname === "/api/sessions" && method === "GET") {
        const sessions = await bridge.listSess();
        sendJson(res, 200, { sessions });
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
        sendJson(res, 200, { label: result.label });
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
        const result = bridge.getDependencies(name, depth);
        if (!result) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        sendJson(res, 200, { symbol: name, dependencies: result });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/references") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/references".length));
        const result = bridge.getReferences(name);
        if (!result) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
        sendJson(res, 200, { symbol: name, references: result });
        return;
      }

      if (pathname.startsWith("/api/symbols/") && pathname.endsWith("/source") && method === "GET") {
        const name = decodeURIComponent(pathname.slice("/api/symbols/".length, -"/source".length));
        const sym = bridge.getSymbol(name);
        if (!sym) {
          sendJson(res, 404, { error: `Symbol "${name}" not found` });
          return;
        }
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

export async function runServe(verbose: boolean, port: number): Promise<void> {
  console.log("Initializing agent...");

  // Set up broadcast plumbing
  let broadcastFn: (msg: ServerMessage) => void = () => {};
  const bridge = new AgentBridge((msg) => broadcastFn(msg), verbose);
  await bridge.init();

  const config = bridge.getConfig();

  const handler = createRequestHandler(bridge);
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

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    wss.close();
    server.close(() => {
      process.exit(0);
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`\nminicode serve`);
    console.log(`  Workspace: ${config.workspaceRoot}`);
    console.log(`  Model:     ${config.model} (${config.modelProvider})`);
    console.log(`  Web UI:    http://localhost:${port}`);
    console.log(`  OpenAI:    http://localhost:${port}/v1`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  });

  // Keep alive
  await new Promise(() => {});
}
