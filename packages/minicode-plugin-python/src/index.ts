import Parser from "tree-sitter";

import type {
  DependencyEdge,
  DependencyEdgeKind,
  IndexedSymbol,
  LanguagePlugin,
} from "@sean.holung/minicode-sdk";

import Python from "tree-sitter-python";

const EXTENSIONS = [".py", ".pyi"];

type SyntaxNode = Parser.SyntaxNode;

function getLine(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function getEndLine(node: SyntaxNode): number {
  return node.endPosition.row + 1;
}

/**
 * Slice the header text of a function/class. Starts at `outerNode.startIndex`
 * so decorators are included; ends just before the body's `:`. Trailing colon
 * and whitespace are trimmed.
 */
function extractHeaderSignature(
  headerNode: SyntaxNode,
  outerNode: SyntaxNode,
  content: string,
): string {
  const body = headerNode.childForFieldName("body");
  const end = body ? body.startIndex : headerNode.endIndex;
  const raw = content.slice(outerNode.startIndex, end).trim();
  return raw.endsWith(":") ? raw.slice(0, -1).trim() : raw;
}

/** Extract a Python docstring (first string-literal expression in a body). */
function extractDocstring(bodyNode: SyntaxNode | null): string | undefined {
  if (!bodyNode) return undefined;
  const first = bodyNode.namedChildren[0];
  if (!first || first.type !== "expression_statement") return undefined;
  const inner = first.namedChildren[0];
  if (!inner || inner.type !== "string") return undefined;

  const parts: string[] = [];
  for (const c of inner.namedChildren) {
    if (c.type === "string_content") parts.push(c.text);
  }
  if (parts.length === 0) return undefined;

  // Dedent: find minimum indent of non-empty lines after the first.
  const lines = parts.join("").split("\n");
  if (lines.length > 1) {
    let minIndent = Infinity;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim().length === 0) continue;
      const indent = line.length - line.trimStart().length;
      if (indent < minIndent) minIndent = indent;
    }
    if (minIndent !== Infinity) {
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        lines[i] = line.slice(Math.min(minIndent, line.length));
      }
    }
  }

  const cleaned = lines.join("\n").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Python has no `export` keyword. Treat names starting with a single underscore
 * (but not dunder names like `__init__`) as private, everything else as exported.
 */
function isExportedName(name: string): boolean {
  if (name.startsWith("__") && name.endsWith("__")) return true;
  return !name.startsWith("_");
}

/**
 * Find a module-level `__all__ = [...]` (or tuple) declaration and return the
 * set of declared names. If `__all__` is absent or has a non-literal value,
 * returns null and callers fall back to the underscore convention.
 */
function extractAllList(rootNode: SyntaxNode): Set<string> | null {
  for (const stmt of rootNode.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const inner = stmt.namedChildren[0];
    if (!inner || inner.type !== "assignment") continue;
    const left = inner.childForFieldName("left");
    if (!left || left.type !== "identifier" || left.text !== "__all__") continue;
    const right = inner.childForFieldName("right");
    if (!right) return null;
    if (right.type !== "list" && right.type !== "tuple") return null;
    const names = new Set<string>();
    for (const element of right.namedChildren) {
      if (element.type !== "string") return null;
      const parts: string[] = [];
      for (const c of element.namedChildren) {
        if (c.type === "string_content") parts.push(c.text);
      }
      const value = parts.join("");
      if (value.length > 0) names.add(value);
    }
    return names;
  }
  return null;
}

/**
 * Return true if any of the class's superclasses is `Protocol` or
 * `<module>.Protocol`. Used to mark `class X(Protocol)` as kind `interface`.
 */
function extendsProtocol(classNode: SyntaxNode): boolean {
  const supers = classNode.childForFieldName("superclasses");
  if (!supers) return false;
  for (const arg of supers.namedChildren) {
    if (arg.type === "identifier" && arg.text === "Protocol") return true;
    if (arg.type === "attribute") {
      const leaf = arg.childForFieldName("attribute");
      if (leaf?.text === "Protocol") return true;
    }
    // `class X(Protocol[T]):` — generic parameterisation
    if (arg.type === "subscript") {
      const value = arg.childForFieldName("value");
      if (value?.type === "identifier" && value.text === "Protocol") return true;
      if (value?.type === "attribute") {
        const leaf = value.childForFieldName("attribute");
        if (leaf?.text === "Protocol") return true;
      }
    }
  }
  return false;
}

