import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { getWorkspaceCacheDir } from "../indexer/cache.js";

const require = createRequire(import.meta.url);

let cachedTscPath: string | null | undefined;
function resolveTscPath(): string | null {
  if (cachedTscPath !== undefined) return cachedTscPath;
  try {
    cachedTscPath = require.resolve("typescript/bin/tsc");
  } catch {
    cachedTscPath = null;
  }
  return cachedTscPath;
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const MAX_PER_FILE = 20;
const TSC_TIMEOUT_MS = 15_000;
const DISABLE_ENV = "MINICODE_DISABLE_POST_EDIT_DIAGNOSTICS";

interface ParsedDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

/**
 * Walk up from `startDir` looking for the nearest tsconfig.json. Stops at
 * `workspaceRoot` (inclusive). Returns null if none found.
 */
async function findNearestTsconfig(
  startDir: string,
  workspaceRoot: string,
): Promise<string | null> {
  const root = path.resolve(workspaceRoot);
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // not present, keep walking
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const TSC_LINE_RE =
  /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

function parseTscOutput(output: string, projectDir: string): ParsedDiagnostic[] {
  const lines = output.split(/\r?\n/);
  const out: ParsedDiagnostic[] = [];
  for (const line of lines) {
    const m = line.match(TSC_LINE_RE);
    if (!m) continue;
    const [, rawFile, ln, col, sev, code, msg] = m;
    if (!rawFile || !ln || !col || !sev || !code || msg === undefined) continue;
    const absFile = path.isAbsolute(rawFile)
      ? rawFile
      : path.resolve(projectDir, rawFile);
    out.push({
      file: absFile,
      line: Number(ln),
      col: Number(col),
      severity: sev === "error" ? "error" : "warning",
      code,
      message: msg.trim(),
    });
  }
  return out;
}

interface RunResult {
  diagnostics: ParsedDiagnostic[];
}

async function runTsc(
  tsconfigPath: string,
  workspaceRoot: string,
): Promise<RunResult | null> {
  const cacheDir = path.join(
    getWorkspaceCacheDir(workspaceRoot),
    "diagnostics",
  );
  await mkdir(cacheDir, { recursive: true });
  const tsbuildinfo = path.join(
    cacheDir,
    `${path.basename(path.dirname(tsconfigPath))}.tsbuildinfo`,
  );

  const tscPath = resolveTscPath();
  if (!tscPath) return null;

  return await new Promise<RunResult | null>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        tscPath,
        "--noEmit",
        "--pretty",
        "false",
        "--incremental",
        "--tsBuildInfoFile",
        tsbuildinfo,
        "-p",
        tsconfigPath,
      ],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(null);
    }, TSC_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = stdout + (stderr ? `\n${stderr}` : "");
      resolve({
        diagnostics: parseTscOutput(combined, path.dirname(tsconfigPath)),
      });
    });
  });
}

function formatDiagnostics(
  filePath: string,
  diags: ParsedDiagnostic[],
): string | undefined {
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length === 0) return undefined;
  const limited = errors.slice(0, MAX_PER_FILE);
  const more = errors.length - MAX_PER_FILE;
  const suffix = more > 0 ? `\n... and ${more} more` : "";
  const body = limited
    .map((d) => `ERROR [${d.line}:${d.col}] ${d.message}`)
    .join("\n");
  return `<diagnostics file="${filePath}">\n${body}${suffix}\n</diagnostics>`;
}

/**
 * Serialize diagnostic runs per workspace+tsconfig so concurrent edits don't
 * trigger overlapping tsc processes that fight over the same .tsbuildinfo.
 */
const inflightByKey = new Map<string, Promise<RunResult | null>>();

function serializedRun(
  tsconfigPath: string,
  workspaceRoot: string,
): Promise<RunResult | null> {
  const key = `${workspaceRoot}::${tsconfigPath}`;
  const prev = inflightByKey.get(key) ?? Promise.resolve(null);
  const next = prev.then(() => runTsc(tsconfigPath, workspaceRoot));
  inflightByKey.set(
    key,
    next.finally(() => {
      if (inflightByKey.get(key) === next) inflightByKey.delete(key);
    }),
  );
  return next;
}

/**
 * Run tsc against the nearest tsconfig and return an opencode-style
 * `<diagnostics file="...">` block listing errors in the touched file. Returns
 * undefined when there are no errors, when the file is not a TypeScript-family
 * file, when no tsconfig is found, or when the run fails. Never throws.
 */
export async function buildPostEditDiagnostic(
  filePath: string,
  workspaceRoot: string,
): Promise<string | undefined> {
  if (process.env[DISABLE_ENV] === "1") return undefined;

  const ext = path.extname(filePath).toLowerCase();
  if (!TS_EXTENSIONS.has(ext)) return undefined;

  try {
    const tsconfig = await findNearestTsconfig(
      path.dirname(filePath),
      workspaceRoot,
    );
    if (!tsconfig) return undefined;

    const result = await serializedRun(tsconfig, workspaceRoot);
    if (!result) return undefined;

    const absTouched = path.resolve(filePath);
    const forFile = result.diagnostics.filter(
      (d) => path.resolve(d.file) === absTouched,
    );
    const displayPath = path.relative(workspaceRoot, absTouched) || filePath;
    return formatDiagnostics(displayPath, forFile);
  } catch {
    return undefined;
  }
}
