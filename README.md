# minicode

A lightweight CLI coding agent optimized for **local models** by providing AST-based intelligent context for smaller models running on consumer hardware.

Read operations dominate token usage in typical agent sessions; minicode addresses this by optimizing for **specific languages** — indexing your project at startup with language plugins (TypeScript/JavaScript built-in) and injecting a compact **code map** (signatures only) into the system prompt, plus symbol-level tools (`read_symbol`, `find_references`, `get_dependencies`) so the model reads only what it needs instead of entire files. This keeps prompts lean enough for smaller models in the 20B range, with faster inference and better attention over the relevant code.

## Quick Start (LM Studio)

```bash
# 1. Start LM Studio, load a model (e.g. [GLM 4.7 Flash](https://lmstudio.ai/models/zai-org/glm-4.7-flash)), and start the local server. May need to increase context length settings for the model loaded.

# 2. Install
npm install -g @sean.holung/minicode

# 3. Configure for local (no API key needed)
mkdir -p ~/.minicode
cat > ~/.minicode/.env << 'EOF'
MODEL_PROVIDER=openai-compatible
MODEL=zai-org/glm-4.7-flash
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=
MAX_STEPS=50
MAX_TOKENS=4096
MAX_CONTEXT_TOKENS=24000
WORKSPACE_ROOT=.
COMMAND_TIMEOUT_MS=30000
MAX_FILE_SIZE_BYTES=1000000
CONFIRM_DESTRUCTIVE=true
KEEP_RECENT_MESSAGES=12
LOOP_DETECTION_WINDOW=6
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
- Built-in tools:
  - `read_file`
  - `write_file`
  - `edit_file`
  - `search` (ripgrep, grep fallback)
  - `list_files`
  - `run_command`
- **Context optimization:** Code map in system prompt, `read_symbol`, `find_references`, `get_dependencies`
- **Plugin system:** Extensible language support (TypeScript built-in)

## Context Optimization

For a deep technical walkthrough of AST parsing, dependency graph construction, code-map ranking, and tool-call orchestration, see [docs/AST_DEP_GRAPH_TOOLING.md](docs/AST_DEP_GRAPH_TOOLING.md).

For agent-loop internals (session lifecycle, tool execution, streaming, loop detection, and model client behavior), see [docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md).

For the proposed reusable package architecture and public interfaces for a standalone runtime SDK, see [docs/SDK_SPEC.md](docs/SDK_SPEC.md).

minicode reduces token usage by indexing your project and providing targeted tools:

- **Code map** — A compact project skeleton (signatures only) is injected into the system prompt so the model can orient itself without reading full files.
- `**read_symbol`** — Read a specific function or class by name, with referenced types.
- `**find_references**` — Find all symbols that reference a given symbol.
- `**get_dependencies**` — Get the dependency cone of a symbol.

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

Configuration can come from (later sources override earlier):

1. `**~/.minicode/.env`** — User-level defaults (API keys, model, etc.)
2. `**~/.minicode/agent.config.json**` — User-level JSON config
3. **Project `.env`** and `**agent.config.json**` in workspace root
4. Environment variables (highest precedence)

Nothing is written inside your workspace; config and cache live under `~/.minicode/`.

### Environment variables


| Variable                | Required        | Default                    | Notes                                                                                                                                 |
| ----------------------- | --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PROVIDER`        | No              | `openai-compatible`        | `anthropic` or `openai-compatible` (aliases: `openai`, `lmstudio`, `lm-studio`)                                                       |
| `MODEL`                 | No              | `zai-org/glm-4.7-flash`    | Model name for selected provider                                                                                                      |
| `ANTHROPIC_API_KEY`     | Yes (Anthropic) | none                       | Required when `MODEL_PROVIDER=anthropic`                                                                                              |
| `OPENAI_BASE_URL`       | No              | `http://localhost:1234/v1` | Base URL for OpenAI-compatible API (LM Studio, etc.)                                                                                  |
| `OPENAI_API_KEY`        | No              | none                       | Optional for local servers; required if your endpoint enforces auth                                                                   |
| `MAX_STEPS`             | No              | `50`                       | Max agent loop iterations per user turn                                                                                               |
| `MAX_TOKENS`            | No              | `4096`                     | Max model output tokens per model call                                                                                                |
| `MAX_CONTEXT_TOKENS`    | No              | `120000`                   | Approximate session history trimming target. For small models (e.g. 8k context), set lower (e.g. `6000`) to leave room for responses. |
| `MAX_TOOL_OUTPUT_CHARS` | No              | `15000`                    | Max chars per tool result before truncation. Set to `0` to disable.                                                                   |
| `WORKSPACE_ROOT`        | No              | current working directory  | Root directory tools are allowed to access                                                                                            |
| `COMMAND_TIMEOUT_MS`    | No              | `30000`                    | Timeout for shell/search commands                                                                                                     |
| `MAX_FILE_SIZE_BYTES`   | No              | `1000000`                  | Read limit for `read_file`                                                                                                            |
| `CONFIRM_DESTRUCTIVE`   | No              | `true`                     | If `true`, blocks destructive shell commands unless confirmed                                                                         |
| `KEEP_RECENT_MESSAGES`  | No              | `12`                       | Minimum number of latest messages kept during trimming                                                                                |
| `LOOP_DETECTION_WINDOW` | No              | `6`                        | Window for repeated tool-call loop detection                                                                                          |
| `COMPACTION_THRESHOLD`  | No              | `0.8`                      | Context fullness ratio (0–1) at which auto-compaction triggers                                                                        |
| `COMPACTION_MODEL`      | No              | none                       | Model for LLM-based compaction summaries. When set, `/compact` and auto-compaction use this model instead of mechanical truncation. Use a small, fast model (e.g. your local model). |


