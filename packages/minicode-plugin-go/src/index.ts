import path from "node:path";
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import type {
  DependencyEdge,
  DependencyEdgeKind,
  IndexedSymbol,
  LanguagePlugin,
  SymbolKind,
} from "@sean.holung/minicode-sdk";

type SyntaxNode = Parser.SyntaxNode;
type Declaration = { symbol: IndexedSymbol; node: SyntaxNode };

const parser = new Parser();
parser.setLanguage(Go);

function packageName(root: SyntaxNode): string | undefined {
  return root.namedChildren.find((n) => n.type === "package_clause")
    ?.namedChildren[0]?.text;
}

// Directories define Go package boundaries; package clauses distinguish external tests.
function packageKey(filePath: string, name: string): string {
  const dir = path.posix.dirname(filePath.replace(/\\/g, "/"));
  return dir === "." ? name : `${dir}/${name}`;
}

function receiverType(node: SyntaxNode): string | undefined {
  let type = node.childForFieldName("receiver")?.namedChildren[0]
    ?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren[0];
  if (type?.type === "generic_type") type = type.childForFieldName("type") ?? undefined;
  return type?.text;
}

function headerText(node: SyntaxNode, body: SyntaxNode | null | undefined): string {
  return node.text.slice(0, body ? body.startIndex - node.startIndex : undefined).trim();
}

function docComment(node: SyntaxNode): string | undefined {
  const comments: string[] = [];
  let previous = node.previousNamedSibling;
  let row = node.startPosition.row;
  while (previous?.type === "comment" && previous.endPosition.row >= row - 1) {
    if (previous.previousSibling?.endPosition.row === previous.startPosition.row) break;
    const text = previous.text;
    const cleaned = text.startsWith("//")
      ? text.split("\n").filter((line) => !/^\/\/[a-z0-9]+:\S/.test(line))
        .map((line) => line.replace(/^\/\/ ?/, "")).join("\n")
      : text.slice(2, -2).split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n").trim();
    if (cleaned) comments.unshift(cleaned);
    row = previous.startPosition.row;
    previous = previous.previousNamedSibling;
  }
  return comments.join("\n") || undefined;
}

function declarations(filePath: string, root: SyntaxNode): Declaration[] {
  const pkg = packageName(root);
  if (!pkg) return [];
  const prefix = packageKey(filePath, pkg);
  const result: Declaration[] = [];

  function add(node: SyntaxNode, name: string, kind: SymbolKind, options: {
    localName?: string;
    signature?: string;
    group?: SyntaxNode;
  } = {}): void {
    if (name === "_") return;
    const localName = options.localName ?? name;
    const signature = options.signature ?? node.text;
    const doc = docComment(node) ?? (options.group && docComment(options.group));
    result.push({ node, symbol: {
      name, qualifiedName: `${prefix}.${localName}`, aliases: [localName, `${pkg}.${localName}`],
      kind, filePath, startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1, signature: signature.trim(),
      exported: /^\p{Lu}/u.test(name), dependencies: [],
      ...(doc ? { docComment: doc } : {}),
    } });
  }

  for (const node of root.namedChildren) {
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      const receiver = receiverType(node);
      const body = node.childForFieldName("body");
      add(node, name, receiver ? "method" : "function", {
        localName: receiver ? `${receiver}.${name}` : name,
        signature: headerText(node, body),
      });
      continue;
    }
    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        const name = spec.childForFieldName("name")?.text;
        if (!name) continue;
        const type = spec.childForFieldName("type");
        const typeKinds: Record<string, SymbolKind> = { struct_type: "class", interface_type: "interface" };
        const kind = spec.type === "type_alias" ? "type" : typeKinds[type?.type ?? ""] ?? "type";
        const body = type?.type === "struct_type" || type?.type === "interface_type"
          ? type.children.find((child) => child.type === "{" || child.type === "field_declaration_list")
          : undefined;
        add(spec, name, kind, { signature: `type ${headerText(spec, body)}`, group: node });
        for (const method of type?.namedChildren ?? []) {
          if (method.type !== "method_elem") continue;
          const methodName = method.childForFieldName("name")?.text;
          if (methodName) add(method, methodName, "method", { localName: `${name}.${methodName}` });
        }
      }
      continue;
    }
    if (node.type === "const_declaration" || node.type === "var_declaration") {
      const keyword = node.type === "const_declaration" ? "const" : "var";
      const specs = (node.namedChildren.find((child) => child.type === "var_spec_list") ?? node)
        .namedChildren.filter((child) => child.type === "var_spec" || child.type === "const_spec");
      for (const spec of specs) {
        for (const name of spec.childrenForFieldName("name")) {
          add(spec, name.text, "variable", {
            signature: `${keyword} ${spec.text.split("\n", 1)[0]}`,
            group: node,
          });
        }
      }
    }
  }
  return result;
}

