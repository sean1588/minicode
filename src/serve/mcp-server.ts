/**
 * MCP (Model Context Protocol) server for minicode.
 *
 * Exposes minicode's symbol-aware tools and code map as an MCP server,
 * allowing external agents (e.g. Claude Code) to use minicode's code
 * intelligence while the web UI visualizes tool activity in real time.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import {
  formatAmbiguousSymbolMatches,
  resolveSymbolInput,
} from "../shared/symbol-resolution.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { ServerMessage } from "./types.js";

/** Active transports keyed by session ID. */
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Create and configure an McpServer with minicode's tools and resources.
 */
function createMcpServer(bridge: AgentBridge, emit: (msg: ServerMessage) => void): McpServer {
  const server = new McpServer(
    { name: "minicode", version: "0.2.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // ── Helper: wrap tool execution with WebSocket event broadcast ──

  function wrapToolCall<T>(
    toolName: string,
    input: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    emit({ type: "tool_call_start", name: toolName, input });

    return fn().then(
      (result) => {
        emit({
          type: "tool_call_end",
          name: toolName,
          input,
          result: typeof result === "string" ? result : JSON.stringify(result),
          elapsedMs: Date.now() - start,
        });
        return result;
      },
      (error) => {
        emit({
          type: "tool_call_end",
          name: toolName,
          input,
          result: `Error: ${error instanceof Error ? error.message : String(error)}`,
          elapsedMs: Date.now() - start,
        });
        throw error;
      },
    );
  }

  // ── Tools ──

  server.tool(
    "read_symbol",
    "Read a specific function, class, interface, or type by name from the AST index. Returns source code, signature, dependencies, references, and annotations in one call — much more targeted than reading an entire file. PREFERRED over read_file for .ts/.tsx/.js/.jsx when you know the symbol name.",
    { name: z.string().describe("The symbol name or qualified name (e.g. 'Session' or 'Session.trim')") },
    async ({ name }) => {
      return wrapToolCall("read_symbol", { name }, async () => {
        const resolution = resolveSymbolInput(bridge, name);
        if (resolution.status === "missing") {
          return { content: [{ type: "text" as const, text: `Symbol "${name}" not found in the project index.` }], isError: true };
        }
        if (resolution.status === "ambiguous") {
          return {
            content: [{ type: "text" as const, text: formatAmbiguousSymbolMatches("read_symbol", name, resolution.matches) }],
            isError: true,
          };
        }
        const sym = resolution.symbol;

        const deps = bridge.getDependencies(sym.qualifiedName, 1);
        const refs = bridge.getReferences(sym.qualifiedName);

        const lines: string[] = [
          `## ${sym.kind}: ${getSymbolDisplayName(sym)}`,
          `File: ${sym.filePath}:${sym.startLine}`,
          `Signature: ${sym.signature}`,
          "",
        ];

        if (sym.docComment) {
          lines.push(sym.docComment, "");
        }

        // Read source from file
        const { readFileSync } = await import("node:fs");
        try {
          const fullPath = (await import("node:path")).resolve(bridge.getConfig().workspaceRoot, sym.filePath);
          const fileContent = readFileSync(fullPath, "utf-8");
          const fileLines = fileContent.split("\n");
          const source = fileLines.slice(sym.startLine - 1, sym.endLine).join("\n");
          lines.push("```", source, "```", "");
        } catch {
          lines.push("(source unavailable)", "");
        }

        if (deps && deps.length > 0) {
          lines.push("Dependencies:", ...deps.map((d) => `  - ${d.name} (${d.kind})`), "");
        }

        if (refs && refs.length > 0) {
          lines.push("Referenced by:", ...refs.map((r) => `  - ${r.name ?? r.from} (${r.kind})`), "");
        }

        // Append annotations if present
        const annotations = bridge.getAnnotationsForSymbol(sym.qualifiedName);
        if (annotations.length > 0) {
          lines.push(`[User annotation: ${annotations.join("; ")}]`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  );

  server.tool(
    "find_references",
    "Find all symbols that call, import, or reference a given symbol. Essential for understanding impact before making changes.",
    { name: z.string().describe("The symbol name or qualified name to find references for") },
    async ({ name }) => {
      return wrapToolCall("find_references", { name }, async () => {
        const resolution = resolveSymbolInput(bridge, name);
        if (resolution.status === "missing") {
          return { content: [{ type: "text" as const, text: `Symbol "${name}" not found.` }], isError: true };
        }
        if (resolution.status === "ambiguous") {
          return {
            content: [{ type: "text" as const, text: formatAmbiguousSymbolMatches("find_references", name, resolution.matches) }],
            isError: true,
          };
        }

        const symbol = resolution.symbol;
        const refs = bridge.getReferences(symbol.qualifiedName);
        if (!refs || refs.length === 0) {
          return { content: [{ type: "text" as const, text: `No references found for "${name}".` }] };
        }

        const lines = [
          `References to ${getSymbolDisplayName(symbol)}:`,
          ...refs.map((r) => `  - ${r.name ?? r.from} (${r.kind})`),
        ];

        const annotations = bridge.getAnnotationsForSymbol(symbol.qualifiedName);
        if (annotations.length > 0) {
          lines.push("", `[User annotation: ${annotations.join("; ")}]`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  );

  server.tool(
    "get_dependencies",
    "Get the dependency cone of a symbol — everything it calls, imports, extends, or references. Essential for understanding implementation and data flow.",
    {
      name: z.string().describe("The symbol name or qualified name to get dependencies for"),
      depth: z.number().optional().default(2).describe("How many levels deep to traverse (default: 2)"),
    },
    async ({ name, depth }) => {
      return wrapToolCall("get_dependencies", { name, depth }, async () => {
        const resolution = resolveSymbolInput(bridge, name);
        if (resolution.status === "missing") {
          return { content: [{ type: "text" as const, text: `Symbol "${name}" not found.` }], isError: true };
        }
        if (resolution.status === "ambiguous") {
          return {
            content: [{ type: "text" as const, text: formatAmbiguousSymbolMatches("get_dependencies", name, resolution.matches) }],
            isError: true,
          };
        }

        const symbol = resolution.symbol;
        const deps = bridge.getDependencies(symbol.qualifiedName, depth);
        if (!deps || deps.length === 0) {
          return { content: [{ type: "text" as const, text: `No dependencies found for "${name}".` }] };
        }

        const lines = [
          `Dependencies of ${getSymbolDisplayName(symbol)} (depth=${depth}):`,
          ...deps.map((d) => `  - ${d.qualifiedName} (${d.kind}) — ${d.filePath}`),
        ];

        const annotations = bridge.getAnnotationsForSymbol(symbol.qualifiedName);
        if (annotations.length > 0) {
          lines.push("", `[User annotation: ${annotations.join("; ")}]`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  );

  server.tool(
    "search_code_map",
    "Search the project's AST-indexed symbols by name or substring. Returns matching function, class, interface, and type definitions with their file locations and signatures. PREFERRED over generic file search when looking for code symbols.",
    {
      query: z.string().describe("Search query — matches against symbol names"),
      kind: z.string().optional().describe("Filter by kind: function, class, interface, type, variable, method"),
    },
    async ({ query, kind }) => {
      return wrapToolCall("search_code_map", { query, kind }, async () => {
        const symbols = bridge.getSymbols();
        const queryLower = query.toLowerCase();

        let matches = symbols.filter((s) => {
          const nameMatch = s.name.toLowerCase().includes(queryLower) ||
            s.qualifiedName.toLowerCase().includes(queryLower);
          return nameMatch;
        });

        if (kind) {
          matches = matches.filter((s) => s.kind === kind);
        }

        matches = matches.slice(0, 30);

        if (matches.length === 0) {
          return { content: [{ type: "text" as const, text: `No symbols matching "${query}"${kind ? ` (kind: ${kind})` : ""}.` }] };
        }

        const lines = [
          `Found ${matches.length} symbol(s) matching "${query}":`,
          ...matches.map((s) =>
            `  - ${s.name} (${s.kind}) — ${s.filePath}:${s.startLine} — qualified: ${s.qualifiedName}${s.signature ? `\n    ${s.signature}` : ""}`,
          ),
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  );

  server.tool(
    "find_path",
    "Find the shortest dependency path between two symbols, or trace a symbol back to an entry point. Useful for understanding how code connects.",
    {
      from: z.string().describe("Source symbol name or qualified name"),
      to: z.string().optional().describe("Target symbol name or qualified name. If omitted, traces back to the nearest entry point."),
    },
    async ({ from, to }) => {
      return wrapToolCall("find_path", { from, to }, async () => {
        if (!bridge.hasIndex()) {
          return { content: [{ type: "text" as const, text: "No project index available." }], isError: true };
        }

        const fromResolution = resolveSymbolInput(bridge, from);
        if (fromResolution.status === "missing") {
          return { content: [{ type: "text" as const, text: `Symbol "${from}" not found.` }], isError: true };
        }
        if (fromResolution.status === "ambiguous") {
          return {
            content: [{ type: "text" as const, text: formatAmbiguousSymbolMatches("find_path", from, fromResolution.matches) }],
            isError: true,
          };
        }
        const fromSym = fromResolution.symbol;

        if (to) {
          const toResolution = resolveSymbolInput(bridge, to);
          if (toResolution.status === "missing") {
            return { content: [{ type: "text" as const, text: `Symbol "${to}" not found.` }], isError: true };
          }
          if (toResolution.status === "ambiguous") {
            return {
              content: [{ type: "text" as const, text: formatAmbiguousSymbolMatches("find_path", to, toResolution.matches) }],
              isError: true,
            };
          }
        }

        // Delegate to the find_path tool via the tool registry
        // We need the actual ProjectIndex for this, so access it through the bridge's getGraph
        const graph = bridge.getGraph();
        if (!graph) {
          return { content: [{ type: "text" as const, text: "No project graph available." }], isError: true };
        }

        // Build adjacency for BFS
        const adj = new Map<string, string[]>();
        for (const edge of graph.edges) {
          let list = adj.get(edge.from);
          if (!list) { list = []; adj.set(edge.from, list); }
          list.push(edge.to);
          // Reverse direction too for path finding
          let rList = adj.get(edge.to);
          if (!rList) { rList = []; adj.set(edge.to, rList); }
          rList.push(edge.from);
        }

        const startId = fromSym.qualifiedName;

        if (to) {
          const toResolution = resolveSymbolInput(bridge, to);
          if (toResolution.status !== "resolved") {
            return { content: [{ type: "text" as const, text: `Symbol "${to}" could not be resolved.` }], isError: true };
          }
          const toSym = toResolution.symbol;
          const endId = toSym.qualifiedName;
          // BFS shortest path
          const visited = new Set<string>([startId]);
          const parent = new Map<string, string>();
          const queue = [startId];

          while (queue.length > 0) {
            const current = queue.shift()!;
            if (current === endId) break;
            for (const neighbor of adj.get(current) || []) {
              if (!visited.has(neighbor)) {
                visited.add(neighbor);
                parent.set(neighbor, current);
                queue.push(neighbor);
              }
            }
          }

          if (!parent.has(endId) && startId !== endId) {
            return { content: [{ type: "text" as const, text: `No path found between "${from}" and "${to}".` }] };
          }

          const path: string[] = [];
          let node = endId;
          while (node !== startId) {
            path.unshift(node);
            node = parent.get(node)!;
          }
          path.unshift(startId);

          return { content: [{ type: "text" as const, text: `Path from "${from}" to "${to}" (${path.length} steps):\n${path.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}` }] };
        } else {
          // Trace to entry point (exported symbols with no incoming edges)
          const hasIncoming = new Set<string>();
          for (const edge of graph.edges) {
            hasIncoming.add(edge.to);
          }
          const entryPoints = new Set(
            graph.nodes.filter((n) => n.exported && !hasIncoming.has(n.id)).map((n) => n.id),
          );

          // BFS from start, looking for any entry point
          const visited = new Set<string>([startId]);
          const parent = new Map<string, string>();
          const queue = [startId];
          let foundEntry: string | null = null;

          while (queue.length > 0) {
            const current = queue.shift()!;
            if (entryPoints.has(current) && current !== startId) {
              foundEntry = current;
              break;
            }
            for (const neighbor of adj.get(current) || []) {
              if (!visited.has(neighbor)) {
                visited.add(neighbor);
                parent.set(neighbor, current);
                queue.push(neighbor);
              }
            }
          }

          if (!foundEntry) {
            return { content: [{ type: "text" as const, text: `No entry point reachable from "${from}".` }] };
          }

          const path: string[] = [];
          let node: string = foundEntry;
          while (node !== startId) {
            path.unshift(node);
            node = parent.get(node)!;
          }
          path.unshift(startId);

          return { content: [{ type: "text" as const, text: `Path from "${from}" to entry point "${foundEntry}" (${path.length} steps):\n${path.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}` }] };
        }
      });
    },
  );

  // ── Annotation tools ──

  server.tool(
    "add_annotation",
    "Attach a note to a symbol in the project index. Annotations are injected into tool results when interacting with annotated code, and appear in the web UI graph. Use this to leave instructions or context for future interactions.",
    {
      symbol: z.string().describe("The symbol name to annotate"),
      text: z.string().max(500).describe("The annotation text (max 500 chars)"),
    },
    async ({ symbol, text }) => {
      return wrapToolCall("add_annotation", { symbol, text }, async () => {
        const success = bridge.addAnnotation(symbol, text);
        if (!success) {
          return { content: [{ type: "text" as const, text: `Could not annotate "${symbol}" — symbol not found in the project index.` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Annotation added to "${symbol}": ${text}` }] };
      });
    },
  );

  server.tool(
    "list_annotations",
    "List all annotations attached to symbols. Annotations are user-provided notes that guide how code should be handled.",
    {
      symbol: z.string().optional().describe("If provided, list annotations for this symbol only. Otherwise list all."),
    },
    async ({ symbol }) => {
      return wrapToolCall("list_annotations", { symbol }, async () => {
        if (symbol) {
          const notes = bridge.getAnnotationsForSymbol(symbol);
          if (notes.length === 0) {
            return { content: [{ type: "text" as const, text: `No annotations for "${symbol}".` }] };
          }
          return { content: [{ type: "text" as const, text: `Annotations for "${symbol}":\n${notes.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}` }] };
        }

        const all = bridge.getAnnotations();
        const entries = Object.entries(all);
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: "No annotations in this session." }] };
        }

        const lines = entries.flatMap(([name, notes]) => [
          `${name}:`,
          ...notes.map((n, i) => `  ${i + 1}. ${n}`),
        ]);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      });
    },
  );

  // ── Resources ──

  server.resource(
    "code-map",
    "minicode://code-map",
    { description: "Compact project skeleton showing all indexed symbols with their signatures, ranked by importance. Provides a high-level overview of the codebase structure." },
    async () => {
      const codeMap = bridge.getCodeMap();
      if (!codeMap) {
        return { contents: [{ uri: "minicode://code-map", text: "No project index available.", mimeType: "text/plain" }] };
      }
      return { contents: [{ uri: "minicode://code-map", text: codeMap.text, mimeType: "text/plain" }] };
    },
  );

  server.resource(
    "structural-analysis",
    "minicode://structural-analysis",
    { description: "Structural analysis of the project: dependency cycles, fan-in/fan-out hotspots, and file coupling findings." },
    async () => {
      const analysis = bridge.getStructuralAnalysis();
      if (!analysis) {
        return { contents: [{ uri: "minicode://structural-analysis", text: "No project index available.", mimeType: "text/plain" }] };
      }

      const lines: string[] = [
        `# Structural Analysis`,
        `Symbols: ${analysis.summary.symbolCount} | Files: ${analysis.summary.fileCount} | Findings: ${analysis.summary.findingCount}`,
        "",
      ];

      for (const finding of analysis.findings) {
        lines.push(
          `## [${finding.severity.toUpperCase()}] ${finding.title}`,
          finding.summary,
          `Type: ${finding.type} | Symbols: ${finding.symbols.join(", ")}`,
          ...finding.rationale.map((r) => `  - ${r}`),
          "",
        );
      }

      return { contents: [{ uri: "minicode://structural-analysis", text: lines.join("\n"), mimeType: "text/plain" }] };
    },
  );

  return server;
}

/**
 * Handle an incoming HTTP request on the /mcp path.
 * Manages stateful sessions via session ID headers.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: AgentBridge,
  emit: (msg: ServerMessage) => void,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    // Read request body
    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => resolve(data));
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON in request body" }, id: null }));
      return;
    }

    // Check if this is an initialization request (method: "initialize")
    const parsedObj = parsed as Record<string, unknown> | Array<Record<string, unknown>>;
    const isInit = Array.isArray(parsedObj)
      ? parsedObj.some((m) => m.method === "initialize")
      : parsedObj.method === "initialize";

    if (isInit) {
      // Create new transport and server for this session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = createMcpServer(bridge, emit);
      await server.connect(transport as any);

      // Store transport by session ID once we know it
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      await transport.handleRequest(req, res, parsed);

      // After handling, the transport has a session ID
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    // Existing session
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, parsed);
    return;
  }

  if (req.method === "GET") {
    // SSE stream for server-initiated messages
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      return;
    }

    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === "DELETE") {
    // Session termination
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}
