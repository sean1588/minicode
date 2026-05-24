import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceStatusEntry {
  status: string;
  path: string;
  previousPath?: string;
}

export interface WorkspaceChanges {
  isGitRepo: boolean;
  entries: WorkspaceStatusEntry[];
  changedFiles: string[];
  /**
   * Top-level files the model created that we treat as scratch (repro
   * scripts, debugging tests, etc.). Stripped from `entries` /
   * `changedFiles` so they don't pollute the canonical diff but surfaced
   * here so consumers can still observe what was filtered.
   */
  scratchPaths: string[];
}

/**
 * Extensions on top-level additions we treat as model scratch.
 *
 * Original cohort (`.py`): repro / debug scripts (`reproduce.py`,
 * `test_logic_v10.py`) observed on django-15863.
 *
 * Added cohort (`.txt`, `.log`, `.out`, `.tmp`, `.bak`): output
 * dumps from `python3 -c '...' > out.txt`, `grep ... > all.txt`,
 * etc. observed on pytest-7432 (6 `.txt` files: `all.txt`, `err.txt`,
 * `final.txt`, `out.txt`, `part.txt`, `temp.txt`) and on django-11433
 * (`temp.txt`). These extensions are essentially never legitimate
 * top-level files in SWE-Bench Python repos.
 *
 * Deliberately excluded: `.md` (README/CHANGELOG live at root),
 * `.cfg`/`.toml`/`.ini`/`.json` (config files that real fixes do
 * sometimes modify), `.yml`/`.yaml` (CI configs).
 */
const SCRATCH_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py",
  ".txt",
  ".log",
  ".out",
  ".tmp",
  ".bak",
]);

/**
 * Top-level additions made during a benchmark run that we treat as
 * scratch. SWE-Bench-style fixes live in deep subdirectories
 * (`django/...`, `sympy/...`, `src/...`); files appearing at the
 * workspace root with scratch-looking extensions are almost
 * certainly repro/debug artifacts the model created and didn't
 * clean up. Stripping them from the diff collapses 39-file patches
 * back to the ~1 real source-file edit (observed on django-15863
 * with gemini-3-flash-preview).
 *
 * Conservative scope:
 *  - top-level path only (no `/`)
 *  - untracked (`?`) or added-vs-baseline (`A`)
 *  - extension in `SCRATCH_EXTENSIONS`
 *
 * Modifications to existing top-level files (status `M`) are
 * untouched — those reflect a deliberate edit, not scratch.
 */
function isScratchAddition(entry: WorkspaceStatusEntry): boolean {
  if (entry.path.includes("/")) return false;
  const dotIndex = entry.path.lastIndexOf(".");
  if (dotIndex <= 0) return false;
  const extension = entry.path.slice(dotIndex);
  if (!SCRATCH_EXTENSIONS.has(extension)) return false;
  const code = entry.status.charAt(0);
  return code === "?" || code === "A";
}

async function runGit(
  workspaceRoot: string,
  args: string[],
  allowFailure = false,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (allowFailure) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === "string") {
        return stdout;
      }
      return "";
    }
    throw error;
  }
}

function parseStatusLine(line: string): WorkspaceStatusEntry | undefined {
  if (line.length < 4) {
    return undefined;
  }
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  if (!rawPath) {
    return undefined;
  }
  if (rawPath.includes(" -> ")) {
    const [previousPath, nextPath] = rawPath.split(" -> ");
    if (!nextPath || !previousPath) {
      return undefined;
    }
    return {
      status,
      path: nextPath,
      previousPath,
    };
  }
  return {
    status,
    path: rawPath,
  };
}

