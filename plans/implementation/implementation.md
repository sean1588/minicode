# Implementation Breakdown: Context Optimization with Plugin Architecture

This document breaks the context optimization work into concrete, ordered tasks grouped by phase. Each task is scoped to a single file or concern. Tasks within a phase can often be parallelized; phases should be completed in order.

---

## Phase 1: Plugin Interface + Code Map (MVP)

**Goal:** Define the plugin system, build the TypeScript reference plugin, generate a code map, and inject it into the system prompt. No new agent tools yet — the model still uses `read_file` but makes better-targeted calls because it can see the project skeleton.

### Task 1.1: Define core types (`src/indexer/types.ts`)

Create the foundational types that the entire indexer system depends on.

```
New file: src/indexer/types.ts

Types to define:
  - IndexedSymbol        { name, qualifiedName, kind, filePath, startLine, endLine, signature, exported, dependencies }
  - DependencyEdge       { from, to, kind }
  - LanguagePlugin       { name, extensions, canIndex(), indexFile(), resolveDependencies?() }
  - ProjectIndex         { symbols, files, dependencyEdges, plugins, getSymbol(), getSymbolsInFile(), getDependencyCone(), getCodeMap() }
```

**Depends on:** Nothing — this is the foundation.
**Acceptance:** Types compile with no errors. Can be imported by other modules.

### Task 1.2: Implement plugin loader (`src/indexer/plugin-loader.ts`)

Build the mechanism that discovers and loads language plugins.

```
New file: src/indexer/plugin-loader.ts

Functions:
  - loadPlugins(workspaceRoot: string): Promise<LanguagePlugin[]>
    1. Load built-in plugins from src/indexer/plugins/
    2. (Future) Scan <workspace>/.mini-coder/plugins/ for local plugins
    3. (Future) Scan ~/.mini-coder/plugins/ for user plugins
    4. (Future) Discover npm packages matching mini-coder-plugin-*
    5. Return array of validated LanguagePlugin instances

  - getPluginForFile(filePath: string, plugins: LanguagePlugin[]): LanguagePlugin | undefined
    Return first plugin where canIndex(filePath) returns true
```

For Phase 1, only the built-in plugin path needs to work. The local/user/npm paths can be stubbed with TODOs.

**Depends on:** Task 1.1 (types).
**Acceptance:** `loadPlugins()` returns an array containing the TypeScript plugin. `getPluginForFile()` correctly routes `.ts`/`.tsx`/`.js`/`.jsx` files.

### Task 1.3: Implement TypeScript plugin (`src/indexer/plugins/typescript.ts`)

The reference plugin. Uses the TypeScript compiler API to extract symbols from source files.

```
New file: src/indexer/plugins/typescript.ts

Implements: LanguagePlugin

indexFile(filePath, content) → IndexedSymbol[]:
  1. ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  2. Walk AST with ts.forEachChild(), extracting:
     - FunctionDeclaration → kind: "function"
     - ClassDeclaration → kind: "class" (+ methods as kind: "method")
     - InterfaceDeclaration → kind: "interface"
     - TypeAliasDeclaration → kind: "type"
     - VariableStatement with arrow functions → kind: "function"
     - ExportAssignment / ExportDeclaration → mark exported: true
  3. For each node, capture:
     - name, qualifiedName (ClassName.methodName for methods)
     - startLine, endLine (from sourceFile.getLineAndCharacterOfPosition)
     - signature (declaration text without body)
     - exported (has export modifier or is in export statement)
     - dependencies: [] (populated in Phase 3 via resolveDependencies)

resolveDependencies: not implemented in Phase 1 (optional on interface)
```

**Depends on:** Task 1.1 (types).
**Acceptance:** Given mini-coder's own `src/agent/agent.ts`, the plugin returns `IndexedSymbol[]` containing `CodingAgent` (class), `runTurn` (method), etc., with correct line numbers and signatures.

### Task 1.4: Implement code map generator (`src/indexer/code-map.ts`)

Generates the compact text skeleton injected into the system prompt.

