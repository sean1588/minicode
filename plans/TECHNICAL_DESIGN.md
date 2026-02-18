# Technical Design Document: Custom Coding Agent MVP

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
│  └─────────────┘  └──────────┘  └───────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │  Model   │ │  Tool    │ │  Config  │
     │  Client  │ │  Registry│ │  Loader  │
     └──────────┘ └──────────┘ └──────────┘
```

## 2. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript (ESM) | Type safety, good SDK support, familiar |
| Runtime | Node.js 22+ | Stable, good for CLI + async |
| Model SDK | `@anthropic-ai/sdk` | Claude API with native tool_use support |
| CLI input | Node `readline/promises` | Zero-dep interactive input |
| Shell exec | Node `child_process` | Built-in, no extra deps |
| File ops | Node `fs/promises` | Built-in |
| Search | `ripgrep` (via shell) | Fast, respects .gitignore |
| Config | dotenv + JSON config file | Simple, no framework needed |
| Package manager | pnpm or npm | Developer preference |

## 3. Project Structure

```
coding-agent/
├── src/
│   ├── index.ts              # Entry point — CLI loop
│   ├── agent/
│   │   ├── agent.ts          # Core agent loop
│   │   ├── types.ts          # Shared types (Message, ToolCall, etc.)
│   │   └── config.ts         # Agent configuration
│   ├── prompt/
│   │   └── system-prompt.ts  # System prompt builder
│   ├── tools/
│   │   ├── registry.ts       # Tool registration + dispatch
│   │   ├── read-file.ts      # read_file tool
│   │   ├── write-file.ts     # write_file tool
│   │   ├── edit-file.ts      # edit_file (search & replace) tool
│   │   ├── search.ts         # grep/ripgrep tool
│   │   ├── list-files.ts     # directory listing tool
│   │   └── run-command.ts    # shell command tool
│   ├── session/
│   │   └── session.ts        # In-memory session history
│   ├── model/
│   │   └── client.ts         # Model API client (Claude)
│   └── safety/
│       └── guardrails.ts     # Safety checks, limits, allowlists
├── docs/
│   ├── PRD.md
│   ├── TECHNICAL_DESIGN.md
│   └── DISCUSSION_SUMMARY.md
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

#### `write_file`
```typescript
// Input: { path: string, content: string }
// Output: confirmation message
// Safety: path must be within workspace root
```

#### `edit_file`
```typescript
// Input: { path: string, old_string: string, new_string: string }
// Output: confirmation or error if old_string not found/not unique
// Safety: path within workspace, old_string must match exactly once
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
You are a coding agent. You help developers by reading, understanding,
and modifying code in their projects.

[Workspace Context]
Working directory: /path/to/project
Project type: Node.js (detected from package.json)

[Tool Descriptions]
You have the following tools available:
- read_file: Read the contents of a file...
- write_file: Create or overwrite a file...
- edit_file: Make a search-and-replace edit...
- search: Search file contents using regex...
- list_files: List directory contents...
- run_command: Execute a shell command...

[Tool Usage Guidelines]
- Always read a file before editing it
- Use search to find relevant code before making changes
- Prefer edit_file over write_file for existing files
- Run tests after making code changes when applicable

[Termination Policy]
- When your task is complete, respond with a summary of what you did
- If you cannot complete the task, explain what's blocking you
- Do not keep exploring after the task is done

[Safety Rules]
- Never modify files outside the workspace directory
- Never run destructive commands (rm -rf, etc.) without explicit confirmation
- If unsure, ask the user before proceeding
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

Thin wrapper around the Anthropic SDK:

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

## 5. Data Flow (Single Turn)

```
User types: "Add error handling to the fetchData function in src/api.ts"
  │
  ▼
CLI sends to Agent Loop
  │
  ▼
Agent Loop builds messages array:
  [system_prompt, ...history, user_message]
  │
  ▼
Model API call → model returns tool_use: read_file({ path: "src/api.ts" })
  │
  ▼
Tool Registry executes read_file → returns file contents
  │
  ▼
Agent Loop appends tool_call + tool_result to messages
  │
  ▼
Model API call → model returns tool_use: edit_file({ path: "src/api.ts", old_string: "...", new_string: "..." })
  │
  ▼
Tool Registry executes edit_file → returns success
  │
  ▼
Agent Loop appends tool_call + tool_result to messages
  │
  ▼
Model API call → model returns text: "I've added try/catch error handling to fetchData..."
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

## 7. API Format (Claude Tool Use)

The tool schemas sent to Claude follow this format:

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

These are designed into the architecture but not implemented in MVP:

- **`model/client.ts`** — swap to OpenAI, Ollama, or other providers
- **`session/session.ts`** — swap in-memory for SQLite persistence
- **`tools/registry.ts`** — add new tools without touching agent loop
- **`prompt/system-prompt.ts`** — add context injection (AGENTS.md, memory, skills)
- **`safety/guardrails.ts`** — add confirmation prompts, audit logging
