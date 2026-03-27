import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MINICODE_HOME } from "../agent/config.js";
import { createProjectIndex } from "./project-index.js";
import { loadPlugins } from "./plugin-loader.js";
import type {
  DependencyEdge,
  IndexedSymbol,
  LanguagePlugin,
  ProjectIndex,
} from "./types.js";

const CACHE_FILENAME = "index.json";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function hashWorkspacePath(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

/**
 * Return the cache directory for a workspace. Index files live under ~/.minicode/cache/<hash>/
 * so caches are global and keyed by workspace path.
 */
export function getWorkspaceCacheDir(workspaceRoot: string): string {
  return path.join(MINICODE_HOME, "cache", hashWorkspacePath(workspaceRoot));
}

interface CachePayload {
  version: 1;
  fileHashes: Record<string, string>;
  symbols: [string, IndexedSymbol][];
  files: [string, IndexedSymbol[]][];
  dependencyEdges: DependencyEdge[];
  projectFiles: [string, string][];
  workspaceRoot: string;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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

/**
 * Compute content hashes for all source files in the workspace.
 */
export async function computeFileHashes(
  workspaceRoot: string,
): Promise<Map<string, string>> {
  const root = path.resolve(workspaceRoot);
  const plugins = await loadPlugins(root);
  const validExtensions = new Set(plugins.flatMap((p) => p.extensions));

  const sourceFiles: string[] = [];
  await collectSourceFiles(root, root, sourceFiles, validExtensions);

  const hashes = new Map<string, string>();
  for (const relPath of sourceFiles) {
    const absPath = path.join(root, relPath);
    try {
      const content = await readFile(absPath, "utf8");
      hashes.set(relPath, hashContent(content));
    } catch {
      // skip unreadable files
    }
  }
  return hashes;
}

function hashesMatch(
  cached: Record<string, string>,
  current: Map<string, string>,
): boolean {
  if (Object.keys(cached).length !== current.size) return false;
  for (const [relPath, hash] of current) {
    if (cached[relPath] !== hash) return false;
  }
  return true;
}

/**
 * Save the project index to disk. Call after buildProjectIndex.
 */
export async function saveIndex(
  index: ProjectIndex,
  cacheDir: string,
  fileHashes: Map<string, string>,
): Promise<void> {
  const payload: CachePayload = {
    version: 1,
    fileHashes: Object.fromEntries(fileHashes),
    symbols: [...index.symbols.entries()],
    files: [...index.files.entries()],
    dependencyEdges: [...index.dependencyEdges],
    projectFiles: [...index.projectFiles.entries()],
    workspaceRoot: index.workspaceRoot,
  };

  await mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  await writeFile(cachePath, JSON.stringify(payload, null, 0), "utf8");
}

/**
 * Load the project index from cache if all file hashes match.
 * Returns null if cache is missing, invalid, or any file has changed.
 */
export async function loadIndex(
  cacheDir: string,
  fileHashes: Map<string, string>,
): Promise<ProjectIndex | null> {
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch {
    return null;
  }

  let payload: CachePayload;
  try {
    payload = JSON.parse(raw) as CachePayload;
  } catch {
    return null;
  }

  if (payload.version !== 1 || !payload.fileHashes) return null;
  if (!hashesMatch(payload.fileHashes, fileHashes)) return null;

  const symbols = new Map<string, IndexedSymbol>(
    payload.symbols as [string, IndexedSymbol][],
  );
  const files = new Map<string, IndexedSymbol[]>(
    payload.files as [string, IndexedSymbol[]][],
  );
  const dependencyEdges = payload.dependencyEdges ?? [];
  const projectFiles = new Map<string, string>(
    payload.projectFiles as [string, string][],
  );
  const workspaceRoot = payload.workspaceRoot ?? "";

  const plugins: LanguagePlugin[] = await loadPlugins(workspaceRoot);

  return createProjectIndexFromCache(
    symbols,
    files,
    dependencyEdges,
    plugins,
    projectFiles,
    workspaceRoot,
  );
}

function createProjectIndexFromCache(
  symbols: Map<string, IndexedSymbol>,
  files: Map<string, IndexedSymbol[]>,
  dependencyEdges: DependencyEdge[],
  plugins: LanguagePlugin[],
  projectFiles: Map<string, string>,
  workspaceRoot: string,
): ProjectIndex {
  return createProjectIndex(
    symbols,
    files,
    dependencyEdges,
    plugins,
    projectFiles,
    workspaceRoot,
  );
}
