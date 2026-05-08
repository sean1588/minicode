import type { ToolDefinition } from "@sean.holung/minicode-sdk";
import { expectNonEmptyString, expectOptionalNumber } from "@sean.holung/minicode-sdk";
import { getSymbolDisplayName, getSymbolLookupNames } from "../indexer/symbol-names.js";
import type { IndexedSymbol, ProjectIndex } from "../indexer/types.js";
import { searchSymbols } from "../shared/symbol-search.js";

const DEFAULT_LIMIT = 30;
const DOC_SUMMARY_MAX_CHARS = 100;

/**
 * Strip JSDoc/block-comment markers and return the first non-empty line of
 * the comment, truncated.
 *
 * Surfacing this beside each match in `search_code_map` output is what
 * addresses the disambiguation failure case from issue #184: when a search
 * returns several similar-named symbols (e.g. `ToolRegistry` class +
 * `createToolRegistry` wrapper + `ToolRegistry.createDefault` method), the
 * model has no way to pick the right one from kind+path alone. The doc
 * summary tells it which is which.
 */
export function summarizeDocComment(doc: string | undefined): string {
  if (!doc) {
    return "";
  }
  // Strip leading /** and trailing */ — defense-in-depth; symbol indexing
  // already cleans most of this.
  const lines = doc
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    // TS compiler can emit JSDoc with `\r` line separators (not `\n`),
    // so we split on both. Without this, the entire comment becomes a
    // single "line" and the truncation chops mid-paragraph rather than
    // at the first description sentence.
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }
  const first = lines[0]!;
  if (first.length <= DOC_SUMMARY_MAX_CHARS) {
    return first;
  }
  return `${first.slice(0, DOC_SUMMARY_MAX_CHARS - 3)}...`;
}

/**
 * When a search returns matches of multiple symbol kinds (class, function,
 * method, …) for what is likely the same conceptual name, the model can
 * confidently pick the wrong one — particularly for queries like
 * `ToolRegistry` that resolve to a class, several class methods, and a
 * standalone wrapper function. This is exactly the failure shape from
 * issue #184. We surface the ambiguity so the model knows to refine
 * rather than guess.
 *
 * The hint fires only on cross-kind ambiguity (class/interface/type AND
 * function/method) — the typical "noun vs. verb" shape (`Foo` class vs.
 * `createFoo()` factory). Methods alone alongside their class are
 * structurally expected and not flagged.
 */
export function buildAmbiguityHint(matches: ReadonlyArray<IndexedSymbol>): string {
  const kinds = new Set(matches.map((m) => m.kind));
  if (kinds.size <= 1) {
    return "";
  }
  const hasNoun =
    kinds.has("class") || kinds.has("interface") || kinds.has("type");
  // Standalone functions only — class methods alongside their class
  // (e.g. `Widget` + `Widget.init`) are a structurally expected pairing,
  // not a disambiguation problem. The model already understands that
  // `Foo.method` is a member of `Foo`. The real confusion is between a
  // type-name and a same-base-name standalone function (`Widget` class
  // vs. `createWidget()` factory).
  const hasStandaloneVerb = kinds.has("function");
  if (!hasNoun || !hasStandaloneVerb) {
    return "";
  }
  return [
    "Note: results span multiple symbol kinds. A class/interface/type and a function/method with similar",
    "names usually have different responsibilities (e.g. `Foo` class vs. `createFoo()` factory). Read the",
    "doc summaries below or call `read_symbol` on a specific candidate before assuming which one the",
    "question is about.",
  ].join("\n");
}

function formatMatchLine(s: IndexedSymbol): string {
  const main = `- ${getSymbolDisplayName(s)} (${s.kind}) — ${s.filePath}:${s.startLine} — qualified: ${s.qualifiedName}`;
  const summary = summarizeDocComment(s.docComment);
  return summary ? `${main}\n    └─ ${summary}` : main;
}

export function createSearchCodeMapTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "search_code_map",
    description:
      "Search the full project index for symbols by name or substring. " +
      "Use when the code map is truncated and you need to find a symbol not listed. " +
      "Returns disambiguated display names, qualified names, file paths, and a one-line doc summary; use read_symbol with the result.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Substring to match against symbol name or qualified name (case-insensitive).",
        },
        kind: {
          type: "string",
          description:
            "Optional filter by symbol kind: function, class, interface, type, variable, method.",
        },
        limit: {
          type: "number",
          description:
            "Max results to return. Default 30.",
        },
        skip: {
          type: "number",
          description:
            "Number of results to skip (for pagination). Default 0.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const pattern = expectNonEmptyString(input, "pattern");
      const kindFilter = input.kind;
      const kind =
        typeof kindFilter === "string" && kindFilter.trim().length > 0
          ? kindFilter.trim().toLowerCase()
          : undefined;
      const limit = Math.max(
        1,
        Math.min(100, expectOptionalNumber(input, "limit") ?? DEFAULT_LIMIT),
      );
      const skip = Math.max(0, expectOptionalNumber(input, "skip") ?? 0);

      const result = searchSymbols(
        [...projectIndex.symbols.values()].map((sym) => ({
          symbol: sym,
          record: {
            name: getSymbolDisplayName(sym),
            qualifiedName: sym.qualifiedName,
            kind: sym.kind,
            filePath: sym.filePath,
            startLine: sym.startLine,
            exported: sym.exported,
          },
          lookupNames: getSymbolLookupNames(sym),
        })),
        pattern,
        { kind, limit, skip },
      );

      const shown = result.matches;
      const lines = shown.map(formatMatchLine);
      const remaining = result.total - skip - shown.length;
      const footer =
        remaining > 0
          ? `\n... and ${remaining} more. Use skip: ${skip + limit}, limit: ${limit} for the next page, or refine the pattern to narrow.`
          : "";

      if (result.total === 0) {
        return `No symbols matching "${pattern}"${kind ? ` (kind: ${kind})` : ""}. Try a shorter or different pattern.`;
      }

      if (result.mode === "similar") {
        return [
          `# No exact substring matches for "${pattern}"${kind ? ` (kind: ${kind})` : ""}`,
          "",
          `Showing similar symbols instead (${result.total} total):`,
          "",
          ...lines,
          footer,
        ].join("\n");
      }

      const ambiguityHint = buildAmbiguityHint(shown);
      const sections = [
        `# Symbols matching "${pattern}" (${result.total} total)`,
      ];
      if (ambiguityHint) {
        sections.push("", ambiguityHint);
      }
      sections.push("", ...lines);
      if (footer) {
        sections.push(footer);
      }
      return sections.join("\n");
    },
  };
}
