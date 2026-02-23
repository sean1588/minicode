# Verify Index Test Program

A minimal TypeScript project designed to verify mini-coder's indexing features:

- **Code map** — Multiple files, classes, functions, interfaces
- **read_symbol** — Functions, classes, methods, interfaces
- **find_references** — Types referenced by multiple symbols (e.g. `Task`, `Result`)
- **get_dependencies** — Clear dependency chains (e.g. `run` → `parse` → `process`)
- **Dependency edges** — `implements`, `references`, `calls`

## Structure

```
src/
  index.ts      — Entry point; main() calls Processor.run()
  types.ts      — Interfaces Task, Result, TaskRunner
  processor.ts  — Class Processor implements TaskRunner; run() calls parse()
  parser.ts    — parse() references Task, Result; calls process()
```

## How to verify

1. **Automated verification** (from mini-coder root):

   ```bash
   npm run verify-index
   ```

   Asserts: code map contents, symbol lookup, find_references, get_dependencies, implements edges.

2. **Interactive** — Run mini-coder with this directory as workspace:

   ```bash
   WORKSPACE_ROOT=./test-programs/verify-index npm run dev
   ```

   Try prompts:
   - "What does the Processor class do?" — exercises read_symbol
   - "What symbols reference the Task type?" — exercises find_references
   - "What does Processor.run depend on?" — exercises get_dependencies
   - "Show me the project structure" — exercises code map
