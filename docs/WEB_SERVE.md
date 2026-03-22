# Minicode Web Serve — Feature Guide

This document covers all features shipped in `minicode serve`, the web-based interface for minicode. These were built across four development phases.

## Getting Started

```bash
minicode serve              # start on default port 4567
minicode serve --port 8080  # custom port
```

Opens:
- **Web UI** at `http://localhost:4567`
- **OpenAI-compatible API** at `http://localhost:4567/v1`
- **WebSocket** for real-time streaming at `ws://localhost:4567`

---

## Phase 1 — HTTP Server, Chat UI, OpenAI-Compatible API

### Web Chat Interface

The web UI provides a full chat interface for interacting with the agent:

- **Streaming responses** — text streams in real-time via WebSocket
- **Tool call visibility** — each tool call appears as a compact pill showing the tool name, primary argument, and elapsed time. Click to expand and see the full result.
- **Thinking indicators** — the agent's intermediate reasoning is shown in dimmed italic text
- **Markdown rendering** — agent responses render full markdown: code blocks with syntax highlighting, bold, lists, headers, blockquotes, and inline code
- **Auto-resize input** — the textarea grows as you type, up to a max height

### Session Management

Save and restore conversation sessions via the Sessions dropdown in the header:

- **Save** — click Sessions → enter an optional label → Save. Sessions persist to `~/.minicode/sessions/`
- **Load** — click Sessions → click any saved session to restore it
- **Sessions list** — shows label, message count, and save timestamp

### OpenAI-Compatible API

Any client that speaks the OpenAI Chat Completions API works out of the box:

```bash
# Non-streaming
curl http://localhost:4567/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"minicode-agent","messages":[{"role":"user","content":"list files"}]}'

# Streaming
curl http://localhost:4567/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"minicode-agent","messages":[{"role":"user","content":"explain main"}],"stream":true}'
```

- `GET /v1/models` — returns `minicode-agent`
- `POST /v1/chat/completions` — standard format, streaming and non-streaming
- Works with OpenWebUI, TypingMind, ChatGPT-Next-Web, Lobe Chat, and other OpenAI-compatible clients

### REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Agent status (ready/busy), workspace, model, provider |
| `GET` | `/api/config` | Formatted agent configuration |
| `POST` | `/api/chat` | Send a message, get response (non-streaming) |
| `GET` | `/api/sessions` | List saved sessions |
| `POST` | `/api/sessions/save` | Save current session (`{ label?: string }`) |
| `POST` | `/api/sessions/load` | Load a session (`{ label: string }`) |

### WebSocket Protocol

Connect to `ws://localhost:4567` for real-time events during agent turns:

**Client → Server:**
- `{ type: "chat", message: "..." }` — send a message
- `{ type: "cancel" }` — abort the current turn

**Server → Client:**
- `turn_start` — agent began processing
- `streaming_chunk` — text response chunk (`content` field)
- `thinking` — agent reasoning text
- `tool_call_start` — tool invocation began (`name`, `input`)
- `tool_call_end` — tool finished (`name`, `result`, `elapsedMs`)
- `step` — step counter update
- `turn_end` — agent finished (`text`, `usage`)
- `error` — error message
- `busy` — agent is already processing another turn

---

## Phase 2 — Graph Data Endpoints

