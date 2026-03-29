# Context Optimization for Agentic Coding

minicode's context strategy started with local AI models and smaller context windows, but the same techniques also help hosted frontier models by reducing latency, cost, and prompt bloat. This document describes the context-management strategies implemented in the current runtime.

## Default configuration

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `maxContextTokens` | `40,000` | Target token budget for session history before trimming |
| `maxToolOutputChars` | `8,000` | Max characters per tool result before truncation |
| `keepRecentMessages` | `12` | Minimum number of latest messages preserved during eviction |
| `enableFileReadDedup` | `true` | Reuses earlier `read_file` results within a turn when the same slice is still in context |
| `enableAdaptiveKeepRecent` | `true` | Scales the protected recent-message window down as context fills |
| `enableToolOutputTruncation` | `true` | Uses tool-specific truncation strategies instead of simple head-only clipping |
| `compactionThreshold` | `0.8` | Auto-compacts old messages once the session reaches 80% of the configured budget |

These can be overridden via environment variables (`MAX_CONTEXT_TOKENS`, etc.), `~/.minicode/agent.config.json`, or a workspace-level `agent.config.json`.

## How context accumulates

Every message in a session — user messages, assistant responses, tool call metadata, and tool result outputs — is stored in a single `Session` array. The entire array is sent to the model on every step. There is no separate "context buffer" vs "session storage"; whatever survives trimming IS the context.

A single `read_file` returning 8,000 characters consumes roughly 2,000 tokens. In a 40k budget, repeated full-file reads still add up quickly, which is why the runtime tries to avoid them with symbol-aware tools, file-read dedup, and trimming/compaction.

## Optimization strategies

### 1. Progressive context eviction (`Session.trim`)

**File:** `packages/agent-sdk/src/session/session.ts`

When the session exceeds `maxContextTokens`, trimming proceeds in three phases:

**Phase 1 — Shrink:** Old tool result messages (outside the protected recent window) have their content replaced with a compact one-line summary:
```
[summary: First line of output... (150 lines, 8234 chars)]
```
This preserves the fact that a tool was called and a rough sense of the result, without the full payload. Tool outputs are ephemeral — the model already extracted what it needed.

**Phase 2 — Drop:** Remove the oldest complete message chunks (assistant + tool results, or standalone messages). This is the original trimming behavior, now only triggered after shrinking has been attempted.

**Phase 3 — Emergency:** If still over budget after dropping all removable messages, shrink tool results in the protected (recent) window too.

### 2. Conversation compaction (`Session.compact` / `Session.compactWithLlm`)

**File:** `packages/agent-sdk/src/session/session.ts`

Compaction summarizes old messages into a single structured message instead of silently deleting them. There are two modes:

#### Mechanical compaction (default)

The default mode truncates messages and stitches them into a bullet-point summary:
- What the user asked (truncated to 300 chars)
- What the agent responded (truncated to 300 chars)
- Which tools were called
- Brief excerpts of tool results (100 chars)

Example:
```
[Conversation Summary — earlier messages were compacted to save context]
- User asked: refactor the auth module to use JWT tokens...
  Agent responded: I'll restructure the authentication flow...
  Agent called tools: read_symbol, edit_file
  edit_file returned: File updated successfully...
```

#### LLM-based compaction (opt-in via `compactionModel`)

When `COMPACTION_MODEL` is set (or `compactionModel` in config), compaction sends old messages to a model for intelligent summarization. The LLM produces a structured summary that preserves:
- The user's overall goal and current task
- Key decisions made and their rationale
- Files that were read, created, or modified (with paths)
- Important facts, constraints, or preferences stated by the user
- Current state of progress (what's done, what's pending)

This produces significantly better summaries than mechanical truncation because the model can identify what actually matters rather than blindly keeping the first N characters. Set `compactionModel` to any model available through your configured provider — typically the same local model you're already running (e.g. `zai-org/glm-4.7-flash`), or a smaller/faster one if available.

If the LLM summarization call fails for any reason, it automatically falls back to mechanical compaction.

**Auto-trigger:** Compaction fires automatically when the session token estimate exceeds `compactionThreshold` (default 80%) of `maxContextTokens`. This happens at the start of each step in the agent turn loop, before trimming.

