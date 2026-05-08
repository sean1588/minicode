# minicode

> Now supports connecting to [OpenRouter](https://openrouter.ai/) account via minicode UI. Sign in with OpenRouter account. Use for free with compatible [free tier OpenRouter hosted models](https://openrouter.ai/models?q=free) from MiniMax, Nvidia, Qwen, Google, etc.

A graph-native coding agent and code exploration environment built around structural context optimization that leverages symbol-aware retrieval, dependency graphs, and targeted context. It started as a way to make local models viable under tighter context budgets, and it now also works well with hosted frontier models through the same runtime, web UI, and OpenAI-compatible serve mode. 

minicode is built on a simple bet: models perform better when you give them more useful context, not less raw context. Bloated context dilutes attention; targeted context lets the model build a structural picture of the codebase before answering.

Read operations dominate token usage in typical agent sessions; minicode addresses this by optimizing for **specific languages**. It indexes your project at startup with language plugins, injects a compact **code map** (signatures only) into the system prompt, and exposes symbol-level tools (`read_symbol`, `find_references`, `get_dependencies`) so the model can walk the code structurally instead of grepping and reading entire files. TypeScript and JavaScript support come built-in, with custom language plugins leaving room for broader language support over time.

In our own ablation on a 25-task local benchmark suite (see [`benchmarks/RESULTS-GEMMA-4.md`](benchmarks/RESULTS-GEMMA-4.md)), turning the structural tools on raises pass rate from 47% to 61% on Gemma 4 26B-A4B — a +14.7 pp lift driven mostly by **comprehension-heavy tasks** (planning and refactor work where the agent has to trace relationships across files). The tradeoff is honest: graph tools cost about 30% more tokens per task when actually used, but they buy correctness on the kinds of questions where reading whole files just runs out the model's reasoning budget without building a structural picture.

_Run `minicode serve` to get the web UI on localhost: chat, tool activity, session controls, model switching, symbol focus, annotations, and a live dependency graph._

<img width="1723" height="920" alt="Screenshot 2026-03-26 at 6 30 23 PM" src="https://github.com/user-attachments/assets/499c8dc7-cc2b-4125-abd5-32b2fc9795ea" />

## Quick Start (OpenRouter)
```bash
npm install -g @sean.holung/minicode
minicode serve
```

1. Navigate to [localhost:4567](http://localhost:4567)
2. Click Connect OpenRouter to sign in to [OpenRouter](https://openrouter.ai/) and connect account.
3. Choose a model. Choose a (free) model if on free tier. Model must support tool use.


## Quick Start (LM Studio)

```bash
# 1. Start LM Studio, load a model (e.g. [GLM 4.7 Flash](https://lmstudio.ai/models/zai-org/glm-4.7-flash)), and start the local server. May need to increase context length settings for the model loaded.

# 2. Install
npm install -g @sean.holung/minicode

# 3. Configure
#    Set your model name in ~/.minicode/.env — minicode will prompt you if this is missing.
cat > ~/.minicode/.env << 'EOF'
MODEL_PROVIDER=openai-compatible
MODEL=your-model-name
EOF
```

### How to run

`cd` to your working directory and run `minicode`.

```
cd /path/to/your/project
minicode
```

or you can also pass it an intial prompt from the start:

```bash
minicode "Add error handling to src/api.ts"
```

Start the web UI (chat, session management, project graph data):

```bash
minicode serve              # http://localhost:4567
minicode serve --port 8080  # custom port
```

The serve mode also exposes an **OpenAI-compatible API** at `/v1/chat/completions`, so you can point any client that speaks the OpenAI protocol (OpenWebUI, TypingMind, ChatGPT-Next-Web, Lobe Chat, etc.) at `http://localhost:4567/v1` and use minicode as a backend.

Run a single task and exit (useful for scripts/CI/orchestration):

```bash
minicode --oneshot "Find TODOs and summarize action items"
# short flag
minicode -1 "Refactor parseArgs and run tests"

# JSON output (for pipeline parsing)
minicode --oneshot --json "Summarize recent changes"

# Write final output to a file (suppresses terminal response output)
minicode --oneshot --out result.txt "Generate release notes"
```

Run the benchmark-friendly non-interactive entrypoint for external eval harnesses:

```bash
minicode benchmark run --prompt-file prompt.txt --out result.json
```

See [docs/BENCHMARKING.md](docs/BENCHMARKING.md) for the reproducible benchmark config/env flow.

**Requirements:** Node.js 22+, LM Studio (or any OpenAI-compatible local server), `rg` in PATH (recommended). Set `MODEL` to match the model name in LM Studio.

### Install from source

To build and install from the repository:

```bash
git clone https://github.com/sean1588/minicode.git
cd minicode
npm install
npm run install:global
```

## Features

- Interactive multi-turn CLI session
- Agent loop with model tool-use support
- In-memory session history with trimming
- Safety guardrails for file paths and shell commands
- Built-in tools: `read_file`, `write_file`, `edit_file`, `search`, `list_files`, `run_command`
- **Web UI** — `minicode serve` starts an HTTP + WebSocket server with a bundled chat client, real-time streaming, session management, and project graph data endpoints
- **OpenAI-compatible API** — any client that speaks the OpenAI protocol can use minicode as a backend at `/v1/chat/completions`
- **Context optimization:** Code map in system prompt, `read_symbol`, `find_references`, `get_dependencies`
- **Plugin system:** Extensible language support (TypeScript/JavaScript built in today)

## Context Optimization

For a deep technical walkthrough of AST parsing, dependency graph construction, code-map ranking, and tool-call orchestration, see [docs/AST_DEP_GRAPH_TOOLING.md](docs/AST_DEP_GRAPH_TOOLING.md).

For agent-loop internals (session lifecycle, tool execution, streaming, loop detection, and model client behavior), see [docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md).

For the proposed reusable package architecture and public interfaces for a standalone runtime SDK, see [docs/SDK_SPEC.md](docs/SDK_SPEC.md).

minicode replaces grep-and-read-whole-file with symbol-level navigation:

- **Code map** — A compact project skeleton (signatures only) is injected into the system prompt so the model can orient itself without reading full files.
- `read_symbol` — Read a specific function or class by name, with referenced types.
- `find_references` — Find all symbols that reference a given symbol.
- `get_dependencies` — Get the dependency cone of a symbol.

The index is cached in `~/.minicode/cache/<workspace-hash>/` for faster startup on subsequent runs. Caches are global and keyed by workspace path, so nothing is stored inside your project directories.

### Indexing and dependency graph

Indexing uses the **TypeScript compiler API** (`ts.createSourceFile`) to parse each file into an AST. It does not run `tsc` — no type-checking, no project config, just lightweight in-memory parsing.

From the AST, minicode builds a **dependency graph** of symbol relationships:

| Edge kind   | How it's inferred from the AST                          |
| ----------- | ------------------------------------------------------- |
| `calls`     | `foo()` or `new Bar()` → function/class being invoked    |
| `references`| Type annotations like `: ModelResponse`                 |
| `extends`   | `class X extends Y`                                     |
| `implements`| `class X implements Y`                                 |

The graph powers:

- **Code map ranking** — When the map is truncated, symbols with higher reference counts and entry-point files appear first.
- **`get_dependencies`** — Returns the transitive closure of what a symbol calls or references.
- **`find_references`** — Returns symbols that call or reference a given symbol.
- **`read_symbol`** — Shows "Used by", "Calls", and "Referenced Types" derived from the graph.

### Why this differs from a tree-sitter-first approach

Tree-sitter-focused agents are excellent for fast, generic syntax parsing across many languages. minicode takes a different path for TypeScript/JavaScript by using the TypeScript compiler AST to build a project symbol graph and drive graph-aware tools.

Advantages of this approach in minicode:

- **Dependency-aware navigation** — tools can follow call/type/inheritance edges (`calls`, `references`, `extends`, `implements`) instead of relying on text-only search.
- **Higher-signal context under tight budgets** — code-map ranking prioritizes exported and highly referenced symbols so key APIs survive truncation.
- **Targeted reads for local models** — symbol-level tools (`read_symbol`, `find_references`, `get_dependencies`) reduce unnecessary file reads and improve attention on relevant code.
- **Fast iterative indexing** — syntax-only AST parsing (without full type-checking) keeps startup and reindexing lightweight while preserving structural code intelligence.

## Plugin System

### Supported Languages


| Language              | Extensions                   | Plugin   |
| --------------------- | ---------------------------- | -------- |
| TypeScript/JavaScript | `.ts`, `.tsx`, `.js`, `.jsx` | Built-in |


### Installing Plugins

**npm:** Add a package matching `minicode-plugin-`* to your dependencies:

```bash
npm install minicode-plugin-go  # example
```

**Local:** Place a `.js` file in `<workspace>/.minicode/plugins/`. It must export a `LanguagePlugin` (default or named `plugin`).

### Creating Plugins

See [docs/PLUGIN_SPEC.md](docs/PLUGIN_SPEC.md) for the full specification. Quick start: copy `templates/plugin-template/` and implement `indexFile()`.

## Configuration

Configuration can come from:

1. `~/.minicode/.env` — User-level defaults (API keys, model, runtime settings)
2. Environment variables — Shell overrides for the current process

When the same key is set in both places, the exported environment variable wins.

Nothing is written inside your workspace; config and cache live under `~/.minicode/`.

### Environment variables


| Variable                | Required        | Default                    | Notes                                                                                                                                 |
| ----------------------- | --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PROVIDER`        | No              | `openai-compatible`        | `anthropic` or `openai-compatible` (aliases: `openai`, `lmstudio`, `lm-studio`)                                                       |
| `MODEL`                 | Yes             | none                       | Model name for selected provider                                                                                                      |
| `ANTHROPIC_API_KEY`     | Yes (Anthropic) | none                       | Required when `MODEL_PROVIDER=anthropic`                                                                                              |
| `OPENAI_BASE_URL`       | No              | `http://localhost:1234/v1` | Base URL for OpenAI-compatible API (LM Studio, etc.)                                                                                  |
| `OPENAI_API_KEY`        | No              | none                       | Optional for local servers; required if your endpoint enforces auth                                                                   |
| `OPENROUTER_API_KEY`    | No              | none                       | Preferred key when `OPENAI_BASE_URL` points at OpenRouter; falls back to `OPENAI_API_KEY` if unset                                  |
| `COMMAND_DENYLIST`      | No              | none                       | Optional JSON array or comma-separated regex patterns appended to the built-in destructive-command denylist                         |
| `MAX_STEPS`             | No              | `50`                       | Max agent loop iterations per user turn                                                                                               |
| `MAX_TOKENS`            | No              | `4096`                     | Max model output tokens per model call                                                                                                |
| `MODEL_TIMEOUT_SECONDS` | No              | `60`                       | Timeout waiting for a model API call to start responding before aborting and surfacing an error                                       |
| `MAX_CONTEXT_TOKENS`    | No              | `32000`                    | Approximate session history trimming target. For small models (e.g. 8k context), set lower (e.g. `6000`) to leave room for responses. |
| `MAX_TOOL_OUTPUT_CHARS` | No              | `8000`                     | Max chars per tool result before truncation. Set to `0` to disable.                                                                   |
| `WORKSPACE_ROOT`        | No              | current working directory  | Root directory tools are allowed to access (set at runtime, not typically configured)                                                  |
| `COMMAND_TIMEOUT_MS`    | No              | `30000`                    | Timeout for shell/search commands                                                                                                     |
| `MAX_FILE_SIZE_BYTES`   | No              | `1000000`                  | Read limit for `read_file`                                                                                                            |
| `CONFIRM_DESTRUCTIVE`   | No              | `true`                     | If `true`, blocks destructive shell commands unless confirmed                                                                         |
| `KEEP_RECENT_MESSAGES`  | No              | `12`                       | Minimum number of latest messages kept during trimming                                                                                |
| `LOOP_DETECTION_WINDOW` | No              | `6`                        | Window for repeated tool-call loop detection                                                                                          |
| `ENABLE_FILE_READ_DEDUP` | No             | `true`                     | Reuses earlier `read_file` results within a turn when the same file slice is still in context                                        |
| `ENABLE_ADAPTIVE_KEEP_RECENT` | No        | `true`                     | Scales `keepRecentMessages` down as context fills so trimming gets more aggressive when needed                                       |
| `ENABLE_TOOL_OUTPUT_TRUNCATION` | No      | `true`                     | Enables content-aware truncation strategies for tool output instead of simple head-only clipping                                     |
| `ENABLE_DYNAMIC_PROMPT` | No             | `false`                    | Rebuilds the system prompt and focused code map every agent step. Leave disabled for a more stable prompt prefix and better KV-cache reuse. |
| `COMPACTION_THRESHOLD`  | No              | `0.8`                      | Context fullness ratio (0–1) at which auto-compaction triggers                                                                        |
| `COMPACTION_MODEL`      | No              | none                       | Model for LLM-based compaction summaries. When set, `/compact` and auto-compaction use this model instead of mechanical truncation. Use a small, fast model (e.g. your local model). |
| `REASONING_EFFORT`      | No              | unset                      | Reasoning level for providers that support it. Valid values: `xhigh`, `high`, `medium`, `low`, `minimal`, `none`                   |


All persisted user-level settings now live in `~/.minicode/.env`. The web UI settings dialog and `/config set` both update that file directly for non-secret runtime defaults.

## Usage

Interactive mode:

```bash
npm run dev
```

With an initial task (runs the task as the first message, then stays interactive for follow-up):

```bash
npm run dev -- "Add error handling to src/api.ts and run tests"
```

Verbose mode (log prompts, model responses, and tool invocations to stderr):

```bash
npm run dev -- --verbose "Fix the bug"
npm run dev -- -v
```

One-shot mode in development:

```bash
npm run dev -- --oneshot "Fix lint errors and explain changes"
npm run dev -- --oneshot --json "Summarize TODOs"
npm run dev -- --oneshot --out result.txt "Draft changelog"
```

Interactive slash commands:

- `/help`
- `/config`
- `/compact`
- `/reasoning [level]`
- `/models`
- `/model [name]`
- `/save [label]`
- `/load [label]`
- `/sessions`
- `/exit`

### Exit codes

- `0`: Success
- `1`: Runtime failure
- `2`: CLI usage/validation error (for example, `--oneshot` without a prompt)

## Scripts

- `npm run dev` - start the CLI in TypeScript mode
- `npm run dev:ink` - start with Ink UI (same as `dev` when in a TTY; use to override `CLI_UI_MODE=legacy`)
- `npm run build` - compile TypeScript to `dist/`
- `npm run build:web` - build the bundled web client used by `minicode serve`
- `npm start` - run compiled CLI
- `npm run install:global` - build and `npm link` the CLI locally
- `npm run lint` - run ESLint on TypeScript source and tests
- `npm test` - run Node test suite
- `npm run verify-index` - run the TypeScript index verification harness
