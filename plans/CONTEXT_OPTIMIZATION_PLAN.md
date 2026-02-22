# Context Optimization Plan: AST-Based Intelligent Context for Small Models

## 1. Problem Statement

Current AI coding agent frameworks send entire source files to the model whenever the agent reads code. For a typical 300-line TypeScript file, that is ~3,000–5,000 tokens — even when the agent only needs to understand or edit a single function. In a multi-step agent loop where the model reads 5–10 files, context fills quickly with irrelevant code.

This is tolerable for frontier models with 200K+ context windows and strong long-range attention. It is **not** tolerable for small local models (7B–14B parameters) where:

- Effective context windows are 8K–32K tokens in practice
- Attention quality degrades significantly with context length — even with perfect retrieval, models lose 13–85% accuracy as input grows (arXiv:2510.05381)
- The "Lost in the Middle" effect means information in the center of long contexts is effectively invisible (Liu et al., 2023)
- Inference speed is proportional to context length on consumer hardware

Read operations consume **67–76% of total tokens** in typical coding agent sessions (SWE-Pruner, arXiv:2601.16746). Reducing read context is the single highest-leverage optimization for making small models viable coding agents.

## 2. Prior Art

### 2.1 Aider — Tree-Sitter Repo Map

Aider uses tree-sitter to generate a "repo map": a compact skeleton of the codebase showing class names, function signatures, and their relationships.

- **Technique:** tree-sitter AST parsing → graph ranking algorithm → token-budgeted map
- **Granularity:** File-level (nodes are files, edges are dependencies)
- **Strengths:** Language-agnostic, proven effective, included in every request
- **Limitations:** No type information, file-level granularity wastes tokens on large files, cannot resolve call graphs or type dependencies

Reference: https://aider.chat/2023/10/22/repomap.html

### 2.2 SWE-Pruner — Neural Context Skimmer

Academic framework that trains a 0.6B parameter model to selectively prune code lines based on a task-specific goal.

- **Technique:** Goal formulation → learned line-level relevance scoring → pruning
- **Granularity:** Line-level
- **Strengths:** Task-aware, 23–54% token reduction with no performance loss
- **Limitations:** Requires a separate neural model, training data, and GPU inference for the skimmer itself — impractical for resource-limited local setups

Reference: arXiv:2601.16746

### 2.3 Roo Code — Tree-Sitter Parsing

Uses tree-sitter for code understanding, claims ~50% system prompt reduction.

- **Technique:** tree-sitter parsing + custom prompt optimization
- **Strengths:** Supports local models, VS Code integration
- **Limitations:** Less documented than Aider's approach, still file-level

### 2.4 Gap

No existing tool combines:
- **Function-level granularity** (not file-level)
- **Resolved type information** (not just syntax)
- **Dependency cone extraction** (only the subgraph a symbol depends on)
- **Zero extra model overhead** (pure static analysis, no neural skimmer)

This is the gap we target.

## 3. Proposed Approach

Build a **plugin-based indexer platform** that uses language-specific parsers to construct a type-aware code index at function/class granularity. The agent receives a compact code map in its system prompt and uses specialized tools to fetch only the code it needs. Each language is supported by a **LanguagePlugin** — a module that implements a defined interface for extracting symbols and dependencies from source files.

The first (reference) plugin uses the **TypeScript compiler API** (`typescript` package — already a devDependency). The plugin interface is designed so that community contributors can add support for Python, Go, Rust, and other languages without touching the agent core.

### 3.1 Why a Plugin Architecture

The core insight — that code has deterministic structure exploitable for context pruning — applies to every language with a parser. But the *best* parser differs per language:

- **TypeScript/JavaScript:** The TS compiler API provides full type resolution, call graphs, and import resolution — far richer than generic parsers.
- **Python:** Python's built-in `ast` module or tree-sitter gives function/class extraction; type stubs (`.pyi`) and tools like pyright add type information.
- **Go:** `go/parser` and `go/types` provide a complete type-checked AST natively.
- **Rust:** `syn` or rust-analyzer APIs provide deep type and trait resolution.

A one-size-fits-all approach (e.g., tree-sitter for everything) sacrifices depth. A hardcoded multi-language approach doesn't scale. The plugin architecture gives each language its best-in-class parser while keeping the agent core language-agnostic.

