# minicode Plugin Specification

This document describes how to create language plugins for minicode. Plugins enable the agent to index and navigate source code in languages beyond the built-in TypeScript/JavaScript support.

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

  /** Parse file content and return extracted symbols */
  indexFile(filePath: string, content: string): IndexedSymbol[];

  /** Optional: resolve dependency edges between symbols (for find_references, get_dependencies) */
  resolveDependencies?(
    symbols: IndexedSymbol[],
    projectFiles: Map<string, string>,
  ): DependencyEdge[];
}
```

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

## Step-by-Step: Creating a Plugin

### 1. Set up the project

```bash
mkdir my-minicode-plugin
cd my-minicode-plugin
npm init -y
npm install @minicode/agent-sdk  # or add as peer dependency
```

### 2. Implement the plugin

Create `src/index.ts` (or `index.js`):

```typescript
import type { IndexedSymbol, LanguagePlugin } from "@minicode/agent-sdk";

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
    "@minicode/agent-sdk": "*"
  }
}
```

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

## Plugin Discovery Order

minicode loads plugins in this order (first match for a file wins):

1. Built-in plugins (TypeScript)
2. npm packages matching `minicode-plugin-*` in workspace `package.json` dependencies
3. Local plugins in `<workspace>/.minicode/plugins/*.js`
