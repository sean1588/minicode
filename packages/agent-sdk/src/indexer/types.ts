/**
 * Symbol kinds extracted by language plugins.
 */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method";

/**
 * A single symbol extracted from source code (function, class, interface, etc.).
 */
export interface IndexedSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
  dependencies: string[];
  /** JSDoc, docstring, or other doc comment when present. */
  docComment?: string;
}

/**
 * Edge kinds for the dependency graph.
 */
export type DependencyEdgeKind =
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "references";

/**
 * A directed edge between two symbols in the dependency graph.
 */
export interface DependencyEdge {
  from: string;
  to: string;
  kind: DependencyEdgeKind;
}

/**
 * Contract for language-specific indexer plugins.
 */
export interface LanguagePlugin {
  name: string;
  extensions: string[];
  canIndex(filePath: string): boolean;
  indexFile(filePath: string, content: string): IndexedSymbol[];
  resolveDependencies?(
    symbols: IndexedSymbol[],
    projectFiles: Map<string, string>,
  ): DependencyEdge[];
}

/**
 * Result of code map generation.
 */
export interface CodeMapResult {
  text: string;
  shownCount: number;
  totalCount: number;
}

/**
 * Queryable project index built from plugin output.
 */
export interface ProjectIndex {
  symbols: Map<string, IndexedSymbol>;
  files: Map<string, IndexedSymbol[]>;
  dependencyEdges: DependencyEdge[];
  plugins: LanguagePlugin[];
  projectFiles: Map<string, string>;
  workspaceRoot: string;

  getSymbol(name: string): IndexedSymbol | undefined;
  getSymbolsInFile(filePath: string): IndexedSymbol[];
  getDependencyCone(symbolName: string, depth?: number): IndexedSymbol[];
  getCodeMap(tokenBudget?: number, focusSymbols?: Set<string>): CodeMapResult;

  /** Find the shortest path between two symbols in the dependency graph. Returns the ordered list of symbols along the path, or empty array if no path exists. */
  findPath(fromSymbol: string, toSymbol: string, maxDepth?: number): IndexedSymbol[];

  /** Trace a symbol back to its entry point(s) — symbols with no inbound edges. Returns paths from the symbol to each reachable entry point. */
  findPathToEntryPoint(symbolName: string, maxDepth?: number): IndexedSymbol[][];

  /** Re-index a file after it has been modified. Updates symbols and dependency edges. */
  reindexFile(filePath: string, content: string): void;
}