async function isGitRepository(workspaceRoot: string): Promise<boolean> {
  try {
    const output = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"], true);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

async function getWorkspaceGitPrefix(workspaceRoot: string): Promise<string> {
  const prefix = await runGit(workspaceRoot, ["rev-parse", "--show-prefix"], true);
  return prefix.trim();
}

/**
 * Snapshot the current HEAD so we can diff against it at the end of a run
 * even if the model committed in between. Returns null when the workspace
 * is not a git repo or has no commits yet.
 */
export async function captureBaselineRef(workspaceRoot: string): Promise<string | null> {
  if (!(await isGitRepository(workspaceRoot))) {
    return null;
  }
  const sha = (await runGit(workspaceRoot, ["rev-parse", "HEAD"], true)).trim();
  return sha.length > 0 ? sha : null;
}

function parseNameStatusLine(line: string): WorkspaceStatusEntry | undefined {
  if (line.length === 0) {
    return undefined;
  }
  // git diff --name-status output is tab-separated: STATUS\tPATH or
  // STATUS\tOLD\tNEW (for renames/copies, status looks like R100 / C75).
  const parts = line.split("\t");
  const rawStatus = parts[0];
  if (!rawStatus) {
    return undefined;
  }
  const code = rawStatus.charAt(0);
  if (code === "R" || code === "C") {
    const previousPath = parts[1];
    const nextPath = parts[2];
    if (!previousPath || !nextPath) {
      return undefined;
    }
    return { status: `${code} `, path: nextPath, previousPath };
  }
  const filePath = parts[1];
  if (!filePath) {
    return undefined;
  }
  // Map to the two-char porcelain-ish status the downstream code expects.
  // We don't try to be exact — the only meaningful check downstream is the
  // "??" untracked case, which is handled separately via git status.
  return { status: `${code} `, path: filePath };
}

function stripWorkspacePrefix(
  filePath: string,
  workspacePrefix: string,
): string {
  if (!workspacePrefix) {
    return filePath;
  }
  const normalizedPrefix = workspacePrefix.endsWith("/")
    ? workspacePrefix
    : `${workspacePrefix}/`;
  return filePath.startsWith(normalizedPrefix)
    ? filePath.slice(normalizedPrefix.length)
    : filePath;
}

export async function collectWorkspaceChanges(
  workspaceRoot: string,
  baselineRef?: string,
): Promise<WorkspaceChanges> {
  const isGitRepo = await isGitRepository(workspaceRoot);
  if (!isGitRepo) {
    return {
      isGitRepo: false,
      entries: [],
      changedFiles: [],
      scratchPaths: [],
    };
  }

  const workspacePrefix = await getWorkspaceGitPrefix(workspaceRoot);

  const remap = (entry: WorkspaceStatusEntry | undefined): WorkspaceStatusEntry | undefined =>
    entry
      ? {
          ...entry,
          path: stripWorkspacePrefix(entry.path, workspacePrefix),
          ...(entry.previousPath
            ? { previousPath: stripWorkspacePrefix(entry.previousPath, workspacePrefix) }
            : {}),
        }
      : undefined;

  // Always pull untracked entries from `git status` — they're never part of
  // a baseline diff because they aren't tracked yet.
  const statusOutput = await runGit(
    workspaceRoot,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "."],
    true,
  );
  const statusEntries = statusOutput
    .split(/\r?\n/)
    .map((line) => parseStatusLine(line))
    .map(remap)
    .filter((entry): entry is WorkspaceStatusEntry => entry !== undefined);

  let entries: WorkspaceStatusEntry[];
  if (baselineRef) {
    // Tracked changes: anything that differs between the baseline commit and
    // the current working tree. Captures committed, staged, AND unstaged
    // edits in one shot.
    const nameStatusOutput = await runGit(
      workspaceRoot,
      ["diff", "--name-status", baselineRef, "--", "."],
      true,
    );
    const trackedEntries = nameStatusOutput
      .split(/\r?\n/)
      .map((line) => parseNameStatusLine(line))
      .map(remap)
      .filter((entry): entry is WorkspaceStatusEntry => entry !== undefined);
    const untrackedEntries = statusEntries.filter((entry) => entry.status === "??");
    const seen = new Set<string>();
    entries = [];
    for (const entry of [...trackedEntries, ...untrackedEntries]) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push(entry);
    }
  } else {
    entries = statusEntries;
  }

  const scratchPaths = [
    ...new Set(entries.filter(isScratchAddition).map((entry) => entry.path)),
  ];
  const scratchSet = new Set(scratchPaths);
  const filteredEntries = entries.filter((entry) => !scratchSet.has(entry.path));
  const changedFiles = [...new Set(filteredEntries.map((entry) => entry.path))];
  return {
    isGitRepo: true,
    entries: filteredEntries,
    changedFiles,
    scratchPaths,
  };
}

export async function getWorkspaceDiff(
  workspaceRoot: string,
  baselineRef?: string,
): Promise<string | null> {
  const changes = await collectWorkspaceChanges(workspaceRoot, baselineRef);
  if (!changes.isGitRepo) {
    return null;
  }

  // With a baseline ref we diff working-tree vs baseline directly, which
  // captures committed + staged + unstaged in one pass. Without one we
  // fall back to the working-tree-vs-index behavior — useful when the
  // caller hasn't snapshotted a starting point. Scratch additions filtered
  // out at the collect step are also excluded here via `:!<path>` pathspecs
  // so they don't appear in the tracked-diff section when the model
  // commits them mid-run.
  const excludeSpecs = changes.scratchPaths.map((scratchPath) => `:!${scratchPath}`);
  const trackedDiffArgs = baselineRef
    ? [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--relative",
        baselineRef,
        "--",
        ".",
        ...excludeSpecs,
      ]
    : ["diff", "--binary", "--no-ext-diff", "--relative", "--", ".", ...excludeSpecs];
  const trackedDiff = await runGit(workspaceRoot, trackedDiffArgs, true);

  const untrackedDiffs: string[] = [];
  for (const entry of changes.entries) {
    if (entry.status === "??") {
      const diff = await runGit(
        workspaceRoot,
        ["diff", "--binary", "--no-ext-diff", "--no-index", "--", "/dev/null", entry.path],
        true,
      );
      if (diff.trim().length > 0) {
        untrackedDiffs.push(diff);
      }
    }
  }

  return [trackedDiff, ...untrackedDiffs]
    .filter((section) => section.trim().length > 0)
    .join("\n");
}

export async function writeWorkspaceDiff(
  workspaceRoot: string,
  outPath: string,
  baselineRef?: string,
): Promise<boolean> {
  const combinedDiff = await getWorkspaceDiff(workspaceRoot, baselineRef);
  if (combinedDiff === null) {
    return false;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, combinedDiff, "utf8");
  return true;
}