/** Unwrap a `decorated_definition` to the inner function/class node, if any. */
function unwrapDecorated(node: SyntaxNode): { inner: SyntaxNode; outer: SyntaxNode } {
  if (node.type === "decorated_definition") {
    const inner = node.childForFieldName("definition");
    if (inner) return { inner, outer: node };
  }
  return { inner: node, outer: node };
}

/**
 * Source-root segments stripped from the front of a file path before computing
 * a module name. These are conventional "source roots" in Python projects
 * (poetry, hatch, src layout, etc.) and treating them as part of the module
 * path produces awkward qualified names like `src.helpers.parse` that don't
 * match anything users actually write in their imports.
 */
const STRIPPED_ROOTS = new Set(["src", "lib"]);

/**
 * Compute a dotted Python module name from a workspace-relative file path.
 * A single leading `src/` or `lib/` segment is dropped — those are
 * conventional source roots, not real Python package boundaries.
 *
 * - `parser.py` → `parser`
 * - `src/parser.py` → `parser`
 * - `lib/parser.py` → `parser`
 * - `src/parser/__init__.py` → `parser`
 * - `src/parser/utils.pyi` → `parser.utils`
 * - `src/__init__.py` → `` (root)
 *
 * Path separators are normalised to `/` first.
 */
function fileToModuleName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\.(py|pyi)$/, "");
  const parts = normalized.split("/");
  if (parts.length > 1 && STRIPPED_ROOTS.has(parts[0]!)) parts.shift();
  if (parts[parts.length - 1] === "__init__") parts.pop();
  return parts.join(".");
}

/**
 * Strip a leading source-root segment (`src.` or `lib.`) from a dotted
 * module name. Mirrors `fileToModuleName`'s stripping so absolute imports
 * (e.g. `from src.helpers import parse`) line up with the file-derived
 * qualifiedNames they target.
 */
function stripSourceRoot(moduleName: string): string {
  if (moduleName.length === 0) return moduleName;
  const parts = moduleName.split(".");
  if (parts.length > 1 && STRIPPED_ROOTS.has(parts[0]!)) parts.shift();
  return parts.join(".");
}

/** Resolve a relative-import target to an absolute module name. */
function resolveRelativeModule(
  level: number,
  suffix: string,
  fromFilePath: string,
): string | null {
  const fromModule = fileToModuleName(fromFilePath);
  const parts = fromModule.split(".");
  // For a non-package file (`foo.py`), the file itself is the module; its
  // package is whatever directory contains it. So we drop the file's own
  // identifier first, then climb `level - 1` more levels.
  parts.pop();
  for (let i = 1; i < level; i += 1) parts.pop();
  if (parts.length === 0 && suffix.length === 0) return null;
  return suffix.length > 0
    ? [...parts, suffix].join(".")
    : parts.join(".");
}

/**
 * Build a per-file alias map: `localName` (as it appears in source) → the
 * dotted target it refers to. Targets are dotted module paths plus optional
 * leaf names (e.g. `src.types.Task`, `src.parser`). Resolution against
 * project symbols happens at edge-emission time.
 */
function collectImports(
  rootNode: SyntaxNode,
  filePath: string,
): Map<string, string> {
  const aliases = new Map<string, string>();

  const setAlias = (localName: string, target: string): void => {
    if (localName.length > 0 && target.length > 0) aliases.set(localName, target);
  };

  for (const stmt of rootNode.namedChildren) {
    if (stmt.type === "import_statement") {
      // import a, b, c.d, x as y
      for (const nameField of stmt.childrenForFieldName("name")) {
        if (nameField.type === "aliased_import") {
          const target = nameField.childForFieldName("name")?.text ?? "";
          const alias = nameField.childForFieldName("alias")?.text ?? "";
          // Strip `src.`/`lib.` so the alias target lines up with file-derived
          // qualifiedNames (e.g. `import src.helpers as h` → `h` resolves to
          // module `helpers`, which is the actual indexed namespace).
          setAlias(alias, stripSourceRoot(target));
        } else if (nameField.type === "dotted_name") {
          const target = nameField.text;
          const localName = target.split(".")[0] ?? target;
          setAlias(localName, target);
        }
      }
      continue;
    }
    if (stmt.type === "import_from_statement") {
      const moduleField = stmt.childForFieldName("module_name");
      let resolvedModule: string | null = null;
      if (moduleField?.type === "dotted_name") {
        // `from src.helpers import X` → module `helpers` after src strip.
        // Relative imports resolve through `fileToModuleName`, which already
        // strips, so we only need to do this for the absolute case.
        resolvedModule = stripSourceRoot(moduleField.text);
      } else if (moduleField?.type === "relative_import") {
        const prefix = moduleField.namedChildren.find((n) => n.type === "import_prefix");
        const dotted = moduleField.namedChildren.find((n) => n.type === "dotted_name");
        const level = prefix?.text.length ?? 0;
        resolvedModule = resolveRelativeModule(level, dotted?.text ?? "", filePath);
      }
      if (resolvedModule === null) continue;

      for (const nameField of stmt.childrenForFieldName("name")) {
        if (nameField.type === "aliased_import") {
          const importedName = nameField.childForFieldName("name")?.text ?? "";
          const alias = nameField.childForFieldName("alias")?.text ?? "";
          if (importedName.length === 0) continue;
          setAlias(alias, `${resolvedModule}.${importedName}`);
        } else if (nameField.type === "dotted_name") {
          const importedName = nameField.text;
          setAlias(importedName, `${resolvedModule}.${importedName}`);
        }
      }
    }
  }

  return aliases;
}