/** Conservatively suppress names declared anywhere inside a declaration's scope. */
function shadowedNames(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const receiver = node.childForFieldName("receiver");
  for (const args of receiver?.descendantsOfType("type_arguments") ?? []) {
    for (const name of args.descendantsOfType("type_identifier")) names.add(name.text);
  }
  for (const decl of node.descendantsOfType([
    "parameter_declaration", "variadic_parameter_declaration", "type_parameter_declaration",
    "short_var_declaration", "var_spec", "const_spec", "type_spec", "type_alias", "range_clause",
    "type_switch_statement", "receive_statement",
  ])) {
    for (const name of decl.childrenForFieldName("name")) names.add(name.text);
    const left = decl.childForFieldName("left") ?? decl.childForFieldName("alias");
    for (const name of left?.namedChildren ?? []) {
      if (name.type === "identifier") names.add(name.text);
    }
  }
  return names;
}

function symbolKey(symbol: IndexedSymbol): string {
  return `${symbol.filePath}\0${symbol.originalQualifiedName ?? symbol.qualifiedName}\0${symbol.startLine}`;
}

export const goPlugin = {
  name: "go",
  extensions: [".go"],
  canIndex(filePath: string): boolean {
    const parts = filePath.replace(/\\/g, "/").split("/");
    return filePath.toLowerCase().endsWith(".go") &&
      !parts.some((part) => part === "vendor" || part === "testdata" || part.startsWith("_"));
  },
  indexFile(filePath, content) {
    const tree = parser.parse(content);
    return declarations(filePath, tree.rootNode).map((d) => d.symbol);
  },
  resolveDependencies(symbols, projectFiles) {
    const trees = new Map<string, Parser.Tree>();
    const sources = new Map(symbols.map((symbol) => [symbolKey(symbol), symbol]));
    const targets = new Map<string, IndexedSymbol[]>();
    const edges: DependencyEdge[] = [];
    const edgeKeys = new Set<string>();
    function addEdge(from: string, to: string, kind: DependencyEdgeKind): void {
      const key = `${from}\0${to}\0${kind}`;
      if (from === to || edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ from, to, kind });
    }
    // Stateless parsing avoids retaining ASTs across workspaces or stale file contents.
    // Tradeoff: every resolution reparses Go files, including after non-Go edits.
    // Source lookups are linear to build and constant-time per declaration.
    for (const [file, content] of projectFiles) {
      if (!goPlugin.canIndex(file)) continue;
      const tree = parser.parse(content);
      trees.set(file, tree);

    }
    for (const symbol of symbols) {
      if (!trees.has(symbol.filePath) || symbol.kind === "method") continue;
      const key = symbol.originalQualifiedName ?? symbol.qualifiedName;
      targets.set(key, [...(targets.get(key) ?? []), symbol]);
    }
    for (const [file, tree] of trees) {
      const name = packageName(tree.rootNode);
      if (!name) continue;
      const pkg = packageKey(file, name);
      // Imports can shadow package-level names; never guess external targets.
      const imports = new Set(tree.rootNode.descendantsOfType("import_spec").map((n) =>
        n.childForFieldName("name")?.text ??
        n.childForFieldName("path")?.text.slice(1, -1).split("/").pop()));
      if (imports.has(".")) continue;
      for (const { symbol, node } of declarations(file, tree.rootNode)) {
        const source = sources.get(symbolKey(symbol));
        if (!source) continue;
        const shadowed = shadowedNames(node);
        const add = (name: string, kind: "calls" | "references") => {
          if (shadowed.has(name) || imports.has(name)) return;
          const matches = targets.get(`${pkg}.${name}`) ?? [];
          // Build-tag alternatives are ambiguous without a Go build context.
          if (matches.length !== 1) return;
          const target = matches[0]!;
          addEdge(source.qualifiedName, target.qualifiedName, kind);
        };
        for (const call of node.descendantsOfType("call_expression")) {
          const fn = call.childForFieldName("function");
          if (fn?.type === "identifier") add(fn.text, "calls");
        }
        for (const type of node.descendantsOfType("type_identifier")) {
          if (type.parent?.type === "qualified_type" ||
              type.parent?.childForFieldName("name")?.id === type.id) continue;
          add(type.text, "references");
        }
      }
    }
    return edges;
  },
} satisfies LanguagePlugin;
