# mini-coder

MVP autonomous coding agent CLI implemented from `plans/PRD.md` and
`plans/TECHNICAL_DESIGN.md`.

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

## Requirements

- Node.js 22+
- Anthropic API key (for Anthropic provider)
- OpenAI-compatible endpoint (for local/remote OpenAI-style providers, e.g. LM Studio)
- `rg` available in PATH (recommended for fast search)

## Setup

```bash
npm install
cp .env.example .env
```

## Configuration

Configuration can come from:

1. Environment variables (`.env`)
2. `agent.config.json` in repository root
3. Built-in defaults

Precedence is: **env vars override `agent.config.json`**, and both override defaults.

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
| `MAX_CONTEXT_TOKENS` | No | `120000` | Approximate session history trimming target |
| `WORKSPACE_ROOT` | No | current working directory | Root directory tools are allowed to access |
| `COMMAND_TIMEOUT_MS` | No | `30000` | Timeout for shell/search commands |
| `MAX_FILE_SIZE_BYTES` | No | `1000000` | Read limit for `read_file` |
| `CONFIRM_DESTRUCTIVE` | No | `false` | If `true`, blocks destructive shell commands unless confirmed |
| `KEEP_RECENT_MESSAGES` | No | `12` | Minimum number of latest messages kept during trimming |
| `LOOP_DETECTION_WINDOW` | No | `6` | Window for repeated tool-call loop detection |

### `agent.config.json`

Create `agent.config.json` in the project root to override defaults:

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

Single task mode:

```bash
npm run dev -- "Add error handling to src/api.ts and run tests"
```

Build and run compiled output:

```bash
npm run build
npm start
```

## Scripts

- `npm run dev` - start the CLI in TypeScript mode
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