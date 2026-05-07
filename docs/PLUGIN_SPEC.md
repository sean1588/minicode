# minicode Plugin Specification

This document describes how to create language plugins for minicode. Plugins enable the agent to index and navigate source code in languages beyond the built-in TypeScript/JavaScript support.

> **Current repo state:** the shared SDK types live in the private workspace package `packages/agent-sdk`. The interfaces below reflect the actual runtime shape, but publishing the SDK as a standalone npm dependency is still a future packaging step.

---

## Overview

minicode uses a **plugin-based indexer** to extract symbols (functions, classes, interfaces, etc.) from source files. The index powers:

- **Code map** — A compact project skeleton injected into the system prompt
- **`read_symbol`** — Read a specific function or class by name
- **`find_references`** — Find symbols that reference a given symbol
- **`get_dependencies`** — Get the dependency cone of a symbol

Plugins implement the `LanguagePlugin` interface and are discovered at startup.

---

## LanguagePlugin Interface

```typescript
interface LanguagePlugin {
  /** Unique identifier for the plugin (e.g. "typescript", "rust") */
  name: string;

  /** File extensions this plugin handles (e.g. [".ts", ".tsx"]) */
  extensions: string[];

  /** Return true if this plugin can index the given file path */
  canIndex(filePath: string): boolean;

  /** Parse file content and return extracted symbols. May be sync or async. */
  indexFile(
    filePath: string,
    content: string,
  ): IndexedSymbol[] | Promise<IndexedSymbol[]>;

  /** Optional: resolve dependency edges between symbols (for find_references, get_dependencies). May be sync or async. */
  resolveDependencies?(
    symbols: IndexedSymbol[],
    projectFiles: Map<string, string>,
  ): DependencyEdge[] | Promise<DependencyEdge[]>;
}
```

Both `indexFile` and `resolveDependencies` may return either a value or a `Promise`. The host always awaits the result, so plugins backed by async sources — language servers (LSP), network calls, or parsers with async initialization (e.g. tree-sitter WASM) — can return promises without changing how they're consumed. Sync plugins continue to return arrays directly.

### `canIndex(filePath: string): boolean`

Return `true` if the plugin can index this file. Typically implemented as:

```typescript
canIndex(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return this.extensions.some((ext) => lower.endsWith(ext));
}
```

### `indexFile(filePath: string, content: string): IndexedSymbol[]`

