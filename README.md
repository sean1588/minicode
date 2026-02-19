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

Set `ANTHROPIC_API_KEY` in `.env` when using `MODEL_PROVIDER=anthropic`.

### Use with LM Studio (OpenAI-compatible)

Set these values in `.env`:

```bash
MODEL_PROVIDER=openai-compatible
MODEL=qwen2.5-coder-7b-instruct
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=
```

Then start your model server in LM Studio and run:

```bash
npm run dev
```

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

## Optional Configuration

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