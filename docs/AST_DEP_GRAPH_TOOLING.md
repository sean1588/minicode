# AST Parsing, Dependency Graph Construction, and Tool-Driven Code Navigation

This document explains the internals of how minicode:

1. Parses source with the TypeScript compiler API,
2. Builds a dependency graph,
3. Uses that graph to generate and rank the code map,
4. Exposes graph-aware tooling to the agent runtime.

## 1) Indexing pipeline overview

At startup, `buildProjectIndex()` recursively scans the workspace for supported source files (`.ts`, `.tsx`, `.js`, `.jsx`), skips common build/vendor folders, loads language plugins, and asks each matching plugin to extract symbols from file contents. The index stores:

- `symbols`: all extracted symbols keyed by qualified name,
- `files`: symbols grouped by file,
- `projectFiles`: raw file content used for dependency resolution,
- `dependencyEdges`: directed graph edges (`from -> to`),
- helper APIs (`getSymbol`, `getDependencyCone`, `getCodeMap`, `reindexFile`).

The dependency graph is resolved after symbol extraction (or recomputed after `reindexFile()`).

## 2) AST parsing internals (TypeScript plugin)

The built-in TypeScript plugin (`src/indexer/plugins/typescript.ts`) is the parser and symbol extractor.

### 2.1 Parsing strategy

For each source file, minicode calls:

- `ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)`

This yields a syntax tree only (fast parse). It does **not** create a `Program`, invoke type-checking, or run full `tsc` project compilation.

### 2.2 Tree traversal and symbol extraction

The plugin walks the AST via `ts.forEachChild(node, visit)` and recognizes declarations with TypeScript node guards:

- `ts.isFunctionDeclaration`
- `ts.isClassDeclaration`
- `ts.isConstructorDeclaration`
- `ts.isMethodDeclaration`
- `ts.isInterfaceDeclaration`
- `ts.isTypeAliasDeclaration`
- `ts.isVariableStatement` (for function-valued variable declarations)

For each match, it emits an `IndexedSymbol` with:

- `name` and `qualifiedName` (e.g. `CodingAgent.runTurn` for methods),
- location (`startLine`, `endLine`) from `sourceFile.getLineAndCharacterOfPosition()`,
- `signature` extracted from node text with lightweight formatting,
- `exported` inferred from modifiers,
- optional `docComment` from JSDoc.

Class scope is tracked via `currentClass` so methods/constructors become class-qualified symbols.

### 2.3 Signature and doc extraction

- Signature slicing is driven by `node.getStart()`, `node.getEnd()`, and body boundaries (for functions/methods/constructors/classes) to avoid dumping full bodies into the index.
- JSDoc is read from the node's `jsDoc` array and cleaned into plain text.

## 3) Dependency graph generation

After symbols are collected, `resolveDependencies(symbols, projectFiles)` parses project files again and builds dependency edges.

### 3.1 Edge model

Supported edge kinds (`DependencyEdgeKind`):

- `calls`
- `imports` (defined type, currently not emitted by built-in TS plugin)
- `extends`
- `implements`
- `references`

Each edge is `{ from, to, kind }` and only retained if `to` exists in the current symbol set.

### 3.2 What the plugin detects

#### A) Inheritance edges

Inside class declarations, `heritageClauses` produce:

- `extends` for `class A extends B`
- `implements` for `class A implements I`

#### B) Type reference edges

A recursive walk over declaration nodes captures `ts.isTypeReferenceNode` and emits `references` from a symbol to referenced type names.

#### C) Call edges

A recursive walk captures `ts.isCallExpression` and `ts.isNewExpression` and emits `calls` when the callee is an identifier. This covers both `foo()` function calls and `new Foo()` constructor calls.

### 3.3 Cone traversal API

`ProjectIndex.getDependencyCone(symbolName, depth)` performs breadth-style expansion over outgoing edges up to depth N. This is the transitive "what this symbol depends on" view used by tools and summaries.

## 4) Code map generation and graph-informed ranking

`generateCodeMap()` builds a compact text map grouped by file, containing symbol signatures.

### 4.1 Budgeting

- Uses a rough token estimator (`chars / 4`) and default budget of 1500 tokens.
- Skips symbols that would exceed budget and appends a truncation footer.

### 4.2 Ranking heuristic

If dependency edges are available, symbols are sorted by:

1. Focus-boosted symbols first (when the agent has recently explored related symbols),
2. Exported before non-exported,
3. Higher inbound reference count (`edge.to`) first,
4. Entry-point bias (`src/index.ts` or `*/index.ts`).

Focus boosting expands one hop in both directions across the dependency graph, so the code map preferentially keeps the current working set and its immediate neighbors. Files containing boosted symbols are also sorted earlier in the map, which helps the relevant slice of the project survive truncation.

### 4.3 Injection into model context

`buildSystemPrompt()` includes the code map in `[Project Code Map]` and, if truncated, adds a hint to use `search_code_map`.

## 5) How graph + code map power agent tools

When a project index exists, minicode's `createToolRegistry()` (`src/tools/registry.ts`) inserts graph-aware tools (`read_symbol`, `find_references`, `get_dependencies`, `search_code_map`) ahead of the SDK's generic file tools.

### 5.1 `read_symbol`

`read_symbol` resolves a symbol via the index, reads only the relevant line range from disk, then enriches output with graph-derived sections:

- **Used by**: inbound edges where `edge.to` is the symbol,
- **Calls**: outbound edges where `edge.from` is the symbol,
- **Referenced Types**: depth-1 dependency cone filtered to `interface`/`type` symbols.

### 5.2 `find_references`

Returns inbound edges (`edge.to == target`) with edge kind so the model can assess blast radius before edits.

### 5.3 `get_dependencies`

Returns `getDependencyCone()` output with depth/pagination for implementation tracing.

### 5.4 `search_code_map`

Searches symbol metadata (name/qualifiedName + optional kind) across the *full* index, used when the injected map is truncated.

## 6) Agent tool-call lifecycle (how these tools are executed)

`CodingAgent.runTurn()` orchestrates model and tools in a loop:

1. Build system prompt from config + tool schemas + optional code map.
2. Send session messages to the model client.
3. If the model returns tool calls, persist them in session.
4. Execute each tool via `ToolRegistry.execute(name, input)`.
5. Append tool results as `role: "tool"` messages.
6. Repeat until the model returns plain text (no tool calls) or step/loop guard stops execution.

Runtime protections include:

- step limit guardrails,
- repeated-identical-tool-call loop detection,
- tool output truncation by configured max chars,
- structured UI/progress events around tool start/end.

## 7) Complete TypeScript compiler package interactions in this codebase

The `typescript` npm package is used directly in the built-in indexer plugin. Interactions include:

### 7.1 Parser entry and targets

- `ts.createSourceFile(...)`
- `ts.ScriptTarget.Latest`

### 7.2 AST navigation

- `ts.forEachChild(node, visitor)`
- `sourceFile.getLineAndCharacterOfPosition(...)`
- `node.getStart(sourceFile?)`, `node.getEnd()`, `node.getText(sourceFile)`
- `sourceFile.getText()`

### 7.3 Node classification/type guards

- `ts.isFunctionDeclaration`
- `ts.isMethodDeclaration`
- `ts.isConstructorDeclaration`
- `ts.isArrowFunction`
- `ts.isBlock`
- `ts.isClassDeclaration`
- `ts.isInterfaceDeclaration`
- `ts.isTypeAliasDeclaration`
- `ts.isVariableStatement`
- `ts.isFunctionExpression`
- `ts.isIdentifier`
- `ts.isComputedPropertyName`
- `ts.isTypeReferenceNode`
- `ts.isQualifiedName`
- `ts.isCallExpression`
- `ts.isNewExpression`
- `ts.isPropertyAccessExpression`

### 7.4 Modifiers / syntax kinds

- `ts.canHaveModifiers(node)`
- `ts.getModifiers(node)`
- `ts.SyntaxKind.ExportKeyword`
- `ts.SyntaxKind.ExtendsKeyword`

These APIs are used for syntax-driven symbol/dependency extraction; there is no use of type-checker APIs (`Program`, `TypeChecker`, module resolution), which keeps indexing lightweight and fast.

## 8) Practical implications and known boundaries

- Fast and robust for structural navigation, but not semantic/type-checked accuracy.
- Name-based edge matching means same-name symbols can collide in rare cases.
- `imports` edge kind exists in shared types but is not emitted by the built-in TypeScript dependency resolver yet.
- Reindexing a single file updates symbols and recomputes dependency edges so tools stay in sync after edits.
