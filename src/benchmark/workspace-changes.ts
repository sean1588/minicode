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

  const changedFiles = [...new Set(entries.map((entry) => entry.path))];
  return {
    isGitRepo: true,
    entries,
    changedFiles,
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
  // caller hasn't snapshotted a starting point.
  const trackedDiffArgs = baselineRef
    ? ["diff", "--binary", "--no-ext-diff", "--relative", baselineRef, "--", "."]
    : ["diff", "--binary", "--no-ext-diff", "--relative", "--", "."];
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
