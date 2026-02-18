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
- Anthropic API key
- `rg` available in PATH (recommended for fast search)

## Setup

```bash
npm install
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`.

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
  "model": "claude-sonnet-4-20250514",
  "maxSteps": 25,
  "maxTokens": 4096,
  "maxContextTokens": 120000,
  "commandTimeout": 30000,
  "commandDenylist": [],
  "confirmDestructive": false,
  "maxFileSizeBytes": 1000000,
  "keepRecentMessages": 12,
  "loopDetectionWindow": 6
}
```

## Scripts

- `npm run dev` - start the CLI in TypeScript mode
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run compiled CLI
- `npm test` - run Node test suite