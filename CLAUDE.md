# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is minicode

minicode is a graph-native coding agent and code exploration environment. It started as a way to make local AI models viable under tight context budgets, and now works with both local models (LM Studio, any OpenAI-compatible server) and hosted frontier models (Anthropic).

The core idea: read operations dominate token usage in agent sessions. Instead of reading entire files, minicode indexes your project at startup using the TypeScript compiler API, builds a dependency graph of symbol relationships (calls, references, extends, implements), and exposes symbol-level tools (`read_symbol`, `find_references`, `get_dependencies`) so the model reads only what it needs. A ranked code map (signatures only) is injected into the system prompt, dynamically adapting based on what the agent is currently exploring.

Three ways to use it:
- **CLI** — interactive multi-turn agent session (`minicode` or `npm run dev`)
- **Web UI** — `minicode serve` starts an HTTP + WebSocket server with chat, real-time streaming, session management, and an interactive dependency graph visualization
- **OpenAI-compatible API** — any client that speaks the OpenAI protocol can use minicode as a backend at `/v1/chat/completions`

## Product vision and direction

minicode is evolving toward an **AI-agent-native IDE** — not an IDE with chat bolted on, but an environment where the agent's understanding of code structure (symbols, dependencies, focus) IS the primary interface. The dependency graph replaces the file tree. Symbols are first-class objects that can be browsed, pinned, annotated, and attached to prompts.

Key principles:
- The agent's attention is visible and steerable (focus pinning, code map)
- Symbols flow between human and agent (annotations, graph-to-chat linking)
- Everything serves context efficiency — every feature should help the agent or user do more with less context

The web UI roadmap (see `docs/WEB_SERVE_VISION.md`) includes: live code map view, symbol prompt attachments, graph diffing, path highlighting, conversation-linked navigation, and history replay. Phases 1–3 and annotations are implemented; live code map view and symbol prompts are next.

The SDK (`packages/agent-sdk`) is being extracted so the CLI becomes one consumer among many (web app, CI bot, IDE extension, custom agent service). See `docs/SDK_SPEC.md` for the proposed package topology.

## Build commands

```bash
npm run dev                    # Build web + run CLI via tsx
npm run build                  # Full build: agent-sdk → tsc → web → chmod
npm run build:web              # Build web client only (esbuild)
npm run lint                   # ESLint (--max-warnings=0)
npm test                       # Node test runner with tsx loader
npm run verify-index           # TypeScript index verification harness
```

Run a single test:
```bash
node --test --import tsx tests/session.test.ts
```

The agent-sdk workspace must build before the root: `npm run build --workspace=packages/agent-sdk`

## Architecture

### Two-layer design

**`packages/agent-sdk`** — The reusable core. Contains `CodingAgent` (agent loop), `Session` (context management), model clients (Anthropic + OpenAI-compatible), system prompt builder, safety guardrails, and base tools (read_file, write_file, edit_file, search, list_files, run_command). UI-agnostic — takes string input, runs tool loop, returns results.

**Root `src/`** — The application layer. Builds on the SDK and adds:
- AST-based project indexing and dependency graph (`src/indexer/`)
- Graph-aware tools: read_symbol, find_references, get_dependencies, find_path, search_code_map (`src/tools/`)
- Web server with REST API, WebSocket streaming, OpenAI-compatible endpoint, MCP server (`src/serve/`)
- Ink terminal UI (`src/ui/`)
- Browser client for the web UI — vanilla JS, no framework, bundled by esbuild (`src/web/`)
- Session persistence, CLI arg parsing, config loading

### Agent turn flow

1. Config loads from: `~/.minicode/agent.config.json` (base) → `~/.minicode/.env` (overrides) → shell env vars (highest precedence). No workspace-level config.
2. Project indexed at startup (TypeScript compiler API, syntax-only — no type checking). Cached in `~/.minicode/cache/`
3. Tool registry combines SDK base tools + graph-aware tools (only when index available)
4. `CodingAgent.runTurn()` loops up to `maxSteps`: build system prompt (with focus-adaptive code map) → call model → execute tool calls → append results → repeat until model returns plain text or guard triggers
5. Loop detection (fingerprinted tool calls in a rolling window), auto-compaction (at 80% budget), progressive trimming (shrink → drop → emergency), and file-read dedup keep context under budget

### Web serve architecture

`AgentBridge` (`src/serve/agent-bridge.ts`) is the central coordinator for web mode — it owns the agent, project index, sessions, pinned symbols, annotations, and file watcher. The HTTP server delegates to it. WebSocket broadcasts structured UI events (thinking, streaming_chunk, tool_call_start/end, step) to all connected clients. The browser client at `src/web/` receives these events and renders the chat + interactive dependency graph (Cytoscape.js).

### Context optimization

This is the heart of what makes minicode different. Key mechanisms:
- **Focus-adaptive code map** — tracks which symbols the agent explores, boosts them + 1-hop neighbors in the code map ranking, regenerated each step
- **Progressive context eviction** — 3-phase trimming: shrink old tool outputs to one-line summaries → drop oldest messages → emergency shrink recent window
- **Auto-compaction** — mechanical or LLM-based summarization of old messages when context hits threshold
- **Tool output truncation** — strategy per tool (never truncate read_file, keep tail for run_command, head+count for search)
- **File-read dedup** — short-circuits repeated read_file calls within a turn
- **Thinking trace capping** — intermediate reasoning capped at 200 chars in session

See `docs/CONTEXT_OPTIMIZATION.md` for full details.

### Plugin system

Language plugins implement `LanguagePlugin` interface (in agent-sdk). TypeScript/JS is built-in. External plugins: npm packages named `minicode-plugin-*` or local `.js` files in `<workspace>/.minicode/plugins/`. Plugin discovery order: built-in → npm → local. See `docs/PLUGIN_SPEC.md`.

## Testing

Uses Node.js built-in test runner (`node:test`), not Jest/Mocha. Integration tests use `.integration.test.ts` suffix. The `pretest` script builds agent-sdk and web client automatically.

## TypeScript

Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. ESM-only with `NodeNext` resolution. JSX via `react-jsx` for Ink components. Node 22+ required.