REST endpoints exposing the project index for external consumption and the graph UI:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/symbols` | All indexed symbols (name, kind, file, lines, signature, exported) |
| `GET` | `/api/symbols/:name/dependencies?depth=N` | Dependency cone for a symbol |
| `GET` | `/api/symbols/:name/references` | Symbols that reference this symbol |
| `GET` | `/api/symbols/:name/source` | Source code for a symbol (extracted from file) |
| `GET` | `/api/code-map` | Ranked code map (`?budget=N` for token budget) |
| `GET` | `/api/graph` | Full dependency graph (nodes + edges) |
| `GET` | `/api/focus` | Currently pinned symbols |
| `POST` | `/api/focus` | Pin/unpin a symbol (`{ action: "pin"\|"unpin", symbol: "..." }`) |

---

## Phase 3 — Interactive Dependency Graph

The right pane of the web UI shows an interactive dependency graph powered by Cytoscape.js.

### Graph Navigation

- **Search** — type in the search bar to find symbols. Results are ranked (exported first). Click a result to add it to the graph and center on it.
- **Expand** — double-click a node to expand its 1-hop neighbors (dependencies and references)
- **Hover** — hovering a node highlights its neighborhood and fades everything else
- **Click** — single-click a node to open the detail panel

### Detail Panel

Clicking a node opens a resizable detail panel on the right showing:

1. **Symbol name and kind badge** (function, class, interface, type, variable, method)
2. **File path and line number**
3. **Action buttons** — Pin to focus, Explain (see Phase 4)
4. **Source code** — syntax-highlighted source extracted from the file
5. **Annotations** — user-attached notes (see Phase 4)
6. **Explanation** — AI-generated explanation (see Phase 4)
7. **Dependencies** — clickable list, clicking navigates to that symbol
8. **References** — clickable list of symbols that reference this one

### Focus Pinning

Pin symbols to steer the agent's attention:

- Click a node → "Pin to focus" in the detail panel
- Pinned nodes get a gold border on the graph
- Pinned symbols feed into the code map ranking — the agent naturally pays more attention to pinned symbols in its system prompt
- Unpin to remove from focus

### Agent Activity

When the agent calls symbol-aware tools (`read_symbol`, `get_dependencies`, `find_references`), the referenced node pulses with an orange highlight on the graph. If the node isn't on the graph yet, it's added automatically with its neighbors.

### Graph Toolbar

- **Fit** — zoom to fit all nodes
- **Re-layout** — re-run the force-directed layout
- **Clear** — remove all nodes from the graph

### Layout Toggle

The "Graph" button in the header toggles between split view (chat + graph) and chat-only mode. The pane divider between chat and graph is draggable.

---

## Phase 4 — Symbol Annotations + Explain

### Symbol Annotations

Attach text notes to any symbol in the project index. Annotations are injected into tool results when the agent interacts with annotated code.

**Adding annotations:**
1. Click a node on the graph to open the detail panel
2. Scroll to the Annotations section
3. Type a note in the textarea and click Add (or press Enter)
4. The note appears in the list with an × button to remove it

**How annotations reach the agent:**

Annotations use a zero-bloat injection strategy:

- **System prompt** gets only a fixed-cost one-liner: `[Annotated symbols: Foo, Bar]`
- **Tool results** get the full annotation text appended when relevant:
  - `read_symbol("Foo")` → appends `[User annotation: don't modify, stable API]`
  - `read_file("src/api.ts")` → appends `[User annotations for symbols in this file:]\n- Foo: don't modify`
  - `find_references("Foo")` and `get_dependencies("Foo")` → same as read_symbol

This way annotations only enter the context window when the agent actually touches relevant code.

**Constraints:**
- Max 500 characters per annotation
- Annotations are ephemeral per-session (not persisted to disk independently)
- Saved and restored with session save/load
- Automatically evicted when a symbol is removed from the index

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/annotations` | All annotations (`{ annotations: { symbol: [notes] } }`) |
| `GET` | `/api/symbols/:name/annotations` | Annotations for one symbol |
| `POST` | `/api/symbols/:name/annotations` | Add annotation (`{ text: "..." }`) |
| `DELETE` | `/api/symbols/:name/annotations/:index` | Remove one annotation by index |
| `DELETE` | `/api/symbols/:name/annotations` | Clear all annotations for a symbol |

### Symbol Explain

Click "Explain" in the detail panel to spawn a separate AI agent that researches and explains the symbol. This is fully independent from the chat — it doesn't affect your conversation context.

**How it works:**
1. Click Explain on any symbol
2. A spinner shows with live tool call status (e.g., `read_symbol(Foo)`) as the explain agent researches
3. Each new tool call replaces the previous status line
4. Once the agent starts responding, the tool status clears and the explanation streams in
5. When streaming finishes, the raw text is rendered as formatted markdown

The explain agent uses `read_symbol`, `get_dependencies`, and `find_references` to gather context, then produces a concise explanation covering what the symbol does, how it works, what depends on it, and key design decisions.

The explain request streams via SSE at `GET /api/symbols/:name/explain`. The connection is abortable — closing the tab or navigating away cleanly aborts the agent.

---

## Additional Improvements

### Markdown Rendering

All agent responses in the web UI (chat messages and explain output) render as formatted markdown:

- Code blocks with syntax highlighting (via highlight.js, Tokyo Night Dark theme)
- Inline code with accent coloring
- Bold, italic, headers, lists, blockquotes
- During streaming, raw text is shown for performance; markdown is rendered on completion

### Verbose Logging Fix

The `--verbose` flag works correctly in the Ink TUI (the default CLI mode). Verbose output (request details, system prompt, messages, tool arguments, responses) is routed through the Ink rendering system instead of writing directly to stderr, which previously got wiped when Ink re-rendered the terminal.
