# Phase 2 Log: `read_symbol` Tool

## What Was Done

Phase 2 adds a new agent tool that reads a single function, class, or type definition by name — delivering only the relevant code instead of entire files.

### New Files

| File | Purpose |
|------|---------|
| `src/tools/read-symbol.ts` | Tool that looks up a symbol in the project index, reads the file, and returns the symbol's source with line numbers |
| `tests/read-symbol.test.ts` | 6 tests covering tool behavior, error handling, and registry integration |

### Modified Files

| File | Change |
|------|--------|
| `src/tools/helpers.ts` | Added `expectOptionalBoolean` for optional boolean tool inputs |
| `src/tools/registry.ts` | `createDefault(config, projectIndex?)` — accepts optional `projectIndex`; registers `read_symbol` only when index is available |
| `src/index.ts` | Builds project index before creating the tool registry; passes `projectIndex` to `createDefault` |
| `src/prompt/system-prompt.ts` | Added tool usage guidance: prefer `read_symbol` for code, use `read_file` for non-code or full-file needs |

### Tool Schema

```
name: "read_symbol"
description: "Read a specific function, class, or type definition by name..."
input_schema:
  name: string (required) — symbol name or qualified name (e.g. "parseResponse", "CodingAgent.runTurn")
  includeBody: boolean (optional, default true) — if false, return signature only
```

### Implementation Details

- Looks up symbol via `projectIndex.getSymbol(name)`
- Returns helpful error if symbol not found (suggests `search` or `read_file`)
- Includes up to 3 lines of leading context (comments, decorators) before the symbol
- Formats output with file path, line range, and line-numbered source
- `includeBody: false` returns only the signature — useful for quick lookups

---

## Why It Was Done

### The Problem

Phase 1 gave the model a code map — it could see *what* exists and *where*. But when the model needed to read actual code, it still used `read_file`, which returns entire files. A 400-line `client.ts` file sends ~4,000 tokens even when the model only needs the 30-line `parseResponse` function.

### The Approach

Let the model request a symbol by name. The index already knows the file path and line range for every symbol. We read the file, extract the relevant lines, and return only that — typically 10–20% of the file's tokens.

### Why Now

Phase 1 built the `ProjectIndex` with `getSymbol()` and `getSymbolsInFile()`. Phase 2 consumes that index. The tool is a thin layer: lookup → read file → slice lines → format. No new indexing logic required.

---

## Value to the Product

### 1. Direct Token Savings

| Operation | Before (read_file) | After (read_symbol) |
|-----------|--------------------|---------------------|
| Read `parseResponse` | ~4,000 tokens (whole client.ts) | ~500 tokens (function + context) |
| Read `CodingAgent.runTurn` | ~4,000 tokens | ~400 tokens |

Estimated **~85–90% reduction** per code read when the model targets a specific symbol.

### 2. Better Fit for Small Models

Small local models (7B–14B) have 8K–32K effective context. A few whole-file reads exhaust the window. With `read_symbol`, the model can read 5–10 symbols for the same token cost as one file — enough to understand and edit a scoped task.

### 3. Complements the Code Map

The code map tells the model *what* to read; `read_symbol` lets it read *only that*. The model sees "parseResponse is in client.ts" from the map, then calls `read_symbol({ name: "parseResponse" })` instead of `read_file({ path: "src/model/client.ts" })`.

### 4. Graceful Degradation

When indexing fails (e.g., no TypeScript files, indexing error), `read_symbol` is not registered. The agent falls back to `read_file` and works as before. No new failure modes.

### 5. Foundation for Phase 3

Phase 3 will enhance `read_symbol` to append referenced type definitions from the dependency cone. The tool interface and flow are already in place; Phase 3 adds the dependency resolution layer.

---

## Summary

Phase 2 delivers **surgical code reads** — the model can fetch a single function or class by name instead of whole files. Combined with Phase 1's code map, the agent now has both orientation (what exists, where) and efficient retrieval (read only what's needed). This is where the majority of token savings come from for context-optimized agent sessions.
