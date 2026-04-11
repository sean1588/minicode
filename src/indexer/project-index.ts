import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { generateCodeMap } from "./code-map.js";
import { getPluginForFile, loadPlugins } from "./plugin-loader.js";
import { getSymbolLookupNames, normalizeIndexedSymbols } from "./symbol-names.js";
import type {
  CodeMapResult,
  DependencyEdge,
  IndexedSymbol,
  LanguagePlugin,
  ProjectIndex,
} from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

async function collectSourceFiles(
  dir: string,
  root: string,
  files: string[],
  validExtensions: Set<string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        await collectSourceFiles(fullPath, root, files, validExtensions);
      }
      continue;
    }

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (validExtensions.has(ext)) {
        files.push(path.relative(root, fullPath));
      }
    }
  }
}

function buildAdjacencyFrom(edges: DependencyEdge[]): Map<string, DependencyEdge[]> {
  const map = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.from);
    if (list) {
      list.push(edge);
    } else {
      map.set(edge.from, [edge]);
    }
  }
  return map;
}

function buildAdjacencyTo(edges: DependencyEdge[]): Map<string, DependencyEdge[]> {
  const map = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.to);
    if (list) {
      list.push(edge);
    } else {
      map.set(edge.to, [edge]);
    }
  }
  return map;
}

function resolveSymbols(
  name: string,
  symbols: Map<string, IndexedSymbol>,
): IndexedSymbol[] {
  const direct = symbols.get(name);
  if (direct) return [direct];

  const matches = [...symbols.values()].filter((sym) =>
    getSymbolLookupNames(sym).includes(name),
  );
  if (matches.length === 0) {
    return [];
  }

  matches.sort((a, b) =>
    Number(b.exported) - Number(a.exported) ||
    a.filePath.localeCompare(b.filePath) ||
    a.startLine - b.startLine ||
    a.qualifiedName.localeCompare(b.qualifiedName),
  );
  return matches;
}

function resolveSymbol(
  name: string,
  symbols: Map<string, IndexedSymbol>,
): IndexedSymbol | undefined {
  return resolveSymbols(name, symbols)[0];
}

