/**
 * Minimal type definitions for mini-coder plugins.
 * Must match mini-coder's IndexedSymbol and LanguagePlugin interfaces.
 */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method";

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

export interface DependencyEdge {
  from: string;
  to: string;
  kind: "calls" | "imports" | "extends" | "implements" | "references";
}

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
