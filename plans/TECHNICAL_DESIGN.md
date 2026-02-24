# Technical Design Document: mini-coder

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    CLI Interface                     │
│              (readline / user input)                 │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                   Agent Runtime                      │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │   Prompt     │  │  Tool    │  │   Session     │  │
│  │   Builder    │  │  Loop    │  │   Manager     │  │
│  └──────┬──────┘  └──────────┘  └───────────────┘  │
└─────────┼──────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────┐
│              Project Index (Context Optimization)     │
│  Code map • Symbol lookup • Dependency graph         │
│  Built at startup, cached, re-indexed on file edits   │
└──────────────────────┬──────────────────────────────┘
                       │
           ┌───────────┼───────────┬───────────┐
           ▼           ▼           ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
     │  Model   │ │  Tool    │ │  Config  │ │ Plugins  │
     │  Client  │ │  Registry│ │  Loader  │ │(TS, Py)  │
     └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

### Design Principles

1. **Context efficiency** — Read operations dominate token usage. We inject a compact code map and provide targeted tools (`read_symbol`, `find_references`, `get_dependencies`) so the model reads only what it needs.
2. **Local-first** — Works well with LM Studio and small models; lean prompts mean faster inference and better fit within context limits.
3. **Extensibility** — Plugin architecture for new languages; tool registry for new capabilities; model client abstraction for new providers.
4. **Graceful degradation** — If indexing fails, the agent still runs with `read_file` and other basic tools.

## 2. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript (ESM) | Type safety, good SDK support, familiar |
| Runtime | Node.js 22+ | Stable, good for CLI + async |
| Model SDK | `@anthropic-ai/sdk` | Claude API with native tool_use support |
| Model (OpenAI-compatible) | fetch + OpenAI schema | LM Studio, local servers, OpenAI |
| CLI input | Node `readline/promises` | Zero-dep interactive input |
| Shell exec | Node `child_process` | Built-in, no extra deps |
| File ops | Node `fs/promises` | Built-in |
| Search | `ripgrep` (via shell) | Fast, respects .gitignore |
| Indexer | TypeScript compiler API | AST parsing for symbols + dependencies |
| Config | dotenv + JSON config file | Simple, no framework needed |
| Package manager | npm | Developer preference |

## 3. Project Structure

```
mini-coder/
├── src/
│   ├── index.ts              # Entry point — CLI loop, builds index at startup
│   ├── agent/
│   │   ├── agent.ts          # Core agent loop (accepts projectIndex)
│   │   ├── types.ts          # Shared types (Message, ToolCall, AgentConfig, etc.)
│   │   └── config.ts         # Agent configuration
│   ├── prompt/
│   │   └── system-prompt.ts  # System prompt builder (accepts codeMap)
│   ├── tools/
│   │   ├── registry.ts       # Tool registration + dispatch
│   │   ├── read-file.ts      # read_file tool
│   │   ├── write-file.ts     # write_file tool (triggers reindex)
│   │   ├── edit-file.ts      # edit_file tool (triggers reindex)
│   │   ├── search.ts         # grep/ripgrep tool
│   │   ├── list-files.ts     # directory listing tool
│   │   ├── run-command.ts    # shell command tool
│   │   ├── read-symbol.ts    # read_symbol — read function/class by name
│   │   ├── find-references.ts # find_references — who uses a symbol
│   │   └── get-dependencies.ts # get_dependencies — dependency cone
│   ├── indexer/
│   │   ├── types.ts          # IndexedSymbol, DependencyEdge, LanguagePlugin
│   │   ├── plugin-loader.ts  # Load built-in, npm, local plugins
│   │   ├── project-index.ts  # buildProjectIndex, getDependencyCone, reindexFile
│   │   ├── code-map.ts       # Token-budgeted code map generator
│   │   ├── cache.ts          # Disk cache for index (.mini-coder/cache/)
│   │   └── plugins/
│   │       ├── typescript.ts # TypeScript/JS symbol extraction + deps
│   │       └── python.ts     # Python symbol extraction
│   ├── session/
│   │   └── session.ts        # In-memory session history
│   ├── model/
│   │   └── client.ts         # Model client (Anthropic + OpenAI-compatible)
│   └── safety/
│       └── guardrails.ts     # Safety checks, limits, allowlists
├── docs/
│   ├── PRD.md
│   ├── TECHNICAL_DESIGN.md
│   └── PLUGIN_SPEC.md       # Plugin creation guide
├── test-programs/
│   └── verify-index/         # Test fixture for indexing verification
├── templates/
│   └── plugin-template/      # Template for creating plugins
├── plans/
│   └── implementation/      # Phase logs, dependency-graph-reference
├── package.json
├── tsconfig.json
└── .env.example
```

