import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { generateCodeMap, type CodeMapResult } from "./code-map.js";
import { getPluginForFile, loadPlugins } from "./plugin-loader.js";
import type {
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
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        await collectSourceFiles(fullPath, root, files);
      }
      continue;
    }

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
        files.push(path.relative(root, fullPath));
      }
    }
  }
}

export function createProjectIndex(
  symbols: Map<string, IndexedSymbol>,
  files: Map<string, IndexedSymbol[]>,
  dependencyEdges: DependencyEdge[],
  plugins: LanguagePlugin[],
  projectFiles: Map<string, string>,
  workspaceRoot: string,
): ProjectIndex {
  return {
    symbols,
    files,
    dependencyEdges,
    plugins,
    projectFiles,
    workspaceRoot,

    getSymbol(name: string): IndexedSymbol | undefined {
      const direct = symbols.get(name);
      if (direct) return direct;
      for (const sym of symbols.values()) {
        if (sym.name === name || sym.qualifiedName === name) return sym;
      }
      return undefined;
    },

    getSymbolsInFile(filePath: string): IndexedSymbol[] {
      return files.get(filePath) ?? [];
    },

    getDependencyCone(symbolName: string, depth = 2): IndexedSymbol[] {
      const target = symbols.get(symbolName) ?? [...symbols.values()].find(
        (s) => s.name === symbolName || s.qualifiedName === symbolName,
      );
      if (!target) return [];

      const result = new Map<string, IndexedSymbol>();
      result.set(target.qualifiedName, target);

      let frontier = new Set<string>([target.qualifiedName]);
      for (let d = 0; d < depth; d += 1) {
        const next = new Set<string>();
        for (const from of frontier) {
          for (const edge of dependencyEdges) {
            if (edge.from === from) {
              const dep = symbols.get(edge.to) ?? [...symbols.values()].find(
                (s) => s.qualifiedName === edge.to || s.name === edge.to,
              );
              if (dep && !result.has(dep.qualifiedName)) {
                result.set(dep.qualifiedName, dep);
                next.add(dep.qualifiedName);
              }
            }
          }
        }
        frontier = next;
      }

      return [...result.values()];
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

      const oldSymbols = files.get(relPath) ?? [];
      for (const sym of oldSymbols) {
        symbols.delete(sym.qualifiedName);
      }
      files.delete(relPath);

      projectFiles.set(relPath, content);
      const extracted = plugin.indexFile(relPath, content);

      for (const sym of extracted) {
        symbols.set(sym.qualifiedName, sym);
        const existing = files.get(relPath) ?? [];
        existing.push(sym);
        files.set(relPath, existing);
      }

      for (const p of plugins) {
        if (p.resolveDependencies) {
          const allSymbols = [...symbols.values()];
          const edges = p.resolveDependencies(allSymbols, projectFiles);
          dependencyEdges.splice(0, dependencyEdges.length, ...edges);
          break;
        }
      }
    },
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

  const sourceFiles: string[] = [];
  await collectSourceFiles(root, root, sourceFiles);

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

    for (const sym of extracted) {
      symbols.set(sym.qualifiedName, sym);
      const existing = files.get(relPath) ?? [];
      existing.push(sym);
      files.set(relPath, existing);
    }
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