### 3.2 Why the TypeScript Compiler API (Reference Plugin)

| Capability | tree-sitter | TS Compiler API |
|---|---|---|
| Parse speed | Faster | Slower (acceptable for indexing) |
| Language coverage | 100+ languages | TypeScript/JavaScript only |
| Type resolution | No | Full type checking |
| Call graph | No | Yes (via type checker) |
| Import resolution | Text-based only | Full module resolution |
| Cross-file references | Limited | Complete |

The TypeScript plugin serves as the reference implementation that proves the interface is sufficient. It demonstrates the maximum depth achievable when a plugin has access to a full type checker.

### 3.3 The LanguagePlugin Interface

Every plugin implements the same contract:

```typescript
interface LanguagePlugin {
  /** Unique plugin identifier, e.g. "typescript", "python", "rust" */
  name: string;

  /** File extensions this plugin handles, e.g. [".ts", ".tsx", ".js", ".jsx"] */
  extensions: string[];

  /** Whether this plugin can index a given file */
  canIndex(filePath: string): boolean;

  /** Extract symbols from a single file's content */
  indexFile(filePath: string, content: string): IndexedSymbol[];

  /**
   * Resolve cross-file dependencies between symbols.
   * Optional — if not implemented, the core falls back to import-path heuristics.
   */
  resolveDependencies?(
    symbols: IndexedSymbol[],
    projectFiles: Map<string, string>,
  ): DependencyEdge[];
}
```

Key design choices that make this community-friendly:

- **`indexFile` works on a single file** — plugin authors don't need to manage multi-file state or understand the agent internals
- **`resolveDependencies` is optional** — a basic plugin that just extracts signatures is still useful; the core can fall back to import-path matching
- **`content` is passed in** — the plugin doesn't need file system access, making it testable and sandboxable
- **Output is plain data objects** — no classes to extend, no framework to learn

### 3.4 Plugin Discovery and Distribution

Plugins can be distributed and loaded through three mechanisms:

1. **Built-in plugins** (`src/indexer/plugins/`): Ship with mini-coder. The TypeScript plugin is the first built-in.
2. **Local plugins** (`~/.mini-coder/plugins/` or `<project>/.mini-coder/plugins/`): `.ts` or `.js` files that export a `LanguagePlugin`. No publishing required — good for personal or team-internal plugins.
3. **npm packages** (`mini-coder-plugin-<language>`): Published to npm following a naming convention. The core discovers installed packages by convention at startup.

The plugin loader checks in order: built-in → local project → local user → npm packages. For a given file, the first plugin whose `canIndex()` returns true handles it. If no plugin matches, the file is treated as plain text (standard `read_file` behavior).

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Runtime                            │
│                                                              │
│  System Prompt                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  [identity] + [code map] + [tool descriptions]         │  │
│  │                                                        │  │
│  │  Code Map (auto-generated, ~500–1500 tokens):          │  │
│  │    src/agent/agent.ts                                  │  │
│  │      class CodingAgent                                 │  │
│  │        runTurn(input: string): Promise<string>         │  │
│  │    src/model/client.ts                                 │  │
│  │      class OpenAICompatibleModelClient                 │  │
│  │        chat(params: ChatParams): Promise<ModelResponse>│  │
│  │      class AnthropicModelClient                        │  │
│  │        chat(params: ChatParams): Promise<ModelResponse>│  │
│  │    ...                                                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Model requests: read_symbol("parseResponse")                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Indexer resolves symbol → returns:                     │  │
│  │    1. Function body (30 lines, ~300 tokens)            │  │
│  │    2. Referenced types (ModelResponse, ToolCall)        │  │
│  │    3. Called function signatures (only signatures)      │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 New Module: `src/indexer/`

```
src/indexer/
├── types.ts              # LanguagePlugin interface, IndexedSymbol, DependencyEdge
├── project-index.ts      # Language-agnostic index: aggregates plugin output, exposes query API
├── code-map.ts           # Language-agnostic skeleton generator for system prompt
├── plugin-loader.ts      # Detect project languages, discover and load plugins
└── plugins/
    └── typescript.ts     # Reference plugin: TS compiler API-based extraction
```

