import type { IndexedSymbol, LanguagePlugin } from "../types.js";

const EXTENSIONS = [".py"];

const CLASS_RE = /^\s*class\s+(\w+)\s*(?:\([^)]*\))?\s*:?\s*(#.*)?$/;
const DEF_RE = /^\s*(async\s+)?def\s+(\w+)\s*\(/;
const INDENT_RE = /^(\s*)/;

function getIndentLevel(line: string): number {
  const match = line.match(INDENT_RE);
  return match && match[1] ? match[1].length : 0;
}

function extractSignature(line: string, fullName: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("async def ")) {
    return trimmed.replace(/^(async\s+def\s+\w+)\s*\(/, "$1(").split("#")[0]?.trim() ?? trimmed;
  }
  if (trimmed.startsWith("def ")) {
    return trimmed.split("#")[0]?.trim() ?? trimmed;
  }
  if (trimmed.startsWith("class ")) {
    const firstLine = trimmed.split("\n")[0];
    return (firstLine ?? trimmed).split("#")[0]?.trim() ?? trimmed;
  }
  return fullName;
}

export const pythonPlugin: LanguagePlugin = {
  name: "python",
  extensions: EXTENSIONS,

  canIndex(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return EXTENSIONS.some((ext) => lower.endsWith(ext));
  },

  indexFile(filePath: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    const lines = content.split("\n");
    let currentClass: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const lineNum = i + 1;
      const indent = getIndentLevel(line);

      const classMatch = line.match(CLASS_RE);
      if (classMatch && indent === 0) {
        const name = classMatch[1] ?? "Unknown";
        currentClass = name;
        symbols.push({
          name,
          qualifiedName: name,
          kind: "class",
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          signature: extractSignature(line, name),
          exported: false,
          dependencies: [],
        });
        continue;
      }

      const defMatch = line.match(DEF_RE);
      if (defMatch) {
        const name = defMatch[2] ?? "unknown";
        const qualifiedName = currentClass ? `${currentClass}.${name}` : name;
        const sig = extractSignature(line, qualifiedName);
        const kind = currentClass && indent > 0 ? "method" : "function";

        symbols.push({
          name,
          qualifiedName,
          kind,
          filePath,
          startLine: lineNum,
          endLine: lineNum,
          signature: sig,
          exported: false,
          dependencies: [],
        });
        continue;
      }

      if (indent === 0 && currentClass !== null) {
        currentClass = null;
      }
    }

    return symbols;
  },
};
