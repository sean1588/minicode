import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  computeFileHashes,
  loadIndex,
  saveIndex,
} from "../src/indexer/cache.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";

test("saveIndex and loadIndex round-trip", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "mini-coder-cache-"));
  const samplePath = path.join(workspaceRoot, "sample.ts");
  const content = `export function greet(name: string): string {
  return \`Hello, \${name}\`;
}
`;
  await writeFile(samplePath, content, "utf8");

  const index = await buildProjectIndex(workspaceRoot);
  const fileHashes = await computeFileHashes(workspaceRoot);
  const cacheDir = path.join(workspaceRoot, ".mini-coder", "cache");

  await saveIndex(index, cacheDir, fileHashes);
  const loaded = await loadIndex(cacheDir, fileHashes);

  assert.ok(loaded, "should load from cache");
  assert.equal(loaded!.getSymbol("greet")?.qualifiedName, "greet");
  assert.ok(loaded!.getCodeMap().includes("greet"));
});

test("loadIndex returns null when file hashes differ", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "mini-coder-cache2-"));
  const samplePath = path.join(workspaceRoot, "sample.ts");
  await writeFile(
    samplePath,
    "export function a(): void {}",
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  const fileHashes = await computeFileHashes(workspaceRoot);
  const cacheDir = path.join(workspaceRoot, ".mini-coder", "cache");
  await saveIndex(index, cacheDir, fileHashes);

  await writeFile(
    samplePath,
    "export function b(): void {}",
    "utf8",
  );
  const newHashes = await computeFileHashes(workspaceRoot);
  const loaded = await loadIndex(cacheDir, newHashes);

  assert.equal(loaded, null, "should invalidate cache when file changes");
});