The separation is deliberate: everything outside `plugins/` is language-agnostic. Adding a new language means adding a single file to `plugins/` (or installing an npm package) — no changes to the core indexer, tools, or agent loop.

### 4.2 Core Types

```typescript
interface LanguagePlugin {
  name: string;
  extensions: string[];
  canIndex(filePath: string): boolean;
  indexFile(filePath: string, content: string): IndexedSymbol[];
  resolveDependencies?(
    symbols: IndexedSymbol[],
    projectFiles: Map<string, string>,
  ): DependencyEdge[];
}

interface IndexedSymbol {
  name: string;
  qualifiedName: string;     // e.g. "MyClass.myMethod" — unique within project
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;         // e.g. "async chat(params: ChatParams): Promise<ModelResponse>"
  exported: boolean;
  dependencies: string[];    // qualified names of referenced symbols
}

interface DependencyEdge {
  from: string;              // qualified name
  to: string;                // qualified name
  kind: "calls" | "imports" | "extends" | "implements" | "references";
}

interface ProjectIndex {
  symbols: Map<string, IndexedSymbol>;
  files: Map<string, IndexedSymbol[]>;
  dependencyEdges: DependencyEdge[];
  plugins: LanguagePlugin[];  // loaded plugins for this project

  getSymbol(name: string): IndexedSymbol | undefined;
  getSymbolsInFile(filePath: string): IndexedSymbol[];
  getDependencyCone(symbolName: string, depth?: number): IndexedSymbol[];
  getCodeMap(tokenBudget?: number): string;
}
```

### 4.3 Component Details

#### `plugin-loader.ts` — Plugin Discovery

Discovers and loads language plugins at session start:

1. Scan built-in plugins (`src/indexer/plugins/*.ts`)
2. Scan local project plugins (`<workspace>/.mini-coder/plugins/`)
3. Scan user plugins (`~/.mini-coder/plugins/`)
4. Scan installed npm packages matching `mini-coder-plugin-*`
5. Validate each plugin implements the `LanguagePlugin` interface
6. Register plugins, resolving extension conflicts (first match wins)

```typescript
async function loadPlugins(workspaceRoot: string): Promise<LanguagePlugin[]> {
  const plugins: LanguagePlugin[] = [];

  // Built-in plugins
  plugins.push(new TypeScriptPlugin());

  // Local project plugins
  const projectPluginDir = path.join(workspaceRoot, ".mini-coder", "plugins");
  plugins.push(...await loadPluginsFromDir(projectPluginDir));

  // User plugins
  const userPluginDir = path.join(os.homedir(), ".mini-coder", "plugins");
  plugins.push(...await loadPluginsFromDir(userPluginDir));

  // npm plugins (mini-coder-plugin-*)
  plugins.push(...await loadNpmPlugins(workspaceRoot));

  return plugins;
}
```

#### `plugins/typescript.ts` — Reference Plugin (TypeScript)

The built-in TypeScript plugin uses the TS compiler API to provide deep, type-aware indexing. It walks the AST using `ts.forEachChild()` and extracts:

- **Function declarations:** Name, parameters (with types), return type, line range
- **Class declarations:** Name, extends/implements, method signatures, property types
- **Interface/type declarations:** Name, members with types
- **Exported variables:** Name, type annotation or inferred type
- **Arrow functions assigned to `const`:** Treated as named functions

For each symbol, the plugin captures the **signature** (declaration line without the body) and the **line range** (for later surgical extraction).

```typescript
// Example: the TypeScript plugin's indexFile implementation
function indexFile(filePath: string, content: string): IndexedSymbol[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const symbols: IndexedSymbol[] = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.text,
        qualifiedName: node.name.text,
        kind: "function",
        filePath,
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        signature: extractSignature(node, sourceFile),
        exported: hasExportModifier(node),
        dependencies: extractDependencies(node),
      });
    }
    // ... similar for ClassDeclaration, InterfaceDeclaration, TypeAliasDeclaration
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}
```

The TypeScript plugin also implements `resolveDependencies()` using `ts.createProgram()` and the type checker to resolve:

1. **Import edges:** `import { X } from "./module"` → edge from current file symbols to X
2. **Call edges:** Function A calls function B → edge A→B (resolved through the type checker, not text matching)
3. **Type reference edges:** Function A uses type T → edge A→T
4. **Inheritance edges:** Class A extends B / implements I → edges A→B, A→I

