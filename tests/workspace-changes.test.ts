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
  await writeFile(path.join(workspaceRoot, "real_change.md"), "# real\n", "utf8");

  const withoutBaseline = await collectWorkspaceChanges(workspaceRoot);
  // Without the baseline we miss the committed file entirely.
  assert.deepEqual(withoutBaseline.changedFiles.sort(), ["real_change.md"]);

  const withBaseline = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(withBaseline.changedFiles.sort(), ["real_change.md", "src/app.ts"]);

  const diffPath = path.join(workspaceRoot, "artifacts", "with-baseline.patch");
  const wrote = await writeWorkspaceDiff(workspaceRoot, diffPath, baseline ?? undefined);
  assert.equal(wrote, true);
  const diff = await readFile(diffPath, "utf8");
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff, /-export const value = 1;/);
  assert.match(diff, /\+export const value = 2;/);
  assert.match(diff, /diff --git a\/real_change\.md b\/real_change\.md/);
});

test("top-level scratch python files are filtered out of changes and diff", async () => {
  // Regression: gemini-3-flash-preview on django-15863 left 38 scratch
  // files (`test_*_v10.py`, `reproduce.py`, ...) at the workspace root,
  // bloating the patch from ~1 real edit to a 39-file diff. Top-level
  // python additions are almost always model scratch, not part of the
  // fix.
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);

  // The real fix lives in a subdirectory.
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  // Model scratch at the workspace root (the failure shape).
  await writeFile(path.join(workspaceRoot, "reproduce.py"), "print('hi')\n", "utf8");
  await writeFile(path.join(workspaceRoot, "test_logic_v10.py"), "print('debug')\n", "utf8");
  await writeFile(path.join(workspaceRoot, "test_decimal.py"), "print('debug')\n", "utf8");

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(changes.changedFiles.sort(), ["src/app.ts"]);
  assert.deepEqual(
    changes.scratchPaths.sort(),
    ["reproduce.py", "test_decimal.py", "test_logic_v10.py"],
  );

  const diffPath = path.join(workspaceRoot, "artifacts", "filtered.patch");
  await writeWorkspaceDiff(workspaceRoot, diffPath, baseline ?? undefined);
  const diff = await readFile(diffPath, "utf8");
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.doesNotMatch(diff, /reproduce\.py/);
  assert.doesNotMatch(diff, /test_logic_v10\.py/);
  assert.doesNotMatch(diff, /test_decimal\.py/);
});

test("scratch filter catches non-python output dumps (.txt, .log, .out, .tmp, .bak)", async () => {
  // Regression: gemini-3-flash on pytest-7432 dumped file contents to
  // `all.txt`, `err.txt`, `final.txt`, `out.txt`, `part.txt`, `temp.txt`
  // via `grep ... > out.txt` shell pipelines. The 6 .txt files crowded
  // the patch with zero real source edits. Same family on django-11433
  // (`temp.txt`). Extend the filter beyond .py to catch this cohort.
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);

  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  for (const name of ["out.txt", "temp.log", "scratch.out", "x.tmp", "old.bak"]) {
    await writeFile(path.join(workspaceRoot, name), "scratch\n", "utf8");
  }

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(changes.changedFiles.sort(), ["src/app.ts"]);
  assert.deepEqual(
    changes.scratchPaths.sort(),
    ["old.bak", "out.txt", "scratch.out", "temp.log", "x.tmp"],
  );
});

test("scratch filter does NOT drop config files at the root (.cfg, .toml, .json, .md)", async () => {
  // Real fixes legitimately touch top-level config files. Don't broaden
  // the filter to swallow them.
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);

  for (const name of ["setup.cfg", "pyproject.toml", "package.json", "README.md", ".env.example"]) {
    await writeFile(path.join(workspaceRoot, name), "real\n", "utf8");
  }

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(
    changes.changedFiles.sort(),
    [".env.example", "README.md", "package.json", "pyproject.toml", "setup.cfg"],
  );
  assert.deepEqual(changes.scratchPaths, []);
});

test("scratch filter does not drop python files in subdirectories", async () => {
  // A real fix touching `tests/test_foo.py` (deep path) MUST be kept.
  // Only top-level additions look like model scratch.
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);

  await mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "tests", "test_real.py"), "assert True\n", "utf8");

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(changes.changedFiles.sort(), ["tests/test_real.py"]);
  assert.deepEqual(changes.scratchPaths, []);
});

test("scratch filter does not drop top-level modifications, only additions", async () => {
  // If a baseline-tracked top-level python file is MODIFIED, that's a
  // deliberate edit (e.g. `setup.py`, `conftest.py`), not scratch.
  const workspaceRoot = await createGitWorkspace();
  await writeFile(path.join(workspaceRoot, "setup.py"), "name='x'\n", "utf8");
  execFileSync("git", ["add", "setup.py"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add setup"], { cwd: workspaceRoot, stdio: "ignore" });
  const baseline = await captureBaselineRef(workspaceRoot);

  await writeFile(path.join(workspaceRoot, "setup.py"), "name='y'\n", "utf8");

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(changes.changedFiles.sort(), ["setup.py"]);
  assert.deepEqual(changes.scratchPaths, []);
});

test("scratch filter excludes committed scratch files from the tracked diff", async () => {
  // Gemini-3-Pro variant: model creates scratch AND commits it before
  // the run ends. Filter must catch this via "added vs baseline" too.
  const workspaceRoot = await createGitWorkspace();
  const baseline = await captureBaselineRef(workspaceRoot);

  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(workspaceRoot, "reproduce.py"), "print('hi')\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fix + scratch"], { cwd: workspaceRoot, stdio: "ignore" });

  const changes = await collectWorkspaceChanges(workspaceRoot, baseline ?? undefined);
  assert.deepEqual(changes.changedFiles.sort(), ["src/app.ts"]);
  assert.deepEqual(changes.scratchPaths, ["reproduce.py"]);

  const diffPath = path.join(workspaceRoot, "artifacts", "committed-scratch.patch");
  await writeWorkspaceDiff(workspaceRoot, diffPath, baseline ?? undefined);
  const diff = await readFile(diffPath, "utf8");
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.doesNotMatch(diff, /reproduce\.py/);
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
