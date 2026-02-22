import type { LanguagePlugin } from "./types.js";
import { typescriptPlugin } from "./plugins/typescript.js";

/**
 * Load all available language plugins.
 * Phase 1: built-in plugins only.
 * Future: local, user, and npm plugins.
 */
export async function loadPlugins(
  workspaceRoot: string,
): Promise<LanguagePlugin[]> {
  void workspaceRoot;
  const plugins: LanguagePlugin[] = [];

  plugins.push(typescriptPlugin);

  // TODO: Scan <workspace>/.mini-coder/plugins/ for local plugins
  // TODO: Scan ~/.mini-coder/plugins/ for user plugins
  // TODO: Discover npm packages matching mini-coder-plugin-*

  return plugins;
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
