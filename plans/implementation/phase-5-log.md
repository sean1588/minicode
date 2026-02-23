# Phase 5 Log: Plugin Ecosystem

## What Was Done

Phase 5 enables community contributions by documenting the plugin spec, providing a template, implementing a Python proof-of-concept, and enabling npm/local plugin discovery.

### New Files

| File | Purpose |
|------|---------|
| `docs/PLUGIN_SPEC.md` | Full plugin specification: LanguagePlugin interface, IndexedSymbol/DependencyEdge schemas, step-by-step guide, testing, distribution |
| `templates/plugin-template/` | Plugin template: package.json, src/index.ts, src/types.ts, tests/, README, CI workflow |
| `src/indexer/plugins/python.ts` | Built-in Python plugin (heuristic regex parser for def/class/method) |
| `plans/implementation/phase-5-log.md` | This log |

### Modified Files

| File | Change |
|------|--------|
| `src/indexer/plugin-loader.ts` | Added pythonPlugin; implemented loadNpmPlugins (mini-coder-plugin-* from package.json) and loadLocalPlugins (.mini-coder/plugins/*.js) |
| `src/indexer/project-index.ts` | Added .py to collectSourceFiles extensions |
| `src/indexer/cache.ts` | Added .py to collectSourceFiles extensions |
| `README.md` | Context Optimization, Plugin System, Supported Languages sections |
| `tests/indexer.test.ts` | Python plugin tests; mixed project test |

### Task 5.1: Document the plugin spec ✓

- `docs/PLUGIN_SPEC.md` with LanguagePlugin, IndexedSymbol, DependencyEdge
- Step-by-step creation guide, testing, distribution (local, npm)
- Reference to TypeScript plugin source

### Task 5.2: Create plugin template ✓

- `templates/plugin-template/` with package.json, src/, tests/, README, .github/workflows/ci.yml
- No-op plugin that returns empty array for .example files
- Template builds and tests pass

### Task 5.3: Implement Python plugin ✓

- Heuristic regex parser for `def`, `async def`, `class`
- Extracts functions, classes, methods with qualified names (ClassName.methodName)
- No resolveDependencies (not required for PoC)

### Task 5.4: Enable npm and local plugin discovery ✓

- npm: Read package.json dependencies, import packages matching `mini-coder-plugin-*`
- Local: Scan `.mini-coder/plugins/*.js`, dynamic import via pathToFileURL

### Task 5.5: Update README ✓

- Context Optimization section (code map, read_symbol, find_references, get_dependencies)
- Plugin System: supported languages, installing, creating
- Link to PLUGIN_SPEC.md

---

## Acceptance

| Requirement | Status |
|-------------|--------|
| Developer can follow guide to create working plugin | ✓ |
| Template produces working no-op plugin | ✓ |
| Python plugin loads, indexes .py, code map includes Python symbols | ✓ |
| npm-installed plugin discovered | ✓ (loadNpmPlugins) |
| Local .mini-coder/plugins/*.js loaded | ✓ (loadLocalPlugins) |
| README reflects plugin system | ✓ |
| All tests pass | ✓ (68/68) |