#### What a Community Plugin Looks Like

A Python plugin author would create a file or npm package that exports a `LanguagePlugin`:

```typescript
// mini-coder-plugin-python/index.ts
import { execSync } from "child_process";
import type { LanguagePlugin, IndexedSymbol } from "mini-coder";

const plugin: LanguagePlugin = {
  name: "python",
  extensions: [".py", ".pyi"],
  canIndex: (filePath) => filePath.endsWith(".py") || filePath.endsWith(".pyi"),
  indexFile: (filePath, content) => {
    // Shell out to a Python script that uses ast.parse()
    const result = execSync("python3 extract_symbols.py", {
      input: content,
      encoding: "utf-8",
    });
    return JSON.parse(result) as IndexedSymbol[];
  },
};

export default plugin;
```

The plugin author doesn't need to understand the agent loop, model client, or tool system. They implement `indexFile`, return `IndexedSymbol[]`, and everything else (code map, tools, system prompt) works automatically.

#### `code-map.ts` — Skeleton Generator

Generates a compact text representation of the project for the system prompt:

```
# Project Code Map

src/agent/agent.ts
  class CodingAgent
    constructor(params: { config: AgentConfig; modelClient: ModelClient; toolRegistry: ToolRegistry })
    async runTurn(input: string): Promise<string>

src/agent/config.ts
  async loadAgentConfig(cwd?: string): Promise<AgentConfig>

src/model/client.ts
  class AnthropicModelClient implements ModelClient
    async chat(params: ChatParams): Promise<ModelResponse>
  class OpenAICompatibleModelClient implements ModelClient
    async chat(params: ChatParams): Promise<ModelResponse>
  createModelClient(config: AgentConfig): ModelClient

src/agent/types.ts
  interface AgentConfig { modelProvider, model, maxSteps, ... }
  interface ModelClient { chat(params): Promise<ModelResponse> }
  interface ModelResponse { text, toolCalls, stopReason, usage }
  interface ToolSchema { name, description, input_schema }
```

The map respects a **token budget** (default ~1,000 tokens). When the project exceeds the budget, symbols are ranked by relevance:
1. Exported symbols ranked higher than internal ones
2. Symbols referenced more frequently ranked higher
3. Entry points (index.ts, main functions) always included

## 5. New Agent Tools

### 5.1 `read_symbol`

```typescript
// Input:  { name: string, includeBody?: boolean }
// Output: Symbol signature + body (if requested) + referenced type definitions
//
// Example output for read_symbol({ name: "parseResponse", includeBody: true }):
//
//   ## parseResponse (src/model/client.ts:73-96)
//
//   function parseResponse(response: Anthropic.Messages.Message): ModelResponse {
//     const textParts: string[] = [];
//     const toolCalls: ToolCall[] = [];
//     for (const block of response.content) {
//       ...
//     }
//     return { text: textParts.join("\n").trim(), toolCalls, stopReason, usage };
//   }
//
//   ## Referenced Types
//   interface ModelResponse { text: string; toolCalls: ToolCall[]; stopReason: ...; usage: ... }
//   interface ToolCall { id: string; name: string; input: Record<string, unknown> }
```

### 5.2 `find_references`

```typescript
// Input:  { name: string }
// Output: List of symbols that reference the given symbol, with file locations
//
// Example output for find_references({ name: "ModelResponse" }):
//
//   ModelResponse is referenced by:
//     - parseResponse (src/model/client.ts:73) — return type
//     - parseOpenAICompatibleResponse (src/model/client.ts:230) — return type
//     - AnthropicModelClient.chat (src/model/client.ts:310) — return type
//     - OpenAICompatibleModelClient.chat (src/model/client.ts:355) — return type
```

### 5.3 `get_dependencies`

```typescript
// Input:  { name: string, depth?: number }
// Output: Dependency cone — the symbol + everything it depends on (signatures only)
//
// Example output for get_dependencies({ name: "createModelClient", depth: 1 }):
//
//   createModelClient depends on:
//     Types:
//       interface AgentConfig { modelProvider, model, maxSteps, ... }
//       interface ModelClient { chat(params): Promise<ModelResponse> }
//     Constructs:
//       new OpenAICompatibleModelClient(params: { baseUrl, apiKey })
//       new AnthropicModelClient(apiKey?: string)
```

