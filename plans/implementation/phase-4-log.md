# Phase 4 Log: Incremental Updates + Polish

## What Was Done

Phase 4 makes the indexer responsive to file edits, improves code map ranking, and adds a disk cache for faster startup on subsequent sessions.

### New Files

| File | Purpose |
|------|---------|
| `src/indexer/cache.ts` | `computeFileHashes`, `saveIndex`, `loadIndex` — cache index to `.mini-coder/cache/index.json` |
| `tests/cache.test.ts` | Tests for save/load round-trip and hash invalidation |
| `tests/file-tools.test.ts` | Added test: edit_file triggers reindex when projectIndex provided |

### Modified Files

| File | Change |
|------|--------|
| `src/indexer/types.ts` | Added `projectFiles`, `workspaceRoot` to ProjectIndex; added `reindexFile()` |
| `src/indexer/project-index.ts` | Implemented `reindexFile()`; exposed `projectFiles`, `workspaceRoot`; export `createProjectIndex` |
| `src/indexer/code-map.ts` | Ranking: exported > high reference count > entry points; optional `dependencyEdges`; fixed footer |
| `src/tools/write-file.ts` | Accepts optional `projectIndex`; calls `reindexFile` after successful write |
| `src/tools/edit-file.ts` | Accepts optional `projectIndex`; calls `reindexFile` after successful edit |
| `src/tools/registry.ts` | Passes `projectIndex` to write_file and edit_file |
| `src/index.ts` | Uses cache: try load, else build + save |
| `tests/indexer.test.ts` | Added `reindexFile` test |
| `.gitignore` | Added `.mini-coder/` |

### Task 4.1: Re-index on file changes

- `reindexFile(filePath, content)` removes old symbols for the file, re-runs plugin indexing, updates `projectFiles`, and re-resolves all dependency edges.
- `write_file` and `edit_file` call `reindexFile` after successful writes when `projectIndex` is available.

### Task 4.2: Token-budgeted code map ranking

- Symbols ranked by: exported first, then reference count (higher first), then entry-point files (`index.ts`).
- Footer: `... and N more symbols in M file(s)`.

### Task 4.3: Disk cache

- Cache location: `<workspace>/.mini-coder/cache/index.json`
- Invalidation: SHA-256 hash of each source file; if any hash differs, rebuild from scratch.
- Startup flow: compute hashes → try load → if null, build and save.

---

## Acceptance

| Requirement | Status |
|-------------|--------|
| After edit_file changes a function signature, code map and read_symbol reflect it | ✓ |
| Code map stays under budget; most important symbols included | ✓ |
| Second session loads from cache (faster than full index) | ✓ |
| All tests pass | ✓ (66/66) |

---

## Not Done (Task 4.4)

- Performance profiling (target: &lt;1s for mini-coder, &lt;3s for ~100 files)
- Hot-path optimization
