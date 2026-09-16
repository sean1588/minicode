/**
 * Minimal type definitions for minicode plugins.
 * Must match minicode's IndexedSymbol and LanguagePlugin interfaces.
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
  /**
   * Optional: whether `filePath` is a conventional entry-point file for this
   * language (e.g. `index.ts`, `__init__.py`, `main.go`). Entry-point files
   * are ranked higher in the code map.
   */
  isEntryPoint?(filePath: string): boolean;
}