## 4. Core Components

### 4.1 Agent Loop (`src/agent/agent.ts`)

The heart of the system. Pseudocode:

```typescript
async function runAgent(userMessage: string, session: Session, config: AgentConfig) {
  session.addMessage({ role: "user", content: userMessage });

  for (let step = 0; step < config.maxSteps; step++) {
    const response = await modelClient.chat({
      model: config.model,
      system: buildSystemPrompt(config),
      messages: session.getMessages(),
      tools: toolRegistry.getToolSchemas(),
    });

    // Case 1: Model returns text only (no tool calls) → done
    if (response.stopReason === "end_turn" && !response.toolCalls?.length) {
      session.addMessage({ role: "assistant", content: response.text });
      return response.text;
    }

    // Case 2: Model wants to use tools → execute and continue
    if (response.toolCalls?.length) {
      session.addMessage({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

      for (const toolCall of response.toolCalls) {
        const result = await toolRegistry.execute(toolCall.name, toolCall.input);
        session.addMessage({ role: "tool", toolCallId: toolCall.id, content: result });
      }
      continue; // next iteration — model sees tool results
    }
  }

  return "Reached maximum steps. Here's what I accomplished so far...";
}
```

**Key design decisions:**
- Loop continues as long as the model returns tool calls
- Loop stops when model returns plain text (its "final answer")
- Hard limit (`maxSteps`) prevents runaway loops
- All messages (user, assistant, tool calls, tool results) accumulate in session

### 4.2 Tool Registry (`src/tools/registry.ts`)

Each tool is a self-contained module that exports:

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: object; // JSON Schema for tool parameters
  execute: (input: Record<string, unknown>) => Promise<string>;
}
```

The registry:
- Collects all tool definitions at startup
- Registers `read_symbol`, `find_references`, `get_dependencies` only when project index is available (graceful fallback if indexing fails)
- Provides `getToolSchemas()` for the model API call
- Provides `execute(name, input)` to dispatch tool calls
- Validates inputs before execution

### 4.3 Tool Implementations

#### `read_file`
```typescript
// Input: { path: string, offset?: number, limit?: number }
// Output: file contents as string (with line numbers)
// Safety: path must be within workspace root
```

#### `read_symbol` (context optimization)
```typescript
// Input: { name: string, includeBody?: boolean }
// Output: symbol source + referenced type definitions
// Prefer over read_file for code — returns only the function/class, not the whole file
// Requires project index; includes "## Referenced Types" when includeBody is true
```

#### `find_references` (context optimization)
```typescript
// Input: { name: string }
// Output: list of symbols that reference the given symbol (with file paths, edge kind)
// Uses dependency graph; useful for impact analysis
```

#### `get_dependencies` (context optimization)
```typescript
// Input: { name: string, depth?: number }
// Output: dependency cone — what the symbol depends on (types, calls)
// Uses dependency graph; depth defaults to 1
```

#### `write_file`
```typescript
// Input: { path: string, content: string }
// Output: confirmation message
// Safety: path must be within workspace root
// Side effect: triggers projectIndex.reindexFile() when index is available
```

#### `edit_file`
```typescript
// Input: { path: string, old_string: string, new_string: string }
// Output: confirmation or error if old_string not found/not unique
// Safety: path within workspace, old_string must match exactly once
// Side effect: triggers projectIndex.reindexFile() when index is available
```

#### `search`
```typescript
// Input: { pattern: string, path?: string, include?: string }
// Output: matching lines with file paths and line numbers
// Implementation: shells out to `rg` (ripgrep) or falls back to grep
```

#### `list_files`
```typescript
// Input: { path: string }
// Output: directory listing (files and subdirectories)
```

#### `run_command`
```typescript
// Input: { command: string, timeout?: number }
// Output: stdout + stderr + exit code
// Safety: command denylist, timeout enforcement, workspace-scoped cwd
```

### 4.4 System Prompt (`src/prompt/system-prompt.ts`)

Built dynamically. Structure:

```
[Identity]
You are a coding agent. You help developers read, understand, and modify code in their projects.

[Workspace Context]
Working directory: /path/to/project
Project type: Node.js / TypeScript (detected from package.json, pyproject.toml, etc.)

[Project Code Map]  ← Injected when project index is available
# Project Code Map

  src/agent/agent.ts
    class CodingAgent
      constructor(params: { config: AgentConfig; ... })
      async runTurn(input: string): Promise<string>
  src/model/client.ts
    function createModelClient(config: AgentConfig): ModelClient
    function parseResponse(...): ModelResponse
  ...

