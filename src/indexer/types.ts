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
}

/**
 * Edge kinds for the dependency graph (Phase 3).
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
 * Queryable project index built from plugin output.
 */
export interface ProjectIndex {
  symbols: Map<string, IndexedSymbol>;
  files: Map<string, IndexedSymbol[]>;
  dependencyEdges: DependencyEdge[];
  plugins: LanguagePlugin[];

  getSymbol(name: string): IndexedSymbol | undefined;
  getSymbolsInFile(filePath: string): IndexedSymbol[];
  getDependencyCone(symbolName: string, depth?: number): IndexedSymbol[];
  getCodeMap(tokenBudget?: number): string;
}
