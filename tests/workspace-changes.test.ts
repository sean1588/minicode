import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  captureBaselineRef,
  collectWorkspaceChanges,
  writeWorkspaceDiff,
} from "../src/benchmark/workspace-changes.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createGitWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-workspace-changes-"));
  tempDirs.push(workspaceRoot);

  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: workspaceRoot, stdio: "ignore" });

  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspaceRoot, stdio: "ignore" });

  return workspaceRoot;
}

async function createNestedGitWorkspace(): Promise<{
  repoRoot: string;
  workspaceRoot: string;
}> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-workspace-changes-nested-"));
  tempDirs.push(repoRoot);

  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot, stdio: "ignore" });

  const workspaceRoot = path.join(repoRoot, "packages", "app");
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(repoRoot, "packages", "other"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repoRoot, "packages", "other", "sibling.ts"), "export const sibling = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

  return { repoRoot, workspaceRoot };
}

test("collectWorkspaceChanges returns changed files for tracked and untracked edits", async () => {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), "# test\n", "utf8");

  const changes = await collectWorkspaceChanges(workspaceRoot);

  assert.equal(changes.isGitRepo, true);
  assert.deepEqual(changes.changedFiles.sort(), ["README.md", "src/app.ts"]);
});

test("writeWorkspaceDiff writes a patch artifact for tracked and untracked changes", async () => {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), "# test\n", "utf8");

  const diffPath = path.join(workspaceRoot, "artifacts", "result.patch");
  const wrote = await writeWorkspaceDiff(workspaceRoot, diffPath);
  const diff = await readFile(diffPath, "utf8");

  assert.equal(wrote, true);
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff, /diff --git a\/README\.md b\/README\.md/);
});

test("workspace change collection is scoped to the selected workspace subtree", async () => {
  const { repoRoot, workspaceRoot } = await createNestedGitWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), "# app\n", "utf8");
  await writeFile(path.join(repoRoot, "packages", "other", "sibling.ts"), "export const sibling = 2;\n", "utf8");
  await writeFile(path.join(repoRoot, "ROOT.md"), "# root\n", "utf8");

  const changes = await collectWorkspaceChanges(workspaceRoot);

  assert.equal(changes.isGitRepo, true);
  assert.deepEqual(changes.changedFiles.sort(), ["README.md", "src/app.ts"]);
});

test("workspace diff only includes files inside the selected workspace subtree", async () => {
  const { repoRoot, workspaceRoot } = await createNestedGitWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), "# app\n", "utf8");
  await writeFile(path.join(repoRoot, "packages", "other", "sibling.ts"), "export const sibling = 2;\n", "utf8");
  await writeFile(path.join(repoRoot, "ROOT.md"), "# root\n", "utf8");

  const diffPath = path.join(workspaceRoot, "artifacts", "scoped.patch");
  const wrote = await writeWorkspaceDiff(workspaceRoot, diffPath);
  const diff = await readFile(diffPath, "utf8");

  assert.equal(wrote, true);
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff, /diff --git a\/README\.md b\/README\.md/);
  assert.doesNotMatch(diff, /sibling\.ts/);
  assert.doesNotMatch(diff, /ROOT\.md/);
});

test("baseline ref captures committed changes that would otherwise be invisible", async () => {
  // Regression: Gemini-3-Pro ran `git add` + `git commit` mid-task on a
  // benchmark run. The old `git diff` (working-tree vs index) saw nothing
  // and the harness threw away a working fix.
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);
  assert.ok(baseline && baseline.length >= 7, "baseline ref should be a SHA");

  // Model edits a tracked file and commits, then leaves an untracked helper.
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  execFileSync("git", ["add", "src/app.ts"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fix value"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(path.join(workspaceRoot, "reproduce.py"), "print('hi')\n", "utf8");

  const withoutBaseline = await collectWorkspaceChanges(workspaceRoot);
  // Without the baseline we miss the committed file entirely.
  assert.deepEqual(withoutBaseline.changedFiles.sort(), ["reproduce.py"]);

  const withBaseline = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(withBaseline.changedFiles.sort(), ["reproduce.py", "src/app.ts"]);

  const diffPath = path.join(workspaceRoot, "artifacts", "with-baseline.patch");
  const wrote = await writeWorkspaceDiff(workspaceRoot, diffPath, baseline ?? undefined);
  assert.equal(wrote, true);
  const diff = await readFile(diffPath, "utf8");
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff, /-export const value = 1;/);
  assert.match(diff, /\+export const value = 2;/);
  assert.match(diff, /diff --git a\/reproduce\.py b\/reproduce\.py/);
});

test("baseline ref also captures staged and unstaged changes (no false negatives)", async () => {
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);

  // One staged tracked change, one unstaged tracked change, one untracked.
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 99;\n", "utf8");
  execFileSync("git", ["add", "src/app.ts"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 100;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "notes.md"), "# notes\n", "utf8");

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(changes.changedFiles.sort(), ["notes.md", "src/app.ts"]);

  const diffPath = path.join(workspaceRoot, "artifacts", "mixed.patch");
  await writeWorkspaceDiff(workspaceRoot, diffPath, baseline ?? undefined);
  const diff = await readFile(diffPath, "utf8");
  assert.match(diff, /\+export const value = 100;/);
  assert.match(diff, /diff --git a\/notes\.md b\/notes\.md/);
});

test("captureBaselineRef returns null for a non-git workspace", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-workspace-changes-nongit-"));
  tempDirs.push(workspaceRoot);
  const baseline = await captureBaselineRef(workspaceRoot);
  assert.equal(baseline, null);
});
