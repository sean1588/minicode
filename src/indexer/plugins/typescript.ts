import path from "node:path";

import ts from "typescript";

import type {
  DependencyEdge,
  DependencyEdgeKind,
  IndexedSymbol,
  LanguagePlugin,
} from "../types.js";

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function getLine(sourceFile: ts.SourceFile, position: number): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(position);
  return line + 1;
}

function extractSignature(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  const fullText = node.getText(sourceFile);
  const sourceText = sourceFile.getText();

  const getSigEnd = (): number | null => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      return node.body?.getStart(sourceFile) ?? null;
    }
    if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
      return node.body.getStart(sourceFile);
    }
    if (ts.isClassDeclaration(node)) {
      const text = sourceText.slice(node.getStart(), node.getEnd());
      const braceIdx = text.indexOf("{");
      return braceIdx >= 0 ? node.getStart() + braceIdx : null;
    }
    return null;
  };

  const sigEnd = getSigEnd();
  if (sigEnd !== null) {
    const sig = sourceText.slice(node.getStart(), sigEnd).trim();
    return sig.endsWith(")") ? sig : sig;
  }

  return fullText;
}

function isExported(node: ts.Declaration): boolean {
  if (ts.canHaveModifiers(node)) {
    const mods = ts.getModifiers(node);
    if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      return true;
    }
  }
  return false;
}

function extractJSDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const nodeWithJSDoc = node as ts.Node & { jsDoc?: ts.NodeArray<ts.JSDoc> };
  const jsDoc = nodeWithJSDoc.jsDoc?.[0];
  if (!jsDoc) return undefined;
  const fullText = jsDoc.getText(sourceFile);
  const cleaned = fullText
    .replace(/^\s*\/\*\*/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function createPlugin(): LanguagePlugin {
  return {
    name: "typescript",
    extensions: EXTENSIONS,

    canIndex(filePath: string): boolean {
      const lower = filePath.toLowerCase();
      return EXTENSIONS.some((ext) => lower.endsWith(ext));
    },

    indexFile(filePath: string, content: string): IndexedSymbol[] {
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );

      const symbols: IndexedSymbol[] = [];
      let currentClass: string | null = null;

      function visit(node: ts.Node): void {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.getText(sourceFile);
          const qualifiedName = currentClass ? `${currentClass}.${name}` : name;
          const doc = extractJSDoc(node, sourceFile);
          symbols.push({
            name,
            qualifiedName,
            kind: "function",
            filePath,
            startLine: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.getEnd()),
            signature: extractSignature(node, sourceFile),
            exported: isExported(node),
            dependencies: [],
            ...(doc && { docComment: doc }),
          });
          return;
        }

        if (ts.isClassDeclaration(node) && node.name) {
          const name = node.name.getText(sourceFile);
          const prevClass = currentClass;
          currentClass = name;
          const doc = extractJSDoc(node, sourceFile);
          symbols.push({
            name,
            qualifiedName: name,
            kind: "class",
            filePath,
            startLine: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.getEnd()),
            signature: extractSignature(node, sourceFile),
            exported: isExported(node),
            dependencies: [],
            ...(doc && { docComment: doc }),
          });
          ts.forEachChild(node, visit);
          currentClass = prevClass;
          return;
        }

        if (ts.isConstructorDeclaration(node)) {
          const qualifiedName = currentClass
            ? `${currentClass}.constructor`
            : "constructor";
          const doc = extractJSDoc(node, sourceFile);
          symbols.push({
            name: "constructor",
            qualifiedName,
            kind: "method",
            filePath,
            startLine: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.getEnd()),
            signature: extractSignature(node, sourceFile),
            exported: false,
            dependencies: [],
            ...(doc && { docComment: doc }),
          });
          return;
        }

        if (ts.isMethodDeclaration(node) && node.name) {
          const name =
            ts.isComputedPropertyName(node.name)
              ? "[computed]"
              : node.name.getText(sourceFile);
          const qualifiedName = currentClass ? `${currentClass}.${name}` : name;
          const doc = extractJSDoc(node, sourceFile);
          symbols.push({
            name,
            qualifiedName,
            kind: "method",
            filePath,
            startLine: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.getEnd()),
            signature: extractSignature(node, sourceFile),
            exported: false,
            dependencies: [],
            ...(doc && { docComment: doc }),
          });
          return;
        }

        if (ts.isInterfaceDeclaration(node) && node.name) {
          const name = node.name.getText(sourceFile);
          const doc = extractJSDoc(node, sourceFile);
          symbols.push({
            name,
            qualifiedName: name,
            kind: "interface",
            filePath,
            startLine: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.getEnd()),
            signature: node.getText(sourceFile).split("\n")[0] ?? `interface ${name}`,
            exported: isExported(node),
            dependencies: [],
            ...(doc && { docComment: doc }),
          });
          return;
        }

        if (ts.isTypeAliasDeclaration(node) && node.name) {
          const name = node.name.getText(sourceFile);
          const doc = extractJSDoc(node, sourceFile);
          symbols.push({
            name,
            qualifiedName: name,
            kind: "type",
            filePath,
            startLine: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.getEnd()),
            signature: node.getText(sourceFile).split("\n")[0] ?? `type ${name}`,
            exported: isExported(node),
            dependencies: [],
            ...(doc && { docComment: doc }),
          });
          return;
        }

        if (ts.isVariableStatement(node)) {
          const exported =
            node.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            ) ?? false;
          const doc = extractJSDoc(node, sourceFile);
          for (const decl of node.declarationList.declarations) {
            const init = decl.initializer;
            if (
              ts.isIdentifier(decl.name) &&
              init &&
              (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
            ) {
              const name = decl.name.getText(sourceFile);
              symbols.push({
                name,
                qualifiedName: name,
                kind: "function",
                filePath,
                startLine: getLine(sourceFile, decl.getStart(sourceFile)),
                endLine: getLine(sourceFile, decl.getEnd()),
                signature: extractSignature(decl, sourceFile),
                exported,
                dependencies: [],
                ...(doc && { docComment: doc }),
              });
            }
          }
          return;
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return symbols;
    },

    resolveDependencies(
      symbols: IndexedSymbol[],
      projectFiles: Map<string, string>,
    ): DependencyEdge[] {
      const symbolSet = new Set(symbols.map((s) => s.qualifiedName));
      const edges: DependencyEdge[] = [];
      const rootDir = "/project";

      function addEdge(
        from: string,
        to: string,
        kind: DependencyEdgeKind,
      ): void {
        if (symbolSet.has(to)) {
          edges.push({ from, to, kind });
        }
      }

      function collectTypeRefs(node: ts.Node, from: string): void {
        if (ts.isTypeReferenceNode(node)) {
          const name = node.typeName.getText();
          addEdge(from, name, "references");
          if (ts.isQualifiedName(node.typeName)) {
            const left = node.typeName.left;
            if (ts.isIdentifier(left)) {
              addEdge(from, left.getText(), "references");
            }
          }
        }
        ts.forEachChild(node, (n) => collectTypeRefs(n, from));
      }

      function collectCalls(node: ts.Node, from: string): void {
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          if (ts.isIdentifier(expr)) {
            addEdge(from, expr.getText(), "calls");
          } else if (ts.isNewExpression(expr) && expr.expression) {
            if (ts.isIdentifier(expr.expression)) {
              addEdge(from, expr.expression.getText(), "calls");
            }
          }
        }
        ts.forEachChild(node, (n) => collectCalls(n, from));
      }

      for (const [filePath, content] of projectFiles) {
        const fullPath = path.join(rootDir, filePath);
        const sourceFile = ts.createSourceFile(
          fullPath,
          content,
          ts.ScriptTarget.Latest,
          true,
        );

        let currentClass: string | null = null;

        function visit(node: ts.Node): void {
          if (ts.isClassDeclaration(node) && node.name) {
            const name = node.name.getText(sourceFile);
            const prevClass = currentClass;
            currentClass = name;

            if (symbolSet.has(name)) {
              for (const clause of node.heritageClauses ?? []) {
                for (const type of clause.types) {
                  const expr = type.expression;
                  const target =
                    ts.isIdentifier(expr)
                      ? expr.getText()
                      : ts.isPropertyAccessExpression(expr)
                        ? expr.expression.getText()
                        : expr.getText();
                  const kind: DependencyEdgeKind =
                    clause.token === ts.SyntaxKind.ExtendsKeyword
                      ? "extends"
                      : "implements";
                  addEdge(name, target, kind);
                }
              }
            }

            ts.forEachChild(node, visit);
            currentClass = prevClass;
            return;
          }

          if (ts.isConstructorDeclaration(node)) {
            const from = currentClass ? `${currentClass}.constructor` : "constructor";
            if (symbolSet.has(from)) {
              collectTypeRefs(node, from);
              collectCalls(node, from);
            }
            return;
          }

          if (ts.isMethodDeclaration(node) && node.name) {
            const name =
              ts.isComputedPropertyName(node.name)
                ? "[computed]"
                : node.name.getText(sourceFile);
            const from = currentClass ? `${currentClass}.${name}` : name;
            if (symbolSet.has(from)) {
              collectTypeRefs(node, from);
              collectCalls(node, from);
            }
            return;
          }

          if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.getText(sourceFile);
            const from = currentClass ? `${currentClass}.${name}` : name;
            if (symbolSet.has(from)) {
              collectTypeRefs(node, from);
              collectCalls(node, from);
            }
            return;
          }

          if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
              const init = decl.initializer;
              if (
                ts.isIdentifier(decl.name) &&
                init &&
                (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
              ) {
                const name = decl.name.getText(sourceFile);
                if (symbolSet.has(name)) {
                  collectTypeRefs(decl, name);
                  collectCalls(decl, name);
                }
              }
            }
            return;
          }

          ts.forEachChild(node, visit);
        }

        visit(sourceFile);
      }

      return edges;
    },
  };
}

export const typescriptPlugin: LanguagePlugin = createPlugin();
