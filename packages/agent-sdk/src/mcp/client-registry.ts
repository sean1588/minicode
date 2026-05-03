/**
 * MCP (Model Context Protocol) client integration for the Agent SDK.
 *
 * Connects to one or more external MCP servers, lists their tools, and
 * wraps each as a `ToolDefinition` ready to drop into a `ToolRegistry`.
 * Consumers get the entire MCP ecosystem (filesystem, github, sqlite,
 * puppeteer, ...) without hand-wrapping every tool.
 *
 * Symmetric to `src/serve/mcp-server.ts` (which exposes minicode's
 * tools as an MCP *server*); this is the *client* side.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ToolDefinition } from "../agent/types.js";

type AnyTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

/**
 * Configuration for a single MCP server. Three transports are
 * supported: spawn a subprocess (`stdio`, the most common shape),
 * connect to a hosted Streamable-HTTP endpoint (`http`), or connect
 * to a legacy SSE endpoint (`sse`).
 */
export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      name: string;
      transport: "sse";
      url: string;
      headers?: Record<string, string>;
    };

export interface CreateMcpToolsOptions {
  servers: McpServerConfig[];
  /**
   * Prefix tool names with `<server>__` to avoid collisions across
   * servers that happen to expose the same tool name (e.g. multiple
   * servers exposing `read_file`). Default: true.
   */
  namespace?: boolean;
  /**
   * Called when a server fails to connect or list its tools. The
   * agent continues with the rest of the servers — a flaky GitHub
   * MCP shouldn't break filesystem MCP. Default: `console.warn`.
   */
  onError?: (server: string, error: unknown) => void;
}

export interface McpToolBundle {
  /** Tools ready to drop into a `ToolRegistry`. */
  tools: ToolDefinition[];
  /** Disconnect every connected client. Call on agent shutdown. */
  close: () => Promise<void>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  /**
   * Tools as the server reports them, keyed by their original (un-namespaced)
   * name so we can dispatch `callTool` with the unprefixed name.
   */
  tools: Array<{
    name: string;
    description?: string | undefined;
    inputSchema: Record<string, unknown>;
  }>;
}

function createTransport(config: McpServerConfig): AnyTransport {
  switch (config.transport) {
    case "stdio": {
      const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
        command: config.command,
        args: config.args ?? [],
      };
      if (config.env) params.env = config.env;
      if (config.cwd) params.cwd = config.cwd;
      return new StdioClientTransport(params);
    }
    case "http": {
      const opts = config.headers
        ? { requestInit: { headers: config.headers } }
        : undefined;
      return new StreamableHTTPClientTransport(new URL(config.url), opts);
    }
    case "sse": {
      const opts = config.headers
        ? { requestInit: { headers: config.headers } }
        : undefined;
      return new SSEClientTransport(new URL(config.url), opts);
    }
  }
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
  uri?: string;
  name?: string;
}

/**
 * Render an MCP tool result into a string the model can read.
 * Concatenates text blocks; non-text blocks become bracketed
 * placeholders so the model knows something was returned without
 * us having to support binary content end-to-end (out of scope for
 * v1 — see #168).
 */
export function formatMcpResult(
  content: ReadonlyArray<McpContentBlock>,
): string {
  if (content.length === 0) {
    return "(empty result)";
  }

  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          parts.push(block.text);
        }
        break;
      case "image":
        parts.push(
          `[image content omitted (${block.mimeType ?? "unknown type"})]`,
        );
        break;
      case "audio":
        parts.push(
          `[audio content omitted (${block.mimeType ?? "unknown type"})]`,
        );
        break;
      case "resource": {
        const r = block.resource;
        if (r && typeof r.text === "string") {
          parts.push(r.text);
        } else if (r) {
          parts.push(
            `[resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ""}]`,
          );
        } else {
          parts.push("[resource]");
        }
        break;
      }
      case "resource_link": {
        const label = block.name ?? block.uri ?? "unknown";
        parts.push(`[resource_link ${label}]`);
        break;
      }
      default:
        parts.push(`[unsupported content type: ${block.type}]`);
    }
  }
  return parts.join("\n");
}

