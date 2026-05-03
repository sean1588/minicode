// A tiny MCP server used by mcp-client.integration.test.ts to verify
// stdio roundtrips end-to-end. Mirrors the shape of real MCP servers
// that ship as `npx`-spawned subprocesses (e.g. server-filesystem,
// server-github) without pulling them in as test deps.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.tool(
  "add",
  "Add two numbers and return the sum.",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

server.tool(
  "echo",
  "Echo the provided message.",
  { message: z.string() },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
