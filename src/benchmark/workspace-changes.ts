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

export async function collectWorkspaceChanges(workspaceRoot: string): Promise<WorkspaceChanges> {
  const isGitRepo = await isGitRepository(workspaceRoot);
  if (!isGitRepo) {
    return {
      isGitRepo: false,
      entries: [],
      changedFiles: [],
    };
  }

  const statusOutput = await runGit(
    workspaceRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    true,
  );
  const entries = statusOutput
    .split(/\r?\n/)
    .map((line) => parseStatusLine(line))
    .filter((entry): entry is WorkspaceStatusEntry => entry !== undefined);

  const changedFiles = [...new Set(entries.map((entry) => entry.path))];
  return {
    isGitRepo: true,
    entries,
    changedFiles,
  };
}

export async function writeWorkspaceDiff(
  workspaceRoot: string,
  outPath: string,
): Promise<boolean> {
  const changes = await collectWorkspaceChanges(workspaceRoot);
  if (!changes.isGitRepo) {
    return false;
  }

  const trackedDiff = await runGit(
    workspaceRoot,
    ["diff", "--binary", "--no-ext-diff", "--relative", "--"],
    true,
  );

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

  const combinedDiff = [trackedDiff, ...untrackedDiffs]
    .filter((section) => section.trim().length > 0)
    .join("\n");

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, combinedDiff, "utf8");
  return true;
}
