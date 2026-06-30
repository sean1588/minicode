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
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
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

function createPlugin() {
  const astCache = new Map<string, ts.SourceFile>();

  return {
    name: "typescript",
    extensions: EXTENSIONS,

    canIndex(filePath: string): boolean {
      const lower = filePath.toLowerCase();
      return EXTENSIONS.some((ext) => lower.endsWith(ext));
    },

    isEntryPoint(filePath: string): boolean {
      return /(?:^|\/)index\.[jt]sx?$/.test(filePath.replace(/\\/g, "/"));
    },

    indexFile(filePath: string, content: string): IndexedSymbol[] {
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      astCache.set(filePath, sourceFile);

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

        if (
          (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
          node.name
        ) {
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
            exported: ts.isClassDeclaration(node) ? isExported(node) : false,
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
            if (!ts.isIdentifier(decl.name) || !init) continue;

            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
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
            } else if (ts.isClassExpression(init)) {
              const name = decl.name.getText(sourceFile);
              const prevClass = currentClass;
              currentClass = name;
              symbols.push({
                name,
                qualifiedName: name,
                kind: "class",
                filePath,
                startLine: getLine(sourceFile, decl.getStart(sourceFile)),
                endLine: getLine(sourceFile, decl.getEnd()),
                signature: extractSignature(init, sourceFile),
                exported,
                dependencies: [],
                ...(doc && { docComment: doc }),
              });
              ts.forEachChild(init, visit);
              currentClass = prevClass;
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
      const symbolsByLookup = new Map<string, IndexedSymbol[]>();
      const edges: DependencyEdge[] = [];
      const edgeKeys = new Set<string>();
      const rootDir = "/project";

      function addLookup(key: string, symbol: IndexedSymbol): void {
        if (key.length === 0) return;
        const existing = symbolsByLookup.get(key);
        if (existing) {
          existing.push(symbol);
        } else {
          symbolsByLookup.set(key, [symbol]);
        }
      }

      for (const symbol of symbols) {
        const lookupKeys = new Set([
          symbol.qualifiedName,
          symbol.name,
          symbol.originalQualifiedName ?? "",
          symbol.displayName ?? "",
          ...(symbol.aliases ?? []),
        ]);
        for (const key of lookupKeys) {
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

      function addResolvedEdges(
        rawFrom: string,
        rawTo: string,
        kind: DependencyEdgeKind,
        filePath: string,
        targetKinds?: IndexedSymbol["kind"][],
      ): void {
        const fromMatches = resolveCandidates(rawFrom, filePath);
        const sameFileTargets = resolveCandidates(rawTo, filePath, targetKinds);
        const toMatches = sameFileTargets.length > 0
          ? sameFileTargets
          : resolveCandidates(rawTo, undefined, targetKinds);
        for (const fromSymbol of fromMatches) {
          for (const toSymbol of toMatches) {
            addEdge(fromSymbol.qualifiedName, toSymbol.qualifiedName, kind);
          }
        }
      }

      function collectTypeRefs(node: ts.Node, from: string, filePath: string): void {
        if (ts.isTypeReferenceNode(node)) {
          const name = node.typeName.getText();
          addResolvedEdges(from, name, "references", filePath, ["type", "interface", "class"]);
          if (ts.isQualifiedName(node.typeName)) {
            const left = node.typeName.left;
            if (ts.isIdentifier(left)) {
              addResolvedEdges(from, left.getText(), "references", filePath, ["type", "interface", "class"]);
            }
          }
        }
        ts.forEachChild(node, (n) => collectTypeRefs(n, from, filePath));
      }

      function collectCalls(node: ts.Node, from: string, filePath: string): void {
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          if (ts.isIdentifier(expr)) {
            addResolvedEdges(from, expr.getText(), "calls", filePath, ["function", "class", "variable"]);
          }
        }
        if (ts.isNewExpression(node)) {
          const expr = node.expression;
          if (ts.isIdentifier(expr)) {
            addResolvedEdges(from, expr.getText(), "calls", filePath, ["class", "function"]);
          }
        }
        ts.forEachChild(node, (n) => collectCalls(n, from, filePath));
      }

      for (const [filePath, content] of projectFiles) {
        const fullPath = path.join(rootDir, filePath);
        const sourceFile = astCache.get(filePath) ?? ts.createSourceFile(
          fullPath,
          content,
          ts.ScriptTarget.Latest,
          true,
        );

        let currentClass: string | null = null;

        function visitClassNode(
          node: ts.ClassDeclaration | ts.ClassExpression,
          name: string,
        ): void {
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
                addResolvedEdges(name, target, kind, filePath, ["class", "interface"]);
              }
            }
          }

          ts.forEachChild(node, visit);
          currentClass = prevClass;
        }

        function visit(node: ts.Node): void {
          if (
            (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
            node.name
          ) {
            const name = node.name.getText(sourceFile);
            visitClassNode(node, name);
            return;
          }

          if (ts.isConstructorDeclaration(node)) {
            const from = currentClass ? `${currentClass}.constructor` : "constructor";
            if (resolveCandidates(from, filePath).length > 0) {
              collectTypeRefs(node, from, filePath);
              collectCalls(node, from, filePath);
            }
            return;
          }

          if (ts.isMethodDeclaration(node) && node.name) {
            const name =
              ts.isComputedPropertyName(node.name)
                ? "[computed]"
                : node.name.getText(sourceFile);
            const from = currentClass ? `${currentClass}.${name}` : name;
            if (resolveCandidates(from, filePath).length > 0) {
              collectTypeRefs(node, from, filePath);
              collectCalls(node, from, filePath);
            }
            return;
          }

          if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.getText(sourceFile);
            const from = currentClass ? `${currentClass}.${name}` : name;
            if (resolveCandidates(from, filePath).length > 0) {
              collectTypeRefs(node, from, filePath);
              collectCalls(node, from, filePath);
            }
            return;
          }

          if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
              const init = decl.initializer;
              if (!ts.isIdentifier(decl.name) || !init) continue;

              if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                const name = decl.name.getText(sourceFile);
                if (resolveCandidates(name, filePath).length > 0) {
                  collectTypeRefs(decl, name, filePath);
                  collectCalls(decl, name, filePath);
                }
              } else if (ts.isClassExpression(init)) {
                const name = decl.name.getText(sourceFile);
                visitClassNode(init, name);
              }
            }
            return;
          }

          ts.forEachChild(node, visit);
        }

        visit(sourceFile);
      }

      astCache.clear();
      return edges;
    },
  };
}

export const typescriptPlugin = createPlugin() satisfies LanguagePlugin;