```
New file: src/indexer/code-map.ts

Functions:
  - generateCodeMap(symbolsByFile: Map<string, IndexedSymbol[]>, tokenBudget?: number): string

Output format:
  # Project Code Map

  src/agent/agent.ts
    class CodingAgent
      constructor(params: { config: AgentConfig; modelClient: ModelClient; toolRegistry: ToolRegistry })
      async runTurn(input: string): Promise<string>

  src/agent/config.ts
    async loadAgentConfig(cwd?: string): Promise<AgentConfig>
  ...

Token budgeting (default ~1500 tokens):
  1. Include all exported symbols first
  2. If over budget, rank by reference count (most-referenced first)
  3. Truncate with "... and N more symbols" footer
```

**Depends on:** Task 1.1 (types).
**Acceptance:** Generates a readable code map for the mini-coder project itself. Output is under 1500 tokens.

### Task 1.5: Implement project index (`src/indexer/project-index.ts`)

The top-level orchestrator that ties plugins, file scanning, and the code map together.

```
New file: src/indexer/project-index.ts

Functions:
  - buildProjectIndex(workspaceRoot: string): Promise<ProjectIndex>
    1. loadPlugins(workspaceRoot)
    2. Scan workspace for source files (respecting .gitignore, skipping node_modules)
    3. For each file, find matching plugin via getPluginForFile()
    4. Call plugin.indexFile(filePath, content)
    5. Merge all IndexedSymbol[] into unified maps
    6. (Phase 3) Call plugin.resolveDependencies() if available
    7. Return ProjectIndex with query methods

  - ProjectIndex query methods:
    - getSymbol(name): lookup by name or qualifiedName
    - getSymbolsInFile(filePath): all symbols in a file
    - getDependencyCone(symbolName, depth): (stub in Phase 1, implemented in Phase 3)
    - getCodeMap(tokenBudget): delegates to generateCodeMap()
```

**Depends on:** Tasks 1.1, 1.2, 1.3, 1.4.
**Acceptance:** `buildProjectIndex("/path/to/mini-coder")` returns a `ProjectIndex` with symbols from all `.ts` files. `getCodeMap()` returns a valid code map string.

### Task 1.6: Inject code map into system prompt

Modify the existing system prompt builder to include the code map when available.

```
Modified file: src/prompt/system-prompt.ts

Changes:
  - Accept optional codeMap parameter (string)
  - If provided, insert a "## Project Code Map" section between
    workspace context and tool descriptions
  - Keep existing prompt structure intact

Modified file: src/index.ts (or src/agent/agent.ts)

Changes:
  - At session start, call buildProjectIndex(workspaceRoot)
  - Pass index.getCodeMap() to the system prompt builder
  - Store the index for later use (Phase 2 tools)
```

**Depends on:** Task 1.5.
**Acceptance:** Running `npm run dev` shows the code map in the system prompt. Model receives project skeleton with first request.

### Task 1.7: Tests for Phase 1

```
New file: tests/indexer.test.ts

Tests:
  - TypeScript plugin extracts functions, classes, interfaces from a sample file
  - TypeScript plugin returns correct line numbers
  - TypeScript plugin handles arrow functions assigned to const
  - Plugin loader returns the built-in TypeScript plugin
  - getPluginForFile routes .ts files to TypeScript plugin
  - getPluginForFile returns undefined for .py files (no plugin)
  - Code map generator produces expected format
  - Code map respects token budget
  - buildProjectIndex works on mini-coder's own src/
```

**Depends on:** Tasks 1.1–1.5.
**Acceptance:** All tests pass. `npm test` still passes (no regressions).

---

## Phase 2: `read_symbol` Tool

**Goal:** Add a new agent tool that reads a single function/class body from the index, dramatically reducing tokens per code read.

### Task 2.1: Implement `read_symbol` tool (`src/tools/read-symbol.ts`)