### 5.4 Preserving Existing Tools

`read_file`, `write_file`, `edit_file`, `search`, `list_files`, and `run_command` remain unchanged. The new tools supplement — they do not replace. The model can fall back to `read_file` for non-code files, configuration, or when it needs full file context.

## 6. Integration with Agent Loop

### 6.1 Indexing Phase

At session start (before the first model call), the indexer runs:

```
Session Start
  │
  ▼
Discover and load plugins (built-in → local → npm)
  │
  ▼
Scan workspace files, route each to matching plugin via canIndex()
  │
  ▼
Build ProjectIndex (each plugin extracts symbols → merge into unified index)
  │
  ▼
Resolve dependencies (plugins with resolveDependencies → fallback to import heuristics)
  │
  ▼
Generate Code Map (compact skeleton, ~1000 tokens)
  │
  ▼
Inject Code Map into System Prompt
  │
  ▼
Agent loop begins (model has full project overview from token 1)
```

Indexing a typical project (50–100 files) takes <2 seconds. The index is held in memory and can be incrementally updated when `write_file` or `edit_file` modifies a file. Plugin loading adds negligible overhead — plugins are loaded once at startup.

### 6.2 Two-Phase Context Flow

```
Phase 1: Orientation (code map in system prompt)
  Model sees: project skeleton with all signatures
  Model knows: what exists, where it lives, how things connect
  Token cost: ~1000 tokens (fixed)

Phase 2: Surgical Retrieval (model uses tools)
  Model calls: read_symbol("parseResponse")
  Model gets:  function body + referenced types (~300 tokens)
  vs. current: read_file("src/model/client.ts") (~4000 tokens)

  Savings: ~90% per code read operation
```

### 6.3 Incremental Index Updates

When the agent modifies a file via `write_file` or `edit_file`:

1. Re-parse only the changed file (incremental — not a full project rebuild)
2. Update affected symbols in the index
3. Regenerate code map if signatures changed (rare during edits)

## 7. Token Budget Analysis

### 7.1 Current Approach (Whole-File Reads)

Typical agent session editing a function in a medium project:

| Step | Operation | Tokens |
|---|---|---|
| System prompt | Identity + tool descriptions | ~800 |
| Step 1 | read_file (target file, 300 lines) | ~4,000 |
| Step 2 | read_file (types file, 80 lines) | ~1,200 |
| Step 3 | read_file (related module, 200 lines) | ~2,800 |
| Step 4 | search results | ~500 |
| Step 5 | edit_file | ~200 |
| **Total read context** | | **~9,500** |

### 7.2 Proposed Approach (AST-Indexed)

Same task with code map + surgical reads:

| Step | Operation | Tokens |
|---|---|---|
| System prompt | Identity + tools + **code map** | ~1,800 |
| Step 1 | read_symbol (target function + deps) | ~500 |
| Step 2 | get_dependencies (call graph check) | ~200 |
| Step 3 | read_symbol (one related function) | ~300 |
| Step 4 | edit_file | ~200 |
| **Total read context** | | **~3,000** |

**Estimated savings: ~68% token reduction** on read operations. For small models with 8K–16K effective context, this is the difference between fitting and not fitting.

## 8. Implementation Phases

### Phase 1: Plugin Interface + Code Map (MVP)

- Define the `LanguagePlugin` interface in `src/indexer/types.ts`
- Implement `plugin-loader.ts` — discover and load plugins
- Implement the TypeScript plugin (`plugins/typescript.ts`) — extract function/class/interface signatures
- Implement `code-map.ts` — language-agnostic text skeleton generator
- Inject code map into system prompt at session start
- No new tools yet — model uses existing `read_file` but with better orientation

**Effort:** ~3–4 days
**Impact:** Model makes better-targeted `read_file` calls; plugin interface is established from day one

### Phase 2: `read_symbol` Tool

- Implement `project-index.ts` — language-agnostic queryable symbol index
- Implement `read_symbol` tool — extract a single function/class body
- Register tool in tool registry
- Update system prompt to recommend `read_symbol` for code files

**Effort:** ~2–3 days
**Impact:** Direct token savings on every code read

