/**
 * Compare alternative code-map formats at a fixed token budget.
 *
 * Usage:
 *   npx tsx scripts/compare-code-map-formats.mts /path/to/repo [--budget 3000]
 *
 * Runs the same ranking pipeline as generateCodeMap, but swaps the
 * per-symbol formatter to compare:
 *   - "full"     — current format (kind name + signature)
 *   - "named"    — name + kind, one line per symbol
 *   - "outline"  — one line per file, comma-separated names
 *
 * Reports shown / total coverage and estimated tokens for each.
 */

import { buildProjectIndex } from "../src/indexer/project-index.js";
import { getSymbolDisplayName } from "../src/indexer/symbol-names.js";
import type { DependencyEdge, IndexedSymbol } from "../src/indexer/types.js";

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET = 3000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function isEntryPointFile(filePath: string): boolean {
  const name = filePath.replace(/\\/g, "/");
  return /(?:^|\/)index\.[jt]sx?$/.test(name);
}

function buildAdjacency(edges: DependencyEdge[]): {
  byFrom: Map<string, DependencyEdge[]>;
  byTo: Map<string, DependencyEdge[]>;
} {
  const byFrom = new Map<string, DependencyEdge[]>();
  const byTo = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    (byFrom.get(edge.from) ?? byFrom.set(edge.from, []).get(edge.from)!).push(edge);
    (byTo.get(edge.to) ?? byTo.set(edge.to, []).get(edge.to)!).push(edge);
  }
  return { byFrom, byTo };
}

function makeRanker(
  adjacency: ReturnType<typeof buildAdjacency>,
): (a: IndexedSymbol, b: IndexedSymbol) => number {
  const refCount = new Map<string, number>();
  for (const [target, edges] of adjacency.byTo) {
    refCount.set(target, edges.length);
  }
  return (a, b) => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    const refA = refCount.get(a.qualifiedName) ?? 0;
    const refB = refCount.get(b.qualifiedName) ?? 0;
    if (refA !== refB) return refB - refA;
    const entryA = isEntryPointFile(a.filePath) ? 1 : 0;
    const entryB = isEntryPointFile(b.filePath) ? 1 : 0;
    return entryB - entryA;
  };
}

type Formatter = (symbol: IndexedSymbol, isMethod: boolean, currentClass: string | null) => string;

const FORMATS: Record<string, Formatter> = {
  full: (symbol, isMethod) => {
    if (isMethod) return `    ${symbol.signature}`;
    return `  ${symbol.kind} ${getSymbolDisplayName(symbol)}\n    ${symbol.signature}`;
  },
  named: (symbol) => {
    return `  - ${getSymbolDisplayName(symbol)} (${symbol.kind})`;
  },
  // Hybrid: keep full signatures for callables (function/method),
  // names-only for types/classes/interfaces/variables.
  hybrid: (symbol, isMethod) => {
    const callable = symbol.kind === "function" || symbol.kind === "method";
    if (!callable) return `  - ${getSymbolDisplayName(symbol)} (${symbol.kind})`;
    if (isMethod) return `    ${symbol.signature}`;
    return `  ${symbol.kind} ${getSymbolDisplayName(symbol)}\n    ${symbol.signature}`;
  },
  // outline handled specially below — one line per file
};

interface FormatResult {
  text: string;
  shownCount: number;
  totalCount: number;
  tokens: number;
}

function generate(
  symbolsByFile: Map<string, IndexedSymbol[]>,
  edges: DependencyEdge[],
  budget: number,
  format: "full" | "named" | "hybrid" | "outline",
): FormatResult {
  const totalCount = [...symbolsByFile.values()].reduce((s, syms) => s + syms.length, 0);
  const adjacency = buildAdjacency(edges);
  const rank = makeRanker(adjacency);

  const lines: string[] = ["# Project Code Map", ""];
  let totalTokens = estimateTokens(lines.join("\n"));
  let shownCount = 0;

  const sortedFiles = [...symbolsByFile.keys()].sort((a, b) => a.localeCompare(b));

  for (const filePath of sortedFiles) {
    const symbols = symbolsByFile.get(filePath);
    if (!symbols?.length) continue;
    const sorted = [...symbols].sort(rank);

    if (format === "outline") {
      // One line per file, names comma-separated
      const names = sorted.map((s) => getSymbolDisplayName(s));
      // Try the whole file first
      const fileLine = `  ${filePath}: ${names.join(", ")}`;
      const fileTokens = estimateTokens(fileLine);
      if (totalTokens + fileTokens <= budget) {
        lines.push(fileLine);
        totalTokens += fileTokens;
        shownCount += sorted.length;
        continue;
      }
      // Otherwise, fit as many as possible on the line
      let fitted = 0;
      const buf: string[] = [];
      for (const n of names) {
        const candidate = `  ${filePath}: ${buf.concat(n).join(", ")}`;
        if (estimateTokens(candidate) + totalTokens > budget) break;
        buf.push(n);
        fitted++;
      }
      if (fitted > 0) {
        const fileLine2 = `  ${filePath}: ${buf.join(", ")}`;
        lines.push(fileLine2);
        totalTokens += estimateTokens(fileLine2);
        shownCount += fitted;
      }
      continue;
    }

    const fileLines: string[] = [`  ${filePath}`];
    let currentClass: string | null = null;

    for (const symbol of sorted) {
      const isMethod = symbol.kind === "method";
      if (symbol.kind === "class") currentClass = symbol.name;
      else if (!isMethod) currentClass = null;

      const block = FORMATS[format]!(symbol, isMethod, currentClass);
      const blockTokens = estimateTokens(block);
      if (totalTokens + blockTokens > budget) continue;
      fileLines.push(block);
      totalTokens += blockTokens;
      shownCount += 1;
    }

    if (fileLines.length > 1) {
      lines.push(...fileLines, "");
    }
  }

  const text = lines.join("\n").trim();
  return { text, shownCount, totalCount, tokens: estimateTokens(text) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = argv.find((a) => !a.startsWith("--"));
  const budgetIdx = argv.indexOf("--budget");
  const budget = budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : DEFAULT_BUDGET;
  if (!root) {
    console.error("usage: compare-code-map-formats.mts <workspace> [--budget N]");
    process.exit(2);
  }

  console.log(`Building project index for ${root}...`);
  const index = await buildProjectIndex(root);
  const total = index.symbols.size;
  console.log(`Indexed ${total} symbols across ${index.files.size} files\n`);
  console.log(`Token budget: ${budget}\n`);

  const formats: Array<"full" | "named" | "hybrid" | "outline"> = ["full", "named", "hybrid", "outline"];
  console.log(`Format    | Shown | Coverage | Tokens | Avg chars/sym`);
  console.log(`--------- | ----- | -------- | ------ | -------------`);
  for (const f of formats) {
    const r = generate(index.files, index.dependencyEdges, budget, f);
    const cov = ((r.shownCount / r.totalCount) * 100).toFixed(1);
    const avg = r.shownCount > 0 ? (r.text.length / r.shownCount).toFixed(1) : "—";
    console.log(`${f.padEnd(9)} | ${String(r.shownCount).padStart(5)} | ${cov.padStart(7)}% | ${String(r.tokens).padStart(6)} | ${avg.padStart(13)}`);
  }

  console.log("\nSample (first 25 lines of each):\n");
  for (const f of formats) {
    const r = generate(index.files, index.dependencyEdges, budget, f);
    console.log(`--- ${f} ---`);
    console.log(r.text.split("\n").slice(0, 25).join("\n"));
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
