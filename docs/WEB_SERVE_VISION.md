# Minicode Web — An AI-Agent-Native IDE

## The Vision

Reimagine what an IDE looks like when designed from the ground up around an AI agent's mental model of a codebase. Not an IDE with AI chat bolted on — but an environment where the agent's understanding of code structure (symbols, dependencies, focus) is the primary interface, and the human and agent collaboratively navigate and modify code through that shared model.

## Core Principles

- **Symbols are first-class objects** — not just in the agent's tools, but in the UI. Symbols can be browsed, pinned, annotated, and attached to prompts the same way people attach screenshots or files today.
- **The dependency graph replaces the file tree** — the agent doesn't think in files, it thinks in symbols and relationships. The graph is the primary navigation, and files are a detail you drill into from a symbol.
- **The agent's attention is visible and steerable** — you can see what the agent is focusing on (the code map), and nudge it: pin something it's missing, unpin something irrelevant. It's collaborative navigation.
- **Prompts are workspaces, not just text** — a prompt can include text instructions, attached symbols, annotations on those symbols, and highlighted code regions. A richer input than any current coding agent gets.

## Architecture Fit

The current minicode architecture is well-suited for this:

- **`CodingAgent`** is completely UI-agnostic — it takes string input, runs the tool loop, returns results
- **`onUiUpdate` callbacks** already emit structured events (thinking, tool_call_start/end, streaming_chunk, step) — these map directly to WebSocket messages
- **`ProjectIndex`** holds all the data needed for graph visualization (symbols, dependency edges, code map rankings)
- **`ToolRegistry`** registers all tools (core + AST-based) identically regardless of UI — the web client gets the full toolset including `read_symbol`, `find_references`, `get_dependencies`, `search_code_map`
- **`focus-tracker.ts`** already tracks which symbols the agent is focusing on — can be exposed to the client
- **`afterWrite`/`afterEdit` hooks** keep the index up-to-date as the agent modifies files

## The Three Layers

### 1. Chat Interface
- Talk to the agent, see streaming responses and real-time tool activity
- **Symbol attachment** — drag symbols from the graph into the prompt composer, giving the agent full context (signature, dependencies, references) without the user having to describe it. Like @-mentioning a symbol.
- Session management (save, load, list)

### 2. Live Agent Perspective — Real-Time Code Map
- Watch the code map update in real-time as the agent explores the codebase
- See which symbols the agent is currently focusing on
- Understand what the agent "sees" at any given moment during a turn
- The code map is dynamically updated in the system prompt as the agent navigates — this is visible to the user
- **Steerable focus** — pin/unpin symbols to guide the agent's attention

### 3. Human-Driven Code Exploration — Dependency Graph
- Interactive visual dependency graph of the entire codebase
- Navigate nodes (symbols) and see code snippets where they're defined
- Browse independently of the agent as a standalone exploration tool
- Click on nodes to inspect symbol details (signature, dependencies, references)

## Feature Ideas

### Symbols as Prompt Attachments
- Drag symbols from the graph into the prompt input, like attaching a file
- The agent receives full symbol context — signature, source, dependencies, references
- Multiple symbols can be attached to a single prompt
- Creates a native, structured way to point the agent at specific code

### Symbol-Level Annotations
- Click on any node in the dependency graph and attach special instructions for the agent
- Examples: "When you touch this function, be careful about X", "This class is being deprecated, prefer Y instead"
- Turns the dependency graph into a **shared workspace** between human and agent
- Annotations persisted per-project (e.g., `.minicode/annotations.json`) to survive across sessions

### Focus Pinning
- Clicking a node "pins" it as a focus symbol
- Pinned symbols feed into the existing code map ranking system (`focus-tracker.ts`)
- The agent naturally pays more attention to pinned symbols in its context
- Users can steer the agent's attention without writing explicit instructions

### Symbol Bookmarks / Workspaces
- Save a set of pinned symbols as a named "workspace" for a particular task
- E.g., "auth refactor" = these 12 symbols, "payment flow" = these 8 symbols
- Quickly switch context between different areas of work

