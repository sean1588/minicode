import type { LanguagePlugin } from "./types.js";
import { typescriptPlugin } from "./plugins/typescript.js";

/**
 * Load all available language plugins.
 * Built-in: TypeScript, Python, Go.
 * Also loads: npm packages (minicode-plugin-*), local plugins (.minicode/plugins/).
 */
export async function loadPlugins(
  workspaceRoot: string,
): Promise<LanguagePlugin[]> {
  const plugins: LanguagePlugin[] = [];

  plugins.push(typescriptPlugin);
  await loadNativePlugins(plugins);

  await loadNpmPlugins(workspaceRoot, plugins);
  await loadLocalPlugins(workspaceRoot, plugins);

  return plugins;
}

/** Missing native dependencies disable only the affected built-in language. */
async function loadNativePlugins(plugins: LanguagePlugin[]): Promise<void> {
  const builtins = [
    { name: "Python", load: async () => (await import("minicode-plugin-python")).pythonPlugin },
    { name: "Go", load: async () => (await import("minicode-plugin-go")).goPlugin },
  ];
  for (const { name, load } of builtins) {
    try {
      plugins.push(await load());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[warn] ${name} plugin failed to load (${name} files will not be indexed): ${message}`,
      );
    }
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
      if (plugin && typeof plugin.canIndex === "function" &&
          !plugins.some((loaded) => loaded.name === plugin.name)) {
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
