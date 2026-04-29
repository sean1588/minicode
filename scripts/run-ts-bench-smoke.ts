#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

import { applyTsBenchMinicodeAdapter } from "./ts-bench-adapter.js";

interface TsBenchSmokeArgs {
  tsBenchPath: string;
  exercise: string;
  provider: "openrouter" | "openai" | "anthropic";
  model: string;
  envFile?: string;
  skipBuild: boolean;
  installDeps: boolean;
  dryRun: boolean;
}

function readFlagValue(args: string[], index: number, flagName: string): { value: string; nextIndex: number } {
  const next = args[index + 1];
  if (!next || next.startsWith("-")) {
    throw new Error(`${flagName} requires a value.`);
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseTsBenchSmokeArgs(argv: string[]): TsBenchSmokeArgs {
  let tsBenchPath: string | undefined;
  let exercise = "acronym";
  let provider: TsBenchSmokeArgs["provider"] = "openrouter";
  let model: string | undefined;
  let envFile: string | undefined;
  let skipBuild = false;
  let installDeps = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--install-deps") {
      installDeps = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--ts-bench-path") {
      const parsed = readFlagValue(argv, i, "--ts-bench-path");
      tsBenchPath = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--ts-bench-path=")) {
      tsBenchPath = arg.slice("--ts-bench-path=".length).trim();
      continue;
    }
    if (arg === "--exercise") {
      const parsed = readFlagValue(argv, i, "--exercise");
      exercise = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--exercise=")) {
      exercise = arg.slice("--exercise=".length).trim();
      continue;
    }
    if (arg === "--provider") {
      const parsed = readFlagValue(argv, i, "--provider");
      const value = parsed.value as TsBenchSmokeArgs["provider"];
      if (value !== "openrouter" && value !== "openai" && value !== "anthropic") {
        throw new Error(`Unsupported --provider ${parsed.value}. Use openrouter, openai, or anthropic.`);
      }
      provider = value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length).trim() as TsBenchSmokeArgs["provider"];
      if (value !== "openrouter" && value !== "openai" && value !== "anthropic") {
        throw new Error(`Unsupported --provider ${value}. Use openrouter, openai, or anthropic.`);
      }
      provider = value;
      continue;
    }
    if (arg === "--model") {
      const parsed = readFlagValue(argv, i, "--model");
      model = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
      continue;
    }
    if (arg === "--env-file") {
      const parsed = readFlagValue(argv, i, "--env-file");
      envFile = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      envFile = arg.slice("--env-file=".length).trim();
      continue;
    }
  }

  if (!tsBenchPath) {
    throw new Error("--ts-bench-path is required.");
  }
  if (!model) {
    throw new Error("--model is required.");
  }

  return {
    tsBenchPath,
    exercise,
    provider,
    model,
    ...(envFile ? { envFile } : {}),
    skipBuild,
    installDeps,
    dryRun,
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function buildStablePath(extraDirs: string[] = []): string {
  const segments = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((segment) => segment.length > 0 && !segment.startsWith("/mnt/"));
  const ordered = [
    ...extraDirs,
    path.join(homedir(), ".bun", "bin"),
    path.dirname(process.execPath),
    ...segments,
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const segment of ordered) {
    if (segment.length === 0 || seen.has(segment)) {
      continue;
    }
    seen.add(segment);
    deduped.push(segment);
  }

  return deduped.join(path.delimiter);
}

async function ensureFileExists(filePath: string, label: string): Promise<void> {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch {
    throw new Error(`${label} was not found at ${filePath}`);
  }
}

export async function createLocalMinicodeShim(tsBenchRoot: string, repoRoot: string): Promise<string> {
  const shimDir = path.join(tsBenchRoot, ".minicode-local-bin");
  const shimPath = path.join(shimDir, "minicode");
  const entryPath = path.join(repoRoot, "dist", "src", "index.js");
  await ensureFileExists(entryPath, "Built minicode entrypoint");
  await mkdir(shimDir, { recursive: true });
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `exec "${process.execPath}" "${entryPath}" "$@"`,
    "",
  ].join("\n");
  await writeFile(shimPath, script, "utf8");
  await chmod(shimPath, 0o755);
  return shimDir;
}

function buildSmokeCommand(args: TsBenchSmokeArgs): string[] {
  return [
    "src/index.ts",
    "--agent",
    "minicode",
    "--version",
    "local-dev",
    "--dataset",
    "v1",
    "--exercise",
    args.exercise,
    "--provider",
    args.provider,
    "--model",
    args.model,
    "--output-format",
    "json",
  ];
}

async function main(): Promise<void> {
  const args = parseTsBenchSmokeArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const tsBenchRoot = path.resolve(repoRoot, args.tsBenchPath);
  const benchmarkConfig = path.join(repoRoot, "benchmarks", "benchmark.config.json");
  const home = homedir();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME ?? home,
    USERPROFILE: home,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"),
    COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(home, ".cache", "node", "corepack"),
    LOCALAPPDATA: path.join(home, ".local", "share"),
    APPDATA: path.join(home, ".config"),
    PATH: buildStablePath(),
  };

  if (!args.skipBuild) {
    await runCommand("npm", ["run", "build"], { cwd: repoRoot, env: baseEnv });
  }

  await applyTsBenchMinicodeAdapter(tsBenchRoot);
  const shimDir = await createLocalMinicodeShim(tsBenchRoot, repoRoot);

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PATH: buildStablePath([shimDir]),
    MINICODE_BENCHMARK_CONFIG: benchmarkConfig,
  };

  if (args.envFile) {
    const envFilePath = path.resolve(repoRoot, args.envFile);
    const parsed = parseDotenv(await readFile(envFilePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) {
        env[key] = value;
      }
    }
    env.MINICODE_BENCHMARK_ENV_FILE = envFilePath;
  }

  if (args.dryRun) {
    console.log(`ts-bench path: ${tsBenchRoot}`);
    console.log(`repo root: ${repoRoot}`);
    console.log(`shim dir: ${shimDir}`);
    console.log(`command: bun ${buildSmokeCommand(args).join(" ")}`);
    return;
  }

  if (args.installDeps) {
    await runCommand("bun", ["install"], { cwd: tsBenchRoot, env });
    await runCommand("git", ["submodule", "update", "--init", "repos/exercism-typescript"], {
      cwd: tsBenchRoot,
      env,
    });
  }

  await runCommand("bun", buildSmokeCommand(args), { cwd: tsBenchRoot, env });
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
