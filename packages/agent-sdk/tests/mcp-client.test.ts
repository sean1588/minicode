import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  createMcpTools,
  formatMcpResult,
  wrapMcpClients,
} from "../src/mcp/client-registry.js";

interface TestServerSpec {
  name: string;
  version?: string;
  tools: Array<{
    name: string;
    description: string;
    schema: Record<string, z.ZodTypeAny>;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text?: string; [k: string]: unknown }>;
      isError?: boolean;
    }>;
  }>;
}

/**
 * Spin up an in-process MCP server, link it to a client via
 * InMemoryTransport, and return the connected client.
 */
async function spawnInMemoryServer(spec: TestServerSpec): Promise<Client> {
  const server = new McpServer(
    { name: spec.name, version: spec.version ?? "1.0.0" },
    { capabilities: { tools: {} } },
  );

  for (const t of spec.tools) {
    server.tool(t.name, t.description, t.schema, async (args) => {
      const result = await t.handler(args as Record<string, unknown>);
      return result as never;
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as never);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport as never);
  return client;
}

test("formatMcpResult concatenates text blocks", () => {
  const out = formatMcpResult([
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ]);
  assert.equal(out, "hello\nworld");
});

test("formatMcpResult substitutes placeholders for non-text blocks", () => {
  const out = formatMcpResult([
    { type: "text", text: "before" },
    { type: "image", mimeType: "image/png", data: "..." },
    { type: "audio", mimeType: "audio/wav", data: "..." },
    { type: "text", text: "after" },
  ]);
  assert.equal(
    out,
    "before\n[image content omitted (image/png)]\n[audio content omitted (audio/wav)]\nafter",
  );
});

test("formatMcpResult inlines text from resource blocks", () => {
  const out = formatMcpResult([
    {
      type: "resource",
      resource: { uri: "test://file", text: "resource body" },
    },
  ]);
  assert.equal(out, "resource body");
});

test("formatMcpResult labels binary resource blocks with uri and mime type", () => {
  const out = formatMcpResult([
    {
      type: "resource",
      resource: {
        uri: "test://blob",
        blob: "base64...",
        mimeType: "application/octet-stream",
      },
    },
  ]);
  assert.equal(out, "[resource test://blob (application/octet-stream)]");
});

test("formatMcpResult renders resource_link blocks", () => {
  const out = formatMcpResult([
    { type: "resource_link", uri: "test://link", name: "linked-thing" },
  ]);
  assert.equal(out, "[resource_link linked-thing]");
});

test("formatMcpResult labels unsupported content types", () => {
  const out = formatMcpResult([
    { type: "video", data: "..." },
  ]);
  assert.equal(out, "[unsupported content type: video]");
});

test("formatMcpResult returns sentinel on empty content", () => {
  assert.equal(formatMcpResult([]), "(empty result)");
});

test("wrapMcpClients discovers tools and namespaces them", async () => {
  const client = await spawnInMemoryServer({
    name: "fs-mock",
    tools: [
      {
        name: "read",
        description: "read a file",
        schema: { path: z.string() },
        handler: async ({ path }) => ({
          content: [{ type: "text" as const, text: `read ${String(path)}` }],
        }),
      },
    ],
  });

  const bundle = await wrapMcpClients([{ name: "fs", client }]);
  assert.equal(bundle.tools.length, 1);
  assert.equal(bundle.tools[0]!.name, "fs__read");
  assert.equal(bundle.tools[0]!.description, "read a file");

  const out = await bundle.tools[0]!.execute({ path: "/tmp/x" });
  assert.equal(out, "read /tmp/x");
  await bundle.close();
});

test("wrapMcpClients omits namespacing when namespace is false", async () => {
  const client = await spawnInMemoryServer({
    name: "fs-mock",
    tools: [
      {
        name: "list",
        description: "list files",
        schema: {},
        handler: async () => ({
          content: [{ type: "text" as const, text: "a\nb\nc" }],
        }),
      },
    ],
  });

  const bundle = await wrapMcpClients(
    [{ name: "fs", client }],
    { namespace: false },
  );
  assert.equal(bundle.tools.length, 1);
  assert.equal(bundle.tools[0]!.name, "list");
  await bundle.close();
});

test("wrapMcpClients sanitizes invalid characters in server and tool names", async () => {
  // Anthropic / OpenAI restrict tool names to [a-zA-Z0-9_-]{1,64}.
  // A server / tool with dots or spaces would otherwise crash the API call.
  const seenArgs: Array<Record<string, unknown>> = [];
  const client = await spawnInMemoryServer({
    name: "fixture",
    tools: [
      {
        name: "repo.create_issue",
        description: "namespaced tool",
        schema: { title: z.string() },
        handler: async (args) => {
          seenArgs.push(args);
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      },
    ],
  });

  const bundle = await wrapMcpClients([
    { name: "github mcp", client },
  ]);

  assert.equal(bundle.tools.length, 1);
  assert.equal(bundle.tools[0]!.name, "github_mcp__repo_create_issue");
  // Original MCP tool name must be preserved for the actual callTool dispatch.
  await bundle.tools[0]!.execute({ title: "hello" });
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0]!.title, "hello");
  await bundle.close();
});

