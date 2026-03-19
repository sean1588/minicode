export interface CliArgs {
  verbose: boolean;
  oneshot: boolean;
  json: boolean;
  outFile?: string;
  serve: boolean;
  port: number;
  task: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let verbose = false;
  let oneshot = false;
  let json = false;
  let outFile: string | undefined;
  let serve = false;
  let port = 4567;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "serve") {
      serve = true;
      continue;
    }
    if (arg === "--port") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("--port requires a number. Example: --port 8080");
      }
      port = Number(value);
      if (!Number.isFinite(port) || port <= 0) {
        throw new CliUsageError("--port must be a positive number. Example: --port 8080");
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length).trim();
      port = Number(value);
      if (!Number.isFinite(port) || port <= 0) {
        throw new CliUsageError("--port must be a positive number. Example: --port=8080");
      }
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--oneshot" || arg === "-1") {
      oneshot = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("--out requires a file path. Example: --out result.txt");
      }
      outFile = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length).trim();
      if (value.length === 0) {
        throw new CliUsageError("--out requires a non-empty file path. Example: --out=result.txt");
      }
      outFile = value;
      continue;
    }

    taskParts.push(arg);
  }

  return {
    verbose,
    oneshot,
    json,
    ...(outFile ? { outFile } : {}),
    serve,
    port,
    task: taskParts.join(" ").trim(),
  };
}

export function validateCliArgs(args: CliArgs): void {
  if (args.oneshot && args.task.length === 0) {
    throw new CliUsageError(
      "--oneshot requires a task prompt. Example: minicode --oneshot \"Fix lint errors\"",
    );
  }

  if (!args.oneshot && (args.json || args.outFile)) {
    throw new CliUsageError("--json and --out are only supported with --oneshot.");
  }

  if (args.serve && (args.oneshot || args.json || args.outFile)) {
    throw new CliUsageError("serve mode is mutually exclusive with --oneshot, --json, and --out.");
  }
}