### `agent.config.json`

Create `agent.config.json` in `~/.minicode/` for user-level defaults, or in the project root for workspace-specific overrides:

```json
{
  "modelProvider": "openai-compatible",
  "model": "zai-org/glm-4.7-flash",
  "maxSteps": 50,
  "maxTokens": 4096,
  "maxContextTokens": 120000,
  "workspaceRoot": ".",
  "commandTimeout": 30000,
  "commandDenylist": [],
  "confirmDestructive": true,
  "maxFileSizeBytes": 1000000,
  "keepRecentMessages": 12,
  "loopDetectionWindow": 6,
  "openAiBaseUrl": "http://localhost:1234/v1",
  "openAiApiKey": "",
  "compactionModel": ""
}
```

Field mapping:

- `modelProvider` ↔ `MODEL_PROVIDER`
- `model` ↔ `MODEL`
- `maxSteps` ↔ `MAX_STEPS`
- `workspaceRoot` ↔ `WORKSPACE_ROOT`
- `maxTokens` ↔ `MAX_TOKENS`
- `maxContextTokens` ↔ `MAX_CONTEXT_TOKENS`
- `commandTimeout` ↔ `COMMAND_TIMEOUT_MS`
- `commandDenylist` ↔ no env equivalent (config-only)
- `confirmDestructive` ↔ `CONFIRM_DESTRUCTIVE`
- `maxFileSizeBytes` ↔ `MAX_FILE_SIZE_BYTES`
- `keepRecentMessages` ↔ `KEEP_RECENT_MESSAGES`
- `loopDetectionWindow` ↔ `LOOP_DETECTION_WINDOW`
- `openAiBaseUrl` ↔ `OPENAI_BASE_URL`
- `openAiApiKey` ↔ `OPENAI_API_KEY`
- `compactionThreshold` ↔ `COMPACTION_THRESHOLD`
- `compactionModel` ↔ `COMPACTION_MODEL`

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

### Exit codes

- `0`: Success
- `1`: Runtime failure
- `2`: CLI usage/validation error (for example, `--oneshot` without a prompt)

## Scripts

- `npm run dev` - start the CLI in TypeScript mode
- `npm run dev:ink` - start with Ink UI (same as `dev` when in a TTY; use to override `CLI_UI_MODE=legacy`)
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run compiled CLI
- `npm run lint` - run ESLint on TypeScript source and tests
- `npm test` - run Node test suite

