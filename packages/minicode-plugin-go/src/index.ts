import path from "node:path";
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import type {
  DependencyEdge,
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

function docComment(node: SyntaxNode): string | undefined {
  const comments: string[] = [];
  let previous = node.previousNamedSibling;
  let row = node.startPosition.row;
  while (previous?.type === "comment" && previous.endPosition.row >= row - 1) {
    comments.unshift(previous.text.replace(/^\/\/ ?/gm, "").replace(/^\/\*\s*|\s*\*\/$/g, ""));
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

  function add(node: SyntaxNode, name: string, kind: SymbolKind, localName = name,
    signature = node.text, commentNode = node): void {
    if (name === "_") return;
    const doc = docComment(commentNode);
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
      add(node, name, receiver ? "method" : "function", receiver ? `${receiver}.${name}` : name,
        node.text.slice(0, body ? body.startIndex - node.startIndex : undefined));
      continue;
    }
    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        const name = spec.childForFieldName("name")?.text;
        if (!name) continue;
        const type = spec.childForFieldName("type");
        const kind: SymbolKind = type?.type === "interface_type" && spec.type !== "type_alias"
          ? "interface" : "type";
        const body = type?.type === "struct_type" || type?.type === "interface_type"
          ? type.children.find((child) => child.type === "{" || child.type === "field_declaration_list")
          : undefined;
        const signature = `type ${spec.text.slice(0, body ? body.startIndex - spec.startIndex : undefined)}`;
        add(spec, name, kind, name, signature, docComment(spec) ? spec : node);
        for (const method of type?.namedChildren ?? []) {
          if (method.type !== "method_elem") continue;
          const methodName = method.childForFieldName("name")?.text;
          if (methodName) add(method, methodName, "method", `${name}.${methodName}`);
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
          add(spec, name.text, "variable", name.text, `${keyword} ${spec.text}`,
            docComment(spec) ? spec : node);
        }
      }
    }
  }
  return result;
}

/** Conservatively suppress names declared anywhere inside a declaration's scope. */
function shadowedNames(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const decl of node.descendantsOfType([
    "parameter_declaration", "variadic_parameter_declaration", "type_parameter_declaration",
    "short_var_declaration", "var_spec", "const_spec", "type_spec", "range_clause",
  ])) {
    for (const name of decl.childrenForFieldName("name")) names.add(name.text);
    const left = decl.childForFieldName("left");
    for (const name of left?.namedChildren ?? []) {
      if (name.type === "identifier") names.add(name.text);
    }
  }
  return names;
}

export const goPlugin: LanguagePlugin = {
  name: "go",
  extensions: [".go"],
  canIndex(filePath) { return filePath.toLowerCase().endsWith(".go"); },
  indexFile(filePath, content) {
    const tree = parser.parse(content);
    return declarations(filePath, tree.rootNode).map((d) => d.symbol);
  },
  resolveDependencies(symbols, projectFiles) {
    const trees = new Map<string, Parser.Tree>();
    const packages = new Map<string, string>();
    const targets = new Map<string, IndexedSymbol[]>();
    const edges = new Map<string, DependencyEdge>();
    for (const [file, content] of projectFiles) {
      if (!goPlugin.canIndex(file)) continue;
      const tree = parser.parse(content);
      trees.set(file, tree);
      const pkg = packageName(tree.rootNode);
      if (pkg) packages.set(file, packageKey(file, pkg));
    }
    for (const symbol of symbols) {
      const pkg = packages.get(symbol.filePath);
      if (!pkg || symbol.kind === "method") continue;
      const key = `${pkg}.${symbol.name}`;
      targets.set(key, [...(targets.get(key) ?? []), symbol]);
    }
    for (const [file, tree] of trees) {
      const pkg = packages.get(file);
      // Imports can shadow package-level names; never guess external targets.
      const imports = new Set(tree.rootNode.descendantsOfType("import_spec").map((n) =>
        n.childForFieldName("name")?.text ??
        n.childForFieldName("path")?.text.slice(1, -1).split("/").pop()));
      if (imports.has(".")) continue;
      for (const { symbol, node } of declarations(file, tree.rootNode)) {
        const source = symbols.find((s) => s.filePath === file &&
          (s.originalQualifiedName ?? s.qualifiedName) === symbol.qualifiedName &&
          s.startLine === symbol.startLine && s.kind === symbol.kind);
        if (!source) continue;
        const shadowed = shadowedNames(node);
        const add = (name: string, kind: "calls" | "references") => {
          if (shadowed.has(name) || imports.has(name)) return;
          const matches = targets.get(`${pkg}.${name}`) ?? [];
          // Build-tag alternatives are ambiguous without a Go build context.
          if (matches.length !== 1) return;
          const target = matches[0]!;
          if (target.qualifiedName === source.qualifiedName) return;
          const edge = { from: source.qualifiedName, to: target.qualifiedName, kind };
          edges.set(`${edge.from}\0${edge.to}\0${kind}`, edge);
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
    return [...edges.values()];
  },
};

export default goPlugin;
