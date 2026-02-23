/**
 * mini-coder plugin template.
 * Replace with your language-specific implementation.
 *
 * @see https://github.com/your-org/mini-coder/blob/main/docs/PLUGIN_SPEC.md
 */
import type { IndexedSymbol, LanguagePlugin } from "./types.js";

const EXTENSIONS = [".example"];

const plugin: LanguagePlugin = {
  name: "template",
  extensions: EXTENSIONS,

  canIndex(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return EXTENSIONS.some((ext) => lower.endsWith(ext));
  },

  indexFile(filePath: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    // TODO: Parse content and extract symbols.
    // For a no-op plugin, return empty array.
    void content;
    void filePath;
    return symbols;
  },
};

export default plugin;
export { plugin };
