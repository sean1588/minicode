# minicode

A lightweight CLI coding agent built for **local LLMs** running on consumer hardware by providing AST-based intelligent context for small local models. Read operations dominate token usage in typical agent sessions; minicode addresses this by optimizing for **specific languages** — indexing your project at startup with language plugins (TypeScript/JavaScript built-in) and injecting a compact **code map** (signatures only) into the system prompt, plus symbol-level tools (`read_symbol`, `find_references`, `get_dependencies`) so the model reads only what it needs instead of entire files. This keeps prompts lean enough for smaller models in the 20B range, with faster inference and better attention over the relevant code.

## Quick Start (LM Studio)

```bash
# 1. Start LM Studio, load a model (e.g. Qwen2.5-Coder, CodeLlama), and start the local server

# 2. Clone and install
git clone https://github.com/sean1588/minicode.git
cd minicode
npm install

# 3. Configure for local (no API key needed)
mkdir -p ~/.minicode
cat > ~/.minicode/.env << 'EOF'
MODEL_PROVIDER=openai-compatible
MODEL=zai-org/glm-4.7-flash
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=
MAX_STEPS=50
MAX_TOKENS=4096
MAX_CONTEXT_TOKENS=120000
WORKSPACE_ROOT=.
COMMAND_TIMEOUT_MS=30000
MAX_FILE_SIZE_BYTES=1000000
CONFIRM_DESTRUCTIVE=false
KEEP_RECENT_MESSAGES=12
LOOP_DETECTION_WINDOW=6
EOF

# 4. Install globally (build + npm link)
npm run install:global

# 5. Run from your project directory
cd /path/to/your/project
minicode
```

With an initial task:

```bash
minicode "Add error handling to src/api.ts"
```

**Requirements:** Node.js 22+, LM Studio (or any OpenAI-compatible local server), `rg` in PATH (recommended). Set `MODEL` to match the model name in LM Studio.

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

minicode reduces token usage by indexing your project and providing targeted tools:

- **Code map** — A compact project skeleton (signatures only) is injected into the system prompt so the model can orient itself without reading full files.
- **`read_symbol`** — Read a specific function or class by name, with referenced types.
- **`find_references`** — Find all symbols that reference a given symbol.
- **`get_dependencies`** — Get the dependency cone of a symbol.

The index is cached in `~/.minicode/cache/<workspace-hash>/` for faster startup on subsequent runs. Caches are global and keyed by workspace path, so nothing is stored inside your project directories.

## Plugin System

### Supported Languages

| Language | Extensions | Plugin |
|----------|------------|--------|
| TypeScript/JavaScript | `.ts`, `.tsx`, `.js`, `.jsx` | Built-in |

### Installing Plugins

**npm:** Add a package matching `minicode-plugin-*` to your dependencies:

```bash
npm install minicode-plugin-go  # example
```

**Local:** Place a `.js` file in `<workspace>/.minicode/plugins/`. It must export a `LanguagePlugin` (default or named `plugin`).

### Creating Plugins

See [docs/PLUGIN_SPEC.md](docs/PLUGIN_SPEC.md) for the full specification. Quick start: copy `templates/plugin-template/` and implement `indexFile()`.

## Configuration

Configuration can come from (later sources override earlier):

1. **`~/.minicode/.env`** — User-level defaults (API keys, model, etc.)
2. **`~/.minicode/agent.config.json`** — User-level JSON config
3. **Project `.env`** and **`agent.config.json`** in workspace root
4. Environment variables (highest precedence)

Nothing is written inside your workspace; config and cache live under `~/.minicode/`.

### Provider quick start

Anthropic:

```bash
MODEL_PROVIDER=anthropic
MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...
```

OpenAI-compatible (LM Studio/local servers):

```bash
MODEL_PROVIDER=openai-compatible
MODEL=qwen2.5-coder-7b-instruct
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=
```

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MODEL_PROVIDER` | No | `anthropic` | `anthropic` or `openai-compatible` (aliases: `openai`, `lmstudio`, `lm-studio`) |
| `MODEL` | No | `claude-sonnet-4-20250514` | Model name for selected provider |
| `ANTHROPIC_API_KEY` | Yes (Anthropic) | none | Required when `MODEL_PROVIDER=anthropic` |
| `OPENAI_BASE_URL` | No | `http://localhost:1234/v1` | Base URL for OpenAI-compatible API (LM Studio, etc.) |
| `OPENAI_API_KEY` | No | none | Optional for local servers; required if your endpoint enforces auth |
| `MAX_STEPS` | No | `25` | Max agent loop iterations per user turn |
| `MAX_TOKENS` | No | `4096` | Max model output tokens per model call |
| `MAX_CONTEXT_TOKENS` | No | `120000` | Approximate session history trimming target. For small models (e.g. 8k context), set lower (e.g. `6000`) to leave room for responses. |
| `MAX_TOOL_OUTPUT_CHARS` | No | `15000` | Max chars per tool result before truncation. Set to `0` to disable. |
| `WORKSPACE_ROOT` | No | current working directory | Root directory tools are allowed to access |
| `COMMAND_TIMEOUT_MS` | No | `30000` | Timeout for shell/search commands |
| `MAX_FILE_SIZE_BYTES` | No | `1000000` | Read limit for `read_file` |
| `CONFIRM_DESTRUCTIVE` | No | `false` | If `true`, blocks destructive shell commands unless confirmed |
| `KEEP_RECENT_MESSAGES` | No | `12` | Minimum number of latest messages kept during trimming |
| `LOOP_DETECTION_WINDOW` | No | `6` | Window for repeated tool-call loop detection |

### `agent.config.json`

Create `agent.config.json` in `~/.minicode/` for user-level defaults, or in the project root for workspace-specific overrides:

```json
{
  "modelProvider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "maxSteps": 25,
  "maxTokens": 4096,
  "maxContextTokens": 120000,
  "commandTimeout": 30000,
  "commandDenylist": [],
  "confirmDestructive": false,
  "maxFileSizeBytes": 1000000,
  "keepRecentMessages": 12,
  "loopDetectionWindow": 6,
  "openAiBaseUrl": "http://localhost:1234/v1",
  "openAiApiKey": ""
}
```

Field mapping:

- `modelProvider` ↔ `MODEL_PROVIDER`
- `model` ↔ `MODEL`
- `maxSteps` ↔ `MAX_STEPS`
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


## Scripts

- `npm run dev` - start the CLI in TypeScript mode
- `npm run dev:ink` - start with Ink UI (same as `dev` when in a TTY; use to override `CLI_UI_MODE=legacy`)
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run compiled CLI
- `npm run lint` - run ESLint on TypeScript source and tests
- `npm test` - run Node test suite

## Continuous Integration

GitHub Actions workflow: `.github/workflows/ci.yml`

- Runs on every push and pull request
- Executes:
  - `npm run lint`
  - `npm test`