test("wrapMcpClients truncates exposed names that exceed 64 chars", async () => {
  const longTool = "x".repeat(80);
  const client = await spawnInMemoryServer({
    name: "fixture",
    tools: [
      {
        name: longTool,
        description: "very long",
        schema: {},
        handler: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      },
    ],
  });

  const bundle = await wrapMcpClients(
    [{ name: "s", client }],
    { namespace: false },
  );
  assert.equal(bundle.tools.length, 1);
  assert.ok(
    bundle.tools[0]!.name.length <= 64,
    `expected <= 64 chars, got ${bundle.tools[0]!.name.length}`,
  );
  await bundle.close();
});

test("wrapMcpClients reports name collisions via onError and skips duplicates", async () => {
  const a = await spawnInMemoryServer({
    name: "a",
    tools: [
      {
        name: "echo",
        description: "echo",
        schema: { msg: z.string() },
        handler: async ({ msg }) => ({
          content: [{ type: "text" as const, text: `a:${String(msg)}` }],
        }),
      },
    ],
  });
  const b = await spawnInMemoryServer({
    name: "b",
    tools: [
      {
        name: "echo",
        description: "echo",
        schema: { msg: z.string() },
        handler: async ({ msg }) => ({
          content: [{ type: "text" as const, text: `b:${String(msg)}` }],
        }),
      },
    ],
  });

  const errors: Array<{ server: string; message: string }> = [];
  const bundle = await wrapMcpClients(
    [
      { name: "shared", client: a },
      { name: "shared", client: b },
    ],
    {
      namespace: true,
      onError: (server, error) => {
        errors.push({
          server,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );

  assert.equal(bundle.tools.length, 1);
  assert.equal(bundle.tools[0]!.name, "shared__echo");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Tool name collision/);
  await bundle.close();
});

test("wrapMcpClients forwards isError through the wrapped result", async () => {
  const client = await spawnInMemoryServer({
    name: "errorful",
    tools: [
      {
        name: "boom",
        description: "always fails",
        schema: {},
        handler: async () => ({
          content: [{ type: "text" as const, text: "kaboom" }],
          isError: true,
        }),
      },
    ],
  });

  const bundle = await wrapMcpClients([{ name: "x", client }]);
  const out = await bundle.tools[0]!.execute({});
  assert.match(out, /MCP tool error \(x__boom\): kaboom/);
  await bundle.close();
});

test("wrapMcpClients closes clients whose listTools throws (no transport leak)", async () => {
  // Build a real connected client, then monkey-patch listTools to throw.
  // We'd otherwise leak its in-memory transport — verify close() ran.
  const client = await spawnInMemoryServer({
    name: "leaky",
    tools: [
      {
        name: "noop",
        description: "noop",
        schema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
      },
    ],
  });

  let closed = false;
  const originalClose = client.close.bind(client);
  client.close = async () => {
    closed = true;
    await originalClose();
  };
  client.listTools = async () => {
    throw new Error("listTools failed");
  };

  const errors: string[] = [];
  const bundle = await wrapMcpClients(
    [{ name: "leaky", client }],
    {
      onError: (name) => {
        errors.push(name);
      },
    },
  );

  assert.equal(bundle.tools.length, 0);
  assert.deepEqual(errors, ["leaky"]);
  assert.equal(closed, true, "client.close() should have been called when listTools threw");
  await bundle.close();
});

test("wrapMcpClients uses onError when listTools rejects, skips that server", async () => {
  const good = await spawnInMemoryServer({
    name: "good",
    tools: [
      {
        name: "ping",
        description: "ping",
        schema: {},
        handler: async () => ({
          content: [{ type: "text" as const, text: "pong" }],
        }),
      },
    ],
  });

  // A client that's never been connected — listTools throws.
  const broken = new Client(
    { name: "broken", version: "1.0.0" },
    { capabilities: {} },
  );

  const errors: string[] = [];
  const bundle = await wrapMcpClients(
    [
      { name: "broken", client: broken },
      { name: "good", client: good },
    ],
    {
      onError: (name) => {
        errors.push(name);
      },
    },
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0], "broken");
  assert.equal(bundle.tools.length, 1);
  assert.equal(bundle.tools[0]!.name, "good__ping");
  await bundle.close();
});

test("createMcpTools surfaces transport-level connect failures via onError", async () => {
  // Use a stdio command that doesn't exist so the spawn fails.
  const errors: Array<{ name: string; message: string }> = [];
  const bundle = await createMcpTools({
    servers: [
      {
        name: "missing",
        transport: "stdio",
        command: "/nonexistent/path/that/should/not/exist",
        args: [],
      },
    ],
    onError: (name, error) => {
      errors.push({
        name,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  assert.equal(bundle.tools.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.name, "missing");
  await bundle.close();
});

test("wrapped tool roundtrips arguments to client.callTool", async () => {
  const seenArgs: Array<Record<string, unknown>> = [];
  const client = await spawnInMemoryServer({
    name: "arg-spy",
    tools: [
      {
        name: "spy",
        description: "captures its args",
        schema: { a: z.number(), b: z.string() },
        handler: async (args) => {
          seenArgs.push(args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(args) }],
          };
        },
      },
    ],
  });

  const bundle = await wrapMcpClients([{ name: "s", client }]);
  const out = await bundle.tools[0]!.execute({ a: 7, b: "hi" });
  assert.equal(out, '{"a":7,"b":"hi"}');
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0]!.a, 7);
  assert.equal(seenArgs[0]!.b, "hi");
  await bundle.close();
});
