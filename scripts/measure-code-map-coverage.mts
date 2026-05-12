/**
 * Measure code-map coverage across one or more workspace roots.
 *
 * Usage:
 *   npx tsx scripts/measure-code-map-coverage.mts /path/to/repo [...more]
 *
 * For each workspace, builds the project index, generates the code map
 * at a few representative token budgets (1500 default, 3000, 6000),
 * and reports:
 *   - total symbols indexed
 *   - symbols shown in the code map
 *   - coverage % (shown / total)
 *   - actual token count of the code map text (chars/4 estimate)
 *   - file count
 */

import { buildProjectIndex } from "../src/indexer/project-index.js";

const BUDGETS = [1500, 3000, 6000];
const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

async function measure(root: string): Promise<void> {
  const t0 = Date.now();
  let index;
  try {
    index = await buildProjectIndex(root);
  } catch (e) {
    console.log(`\n## ${root}\n  ERROR building index: ${(e as Error).message}`);
    return;
  }
  const buildMs = Date.now() - t0;

  const totalSymbols = index.symbols.size;
  const totalFiles = index.files.size;
  const totalEdges = index.dependencyEdges.length;

  console.log(`\n## ${root}`);
  console.log(
    `  Index: ${totalSymbols} symbols, ${totalFiles} files, ${totalEdges} dependency edges (built in ${buildMs}ms)`,
  );

  if (totalSymbols === 0) {
    console.log("  (no symbols — skipping code-map measurement)");
    return;
  }

  console.log(`  Budget | Shown | Coverage | Map tokens (est)`);
  console.log(`  ------ | ----- | -------- | ----------------`);
  for (const budget of BUDGETS) {
    const map = index.getCodeMap(budget);
    const coverage = ((map.shownCount / map.totalCount) * 100).toFixed(1);
    const actualTokens = estimateTokens(map.text);
    console.log(
      `  ${String(budget).padStart(6)} | ${String(map.shownCount).padStart(5)} | ${coverage.padStart(7)}% | ${actualTokens}`,
    );
  }
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: measure-code-map-coverage.mts <workspace> [...more]");
    process.exit(2);
  }
  for (const t of targets) {
    await measure(t);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
