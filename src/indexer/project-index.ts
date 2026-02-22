import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { generateCodeMap } from "./code-map.js";
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

function createProjectIndex(
  symbols: Map<string, IndexedSymbol>,
  files: Map<string, IndexedSymbol[]>,
  dependencyEdges: DependencyEdge[],
  plugins: LanguagePlugin[],
): ProjectIndex {
  return {
    symbols,
    files,
    dependencyEdges,
    plugins,

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

    getDependencyCone(symbolName: string, depth?: number): IndexedSymbol[] {
      void symbolName;
      void depth;
      return [];
    },

    getCodeMap(tokenBudget?: number): string {
      return generateCodeMap(files, tokenBudget);
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

    const extracted = plugin.indexFile(relPath, content);

    for (const sym of extracted) {
      symbols.set(sym.qualifiedName, sym);
      const existing = files.get(relPath) ?? [];
      existing.push(sym);
      files.set(relPath, existing);
    }
  }

  return createProjectIndex(
    symbols,
    files,
    [],
    plugins,
  );
}
