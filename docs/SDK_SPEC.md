# Agent Runtime SDK Specification (Draft)

This document proposes a reusable SDK extracted from minicode's existing runtime so the CLI can become one consumer among many (CLI, web app, CI bot, IDE extension, custom agent service).

## 1) Goals

### Primary goals

- **Runtime reusability:** Expose the agent loop, tool orchestration, session state, and model abstraction as a stable library API.
- **Composable architecture:** Let users bring their own model client, tool registry, indexer, storage, and UI.
- **Production-friendly hooks:** Provide progress events, cancellation, streaming, loop protection, and guardrail extensibility.
- **Ecosystem growth:** Pair runtime SDK with the plugin system so teams can build reusable language + tool packages.

### Non-goals (v0)

- Not a hosted service.
- Not a no-code builder.
- Not a strict replacement for framework-level workflow engines.
- Not attempting to standardize every provider-specific feature in v0.

---

## 2) Proposed package topology

To keep responsibilities clean, split into focused packages:

### `@minicode/agent-runtime` (core)

Contains:

- `AgentRuntime` / `CodingAgent` orchestration loop
- `Session` + session message types
- model interfaces (`ModelClient`, `ModelResponse`, tool-call types)
- runtime events and lifecycle hooks
- base guardrail interfaces

Does **not** require UI or CLI.

### `@minicode/tools-core` (optional defaults)

Contains built-in tools currently shipped in CLI runtime:

- file tools (`read_file`, `write_file`, `edit_file`, `list_files`, `search`)
- command tool (`run_command`)

This package can export:

- `createCoreTools(config)`
- `createToolRegistry(tools)`

### `@minicode/indexer` (optional indexing + code-map)

Contains project indexing and graph capabilities:

- project indexing APIs
- code map generation
- symbol graph (`read_symbol`, `find_references`, `get_dependencies`)
- plugin loader and plugin types

### `@minicode/cli` (application)

Existing CLI becomes a thin app over the above packages.

---

## 3) Public API surface (v0)

## 3.1 Core types

```ts
export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
}

export type SessionMessage = UserMessage | AssistantMessage | ToolMessage;
```

## 3.2 Model abstraction

```ts
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: ModelUsage;
}

export interface ModelClient {
  chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
    onStream?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
}
```

## 3.3 Tool interfaces

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  workspaceRoot: string;
  step: number;
  runtime: {
    turnId: string;
    requestId?: string;
  };
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ToolRegistry {
  getToolSchemas(): ToolSchema[];
  execute(name: string, input: unknown, ctx: ToolExecutionContext): Promise<string>;
}
```

## 3.4 Runtime config

```ts
export interface AgentRuntimeConfig {
  model: string;
  maxSteps: number;
  maxTokens: number;
  maxContextTokens: number;
  keepRecentMessages: number;
  loopDetectionWindow: number;
  maxToolOutputChars: number;

  // Optional prompt customization
  systemPrompt?: string;
  systemPromptBuilder?: (ctx: { tools: ToolSchema[]; codeMap?: string }) => string;
}
```

## 3.5 Lifecycle events

```ts
export type RuntimeEvent =
  | { type: "turn_start"; turnId: string; input: string }
  | { type: "step_start"; turnId: string; step: number }
  | { type: "model_stream"; turnId: string; chunk: string }
  | { type: "model_response"; turnId: string; text: string; toolCalls: ToolCall[] }
  | { type: "tool_start"; turnId: string; step: number; tool: string; input: Record<string, unknown> }
  | { type: "tool_end"; turnId: string; step: number; tool: string; output: string; elapsedMs: number }
  | { type: "loop_detected"; turnId: string; tool: string }
  | { type: "turn_end"; turnId: string; output: string; usage: ModelUsage };
```

## 3.6 Runtime class

```ts
export interface RunTurnResult {
  text: string;
  usage: ModelUsage;
  streamed: boolean;
}

export interface AgentRuntimeDeps {
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  session?: Session;
  getCodeMap?: () => string | undefined;
}

export class AgentRuntime {
  constructor(config: AgentRuntimeConfig, deps: AgentRuntimeDeps);

  runTurn(input: string, options?: { signal?: AbortSignal; requestId?: string }): Promise<RunTurnResult>;

  getSession(): Session;

  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}
```

---

## 4) User-facing capabilities

What SDK consumers can do out of the box:

- Run multi-step tool-calling agent turns.
- Stream model text to UI.
- Register tools with JSON schemas for model function-calling.
- Enforce step limits and loop protection.
- Trim long sessions to fit context windows.
- Optionally inject code map context from an indexer.
- Observe detailed runtime events for logs/telemetry.

What users can customize:

- Model provider (OpenAI-compatible, Anthropic, custom)
- Prompt strategy
- Tool set and guardrails
- Session persistence strategy
- UI/event consumers

---

## 5) Guardrails and policy extension points

Expose formal policy hooks so enterprise users can adapt behavior:

```ts
export interface RuntimePolicy {
  beforeModelCall?(ctx: {
    step: number;
    messages: SessionMessage[];
    tools: ToolSchema[];
  }): Promise<void> | void;

