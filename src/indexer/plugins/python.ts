import Parser from "tree-sitter";

import type {
  DependencyEdge,
  DependencyEdgeKind,
  IndexedSymbol,
  LanguagePlugin,
} from "../types.js";

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
 * Compute a dotted Python module name from a workspace-relative file path.
 *
 * - `parser.py` → `parser`
 * - `src/parser.py` → `src.parser`
 * - `src/parser/__init__.py` → `src.parser`
 * - `src/parser/utils.pyi` → `src.parser.utils`
 *
 * Path separators are normalised to `/` first.
 */
function fileToModuleName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\.(py|pyi)$/, "");
  const parts = normalized.split("/");
  if (parts[parts.length - 1] === "__init__") parts.pop();
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
          setAlias(alias, target);
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
        resolvedModule = moduleField.text;
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

  function emitFunction(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    name: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    const inClass = classStack.length > 0;
    const qualifiedName = inClass
      ? `${classStack.join(".")}.${name}`
      : name;
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
      ...(docComment !== undefined && { docComment }),
    });
  }

  function emitClass(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    name: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    const qualifiedName =
      classStack.length > 0 ? `${classStack.join(".")}.${name}` : name;
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
      ...(docComment !== undefined && { docComment }),
    });
  }

  function emitTypeAlias(
    node: SyntaxNode,
    name: string,
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    const raw = content.slice(node.startIndex, node.endIndex).trim();
    const signature = raw.split("\n")[0] ?? `type ${name}`;
    symbols.push({
      name,
      qualifiedName: name,
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
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
    allList: Set<string> | null,
  ): void {
    if (node.type === "decorated_definition") {
      const { inner, outer } = unwrapDecorated(node);
      handleDef(inner, outer, classStack, filePath, content, symbols, allList);
      return;
    }
    if (node.type === "function_definition" || node.type === "class_definition") {
      handleDef(node, node, classStack, filePath, content, symbols, allList);
      return;
    }
    if (node.type === "type_alias_statement") {
      const left = node.childForFieldName("left");
      const nameNode = left?.namedChild(0) ?? left;
      if (nameNode && nameNode.type === "identifier") {
        emitTypeAlias(node, nameNode.text, filePath, content, symbols, allList);
      }
      return;
    }

    for (const child of node.namedChildren) {
      visit(child, classStack, filePath, content, symbols, allList);
    }
  }

  function handleDef(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
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
          visit(child, classStack, filePath, content, symbols, null);
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

    indexFile(filePath: string, content: string): IndexedSymbol[] {
      const tree = parse(filePath, content);
      const symbols: IndexedSymbol[] = [];
      const classStack: string[] = [];
      const allList = extractAllList(tree.rootNode);
      for (const child of tree.rootNode.namedChildren) {
        visit(child, classStack, filePath, content, symbols, allList);
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
       * Resolve a name as it appears at a callsite into one or more candidate
       * symbols, biased toward (1) the importing file's local aliases, then
       * (2) same-file symbols, then (3) any project symbol with that name.
       */
      function resolveName(
        rawName: string,
        filePath: string,
        aliases: Map<string, string>,
        kinds?: IndexedSymbol["kind"][],
      ): IndexedSymbol[] {
        const aliasTarget = aliases.get(rawName);
        if (aliasTarget !== undefined) {
          // Try the fully-qualified alias first (e.g. `src.types.Task`).
          const aliasMatches = resolveCandidates(aliasTarget, undefined, kinds);
          if (aliasMatches.length > 0) return aliasMatches;
          // The alias may point at a module path whose leaf is the symbol name.
          const lastDot = aliasTarget.lastIndexOf(".");
          if (lastDot >= 0) {
            const leaf = aliasTarget.slice(lastDot + 1);
            const moduleStub = aliasTarget.slice(0, lastDot);
            const targetFile = moduleToFile.get(moduleStub);
            if (targetFile !== undefined) {
              const inModule = resolveCandidates(leaf, targetFile, kinds);
              if (inModule.length > 0) return inModule;
            }
            const leafMatches = resolveCandidates(leaf, undefined, kinds);
            if (leafMatches.length > 0) return leafMatches;
          }
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

        const classStack: string[] = [];

        function fromFor(name: string): string {
          return classStack.length > 0
            ? `${classStack.join(".")}.${name}`
            : name;
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
                  } else {
                    const aliasTarget = aliases.get(objName);
                    if (aliasTarget !== undefined) {
                      // Module-qualified call: `mod.foo()` → look up `<aliasTarget>.foo`.
                      const fq = `${aliasTarget}.${attrName}`;
                      const targets = resolveName(fq, filePath, aliases, [
                        "function",
                        "class",
                        "method",
                      ]);
                      addResolvedEdges(from, targets, "calls");
                      // Also try the leaf — `mod.foo` might be a same-named symbol.
                      const leafMatches = resolveCandidates(attrName, undefined, [
                        "function",
                        "class",
                        "method",
                      ]);
                      addResolvedEdges(from, leafMatches, "calls");
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
                  let baseName: string | null = null;
                  if (arg.type === "identifier") baseName = arg.text;
                  else if (arg.type === "attribute") {
                    // `mod.Base` — use the attribute leaf as the candidate base name.
                    baseName = arg.childForFieldName("attribute")?.text ?? null;
                  }
                  if (baseName === null || baseName.length === 0) continue;
                  const targets = resolveName(baseName, filePath, aliases, [
                    "class",
                    "interface",
                  ]);
                  addResolvedEdges(fqClass, targets, "extends");
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
