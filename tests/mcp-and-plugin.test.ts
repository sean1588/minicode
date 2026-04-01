import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";

import { parseCliArgs, validateCliArgs } from "../src/cli/args.js";

// ── CLI args: plugin install ──

test("parseCliArgs parses 'plugin install' subcommand", () => {
  const parsed = parseCliArgs(["node", "src/index.ts", "plugin", "install"]);
  assert.equal(parsed.pluginInstall, true);
  assert.equal(parsed.serve, false);
  assert.equal(parsed.oneshot, false);
});

test("parseCliArgs does not set pluginInstall for bare 'plugin'", () => {
  const parsed = parseCliArgs(["node", "src/index.ts", "plugin"]);
  assert.equal(parsed.pluginInstall, false);
  assert.equal(parsed.task, "plugin");
});

test("validateCliArgs rejects plugin install with serve", () => {
  assert.throws(
    () => validateCliArgs({
      verbose: false, oneshot: false, json: false, serve: true,
      port: 4567, task: "", pluginInstall: true,
    }),
    /mutually exclusive/,
  );
});

test("validateCliArgs rejects plugin install with oneshot", () => {
  assert.throws(
    () => validateCliArgs({
      verbose: false, oneshot: true, json: false, serve: false,
      port: 4567, task: "test", pluginInstall: true,
    }),
    /mutually exclusive/,
  );
});

// ── MCP endpoint: malformed JSON ──

test("MCP POST with malformed JSON returns 400 with JSON-RPC error", async () => {
  // Import after top-level to avoid issues with module loading
  const { createRequestHandler } = await import("../src/serve/server.js");
  const { AgentBridge } = await import("../src/serve/agent-bridge.js");

  // Create a minimal mock bridge
  class MinimalBridge extends AgentBridge {
    constructor() { super(() => {}, false); }
    override getConfig() {
      return {
        modelProvider: "openai-compatible" as const,
        model: "test",
        maxSteps: 10,
        maxTokens: 1024,
        maxContextTokens: 4000,
        workspaceRoot: "/tmp/mcp-test",
        commandTimeoutMs: 5000,
        maxFileSizeBytes: 100000,
        commandDenylist: [],
        confirmDestructive: false,
        keepRecentMessages: 6,
        loopDetectionWindow: 4,
        maxToolOutputChars: 2000,
        openAiBaseUrl: "http://localhost:1234/v1",
      };
    }
  }

  const bridge = new MinimalBridge();
  const handler = createRequestHandler(bridge, () => {});

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json{{{",
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { jsonrpc: string; error: { code: number; message: string } };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32700);
    assert.ok(body.error.message.includes("Parse error"));
  } finally {
    server.close();
  }
});

// ── MCP endpoint: missing session ID ──

test("MCP POST without session ID and non-init request returns 400", async () => {
  const { createRequestHandler } = await import("../src/serve/server.js");
  const { AgentBridge } = await import("../src/serve/agent-bridge.js");

  class MinimalBridge extends AgentBridge {
    constructor() { super(() => {}, false); }
    override getConfig() {
      return {
        modelProvider: "openai-compatible" as const,
        model: "test",
        maxSteps: 10,
        maxTokens: 1024,
        maxContextTokens: 4000,
        workspaceRoot: "/tmp/mcp-test",
        commandTimeoutMs: 5000,
        maxFileSizeBytes: 100000,
        commandDenylist: [],
        confirmDestructive: false,
        keepRecentMessages: 6,
        loopDetectionWindow: 4,
        maxToolOutputChars: 2000,
        openAiBaseUrl: "http://localhost:1234/v1",
      };
    }
  }

  const bridge = new MinimalBridge();
  const handler = createRequestHandler(bridge, () => {});

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("session"));
  } finally {
    server.close();
  }
});

// ── MCP endpoint: method not allowed ──

test("MCP PATCH returns 405", async () => {
  const { createRequestHandler } = await import("../src/serve/server.js");
  const { AgentBridge } = await import("../src/serve/agent-bridge.js");

  class MinimalBridge extends AgentBridge {
    constructor() { super(() => {}, false); }
    override getConfig() {
      return {
        modelProvider: "openai-compatible" as const,
        model: "test",
        maxSteps: 10,
        maxTokens: 1024,
        maxContextTokens: 4000,
        workspaceRoot: "/tmp/mcp-test",
        commandTimeoutMs: 5000,
        maxFileSizeBytes: 100000,
        commandDenylist: [],
        confirmDestructive: false,
        keepRecentMessages: 6,
        loopDetectionWindow: 4,
        maxToolOutputChars: 2000,
        openAiBaseUrl: "http://localhost:1234/v1",
      };
    }
  }

  const bridge = new MinimalBridge();
  const handler = createRequestHandler(bridge, () => {});

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "PATCH",
    });

    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

// ── Plugin installer: resolves source dir ──

test("plugin source directory contains plugin.json", async () => {
  // Verify the plugin directory exists in the repo
  const pluginJson = path.resolve(process.cwd(), "plugin/.claude-plugin/plugin.json");
  assert.ok(existsSync(pluginJson), `Plugin manifest should exist at ${pluginJson}`);
});

test("plugin manifest has required fields", async () => {
  const pluginJson = path.resolve(process.cwd(), "plugin/.claude-plugin/plugin.json");
  const { readFile } = await import("node:fs/promises");
  const content = JSON.parse(
    await readFile(pluginJson, "utf-8"),
  ) as { name: string; version: string; description: string };

  assert.ok(content.name, "Plugin must have a name");
  assert.equal(content.name, "minicode");
  assert.ok(content.version, "Plugin must have a version");
  assert.ok(content.description, "Plugin must have a description");
});

test("plugin .mcp.json references minicode MCP endpoint", async () => {
  const mcpJson = path.resolve(process.cwd(), "plugin/.mcp.json");
  assert.ok(existsSync(mcpJson), `.mcp.json should exist`);

  const { readFile } = await import("node:fs/promises");
  const content = JSON.parse(await readFile(mcpJson, "utf-8")) as {
    mcpServers: Record<string, { type: string; url: string }>;
  };

  assert.ok(content.mcpServers.minicode, "Should have a minicode server entry");
  assert.equal(content.mcpServers.minicode.type, "http");
  assert.ok(content.mcpServers.minicode.url.includes("/mcp"), "URL should point to /mcp");
});