[Tool Descriptions]
You have the following tools available:
- read_symbol: Read a specific function or class by name (prefer over read_file for code)
- read_file: Read file contents with line numbers
- find_references: Find symbols that reference a given symbol
- get_dependencies: Get the dependency cone of a symbol
- write_file, edit_file, search, list_files, run_command

[Tool Usage Guidelines]
- Use read_symbol to read specific functions or classes by name — more efficient than read_file for code
- Use find_references to see what uses a symbol; use get_dependencies to see what a symbol depends on
- Use read_file for non-code files or when you need the full file
- Always read before editing; prefer edit_file over write_file for existing files
- Run tests or lint after code changes when applicable

[Termination Policy]
- When the task is complete, respond with a concise summary of what you changed
- Do not continue exploring once the task is done

[Safety Rules]
- Never modify files outside the workspace directory
- Never run destructive commands without explicit user confirmation
```

### 4.5 Session Manager (`src/session/session.ts`)

MVP: in-memory array of messages.

```typescript
interface Session {
  id: string;
  messages: Message[];
  createdAt: Date;
  addMessage(msg: Message): void;
  getMessages(): Message[];
  getTokenEstimate(): number;
  trim(maxTokens: number): void;
}
```

Token-aware trimming strategy:
1. Always keep the system prompt (never trimmed)
2. Always keep the last N messages (recent context)
3. Trim oldest messages first when approaching token limit
4. Keep tool call + tool result pairs together (never orphan one)

### 4.6 Model Client (`src/model/client.ts`)

Abstract interface supporting multiple providers:

```typescript
interface ModelClient {
  chat(params: {
    model: string;
    system: string;
    messages: Message[];
    tools: ToolSchema[];
    maxTokens?: number;
  }): Promise<ModelResponse>;
}

interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}
```

**Implementations:**
- **Anthropic** — `@anthropic-ai/sdk`, native tool_use
- **OpenAI-compatible** — fetch + OpenAI schema; works with LM Studio, local servers, OpenAI API

### 4.7 Safety Guardrails (`src/safety/guardrails.ts`)

```typescript
const COMMAND_DENYLIST = [
  /rm\s+-rf\s+\//,       // rm -rf /
  /mkfs/,                 // format disk
  /dd\s+if=/,             // raw disk write
  /:(){ :|:& };:/,        // fork bomb
  // etc.
];

const MAX_STEPS = 25;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB read limit

