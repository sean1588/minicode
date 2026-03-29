/**
 * Loads benchmark tasks from the benchmarks/tasks/ directory.
 *
 * Each task lives in a category subdirectory and contains:
 *   - task.json   — task metadata, prompt, and rubric
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkCategory, BenchmarkTask } from "./types.js";

const VALID_CATEGORIES = new Set<BenchmarkCategory>([
  "navigation",
  "editing",
  "refactors",
  "debugging",
  "planning",
]);

interface TaskFile {
  title: string;
  prompt: string;
  workspaceRoot?: string | undefined;
  rubric: {
    expectedOutputPatterns?: string[] | undefined;
    expectedFilesRead?: string[] | undefined;
    expectedSymbols?: string[] | undefined;
    forbiddenPatterns?: string[] | undefined;
    maxToolCalls?: number | undefined;
    maxTotalTokens?: number | undefined;
    customEvaluator?: string | undefined;
  };
}

function isValidCategory(name: string): name is BenchmarkCategory {
  return VALID_CATEGORIES.has(name as BenchmarkCategory);
}

/**
 * Load all benchmark tasks from the given base directory.
 * Expects: `<baseDir>/<category>/<task-name>/task.json`
 */
export async function loadBenchmarkTasks(
  baseDir: string,
): Promise<BenchmarkTask[]> {
  const tasks: BenchmarkTask[] = [];
  const entries = await readdir(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidCategory(entry.name)) continue;

    const category = entry.name as BenchmarkCategory;
    const categoryDir = path.join(baseDir, category);
    const taskDirs = await readdir(categoryDir, { withFileTypes: true });

    for (const taskDir of taskDirs) {
      if (!taskDir.isDirectory()) continue;

      const taskJsonPath = path.join(categoryDir, taskDir.name, "task.json");
      const exists = await stat(taskJsonPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;

      const raw = await readFile(taskJsonPath, "utf8");
      const parsed: TaskFile = JSON.parse(raw) as TaskFile;

      tasks.push({
        id: `${category}/${taskDir.name}`,
        title: parsed.title,
        category,
        prompt: parsed.prompt,
        workspaceRoot: parsed.workspaceRoot,
        rubric: parsed.rubric,
      });
    }
  }

  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Load a single benchmark task by its id (e.g. "navigation/find-symbol-definition").
 */
export async function loadBenchmarkTask(
  baseDir: string,
  taskId: string,
): Promise<BenchmarkTask | undefined> {
  const taskJsonPath = path.join(baseDir, taskId, "task.json");
  const exists = await stat(taskJsonPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) return undefined;

  const raw = await readFile(taskJsonPath, "utf8");
  const parsed: TaskFile = JSON.parse(raw) as TaskFile;

  const [category] = taskId.split("/");
  if (!category || !isValidCategory(category)) return undefined;

  return {
    id: taskId,
    title: parsed.title,
    category,
    prompt: parsed.prompt,
    workspaceRoot: parsed.workspaceRoot,
    rubric: parsed.rubric,
  };
}