**Manual trigger:** The `/compact` slash command lets users manually compact at any time. It reports stats and which method was used:
```
Compacted (LLM): 24 messages summarized, 28500 → 8200 tokens (saved 20300 tokens)
```

### 3. Thinking trace capping

**File:** `packages/agent-sdk/src/agent/agent.ts`

When the model returns both text and tool calls, the text is "thinking" — reasoning that led to the tool call decision. Previously stored verbatim, these traces accumulated hundreds of wasted tokens per step.

Now, thinking text is capped at 200 characters (head-trimmed) before being added to the session. The opening sentence captures the decision/intent; the tail (elaboration) is discarded. The full thinking text is still sent to the UI via `onUiUpdate` before capping.

Final assistant responses (no tool calls) are NOT capped — only intermediate thinking traces.

### 4. Focus-adaptive code map

**Files:** `src/indexer/code-map.ts`, `src/indexer/focus-tracker.ts`, `packages/agent-sdk/src/agent/agent.ts`

The code map is a compact project skeleton injected into the system prompt (~1,500 tokens). Previously, which symbols survived truncation was determined by a static ranking: exported > high reference count > entry points.

Now the code map dynamically adapts based on what the user is exploring:

**Focus tracking:** The agent records symbol names from tool calls to `read_symbol`, `find_references`, `get_dependencies`, and `search_code_map`. Up to 30 symbols are tracked, with most-recent having highest priority.

**Focus-aware ranking:** When generating the code map, focused symbols and their 1-hop dependency neighbors (both inbound and outbound edges in the dependency graph) are boosted above all other ranking criteria. Files containing focused symbols are also sorted to appear first.

**Per-step regeneration:** The system prompt is rebuilt each step (not just once per turn), so the code map updates as the agent explores symbols within a multi-step turn. Focus persists across turns, so subsequent user messages benefit from symbols explored in prior exchanges.

**Example:** If the user asks about the `Session` class and the agent calls `read_symbol("Session")`, the next code map will prioritize:
- `Session` itself
- `SessionMessage`, `estimateMessageTokens` (dependencies of Session)
- `CodingAgent` (which references Session via `session.trim()`)
- The files containing these symbols

### 5. File-read deduplication

**File:** `packages/agent-sdk/src/agent/agent.ts`

When `enableFileReadDedup` is enabled, repeated `read_file` calls within the same turn are short-circuited if the exact same file slice is still present in the session context. Instead of re-inserting the full file contents, the agent gets a compact reminder that the file was already read earlier in the turn.

This saves tokens in common agent loops where the model repeatedly re-reads the same file before editing.

### 6. Tool output truncation

**File:** `packages/agent-sdk/src/agent/agent.ts`

When `enableToolOutputTruncation` is enabled, minicode uses tool-specific truncation strategies. The current behavior is:

- `read_file` — never truncated, because exact file contents are needed for edits
- `run_command` — preserves the tail, where errors and final status usually appear
- `search` — keeps the head and appends a match-count footer
- other tools — fall back to simple head truncation

When truncation is disabled, the runtime falls back to a simple head-only clip at `maxToolOutputChars` (default 8,000):
```
[... truncated, 5000 more chars ...]
```

### 7. AST-indexed tools

**Files:** `src/tools/read-symbol.ts`, `src/tools/find-references.ts`, `src/tools/get-dependencies.ts`

These tools provide surgical access to code via the project index, avoiding full-file reads:
- `read_symbol`: Returns only a function/class definition + dependency context
- `find_references`: Returns only symbols that call/reference the target
- `get_dependencies`: Returns the transitive dependency cone up to N levels deep

The system prompt instructs the model to prefer these over `read_file` for code exploration.

## Token estimation

Token counts are approximated using `text.length / 4`. This is a rough heuristic — actual tokenizer output varies by model. For tight budgets, this can lead to over/under-trimming. A future improvement would be to use a tokenizer-aware counter.

## Configuration recommendations

| Model context window | Recommended `maxContextTokens` | Notes |
|---------------------|-------------------------------|-------|
| 8k | `6,000` | Very tight; lower `maxToolOutputChars` to ~4,000 |
| 16k | `12,000` | Comfortable for single-file tasks |
| 32k | `25,000` | Good for multi-file exploration |
| 64k+ | `40,000`–`60,000` | Default range; room for complex tasks |
