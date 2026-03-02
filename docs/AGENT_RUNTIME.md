# Agent Runtime: Execution Loop, Tool Calls, Session State, and Safety

This document describes how the minicode agent runtime works end-to-end, from a user message to final output.

## 1) Runtime components

The runtime is primarily composed of:

- `CodingAgent` (`src/agent/agent.ts`) — orchestrates one user turn over one or more model/tool steps.
- `Session` (`src/session/session.ts`) — stores conversation history and handles context trimming.
- `ToolRegistry` (`src/tools/registry.ts`) — exposes tool schemas and executes tool calls safely.
- `ModelClient` implementations (`src/model/client.ts`) — transport for Anthropic or OpenAI-compatible providers.
- Prompt builder (`src/prompt/system-prompt.ts`) — builds the system prompt from config, tools, and code map.

## 2) Turn lifecycle (`CodingAgent.runTurn`)

A single turn follows this sequence:

1. Append user message to session.
2. Build tool schemas from `ToolRegistry`.
3. Build optional code map from project index.
4. Build a system prompt that includes workspace context, available tools, and guidance.
5. Loop up to `maxSteps`:
   - Enforce step limit guard.
   - Trim session for context budget.
   - Call model with system prompt + session + tool schemas.
   - If no tool calls: return assistant text and finish turn.
   - If tool calls exist:
     - Persist assistant message/tool call metadata in session.
     - Execute each tool.
     - Append each tool result as a `role: "tool"` session message.
     - Continue loop for next model step.
6. If step limit is reached, return a stop message to prevent infinite loops.

## 3) Session and context management

The session tracks all message roles used by tool-using chat:

- `user`
- `assistant` (including tool-call intents)
- `tool` (results tied to `toolCallId`)

Before each model request, the runtime calls `session.trim(maxContextTokens, keepRecentMessages)` to keep the most recent messages while reducing approximate token load.

This keeps long-running conversations from exceeding model context while preserving near-term continuity.

## 4) Tool registration and execution

`ToolRegistry.createDefault()` always registers core file/shell tools and conditionally adds code-intelligence tools when a `ProjectIndex` is available:

- Core: `read_file`, `write_file`, `edit_file`, `search`, `list_files`, `run_command`
- Indexed: `read_symbol`, `find_references`, `get_dependencies`, `search_code_map`

Execution model:

- Tool requests are looked up by name.
- Inputs are validated as JSON objects.
- Tool errors are caught and returned as structured tool error strings.

This keeps failures visible to the model while avoiding runtime crashes.

## 5) Loop detection and runtime guardrails

`CodingAgent` uses a deterministic fingerprint for each tool call (`name + stable-serialized input`) and keeps a rolling window. If an identical call appears repeatedly (3+ times in the detection window), the runtime stops with a loop-protection message.

Additional protections:

- Step count hard limit (`maxSteps`)
- Tool output truncation (`maxToolOutputChars`)
- Path/command guardrails enforced inside tool implementations and safety utilities

## 6) Progress, streaming, and UI updates

The runtime can emit progress events through callbacks:

- `onProgress` for concise textual progress
- `onUiUpdate` for structured UI events:
  - `step`
  - `thinking`
  - `streaming_chunk`
  - `tool_call_start`
  - `tool_call_end`

For OpenAI-compatible providers, streaming token chunks can be forwarded in real time while the response is being assembled.

## 7) Model-client interactions

### Anthropic path

- Converts session messages to Anthropic message blocks.
- Encodes tool calls as `tool_use` blocks.
- Parses returned text + `tool_use` blocks into internal `ModelResponse`.
- Wraps request in retry logic with exponential backoff.

### OpenAI-compatible path

- Builds Chat Completions payload with:
  - `messages`
  - `tools` (`type: "function"`, JSON schema parameters)
  - `tool_choice: "auto"`
- Supports both non-streaming and SSE-like streaming parsing.
- Reassembles partial streamed function-call arguments before parsing JSON.
- Normalizes provider finish reasons to internal stop reasons.

## 8) Why this architecture works for coding workflows

- **Tool-first loop:** The model can repeatedly inspect/edit/run as needed instead of hallucinating code state.
- **Session persistence:** Multi-step plans stay coherent across tool calls.
- **Indexed navigation:** When project index exists, symbol-level tools reduce irrelevant file reads and token cost.
- **Hard stops:** Loop detection + max steps prevent runaway agents.
- **Provider abstraction:** Same runtime behavior across Anthropic and OpenAI-compatible backends.