function defaultOnError(server: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[minicode-mcp] Failed to load tools from server "${server}": ${message}`,
  );
}

async function connectServer(
  config: McpServerConfig,
): Promise<{ name: string; client: Client }> {
  const transport = createTransport(config);
  const client = new Client(
    { name: "@minicode/agent-sdk", version: "0.1.0" },
    { capabilities: {} },
  );
  // The MCP SDK's Transport interface uses `string` for some fields the
  // concrete transports declare as `string | undefined`. Cast to bypass
  // the exactOptionalPropertyTypes mismatch — same pattern used on the
  // server side in src/serve/mcp-server.ts.
  await client.connect(transport as Parameters<typeof client.connect>[0]);
  return { name: config.name, client };
}

function buildToolDefinition(
  server: ConnectedServer,
  tool: ConnectedServer["tools"][number],
  namespace: boolean,
): ToolDefinition {
  const exposedName = namespace ? `${server.name}__${tool.name}` : tool.name;
  return {
    name: exposedName,
    description: tool.description ?? `Tool from MCP server "${server.name}".`,
    inputSchema: tool.inputSchema,
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const result = await server.client.callTool({
        name: tool.name,
        arguments: input,
      });
      const formatted = formatMcpResult(
        (result.content ?? []) as McpContentBlock[],
      );
      if (result.isError) {
        return `MCP tool error (${exposedName}): ${formatted}`;
      }
      return formatted;
    },
  };
}

/**
 * Discover tools on a list of already-connected MCP clients and wrap
 * each as a `ToolDefinition`. The advanced entry point — most
 * consumers want `createMcpTools` instead, which also handles
 * spawning / connecting the underlying transport. Useful when the
 * caller wants to bring its own `Client` (e.g. a custom transport or
 * an in-memory test server).
 *
 * Ownership: the returned bundle takes ownership of every client
 * passed in. `bundle.close()` closes successful clients; any client
 * whose `listTools()` throws is also closed before `onError` fires,
 * so callers don't have to worry about leaked transports.
 */
export async function wrapMcpClients(
  servers: Array<{ name: string; client: Client }>,
  options?: { namespace?: boolean; onError?: CreateMcpToolsOptions["onError"] },
): Promise<McpToolBundle> {
  const namespace = options?.namespace ?? true;
  const onError = options?.onError ?? defaultOnError;

  const connected: ConnectedServer[] = [];
  await Promise.all(
    servers.map(async ({ name, client }) => {
      try {
        const result = await client.listTools();
        connected.push({
          name,
          client,
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          })),
        });
      } catch (error) {
        // Transport may have already connected before listTools threw —
        // close it so we don't leak the spawned subprocess / HTTP /
        // SSE connection. Errors during cleanup are swallowed; the
        // original failure is what the caller cares about.
        try {
          await client.close();
        } catch {
          // ignore
        }
        onError(name, error);
      }
    }),
  );

  const tools: ToolDefinition[] = [];
  const seenNames = new Set<string>();
  for (const server of connected) {
    for (const tool of server.tools) {
      const def = buildToolDefinition(server, tool, namespace);
      if (seenNames.has(def.name)) {
        onError(
          server.name,
          new Error(
            `Tool name collision: "${def.name}" is already exposed by another server.`,
          ),
        );
        continue;
      }
      seenNames.add(def.name);
      tools.push(def);
    }
  }

  const close = async (): Promise<void> => {
    await Promise.allSettled(connected.map((s) => s.client.close()));
  };

  return { tools, close };
}

/**
 * Connect to each configured MCP server, discover its tools, and
 * return them as `ToolDefinition`s ready to register. Servers that
 * fail to connect or list their tools are skipped (with a warning);
 * the bundle still includes tools from the servers that succeeded.
 */
export async function createMcpTools(
  options: CreateMcpToolsOptions,
): Promise<McpToolBundle> {
  const onError = options.onError ?? defaultOnError;

  const settled = await Promise.allSettled(
    options.servers.map((s) => connectServer(s)),
  );

  const connected: Array<{ name: string; client: Client }> = [];
  settled.forEach((result, idx) => {
    const cfg = options.servers[idx];
    if (!cfg) return;
    if (result.status === "fulfilled") {
      connected.push(result.value);
    } else {
      onError(cfg.name, result.reason);
    }
  });

  const wrapOpts: { namespace?: boolean; onError: typeof onError } = { onError };
  if (options.namespace !== undefined) wrapOpts.namespace = options.namespace;
  return wrapMcpClients(connected, wrapOpts);
}