```
New file: src/tools/read-symbol.ts

Tool schema:
  name: "read_symbol"
  description: "Read a specific function, class, or type definition by name.
                Returns the symbol's source code and referenced type definitions.
                Prefer this over read_file for code files."
  input_schema:
    name: string (required) — symbol name or qualified name (e.g. "parseResponse" or "CodingAgent.runTurn")
    includeBody: boolean (optional, default true) — if false, return signature only

Implementation:
  1. Look up symbol in ProjectIndex via getSymbol(name)
  2. If not found, return error message suggesting search or read_file
  3. Read the file, extract lines startLine..endLine
  4. Include a few lines before startLine to capture leading comments/decorators
  5. (Phase 3) Append referenced type definitions from dependency cone
  6. Format output with file path, line numbers, and source
```

**Depends on:** Phase 1 complete. ProjectIndex is available at runtime.
**Acceptance:** `read_symbol({ name: "parseResponse" })` returns the function body from `src/model/client.ts` with correct line numbers.

### Task 2.2: Register `read_symbol` in tool registry

```
Modified file: src/tools/registry.ts

Changes:
  - Import createReadSymbolTool from read-symbol.ts
  - Add to createDefault() tool list
  - Pass ProjectIndex reference to the tool factory

Modified file: src/index.ts

Changes:
  - Pass the ProjectIndex built in Phase 1 to the ToolRegistry
```

**Depends on:** Task 2.1.
**Acceptance:** `read_symbol` appears in tool schemas sent to the model.

### Task 2.3: Update system prompt for `read_symbol`

```
Modified file: src/prompt/system-prompt.ts

Changes:
  - Add to tool usage guidelines:
    "Use read_symbol to read specific functions or classes by name — it is
     more efficient than read_file for code. Use read_file for non-code
     files or when you need the full file."
```

**Depends on:** Task 2.2.
**Acceptance:** System prompt includes guidance to prefer `read_symbol`.

### Task 2.4: Tests for Phase 2

```
New/modified file: tests/read-symbol.test.ts

Tests:
  - read_symbol returns correct function body
  - read_symbol returns error for unknown symbol name
  - read_symbol with includeBody: false returns signature only
  - read_symbol includes leading comments
  - read_symbol appears in tool registry schemas
```

**Depends on:** Tasks 2.1–2.3.
**Acceptance:** All tests pass.

---

## Phase 3: Dependency Graph + Advanced Tools

**Goal:** Add type-aware dependency resolution to the TypeScript plugin. Implement `find_references` and `get_dependencies` tools. Enhance `read_symbol` to auto-include referenced types.

### Task 3.1: Add `resolveDependencies()` to TypeScript plugin

```
Modified file: src/indexer/plugins/typescript.ts

Changes:
  - Implement resolveDependencies(symbols, projectFiles) → DependencyEdge[]
  - Use ts.createProgram() with all project files for full type checking
  - Walk each symbol's AST node to find:
    - Import references → "imports" edges
    - Call expressions → "calls" edges
    - Type references → "references" edges
    - Heritage clauses → "extends" / "implements" edges
  - Return edges as DependencyEdge[]
```

**Depends on:** Phase 2 complete.
**Acceptance:** Given mini-coder's source, returns edges like `createModelClient → OpenAICompatibleModelClient (calls)`, `AnthropicModelClient → ModelClient (implements)`.

### Task 3.2: Implement dependency cone in ProjectIndex

```
Modified file: src/indexer/project-index.ts

Changes:
  - Implement getDependencyCone(symbolName, depth):
    1. Start with target symbol
    2. Follow dependency edges to depth D (default 2)
    3. Return: target body + referenced type definitions + called function signatures
    4. Respect a token budget — if cone is too large, truncate to signatures only
```

**Depends on:** Task 3.1.
**Acceptance:** `getDependencyCone("createModelClient", 1)` returns `AgentConfig` interface, `ModelClient` interface, `OpenAICompatibleModelClient` constructor signature, `AnthropicModelClient` constructor signature.

### Task 3.3: Enhance `read_symbol` with dependency context