### Phase 3: Dependency Graph + Advanced Tools

- Add `resolveDependencies()` to the TypeScript plugin — import/call/type edges via the type checker
- Implement `find_references` and `get_dependencies` tools (language-agnostic — they query the index)
- Add dependency cone extraction to `read_symbol` (auto-include referenced types)

**Effort:** ~3–5 days
**Impact:** Model can navigate the codebase structurally instead of text-searching

### Phase 4: Incremental Updates + Polish

- Re-index files after `write_file` / `edit_file` modifications (re-run plugin on changed file)
- Rank symbols by relevance for token-budgeted code maps
- Cache index to disk for faster session startup on repeat projects
- Performance profiling and optimization

**Effort:** ~2–3 days
**Impact:** Production-ready, responsive to edits

### Phase 5: Plugin Ecosystem

- Publish the `LanguagePlugin` interface as a documented spec
- Create a plugin template repository (boilerplate + tests + README)
- Implement a second language plugin (Python via tree-sitter or `ast` module) as proof the interface works across languages
- Add plugin documentation to README: how to install, develop, and publish plugins
- Set up npm package discovery for `mini-coder-plugin-*` packages

**Effort:** ~3–5 days
**Impact:** Community can contribute language support; mini-coder becomes a platform

## 9. Trade-offs and Risks

### 9.1 What the Model Loses

- **Surrounding context:** Comments above a function, nearby helper functions, module-level constants. Mitigation: `read_symbol` includes a few lines of leading context (comments/decorators).
- **File-level patterns:** Import ordering, module organization conventions. Mitigation: Code map shows file structure; `read_file` remains available.
- **Runtime behavior:** Dynamic dispatch, monkey-patching, eval(). Mitigation: Static analysis cannot capture these — same limitation as all AST approaches. Fall back to `read_file` when the model detects dynamic patterns.

### 9.2 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Small models ignore code map | Medium | Tune system prompt; test with target models |
| Indexing too slow for large projects | Low | Incremental parsing; skip node_modules |
| TS compiler API breaks on malformed code | Low | Graceful fallback to `read_file` |
| Dependency cone too large for deeply connected code | Medium | Depth limit on dependency resolution (default: 2) |
| Plugin quality variance across languages | Medium | Validate plugin output against `IndexedSymbol` schema; log warnings for malformed data |
| Plugin version incompatibility | Low | Semver the `LanguagePlugin` interface; check plugin compatibility at load time |
| Security of third-party plugins | Low | Plugins run in the same process — same trust model as npm packages. Document this clearly. Future: consider sandboxing via worker threads |
| Plugin `resolveDependencies` missing | Expected | Core falls back to import-path heuristics — plugins without dependency resolution still provide code maps and `read_symbol` |

### 9.3 Fallback Strategy

The system always degrades gracefully:
- If indexing fails → agent works exactly as it does today (no code map, whole-file reads)
- If `read_symbol` cannot find a symbol → returns error, model uses `read_file`
- If dependency cone exceeds token budget → truncate to signatures only, let model request bodies

## 10. Success Criteria

### 10.1 Core Indexer

- [ ] Code map generation works for the mini-coder project itself
- [ ] `read_symbol` returns a single function body with correct line numbers
- [ ] `find_references` returns accurate cross-file references
- [ ] `get_dependencies` returns the dependency cone for a given symbol
- [ ] Token usage per session decreases by >50% on representative tasks
- [ ] Agent completes the same tasks successfully with a 7B–14B model that previously required a frontier model
- [ ] Indexing completes in <3 seconds for projects with 100 files
- [ ] No regression: agent still works correctly on non-TypeScript files via `read_file`

### 10.2 Plugin System

- [ ] `LanguagePlugin` interface is defined, documented, and stable
- [ ] TypeScript plugin passes all tests as the reference implementation
- [ ] A second language plugin (Python) loads and produces valid `IndexedSymbol[]` output
- [ ] Plugin loader discovers built-in, local, and npm plugins correctly
- [ ] A plugin template repository exists with boilerplate, tests, and documentation
- [ ] Agent works on a mixed-language project (e.g., TypeScript + Python) using both plugins simultaneously
- [ ] Graceful degradation: files with no matching plugin fall through to standard `read_file`
