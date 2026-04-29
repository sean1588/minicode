import Parser from "tree-sitter";

import type {
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
 * Slice the header text of a function/class from `def`/`class` to the start
 * of its body (the `:`), with trailing colon and whitespace trimmed.
 */
function extractHeaderSignature(headerNode: SyntaxNode, content: string): string {
  const body = headerNode.childForFieldName("body");
  const end = body ? body.startIndex : headerNode.endIndex;
  const raw = content.slice(headerNode.startIndex, end).trim();
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

/** Unwrap a `decorated_definition` to the inner function/class node, if any. */
function unwrapDecorated(node: SyntaxNode): { inner: SyntaxNode; outer: SyntaxNode } {
  if (node.type === "decorated_definition") {
    const inner = node.childForFieldName("definition");
    if (inner) return { inner, outer: node };
  }
  return { inner: node, outer: node };
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

  function emitFunction(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    name: string,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
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
      signature: extractHeaderSignature(headerNode, content),
      exported: inClass ? false : isExportedName(name),
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
  ): void {
    const qualifiedName =
      classStack.length > 0 ? `${classStack.join(".")}.${name}` : name;
    const docComment = extractDocstring(headerNode.childForFieldName("body"));
    symbols.push({
      name,
      qualifiedName,
      kind: "class",
      filePath,
      startLine: getLine(outerNode),
      endLine: getEndLine(outerNode),
      signature: extractHeaderSignature(headerNode, content),
      exported: classStack.length > 0 ? false : isExportedName(name),
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
      exported: isExportedName(name),
      dependencies: [],
    });
  }

  function visit(
    node: SyntaxNode,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
  ): void {
    if (node.type === "decorated_definition") {
      const { inner, outer } = unwrapDecorated(node);
      handleDef(inner, outer, classStack, filePath, content, symbols);
      return;
    }
    if (node.type === "function_definition" || node.type === "class_definition") {
      handleDef(node, node, classStack, filePath, content, symbols);
      return;
    }
    if (node.type === "type_alias_statement") {
      const left = node.childForFieldName("left");
      const nameNode = left?.namedChild(0) ?? left;
      if (nameNode && nameNode.type === "identifier") {
        emitTypeAlias(node, nameNode.text, filePath, content, symbols);
      }
      return;
    }

    for (const child of node.namedChildren) {
      visit(child, classStack, filePath, content, symbols);
    }
  }

  function handleDef(
    headerNode: SyntaxNode,
    outerNode: SyntaxNode,
    classStack: string[],
    filePath: string,
    content: string,
    symbols: IndexedSymbol[],
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
      );
      const body = headerNode.childForFieldName("body");
      if (body) {
        classStack.push(nameNode.text);
        for (const child of body.namedChildren) {
          visit(child, classStack, filePath, content, symbols);
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
      for (const child of tree.rootNode.namedChildren) {
        visit(child, classStack, filePath, content, symbols);
      }
      return symbols;
    },
  } satisfies LanguagePlugin;
}

export const pythonPlugin = createPlugin();