```
Modified file: src/tools/read-symbol.ts

Changes:
  - After returning the symbol body, append a "## Referenced Types" section
    with type definitions from the dependency cone (signatures only)
  - Only include types the symbol directly references (depth 1)
```

**Depends on:** Task 3.2.
**Acceptance:** `read_symbol({ name: "parseResponse" })` includes `ModelResponse` and `ToolCall` interface definitions in its output.

### Task 3.4: Implement `find_references` tool

```
New file: src/tools/find-references.ts

Tool schema:
  name: "find_references"
  description: "Find all symbols that reference a given symbol."
  input_schema:
    name: string (required)

Implementation:
  1. Find all DependencyEdges where edge.to matches the symbol
  2. Return list of referencing symbols with file locations and edge kind
```

**Depends on:** Task 3.1.
**Acceptance:** `find_references({ name: "ModelResponse" })` returns all functions/classes that use `ModelResponse`.

### Task 3.5: Implement `get_dependencies` tool

```
New file: src/tools/get-dependencies.ts

Tool schema:
  name: "get_dependencies"
  description: "Get the dependency cone of a symbol — everything it depends on."
  input_schema:
    name: string (required)
    depth: number (optional, default 1)

Implementation:
  Delegates to ProjectIndex.getDependencyCone()
  Formats output as a readable dependency tree
```

**Depends on:** Task 3.2.
**Acceptance:** `get_dependencies({ name: "createModelClient" })` returns types and constructor signatures it depends on.

### Task 3.6: Register new tools + tests

```
Modified: src/tools/registry.ts — add find_references and get_dependencies
Modified: src/prompt/system-prompt.ts — add guidance for new tools
New: tests/dependency-graph.test.ts — test edge resolution
New: tests/find-references.test.ts — test reference finding
New: tests/get-dependencies.test.ts — test dependency cone
```

**Depends on:** Tasks 3.3–3.5.
**Acceptance:** All new tools appear in schemas. All tests pass.

---

## Phase 4: Incremental Updates + Polish

**Goal:** Make the indexer responsive to file edits, optimize performance, and cache for faster startup.

### Task 4.1: Re-index on file changes

```
Modified: src/tools/write-file.ts
Modified: src/tools/edit-file.ts

Changes:
  - After successful write/edit, call projectIndex.reindexFile(filePath, newContent)
  - reindexFile: re-run the plugin's indexFile() on the changed file
  - Update symbols and dependency edges in the index
  - Regenerate code map if any signatures changed

Modified: src/indexer/project-index.ts
  - Add reindexFile(filePath: string, content: string): void
```

**Depends on:** Phase 3 complete.
**Acceptance:** After `edit_file` changes a function signature, the code map and `read_symbol` reflect the new signature.

### Task 4.2: Token-budgeted code map ranking

```
Modified: src/indexer/code-map.ts

Changes:
  - Rank symbols by: exported > high reference count > entry points
  - When over token budget, include top-ranked symbols and truncate
  - Add "... and N more symbols in M files" footer
```

**Depends on:** Task 3.1 (needs dependency edges for reference counts).
**Acceptance:** Code map stays under budget even for large projects. Most important symbols are always included.

### Task 4.3: Disk cache for index

```
New file: src/indexer/cache.ts

Functions:
  - saveIndex(index: ProjectIndex, cacheDir: string): Promise<void>
  - loadIndex(cacheDir: string, fileHashes: Map<string, string>): Promise<ProjectIndex | null>
    Returns null if any file has changed since last cache

Cache location: <workspace>/.mini-coder/cache/index.json
Invalidation: hash each source file; if any hash differs, rebuild from scratch
```

**Depends on:** Phase 3 complete.
**Acceptance:** Second session start on same project loads from cache in <200ms vs ~2s for full index.

### Task 4.4: Performance profiling

```
- Profile buildProjectIndex on mini-coder itself (target: <1s)
- Profile on a larger project (~100 files, target: <3s)
- Identify and optimize hot paths (file I/O, AST walking)
- Ensure node_modules is always skipped
```

