import type { LanguagePlugin } from "./types.js";
import { typescriptPlugin } from "./plugins/typescript.js";

/**
 * Load all available language plugins.
 * Built-in: TypeScript, Python.
 * Also loads: npm packages (minicode-plugin-*), local plugins (.minicode/plugins/).
 */
export async function loadPlugins(
  workspaceRoot: string,
): Promise<LanguagePlugin[]> {
  const plugins: LanguagePlugin[] = [];

  plugins.push(typescriptPlugin);
  await loadPythonPlugin(plugins);

  await loadNpmPlugins(workspaceRoot, plugins);
  await loadLocalPlugins(workspaceRoot, plugins);

  return plugins;
}

/**
 * Load the built-in Python plugin via dynamic import so a missing native
 * dependency (e.g. failed `node-gyp` build for `tree-sitter`) degrades
 * gracefully: Python files simply won't be indexed, but the rest of
 * minicode keeps working.
 */
async function loadPythonPlugin(plugins: LanguagePlugin[]): Promise<void> {
  try {
    const mod = await import("minicode-plugin-python");
    if (mod.pythonPlugin) plugins.push(mod.pythonPlugin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] Python plugin failed to load (Python files will not be indexed): ${message}`,
    );
  }
}

async function loadNpmPlugins(
  workspaceRoot: string,
  plugins: LanguagePlugin[],
): Promise<void> {
  const path = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const pkgPath = path.join(workspaceRoot, "package.json");
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    const raw = await readFile(pkgPath, "utf8");
    pkg = JSON.parse(raw) as typeof pkg;
  } catch {
    return;
  }
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const pluginPkgs = Object.keys(deps).filter((k) =>
    k.startsWith("minicode-plugin-"),
  );
  for (const pkgName of pluginPkgs) {
    try {
      const mod = await import(pkgName);
      const plugin = mod.default ?? mod.plugin ?? mod;
      if (plugin && typeof plugin.canIndex === "function") {
        plugins.push(plugin as LanguagePlugin);
      }
    } catch {
      // skip failed plugins
    }
  }
}

async function loadLocalPlugins(
  workspaceRoot: string,
  plugins: LanguagePlugin[],
): Promise<void> {
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { readdir } = await import("node:fs/promises");
  const pluginDir = path.join(workspaceRoot, ".minicode", "plugins");
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = await readdir(pluginDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const pluginPath = path.join(pluginDir, entry.name);
    const pluginUrl = pathToFileURL(pluginPath).href;
    try {
      const mod = await import(pluginUrl);
      const plugin = mod.default ?? mod.plugin ?? mod;
      if (plugin && typeof plugin.canIndex === "function") {
        plugins.push(plugin as LanguagePlugin);
      }
    } catch {
      // skip failed plugins
    }
  }
}

/**
 * Return the first plugin that can index the given file path.
 */
export function getPluginForFile(
  filePath: string,
  plugins: LanguagePlugin[],
): LanguagePlugin | undefined {
  return plugins.find((p) => p.canIndex(filePath));
}