Parse the file content and return an array of extracted symbols. This is the core method. See [IndexedSymbol](#indexedsymbol) below for the required shape.

### `resolveDependencies?` (optional)

If implemented, returns directed edges between symbols. Used for `find_references` and `get_dependencies`. Not required for a basic plugin.

---

## IndexedSymbol

Each extracted symbol must conform to:

```typescript
interface IndexedSymbol {
  /** Short name (e.g. "runTurn") */
  name: string;

  /** Fully qualified name (e.g. "CodingAgent.runTurn" for methods) */
  qualifiedName: string;

  /** One of: "function" | "class" | "interface" | "type" | "variable" | "method" */
  kind: SymbolKind;

  /** Path relative to workspace root */
  filePath: string;

  /** 1-based start line */
  startLine: number;

  /** 1-based end line */
  endLine: number;

  /** Declaration text without body (e.g. "async runTurn(input: string): Promise<string>") */
  signature: string;

  /** Whether the symbol is exported */
  exported: boolean;

  /** Reserved for future use; pass empty array */
  dependencies: string[];
}
```

### Symbol kinds

| kind | Description | Example |
|------|-------------|---------|
| `function` | Standalone function or arrow function | `function greet()`, `const fn = () => {}` |
| `class` | Class declaration | `class CodingAgent` |
| `method` | Method or constructor inside a class | `runTurn`, `constructor` |
| `interface` | Interface declaration | `interface ModelResponse` |
| `type` | Type alias | `type UserId = string` |
| `variable` | Variable (non-function) | Rare; prefer `function` for callables |

### qualifiedName

- For top-level symbols: same as `name` (e.g. `"parseResponse"`).
- For methods: `ClassName.methodName` (e.g. `"CodingAgent.runTurn"`).
- For constructors: `ClassName.constructor`.

### signature

The declaration text **without** the body. Examples:

- Function: `async runTurn(input: string): Promise<string>`
- Class: `class CodingAgent`
- Interface: `interface ModelResponse { content: string; }` (first line is fine)

---

## DependencyEdge

Used by `resolveDependencies` to describe relationships between symbols:

```typescript
interface DependencyEdge {
  /** Qualified name of the symbol that depends */
  from: string;

  /** Qualified name of the symbol being depended on */
  to: string;

  /** One of: "calls" | "imports" | "extends" | "implements" | "references" */
  kind: DependencyEdgeKind;
}
```

| kind | Meaning |
|------|---------|
| `calls` | Symbol A invokes symbol B |
| `imports` | Symbol A's file imports symbol B |
| `references` | Symbol A uses type B (parameter, return type, variable) |
| `extends` | Class A extends class B |
| `implements` | Class A implements interface B |

---

## Choosing an approach

`indexFile` and `resolveDependencies` are unconstrained — implement them with an AST parser, a language server, regex, or anything else. The right tool depends on what each method actually needs to do:

- `indexFile` is single-file and structural ("extract symbols, signatures, and line ranges from this string"). An in-process parser — the language's own compiler API or a grammar-based parser — maps directly onto this shape and stays sync.
- `resolveDependencies` is whole-project and semantic. Heuristic AST analysis works well for statically-typed languages; precise cross-file resolution or dynamic-language accuracy is where an external semantic source (e.g. a language server) starts to pay off.

A reasonable default for a new plugin: in-process AST for both, accepting that `resolveDependencies` will be heuristic. Reach for an external/async source when heuristics produce too many false matches, when you need cross-file type information you can't get from a single file, or when an authoritative source (one your users already run) is available.

Properties to weigh:

| Dimension | In-process AST | External (async) source |
|-----------|----------------|-------------------------|
| Startup time | Negligible | Seconds, sometimes much longer |
| Memory | Bounded by file size | Often substantial |
| Dependencies | A library | A server or binary the user must install |
| Sync/async | Naturally sync | Inherently async |
| Cross-file accuracy | Heuristic | Authoritative |
| Failure mode | Bad parse → no symbols | Process crash, retries, version drift |

Both options satisfy the contract; pick whichever fits your language and constraints.

---

## Step-by-Step: Creating a Plugin

### 1. Set up the project

```bash
mkdir my-minicode-plugin
cd my-minicode-plugin
npm init -y
# Today, develop against a local checkout of minicode or copied type definitions
# from packages/agent-sdk until the SDK is published as a standalone package.
```

### 2. Implement the plugin

Create `src/index.ts` (or `index.js`):

```typescript
import type { IndexedSymbol, LanguagePlugin } from "@sean.holung/minicode-sdk";

const plugin: LanguagePlugin = {
  name: "my-language",
  extensions: [".mylang"],

  canIndex(filePath: string): boolean {
    return this.extensions.some((ext) =>
      filePath.toLowerCase().endsWith(ext),
    );
  },

  indexFile(filePath: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    // Parse content and push symbols...
    return symbols;
  },
};

export default plugin;
export { plugin };
```

### 3. Export the plugin

Your package must export the plugin. In `package.json`:

```json
{
  "name": "minicode-plugin-mylang",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "peerDependencies": {
    "@sean.holung/minicode-sdk": "*"
  }
}
```

If you are developing against the current repo state, point this at a local workspace copy instead of assuming the package is published.

For local plugins (`.minicode/plugins/`), export a default or named `LanguagePlugin`:

```javascript
// .minicode/plugins/mylang.js
module.exports = { default: myPlugin };
```

### 4. Test the plugin

Use minicode's indexer test harness or run minicode against a sample project:

```bash
# In a project with .mylang files
npm run dev
```

The code map should include symbols from your language.

---

## How to Test a Plugin

1. **Unit test** — Call `plugin.indexFile("sample.mylang", sampleContent)` and assert the returned `IndexedSymbol[]` shape and values.

2. **Integration test** — Create a temp workspace with a `.mylang` file, run `buildProjectIndex(workspaceRoot)`, and verify `index.getSymbolsInFile("sample.mylang")` returns your symbols.

3. **Manual test** — Place a plugin file in `<workspace>/.minicode/plugins/`, run minicode, and check that the code map includes symbols from your language.

---

## Distribution

### Local plugin (no publish)

1. Create a `.js` file that exports a `LanguagePlugin`.
2. Place it in `<workspace>/.minicode/plugins/`.
3. minicode will load it at startup.

### npm package

1. Name the package `minicode-plugin-<language>` (e.g. `minicode-plugin-rust`).
2. Add `minicode` as a peer dependency.
3. Export the plugin as the main entry.
4. Publish to npm. Users install with `npm install minicode-plugin-rust` and minicode discovers it via `package.json` dependencies.

---

## Reference: TypeScript Plugin

The built-in TypeScript plugin is the canonical example. Source: `src/indexer/plugins/typescript.ts`.

It extracts:

- `FunctionDeclaration` → `function`
- `ClassDeclaration` → `class`
- `MethodDeclaration`, `ConstructorDeclaration` → `method`
- `InterfaceDeclaration` → `interface`
- `TypeAliasDeclaration` → `type`
- `VariableStatement` with arrow/function expression → `function`

It implements `resolveDependencies` using heuristic AST analysis (heritage clauses, type references, call expressions).

---

## Reference: Python Plugin

The built-in Python plugin is powered by `tree-sitter-python` and lives in its own workspace package at `packages/minicode-plugin-python/`. It serves as the canonical example of how an external `minicode-plugin-*` package would be structured: it imports `LanguagePlugin` from `@sean.holung/minicode-sdk`, declares its own native dependencies, and is bundled into minicode at publish time via `bundleDependencies`. Authors of new built-in or third-party plugins can copy this layout directly.

It extracts:

- `function_definition` (top-level) → `function` (`async def` is naturally preserved in the signature text)
- `function_definition` (inside `class`) → `method`
- `class_definition` → `class` (or `interface` if it extends `Protocol` / `typing.Protocol` / `Protocol[T]`)
- `type_alias_statement` (PEP 695 `type X = ...`) → `type`
- Decorators are included in the symbol's `signature` and contribute to its `startLine`
- Docstrings (first string-literal expression in a function/class body) become `docComment`
- `__all__ = [...]` overrides the underscore-prefix convention for module-level `exported`

It implements `resolveDependencies` with:

- A project-wide module resolver: `src/parser.py` and `src/parser/__init__.py` both map to module `parser` (a leading `src/` or `lib/` segment is stripped as a conventional source root)
- Per-file alias maps from `import` and `from ... import`, including relative imports (`from .x import y`)
- `extends` edges from `class Foo(Bar):` headers, resolved through the alias map
- `calls` edges for bare calls, `self.method()` / `cls.method()`, `module.attr()` (via the alias map), and `Class.method()`

Both `.py` and `.pyi` (stub) files are indexed.

### Module-prefixed `qualifiedName`

Top-level Python symbols use module-prefixed qualified names: `parse()` in `helpers.py` becomes `helpers.parse`, and method `bar` of class `Foo` in `helpers.py` becomes `helpers.Foo.bar`. This matches how Python users actually reference symbols in their code (`from helpers import parse`, `helpers.Foo.bar`).

Source-root segments (`src/`, `lib/`) are stripped: `src/parser.py` → module `parser`, not `src.parser`. The TypeScript plugin keeps its existing bare-name scheme since TS modules are file-scoped, not name-scoped.

User-natural lookups still work: `getSymbol("Foo")` and `getSymbol("Foo.bar")` resolve through the existing alias system. The plugin emits the un-prefixed `Class.method` form as an explicit `aliases` entry so neither the agent nor a human has to know the module path to reference a symbol.

---

## Plugin Discovery Order

minicode loads plugins in this order (first match for a file wins):

1. Built-in plugins (TypeScript, Python)
2. npm packages matching `minicode-plugin-*` in workspace `package.json` dependencies
3. Local plugins in `<workspace>/.minicode/plugins/*.js`