**Depends on:** Tasks 4.1–4.3.
**Acceptance:** Indexing meets the <3 second target for 100-file projects.

---

## Phase 5: Plugin Ecosystem

**Goal:** Enable community contributions. Document the spec, create a template, prove it works with a second language.

### Task 5.1: Document the plugin spec

```
New file: docs/PLUGIN_SPEC.md (or in README)

Contents:
  - LanguagePlugin interface with JSDoc comments
  - IndexedSymbol and DependencyEdge schemas
  - Step-by-step guide: how to create a plugin
  - How to test a plugin
  - How to distribute (local file, npm package)
  - Reference: TypeScript plugin source as example
```

**Depends on:** Phase 4 complete (interface is stable).
**Acceptance:** A developer unfamiliar with mini-coder can follow the guide to create a working plugin.

### Task 5.2: Create plugin template repository

```
New repo: mini-coder-plugin-template (or a directory with template files)

Contents:
  - package.json with mini-coder peer dependency
  - src/index.ts with LanguagePlugin skeleton
  - tests/ with test harness
  - README.md with setup instructions
  - .github/workflows/ci.yml for automated testing
```

**Depends on:** Task 5.1.
**Acceptance:** `npm init` from the template produces a working (no-op) plugin that loads in mini-coder.

### Task 5.3: Implement Python plugin (proof of concept)

```
New file: src/indexer/plugins/python.ts (built-in) or separate npm package

Approach (pick one):
  A. Shell out to Python's ast module via a bundled Python script
  B. Use tree-sitter-python via the node tree-sitter bindings
  C. Use a regex/heuristic parser (simplest, least accurate)

Extract:
  - def/async def → kind: "function"
  - class → kind: "class"
  - Method definitions inside classes → kind: "method"
  - Type hints if present → include in signature
  - import statements → for future dependency resolution

resolveDependencies: not required for proof of concept
```

**Depends on:** Task 5.1 (spec is documented).
**Acceptance:** Python plugin loads, indexes a sample `.py` file, and produces valid `IndexedSymbol[]`. Code map includes Python symbols alongside TypeScript symbols in a mixed-language project.

### Task 5.4: Enable npm plugin discovery

```
Modified: src/indexer/plugin-loader.ts

Changes:
  - Implement the npm discovery path:
    1. Read workspace package.json dependencies
    2. Find packages matching mini-coder-plugin-*
    3. Import and validate each as LanguagePlugin
  - Implement local plugin loading:
    1. Scan <workspace>/.mini-coder/plugins/*.js
    2. Dynamic import each file
    3. Validate exports LanguagePlugin
```

**Depends on:** Task 5.2.
**Acceptance:** An npm-installed plugin is discovered and loaded automatically. A local `.js` plugin file in `.mini-coder/plugins/` is loaded.

### Task 5.5: Update README and project documentation

```
Modified: README.md

New sections:
  - Context Optimization: explain the code map and smart tools
  - Plugin System: how it works, how to install plugins, how to create plugins
  - Supported Languages: list built-in plugins
  - Link to PLUGIN_SPEC.md for full details
```

**Depends on:** Tasks 5.1–5.4.
**Acceptance:** README reflects the current state of the project. A new developer can understand the plugin system from the README alone.

---

## Summary

| Phase | Tasks | Effort | Key Deliverable |
|---|---|---|---|
| **Phase 1** | 1.1–1.7 | ~3–4 days | Code map in system prompt, plugin interface defined |
| **Phase 2** | 2.1–2.4 | ~2–3 days | `read_symbol` tool, direct token savings |
| **Phase 3** | 3.1–3.6 | ~3–5 days | Dependency graph, `find_references`, `get_dependencies` |
| **Phase 4** | 4.1–4.4 | ~2–3 days | Incremental updates, caching, performance |
| **Phase 5** | 5.1–5.5 | ~3–5 days | Plugin ecosystem, Python proof-of-concept, docs |
| **Total** | | **~13–20 days** | Context-optimized agent platform with plugin support |