export function createProjectIndex(
  symbols: Map<string, IndexedSymbol>,
  files: Map<string, IndexedSymbol[]>,
  dependencyEdges: DependencyEdge[],
  plugins: LanguagePlugin[],
  projectFiles: Map<string, string>,
  workspaceRoot: string,
): ProjectIndex {
  let adjacencyFrom = buildAdjacencyFrom(dependencyEdges);
  const root = path.resolve(workspaceRoot);

  function rebuildSymbolsMap(): void {
    const normalizedSymbols = normalizeIndexedSymbols(files);
    symbols.clear();
    for (const [qualifiedName, symbol] of normalizedSymbols) {
      symbols.set(qualifiedName, symbol);
    }
  }

  function rebuildDependencyEdges(): void {
    for (const p of plugins) {
      if (p.resolveDependencies) {
        const allSymbols = [...symbols.values()];
        const edges = p.resolveDependencies(allSymbols, projectFiles);
        dependencyEdges.splice(0, dependencyEdges.length, ...edges);
        adjacencyFrom = buildAdjacencyFrom(dependencyEdges);
        break;
      }
    }
  }

  async function refreshFromWorkspace(): Promise<void> {
    const validExtensions = new Set(plugins.flatMap((p) => p.extensions));
    const sourceFiles: string[] = [];
    await collectSourceFiles(root, root, sourceFiles, validExtensions);

    files.clear();
    projectFiles.clear();

    for (const relPath of sourceFiles) {
      const plugin = getPluginForFile(relPath, plugins);
      if (!plugin) continue;

      const absPath = path.join(root, relPath);
      let content: string;
      try {
        content = await readFile(absPath, "utf8");
      } catch {
        continue;
      }

      projectFiles.set(relPath, content);
      const extracted = plugin.indexFile(relPath, content);
      files.set(relPath, extracted);
    }

    rebuildSymbolsMap();
    rebuildDependencyEdges();
  }

  return {
    symbols,
    files,
    dependencyEdges,
    plugins,
    projectFiles,
    workspaceRoot,

    getSymbol(name: string): IndexedSymbol | undefined {
      return resolveSymbol(name, symbols);
    },

    getSymbolMatches(name: string): IndexedSymbol[] {
      return resolveSymbols(name, symbols);
    },

    getSymbolsInFile(filePath: string): IndexedSymbol[] {
      return files.get(filePath) ?? [];
    },

    getDependencyCone(symbolName: string, depth = 2): IndexedSymbol[] {
      const target = resolveSymbol(symbolName, symbols);
      if (!target) return [];

      const result = new Map<string, IndexedSymbol>();
      result.set(target.qualifiedName, target);

      let frontier = new Set<string>([target.qualifiedName]);
      for (let d = 0; d < depth; d += 1) {
        const next = new Set<string>();
        for (const from of frontier) {
          const outEdges = adjacencyFrom.get(from);
          if (!outEdges) continue;
          for (const edge of outEdges) {
            const dep = resolveSymbol(edge.to, symbols);
            if (dep && !result.has(dep.qualifiedName)) {
              result.set(dep.qualifiedName, dep);
              next.add(dep.qualifiedName);
            }
          }
        }
        frontier = next;
      }

      return [...result.values()];
    },

    findPath(fromSymbol: string, toSymbol: string, maxDepth = 10): IndexedSymbol[] {
      const from = resolveSymbol(fromSymbol, symbols);
      const to = resolveSymbol(toSymbol, symbols);
      if (!from || !to) return [];

      // BFS over both outgoing and incoming edges (undirected search)
      const adjacencyTo = buildAdjacencyTo(dependencyEdges);
      const visited = new Set<string>();
      const parent = new Map<string, string>();
      const queue: { name: string; depth: number }[] = [
        { name: from.qualifiedName, depth: 0 },
      ];
      visited.add(from.qualifiedName);

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.name === to.qualifiedName) {
          // Reconstruct path
          const path: IndexedSymbol[] = [];
          let node: string | undefined = to.qualifiedName;
          while (node !== undefined) {
            const sym = resolveSymbol(node, symbols);
            if (sym) path.unshift(sym);
            node = parent.get(node);
          }
          return path;
        }

        if (current.depth >= maxDepth) continue;

        // Follow outgoing edges
        const outEdges = adjacencyFrom.get(current.name) ?? [];
        for (const edge of outEdges) {
          const target = resolveSymbol(edge.to, symbols);
          if (target && !visited.has(target.qualifiedName)) {
            visited.add(target.qualifiedName);
            parent.set(target.qualifiedName, current.name);
            queue.push({ name: target.qualifiedName, depth: current.depth + 1 });
          }
        }

        // Follow incoming edges (reverse direction)
        const inEdges = adjacencyTo.get(current.name) ?? [];
        for (const edge of inEdges) {
          const source = resolveSymbol(edge.from, symbols);
          if (source && !visited.has(source.qualifiedName)) {
            visited.add(source.qualifiedName);
            parent.set(source.qualifiedName, current.name);
            queue.push({ name: source.qualifiedName, depth: current.depth + 1 });
          }
        }
      }

      return [];
    },

    findPathToEntryPoint(symbolName: string, maxDepth = 20): IndexedSymbol[][] {
      const target = resolveSymbol(symbolName, symbols);
      if (!target) return [];

      // Build reverse adjacency: who calls/references this symbol?
      const adjacencyTo = buildAdjacencyTo(dependencyEdges);

      // Find entry points: symbols that have no inbound edges
      const hasInbound = new Set<string>();
      for (const edge of dependencyEdges) {
        hasInbound.add(edge.to);
      }

      // If the target itself is already an entry point (no inbound edges), nothing to trace
      if (!hasInbound.has(target.qualifiedName)) return [];

      // DFS from target following inbound edges back to entry points
      const paths: IndexedSymbol[][] = [];
      const currentPath: IndexedSymbol[] = [target];
      const visiting = new Set<string>([target.qualifiedName]);

      function dfs(node: string, depth: number): void {
        if (depth >= maxDepth) return;

        const inEdges = adjacencyTo.get(node) ?? [];
        const callers = inEdges
          .map((e) => resolveSymbol(e.from, symbols))
          .filter((s): s is IndexedSymbol => s != null && !visiting.has(s.qualifiedName));

        if (callers.length === 0) {
          // Dead end going backwards — this is as far as we can trace
          if (currentPath.length > 1) {
            paths.push([...currentPath].reverse());
          }
          return;
        }

        for (const caller of callers) {
          // If this caller is an entry point (no inbound edges), record the path
          if (!hasInbound.has(caller.qualifiedName)) {
            currentPath.push(caller);
            paths.push([...currentPath].reverse());
            currentPath.pop();
            continue;
          }

          visiting.add(caller.qualifiedName);
          currentPath.push(caller);
          dfs(caller.qualifiedName, depth + 1);
          currentPath.pop();
          visiting.delete(caller.qualifiedName);
        }
      }

      dfs(target.qualifiedName, 0);

      return paths.slice(0, 10);
    },

    getCodeMap(tokenBudget?: number, focusSymbols?: Set<string>): CodeMapResult {
      return generateCodeMap(files, tokenBudget, dependencyEdges, focusSymbols);
    },

    reindexFile(filePath: string, content: string): void {
      const relPath = path.isAbsolute(filePath)
        ? path.relative(workspaceRoot, filePath)
        : path.normalize(filePath);

      const plugin = getPluginForFile(relPath, plugins);
      if (!plugin) return;

      files.delete(relPath);

      projectFiles.set(relPath, content);
      const extracted = plugin.indexFile(relPath, content);
      files.set(relPath, extracted);
      rebuildSymbolsMap();
      rebuildDependencyEdges();
    },

    refreshFromWorkspace,
  };
}

/**
 * Build a project index by scanning the workspace and running all matching plugins.
 */
export async function buildProjectIndex(
  workspaceRoot: string,
): Promise<ProjectIndex> {
  const plugins = await loadPlugins(workspaceRoot);
  const root = path.resolve(workspaceRoot);
  const validExtensions = new Set(plugins.flatMap((p) => p.extensions));

  const sourceFiles: string[] = [];
  await collectSourceFiles(root, root, sourceFiles, validExtensions);

  const symbols = new Map<string, IndexedSymbol>();
  const files = new Map<string, IndexedSymbol[]>();
  const projectFiles = new Map<string, string>();

  for (const relPath of sourceFiles) {
    const plugin = getPluginForFile(relPath, plugins);
    if (!plugin) continue;

    const absPath = path.join(root, relPath);
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    projectFiles.set(relPath, content);
    const extracted = plugin.indexFile(relPath, content);
    files.set(relPath, extracted);
  }

  const normalizedSymbols = normalizeIndexedSymbols(files);
  symbols.clear();
  for (const [qualifiedName, symbol] of normalizedSymbols) {
    symbols.set(qualifiedName, symbol);
  }

  let dependencyEdges: DependencyEdge[] = [];
  for (const plugin of plugins) {
    if (plugin.resolveDependencies) {
      const allSymbols = [...symbols.values()];
      const edges = plugin.resolveDependencies(allSymbols, projectFiles);
      dependencyEdges = edges;
      break;
    }
  }

  return createProjectIndex(
    symbols,
    files,
    dependencyEdges,
    plugins,
    projectFiles,
    root,
  );
}