  beforeToolCall?(ctx: {
    step: number;
    name: string;
    input: Record<string, unknown>;
  }): Promise<void> | void;

  afterToolCall?(ctx: {
    step: number;
    name: string;
    input: Record<string, unknown>;
    output: string;
  }): Promise<void> | void;
}
```

Examples:

- deny specific tools by workspace path
- redact secrets before persistence
- block dangerous commands unless approved by host app policy

---

## 6) Plugin + SDK alignment

The SDK should align with plugin interfaces so language intelligence is reusable:

- Keep `LanguagePlugin` API stable.
- Make indexing package optional dependency.
- Allow runtime to accept a generic `getCodeMap()` and optional symbol tools.
- Keep symbol tooling separate from runtime core so non-code domains can still use the agent runtime.

---

## 7) SDK consumption examples

### 7.1 Minimal usage

```ts
import { AgentRuntime } from "@minicode/agent-runtime";
import { OpenAICompatibleModelClient } from "@minicode/provider-openai";
import { createCoreToolRegistry } from "@minicode/tools-core";

const runtime = new AgentRuntime(
  {
    model: "zai-org/glm-4.7-flash",
    maxSteps: 50,
    maxTokens: 4096,
    maxContextTokens: 120000,
    keepRecentMessages: 12,
    loopDetectionWindow: 6,
    maxToolOutputChars: 15000,
  },
  {
    modelClient: new OpenAICompatibleModelClient({
      baseUrl: "http://localhost:1234/v1",
    }),
    toolRegistry: createCoreToolRegistry({ workspaceRoot: process.cwd() }),
  },
);

runtime.onEvent((event) => {
  if (event.type === "tool_start") {
    console.log(`[tool] ${event.tool}`);
  }
});

const result = await runtime.runTurn("Find TODOs and summarize next actions");
console.log(result.text);
```

### 7.2 App-style integration (custom tool + events + cancellation)

```ts
import process from "node:process";
import {
  AgentRuntime,
  type ToolDefinition,
  type ToolRegistry,
  type ToolExecutionContext,
} from "@minicode/agent-runtime";
import { OpenAICompatibleModelClient } from "@minicode/provider-openai";

const nowTool: ToolDefinition = {
  name: "get_current_time",
  description: "Returns the current ISO timestamp",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_input: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
    return new Date().toISOString();
  },
};

function createRegistry(tools: ToolDefinition[]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    getToolSchemas() {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    },
    async execute(name, input, ctx) {
      const tool = byName.get(name);
      if (!tool) return `Tool error: Unknown tool "${name}"`;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return `Tool error (${name}): Tool input must be a JSON object.`;
      }
      return tool.execute(input as Record<string, unknown>, ctx);
    },
  };
}

const runtime = new AgentRuntime(
  {
    model: "zai-org/glm-4.7-flash",
    maxSteps: 20,
    maxTokens: 2048,
    maxContextTokens: 64000,
    keepRecentMessages: 10,
    loopDetectionWindow: 6,
    maxToolOutputChars: 10000,
    systemPrompt: "You are a concise engineering assistant.",
  },
  {
    modelClient: new OpenAICompatibleModelClient({ baseUrl: "http://localhost:1234/v1" }),
    toolRegistry: createRegistry([nowTool]),
  },
);

runtime.onEvent((event) => {
  if (event.type === "model_stream") process.stdout.write(event.chunk);
  if (event.type === "tool_end") {
    console.error(`\n[tool:${event.tool}] ${event.elapsedMs}ms`);
  }
});

const abortController = new AbortController();
setTimeout(() => abortController.abort(), 30_000); // host app timeout policy

const response = await runtime.runTurn(
  "What time is it? Use tools when needed.",
  { signal: abortController.signal, requestId: "req-123" },
);

console.log("\nFinal:", response.text);
```

---

## 8) Backward compatibility and migration plan

### From current `minicode` package

1. Extract runtime internals to `@minicode/agent-runtime` with compatibility wrappers.
2. Extract built-in tools to `@minicode/tools-core`.
3. Keep CLI behavior unchanged while switching imports to SDK packages.
4. Mark old deep imports as deprecated and document replacements.

### Versioning policy

- Follow semver strictly.
- Treat type-level API changes as breaking when they affect public interfaces.
- Keep event payload shapes stable within major version.

---

## 9) Open questions

- Should runtime include default session persistence adapters (file/sqlite), or keep persistence external?
- Should tool execution be parallelizable by policy, or remain strictly sequential for determinism?
- Should provider adapters live in core package or separate provider packages?
- Should runtime expose middleware chain in addition to event hooks?

---

## 10) Suggested v0 acceptance criteria

- Build a sample app (non-CLI) using only SDK packages.
- CLI consumes SDK packages internally with no feature regressions.
- Public API reference docs generated for exported symbols.
- At least one custom tool package and one custom plugin package validated against SDK.
- End-to-end tests prove tool calling, loop detection, streaming, and cancellation.