### Path Highlighting / Agent Graph Walking
- When the agent calls `get_dependencies`, light up the dependency cone on the graph in real-time
- Visually see the agent "walking" the graph as it explores
- When `find_references` is called, highlight all reference edges
- The graph becomes a live visualization of the agent's exploration

### Inline Diffs on the Graph
- When the agent proposes edits, show the diff right on the symbol node
- Review and accept/reject changes in the context of the graph, not just a flat diff view
- See how a change to one symbol affects its dependents visually

### Graph Diffing
- After the agent makes changes (writes/edits files), the graph updates
- Visually show what changed: new symbols, removed symbols, new/removed edges
- Understand the structural impact of agent actions at a glance

### Conversation-Linked Navigation
- Clicking a tool call in the chat (e.g., `read_symbol: Session.trim`) highlights that node on the graph
- Clicking a node on the graph scrolls to relevant mentions in the chat
- Bidirectional linking between conversation and codebase visualization

### History Replay
- Scrub through the conversation timeline and see how the agent's code map and focus evolved
- Like a time-lapse of the agent's exploration of the codebase
- Useful for understanding how the agent arrived at a solution

### Multi-Agent Views (Future)
- If multiple agents are supported in parallel, each could have its own visible focus on the same graph
- See where different agents are working simultaneously
- Coordinate multi-agent workflows visually

## Foundation: `minicode serve`

All of the above requires a server mode as the foundation.

### CLI Entry Point
- `minicode serve` or `minicode --serve` command
- Optional `--port` flag (default to something like 4567)
- Starts HTTP + WebSocket server on localhost

### API Surface (Preliminary)

**REST Endpoints:**
- `POST /chat` — send a message, get streamed response
- `GET /sessions` / `POST /sessions` — list, save, load sessions
- `GET /config` — current agent configuration
- `GET /status` — health check, project info
- `GET /symbols` — list all indexed symbols
- `GET /symbols/:id/dependencies` — dependency cone for a symbol
- `GET /symbols/:id/references` — references to a symbol
- `GET /code-map` — current code map (ranked symbols)
- `GET /graph` — full dependency graph (nodes + edges)
- `POST /focus` — pin/unpin symbols
- `POST /annotations` — attach instructions to symbols

**WebSocket:**
- Real-time streaming of `onUiUpdate` events during agent turns:
  - `thinking` — agent thinking content
  - `streaming_chunk` — text response chunks
  - `tool_call_start` / `tool_call_end` — tool activity with timing
  - `step` — step counter
- Code map updates as focus changes
- Graph updates after file modifications
- Bidirectional for confirmations (destructive command approval)

## Technical Considerations

### Concurrency
- The agent currently runs one turn at a time
- Server needs to handle this: queue requests or reject concurrent ones

### Safety / Confirmations
- `CONFIRM_DESTRUCTIVE` currently prompts via readline
- WebSocket back-channel for confirmations, or configurable auto-approve mode for serve

### Server Framework Options
- Node built-in `http` module (minimal dependencies)
- Hono (lightweight, modern)
- Fastify (performant, plugin ecosystem)

### Graph Visualization Libraries (Frontend)
- **D3 force-directed graphs** — maximum flexibility
- **Cytoscape.js** — purpose-built for graph visualization
- **React Flow** — React-native node-based UI, good for interactive graphs

### File Watching
- Watch for external file changes and re-index
- Keep graph visualization in sync with actual codebase state

## Incremental Build Path

1. **API server** — `minicode serve` with REST + WebSocket for chat, sessions, config
2. **Graph data endpoints** — expose ProjectIndex data (symbols, edges, code map)
3. **Basic web chat** — minimal React SPA with chat interface + streaming
4. **Dependency graph UI** — interactive graph visualization with symbol inspection
5. **Live code map view** — real-time agent perspective, steerable focus
6. **Symbol prompts** — attach symbols to prompts, symbol bookmarks/workspaces
7. **Symbol annotations** — click-to-annotate with agent instructions, persisted per-project
8. **Advanced features** — graph diffing, path highlighting, inline diffs, conversation-linked navigation, history replay
