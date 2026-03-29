# Agent Runtime: Execution Loop, Tool Calls, Session State, and Safety

This document describes how the minicode agent runtime works end-to-end, from a user message to final output.

## 1) Runtime components

The runtime is primarily composed of:

- `CodingAgent` (`packages/agent-sdk/src/agent/agent.ts`) — orchestrates one user turn over one or more model/tool steps.
- `Session` (`packages/agent-sdk/src/session/session.ts`) — stores conversation history and handles trimming and compaction.
- SDK `ToolRegistry` (`packages/agent-sdk/src/tools/registry.ts`) — exposes the core file/shell tools and executes them safely.
- minicode `createToolRegistry` (`src/tools/registry.ts`) — layers graph-aware tools on top of the SDK registry when a project index is available.
- `ModelClient` implementations (`packages/agent-sdk/src/model/client.ts`) — transport for Anthropic or OpenAI-compatible providers.
- Prompt builder (`packages/agent-sdk/src/prompt/system-prompt.ts`) — builds the system prompt from config, tools, and code map.
- Config and indexing adapters (`src/agent/config.ts`, `src/indexer/project-index.ts`) — load runtime config and prepare the project index used by the CLI and serve mode.

## 2) Turn lifecycle (`CodingAgent.runTurn`)

A single turn follows this sequence:

1. Append user message to session.
2. Build tool schemas from the current tool registry.
3. Loop up to `maxSteps`:
   - Enforce step limit guard.
   - Optionally auto-compact when context exceeds `compactionThreshold`.
   - Trim session for context budget, with adaptive `keepRecentMessages` when enabled.
   - Build a fresh system prompt, including the current code map and any focus-symbol boosts.
   - Call model with system prompt + session + tool schemas.
   - If no tool calls: return assistant text and finish turn.
   - If tool calls exist:
     - Persist assistant message/tool call metadata in session.
     - Execute each tool.
     - Deduplicate repeated `read_file` calls within the same turn when enabled and the earlier file slice is still present in context.
     - Apply content-aware tool output truncation when enabled.
     - Record focus symbols from graph-aware tool calls so subsequent code maps stay aligned with the current area of work.
     - Append each tool result as a `role: "tool"` session message.
     - Continue loop for next model step.
4. If step limit is reached, return a stop message to prevent infinite loops.

## 3) Session and context management

The session tracks all message roles used by tool-using chat:

- `user`
- `assistant` (including tool-call intents)
- `tool` (results tied to `toolCallId`)

Before each model request, the runtime may compact old messages and then calls `session.trim(maxContextTokens, keepRecentMessages)` to keep the most recent messages while reducing approximate token load.

This keeps long-running conversations from exceeding model context while preserving near-term continuity.

## 4) Tool registration and execution

At the SDK layer, `ToolRegistry.createDefault()` registers the core file/shell tools:

- Core: `read_file`, `write_file`, `edit_file`, `search`, `list_files`, `run_command`

At the minicode application layer, `src/tools/registry.ts` wraps those and conditionally adds code-intelligence tools when a `ProjectIndex` is available:

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
- Optional file-read deduplication inside a turn
- Compaction and trimming before prompts exceed the budget
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