function validatePath(path: string, workspaceRoot: string): boolean;
function validateCommand(command: string): boolean;
function isWithinStepLimit(currentStep: number): boolean;
```

### 4.8 Context Optimization: Project Index (`src/indexer/`)

**Design goal:** Reduce token usage and latency by giving the model a compact project skeleton and targeted read tools, instead of forcing it to read entire files.

**Why it matters:** Research shows read operations consume 67–76% of tokens in typical agent sessions. Attention degrades with context length. Local models (LM Studio, etc.) have limited effective context — targeted reads keep prompts lean and responses fast.

#### Project Index

Built at session startup (or loaded from cache). Contains:

- **Symbols** — Functions, classes, methods, interfaces, types extracted from source
- **Dependency edges** — `calls`, `references`, `implements`, `extends` between symbols
- **Code map** — Token-budgeted text skeleton (signatures only) injected into the system prompt

#### Plugin Architecture

Language-specific plugins implement `LanguagePlugin`:

```typescript
interface LanguagePlugin {
  name: string;
  extensions: string[];
  canIndex(filePath: string): boolean;
  indexFile(filePath: string, content: string): IndexedSymbol[];
  resolveDependencies?(symbols, projectFiles): DependencyEdge[];
}
```

**Built-in plugins:** TypeScript (`.ts`, `.tsx`, `.js`, `.jsx`), Python (`.py`).

**Discovery order:** Built-in → npm packages (`mini-coder-plugin-*`) → local (`.mini-coder/plugins/*.js`).

#### Code Map

- Ranks symbols: exported > high reference count > entry points (`index.ts`)
- Token budget (default ~1500) — truncates with "... and N more symbols in M files"
- Model sees project structure upfront; makes better-targeted `read_symbol` calls

#### Incremental Updates

- `write_file` and `edit_file` call `reindexFile()` after successful writes
- Code map and `read_symbol` stay in sync with edits

#### Disk Cache

- Location: `.mini-coder/cache/index.json`
- Invalidation: SHA-256 hash of each source file; any change → full rebuild
- Second session on same project loads from cache in &lt;200ms vs ~2s for full index

#### Design Rationale

1. **Code map over full-file reads** — Model orients itself with signatures; reads bodies only when needed.
2. **read_symbol over read_file** — Returns one function/class + referenced types; avoids 300-line file when only one function matters.
3. **Dependency graph** — `find_references` and `get_dependencies` support exploration without blind search.
4. **Plugin system** — Indexing is language-specific; plugins keep the core language-agnostic.

## 5. Data Flow (Single Turn)

```
Session start:
  buildProjectIndex(workspaceRoot) or load from .mini-coder/cache/
  → Code map injected into system prompt

User types: "Add error handling to the fetchData function in src/api.ts"
  │
  ▼
CLI sends to Agent Loop
  │
  ▼
Agent Loop builds messages:
  [system_prompt with code map, ...history, user_message]
  │
  ▼
Model sees code map → knows fetchData exists in src/api.ts
  │
  ▼
Model API call → model returns tool_use: read_symbol({ name: "fetchData" })
  │
  ▼
Tool Registry executes read_symbol → returns function body + referenced types
  │
  ▼
Agent Loop appends tool_call + tool_result to messages
  │
  ▼
Model API call → model returns tool_use: edit_file({ path: "src/api.ts", ... })
  │
  ▼
Tool Registry executes edit_file → returns success; triggers reindexFile()
  │
  ▼
Model API call → model returns text: "I've added try/catch error handling..."
  │
  ▼
Agent Loop detects no tool_calls → returns final response to CLI
  │
  ▼
CLI displays response to user
```

## 6. Configuration

`.env` file:

```
ANTHROPIC_API_KEY=sk-ant-...
MODEL=claude-sonnet-4-20250514
MAX_STEPS=25
MAX_TOKENS=4096
WORKSPACE_ROOT=.
COMMAND_TIMEOUT_MS=30000
```

Config file (`agent.config.json`, optional):

```json
{
  "model": "claude-sonnet-4-20250514",
  "maxSteps": 25,
  "maxTokens": 4096,
  "commandTimeout": 30000,
  "commandDenylist": [],
  "confirmDestructive": true
}
```

## 7. API Format (Tool Use)

The tool schemas sent to the model follow this format (OpenAI/Anthropic compatible):

```json
{
  "name": "read_file",
  "description": "Read the contents of a file. Returns the file content with line numbers.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the file to read, relative to workspace root"
      },
      "offset": {
        "type": "number",
        "description": "Line number to start reading from (1-based, optional)"
      },
      "limit": {
        "type": "number",
        "description": "Maximum number of lines to read (optional)"
      }
    },
    "required": ["path"]
  }
}
```

The model responds with:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me read that file first." },
    {
      "type": "tool_use",
      "id": "toolu_01abc...",
      "name": "read_file",
      "input": { "path": "src/api.ts" }
    }
  ]
}
```

We respond with tool results:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01abc...",
      "content": "1|import axios from 'axios';\n2|\n3|export async function fetchData()..."
    }
  ]
}
```

## 8. Termination Policy (Implementation)

The agent loop exits when ANY of these conditions are met:

| Condition | Behavior |
|-----------|----------|
| Model returns text with no tool_calls | Normal completion — return text to user |
| `step >= maxSteps` | Return partial result + "reached step limit" message |
| Tool execution timeout | Return error + what was accomplished so far |
| User sends interrupt (Ctrl+C) | Graceful shutdown, save session state |
| Repeated identical tool calls (loop detection) | Break + report to user |

## 9. Error Handling

- **Model API errors:** Retry with exponential backoff (3 attempts), then surface error to user
- **Tool execution errors:** Return error message as tool result (model can adapt/retry)
- **File not found:** Return descriptive error (model will search for correct path)
- **Permission denied:** Return error, suggest alternative approach
- **Malformed tool input:** Return validation error as tool result

## 10. Future Extension Points

Designed into the architecture; some implemented, some not:

| Area | Status | Notes |
|------|--------|-------|
| **Model providers** | Implemented | Anthropic + OpenAI-compatible (LM Studio, etc.) |
| **Context injection** | Implemented | Code map, read_symbol, find_references, get_dependencies |
| **Plugin system** | Implemented | TypeScript, Python; npm + local discovery |
| **Index caching** | Implemented | `.mini-coder/cache/` |
| **Re-index on edit** | Implemented | write_file, edit_file trigger reindexFile |
| **Session persistence** | Not implemented | In-memory only; SQLite could be added |
| **AGENTS.md / memory** | Not implemented | Could add to system prompt |
| **Confirmation prompts** | Partial | `confirmDestructive` config; could add more |