function createPlugin() {
  const parser = new Parser();
  parser.setLanguage(Python as unknown as Parser.Language);
  const astCache = new Map<string, Parser.Tree>();

  function parse(filePath: string, content: string): Parser.Tree {
    const tree = parser.parse(content);
    astCache.set(filePath, tree);
    return tree;
  }

  function topLevelExported(
    name: string,
    allList: Set<string> | null,
  ): boolean {
    if (allList !== null) return allList.has(name);
    return isExportedName(name);
  }

  /**
   * Compose a Python symbol's qualifiedName from the file's module prefix,
   * any enclosing classes, and the symbol name. Module-prefixed names mean
   * `helpers.parse` for top-level `parse()` in `helpers.py`, and
   * `helpers.Foo.bar` for method `bar` of class `Foo` in `helpers.py`.
   * Files at the workspace root (or directly under a stripped source root
   * like `src/`) get no prefix — symbols there look like plain `Foo`.
   */
  function qualify(
    modulePrefix: string,
    classStack: string[],
    name: string,
  ): string {
    const segments: string[] = [];
    if (modulePrefix.length > 0) segments.push(modulePrefix);
    segments.push(...classStack, name);
    return segments.join(".");
  }

  /**
   * Build the alias list for a symbol with a module prefix. Includes the
   * un-prefixed `Class.method` (or `Outer.Inner`) form so user-natural
   * lookups like `getSymbol("Foo.bar")` keep working alongside the
   * canonical `module.Foo.bar` qualifiedName. The bare leaf name is
   * already in `symbol.name` and doesn't need to be added here.
   */
  function aliasesForPrefixed(
    modulePrefix: string,
    classStack: string[],
    name: string,
  ): string[] {
    if (modulePrefix.length === 0 || classStack.length === 0) return [];
    return [`${classStack.join(".")}.${name}`];
  }

  function emitFunction(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    name: string,
    modulePrefix: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    const inClass = classStack.length > 0;
    const qualifiedName = qualify(modulePrefix, classStack, name);
    const aliases = aliasesForPrefixed(modulePrefix, classStack, name);
    const docComment = extractDocstring(headerNode.childForFieldName("body"));
    symbols.push({
      name,
      qualifiedName,
      kind: inClass ? "method" : "function",
      filePath,
      startLine: getLine(outerNode),
      endLine: getEndLine(outerNode),
      signature: extractHeaderSignature(headerNode, outerNode, content),
      exported: inClass ? false : topLevelExported(name, allList),
      dependencies: [],
      ...(aliases.length > 0 && { aliases }),
      ...(docComment !== undefined && { docComment }),
    });
  }

  function emitClass(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    name: string,
    modulePrefix: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    const qualifiedName = qualify(modulePrefix, classStack, name);
    const aliases = aliasesForPrefixed(modulePrefix, classStack, name);
    const docComment = extractDocstring(headerNode.childForFieldName("body"));
    const kind = extendsProtocol(headerNode) ? "interface" : "class";
    symbols.push({
      name,
      qualifiedName,
      kind,
      filePath,
      startLine: getLine(outerNode),
      endLine: getEndLine(outerNode),
      signature: extractHeaderSignature(headerNode, outerNode, content),
      exported:
        classStack.length > 0 ? false : topLevelExported(name, allList),
      dependencies: [],
      ...(aliases.length > 0 && { aliases }),
      ...(docComment !== undefined && { docComment }),
    });
  }

  function emitTypeAlias(
    node: SyntaxNode,
    name: string,
    modulePrefix: string,
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    const raw = content.slice(node.startIndex, node.endIndex).trim();
    const signature = raw.split("\n")[0] ?? `type ${name}`;
    symbols.push({
      name,
      qualifiedName: qualify(modulePrefix, [], name),
      kind: "type",
      filePath,
      startLine: getLine(node),
      endLine: getEndLine(node),
      signature,
      exported: topLevelExported(name, allList),
      dependencies: [],
    });
  }

  function visit(
    node: SyntaxNode,
    modulePrefix: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    if (node.type === "decorated_definition") {
      const { inner, outer } = unwrapDecorated(node);
      handleDef(inner, outer, modulePrefix, classStack, filePath, content, symbols, allList);
      return;
    }
    if (node.type === "function_definition" || node.type === "class_definition") {
      handleDef(node, node, modulePrefix, classStack, filePath, content, symbols, allList);
      return;
    }
    if (node.type === "type_alias_statement") {
      const left = node.childForFieldName("left");
      const nameNode = left?.namedChild(0) ?? left;
      if (nameNode && nameNode.type === "identifier") {
        emitTypeAlias(node, nameNode.text, modulePrefix, filePath, content, symbols, allList);
      }
      return;
    }

    for (const child of node.namedChildren) {
      visit(child, modulePrefix, classStack, filePath, content, symbols, allList);
    }
  }

  function handleDef(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    modulePrefix: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    if (headerNode.type === "function_definition") {
      const nameNode = headerNode.childForFieldName("name");
      if (!nameNode) return;
      emitFunction(
        headerNode,
        outerNode,
        nameNode.text,
        modulePrefix,
        classStack,
        filePath,
        content,
        symbols,
        allList,
      );
      // Don't recurse into function bodies — nested functions/classes are
      // closure-scoped and rarely the right thing to surface in the code map.
      return;
    }
    if (headerNode.type === "class_definition") {
      const nameNode = headerNode.childForFieldName("name");
      if (!nameNode) return;
      emitClass(
        headerNode,
        outerNode,
        nameNode.text,
        modulePrefix,
        classStack,
        filePath,
        content,
        symbols,
        allList,
      );
      const body = headerNode.childForFieldName("body");
      if (body) {
        classStack.push(nameNode.text);
        // Class bodies don't honor module-level `__all__`; pass null so
        // method `exported` continues to fall through to the (false) inClass
        // branch.
        for (const child of body.namedChildren) {
          visit(child, modulePrefix, classStack, filePath, content, symbols, null);
        }
        classStack.pop();
      }
    }
  }

  return {
    name: "python",
    extensions: EXTENSIONS,

    canIndex(filePath: string): boolean {
      const lower = filePath.toLowerCase();
      return EXTENSIONS.some((ext) => lower.endsWith(ext));
    },

    isEntryPoint(filePath: string): boolean {
      const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
      return base === "__init__.py" || base === "__main__.py";
    },

    indexFile(filePath: string, content: string): IndexedSymbol[] {
      const tree = parse(filePath, content);
      const symbols: IndexedSymbol[] = [];
      const classStack: string[] = [];
      const allList = extractAllList(tree.rootNode);
      const modulePrefix = fileToModuleName(filePath);
      for (const child of tree.rootNode.namedChildren) {
        visit(child, modulePrefix, classStack, filePath, content, symbols, allList);
      }
      return symbols;
    },

    resolveDependencies(
      symbols: IndexedSymbol[],
      projectFiles: Map<string, string>,
    ): DependencyEdge[] {
      const symbolSet = new Set(symbols.map((s) => s.qualifiedName));
      const symbolsByLookup = new Map<string, IndexedSymbol[]>();
      const edges: DependencyEdge[] = [];
      const edgeKeys = new Set<string>();

      // Project-wide module → file index. Lets us resolve `src.types` to
      // `src/types.py` (or `src/types/__init__.py`) so we can look up
      // `src.types.Task` as a symbol.
      const moduleToFile = new Map<string, string>();
      for (const filePath of projectFiles.keys()) {
        if (!filePath.endsWith(".py") && !filePath.endsWith(".pyi")) continue;
        moduleToFile.set(fileToModuleName(filePath), filePath);
      }

      function addLookup(key: string, symbol: IndexedSymbol): void {
        if (key.length === 0) return;
        const existing = symbolsByLookup.get(key);
        if (existing) existing.push(symbol);
        else symbolsByLookup.set(key, [symbol]);
      }

      for (const symbol of symbols) {
        for (const key of new Set([
          symbol.qualifiedName,
          symbol.name,
          symbol.originalQualifiedName ?? "",
          symbol.displayName ?? "",
          ...(symbol.aliases ?? []),
        ])) {
          addLookup(key, symbol);
        }
      }

      function addEdge(
        from: string,
        to: string,
        kind: DependencyEdgeKind,
      ): void {
        const edgeKey = `${from}->${to}:${kind}`;
        if (symbolSet.has(from) && symbolSet.has(to) && !edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey);
          edges.push({ from, to, kind });
        }
      }

      function resolveCandidates(
        rawName: string,
        filePath?: string,
        kinds?: IndexedSymbol["kind"][],
      ): IndexedSymbol[] {
        const matches = symbolsByLookup.get(rawName) ?? [];
        return matches.filter((symbol) =>
          (filePath === undefined || symbol.filePath === filePath) &&
          (kinds === undefined || kinds.includes(symbol.kind)),
        );
      }

      /**
       * Resolve `objName.attrName` where `objName` is a local identifier (e.g.
       * an `import x as y` alias or a `from pkg import mod` re-export). Only
       * returns symbols from the file the alias resolves to — never falls
       * back to a global match on `attrName`, since that would emit edges to
       * unrelated same-named symbols in other modules.
       *
       * Returns an empty array when `objName` isn't a known alias, when the
       * alias target doesn't map to a project file (external module), or
       * when no symbol with that name exists in the resolved file.
       */
      function resolveAttributeOnModuleAlias(
        objName: string,
        attrName: string,
        aliases: Map<string, string>,
        kinds?: IndexedSymbol["kind"][],
      ): IndexedSymbol[] {
        const aliasTarget = aliases.get(objName);
        if (aliasTarget === undefined) return [];
        const targetFile = moduleToFile.get(aliasTarget);
        if (targetFile === undefined) return [];
        return resolveCandidates(attrName, targetFile, kinds);
      }

      /**
       * Resolve a name as it appears at a callsite into one or more candidate
       * symbols. When a local alias exists for the name, resolution is
       * strict: we only return symbols that actually live in the alias's
       * target — never fall back to a global leaf match, since that would
       * emit edges to unrelated same-named symbols in other modules. With
       * no alias, we fall back to (1) same-file then (2) any project symbol.
       */
      function resolveName(
        rawName: string,
        filePath: string,
        aliases: Map<string, string>,
        kinds?: IndexedSymbol["kind"][],
      ): IndexedSymbol[] {
        const aliasTarget = aliases.get(rawName);
        if (aliasTarget !== undefined) {
          // Try the fully-qualified alias first (e.g. `helpers.parse`).
          const aliasMatches = resolveCandidates(aliasTarget, undefined, kinds);
          if (aliasMatches.length > 0) return aliasMatches;
          // The alias may point at `<module>.<leaf>` where the module is a
          // project file we know about. Look up the leaf strictly within
          // that file.
          const lastDot = aliasTarget.lastIndexOf(".");
          if (lastDot >= 0) {
            const moduleStub = aliasTarget.slice(0, lastDot);
            const targetFile = moduleToFile.get(moduleStub);
            if (targetFile !== undefined) {
              const leaf = aliasTarget.slice(lastDot + 1);
              const inModule = resolveCandidates(leaf, targetFile, kinds);
              if (inModule.length > 0) return inModule;
            }
          }
          // Alias known but unresolvable (external module, typo, etc.).
          // Returning empty is safer than guessing — a global leaf match
          // would point at any same-named symbol anywhere in the project.
          return [];
        }
        const sameFile = resolveCandidates(rawName, filePath, kinds);
        if (sameFile.length > 0) return sameFile;
        return resolveCandidates(rawName, undefined, kinds);
      }

      function addResolvedEdges(
        from: string,
        targets: IndexedSymbol[],
        kind: DependencyEdgeKind,
      ): void {
        for (const target of targets) {
          addEdge(from, target.qualifiedName, kind);
        }
      }

      // ── walk every file ──────────────────────────────────────────────
      for (const [filePath, content] of projectFiles) {
        if (!filePath.endsWith(".py") && !filePath.endsWith(".pyi")) continue;

        const tree = astCache.get(filePath) ?? parser.parse(content);
        const aliases = collectImports(tree.rootNode, filePath);
        const modulePrefix = fileToModuleName(filePath);

        const classStack: string[] = [];

        function fromFor(name: string): string {
          return qualify(modulePrefix, classStack, name);
        }

        function collectCalls(
          node: SyntaxNode,
          from: string,
        ): void {
          if (node.type === "call") {
            const fnNode = node.childForFieldName("function");
            if (fnNode) {
              if (fnNode.type === "identifier") {
                const targets = resolveName(fnNode.text, filePath, aliases, [
                  "function",
                  "class",
                  "method",
                ]);
                addResolvedEdges(from, targets, "calls");
              } else if (fnNode.type === "attribute") {
                const objectNode = fnNode.childForFieldName("object");
                const attrNode = fnNode.childForFieldName("attribute");
                const attrName = attrNode?.text ?? "";
                if (
                  objectNode?.type === "identifier" &&
                  attrName.length > 0
                ) {
                  const objName = objectNode.text;
                  if (objName === "self" || objName === "cls") {
                    if (classStack.length > 0) {
                      const className = classStack[classStack.length - 1] ?? "";
                      const fq = `${className}.${attrName}`;
                      const targets = resolveCandidates(fq, filePath, ["method"]);
                      addResolvedEdges(from, targets, "calls");
                    }
                  } else if (aliases.has(objName)) {
                    // Module-qualified call: `mod.foo()` where `mod` is a
                    // known import alias. Resolve strictly within the
                    // module's file — never fall back to global, which
                    // would pollute the graph with same-named symbols
                    // defined in other modules.
                    const targets = resolveAttributeOnModuleAlias(
                      objName,
                      attrName,
                      aliases,
                      ["function", "class", "method"],
                    );
                    addResolvedEdges(from, targets, "calls");
                  } else {
                    // `Foo.bar()` where Foo is a class symbol: try `Foo.bar`.
                    const fq = `${objName}.${attrName}`;
                    const targets = resolveName(fq, filePath, aliases, ["method"]);
                    addResolvedEdges(from, targets, "calls");
                  }
                }
              }
            }
          }
          for (const child of node.namedChildren) {
            collectCalls(child, from);
          }
        }

        function visitNode(node: SyntaxNode): void {
          if (node.type === "decorated_definition") {
            const inner = node.childForFieldName("definition");
            if (inner) visitNode(inner);
            return;
          }

          if (node.type === "class_definition") {
            const nameNode = node.childForFieldName("name");
            if (!nameNode) return;
            const className = nameNode.text;
            const fqClass = fromFor(className);

            // extends edges from the superclasses list
            if (symbolSet.has(fqClass)) {
              const supers = node.childForFieldName("superclasses");
              if (supers) {
                for (const arg of supers.namedChildren) {
                  if (arg.type === "identifier") {
                    const targets = resolveName(arg.text, filePath, aliases, [
                      "class",
                      "interface",
                    ]);
                    addResolvedEdges(fqClass, targets, "extends");
                  } else if (arg.type === "attribute") {
                    // `mod.Base`: resolve the qualifier through the alias map
                    // and look up the attribute strictly within the resolved
                    // module's file. Never fall back to a global leaf match,
                    // which would erroneously extend any same-named class in
                    // an unrelated module.
                    const objectNode = arg.childForFieldName("object");
                    const attrNode = arg.childForFieldName("attribute");
                    const attrName = attrNode?.text ?? "";
                    if (
                      objectNode?.type === "identifier" &&
                      attrName.length > 0
                    ) {
                      const targets = resolveAttributeOnModuleAlias(
                        objectNode.text,
                        attrName,
                        aliases,
                        ["class", "interface"],
                      );
                      addResolvedEdges(fqClass, targets, "extends");
                    }
                  }
                }
              }
            }

            const body = node.childForFieldName("body");
            if (body) {
              classStack.push(className);
              for (const child of body.namedChildren) visitNode(child);
              classStack.pop();
            }
            return;
          }

          if (node.type === "function_definition") {
            const nameNode = node.childForFieldName("name");
            if (!nameNode) return;
            const from = fromFor(nameNode.text);
            const body = node.childForFieldName("body");
            if (body && symbolSet.has(from)) {
              collectCalls(body, from);
            }
            return;
          }

          for (const child of node.namedChildren) visitNode(child);
        }

        visitNode(tree.rootNode);
      }

      astCache.clear();
      return edges;
    },
  } satisfies LanguagePlugin;
}

export const pythonPlugin = createPlugin();
