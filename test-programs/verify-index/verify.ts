#!/usr/bin/env node
/**
 * Verification script for minicode indexing.
 * Run from minicode root: node --import tsx test-programs/verify-index/verify.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProjectIndex } from "../../src/indexer/project-index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname);

async function verify(): Promise<void> {
  console.log("Building index for verify-index test program...\n");

  const index = await buildProjectIndex(WORKSPACE);

  // 1. Code map
  const codeMap = index.getCodeMap().text;
  const codeMapChecks = [
    ["# Project Code Map", "code map header"],
    ["src/index.ts", "entry file"],
    ["src/types.ts", "types file"],
    ["Processor", "Processor class"],
    ["Task", "Task interface"],
    ["parse", "parse function"],
    ["parseAndProcess", "parseAndProcess function"],
  ];
  for (const [substr, label] of codeMapChecks) {
    const ok = codeMap.includes(substr);
    console.log(ok ? "  ✓" : "  ✗", label, ok ? "" : `(missing: ${substr})`);
  }

  // 2. read_symbol targets
  const symbolChecks = [
    "main",
    "Processor",
    "Processor.run",
    "parse",
    "process",
    "parseAndProcess",
    "Task",
    "Result",
    "TaskRunner",
  ];
  console.log("\nSymbol lookup:");
  for (const name of symbolChecks) {
    const sym = index.getSymbol(name);
    const ok = !!sym;
    console.log(ok ? "  ✓" : "  ✗", name, ok ? `(${sym!.kind})` : "(not found)");
  }

  // 3. find_references (Task is referenced by parse, process, Processor.run)
  const taskRefs = index.dependencyEdges.filter((e) => e.to === "Task");
  console.log("\nfind_references(Task):", taskRefs.length, "references");
  for (const e of taskRefs) {
    console.log("  ", e.from, "->", e.to, `(${e.kind})`);
  }

  // 4. get_dependencies (main -> Processor -> run -> parseAndProcess -> parse, process)
  const mainCone = index.getDependencyCone("main", 2);
  const mainDeps = mainCone.map((s) => s.qualifiedName);
  console.log("\nget_dependencies(main, 2):", mainDeps.length, "symbols");
  console.log("  ", mainDeps.join(", "));

  const runCone = index.getDependencyCone("Processor.run", 1);
  const runDeps = runCone.map((s) => s.qualifiedName);
  console.log("\nget_dependencies(Processor.run, 1):", runDeps.length, "symbols");
  console.log("  ", runDeps.join(", "));

  // 5. implements edge (Processor implements TaskRunner)
  const implementsEdges = index.dependencyEdges.filter(
    (e) => e.kind === "implements" && e.from === "Processor",
  );
  console.log("\nProcessor implements:", implementsEdges.length ? "✓" : "✗");

  console.log("\nVerification complete.");
}

verify().catch((err) => {
  console.error(err);
  process.exit(1);
});
