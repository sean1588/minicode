import { spawn } from "node:child_process";
import path from "node:path";

import type { ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";
import { expectNonEmptyString } from "./helpers.js";

/**
 * Minimal options needed by the search tool. `AgentConfig` satisfies
 * this structurally, so passing the full config keeps working.
 */
export interface SearchToolOptions {
  workspaceRoot: string;
  commandTimeoutMs: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `Search command timed out after ${timeoutMs} ms.`,
          ),
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        code,
      });
    });
  });
}

/**
 * Single source of truth for what the search tool excludes. Both the
 * ripgrep / grep invocations and the "no matches" message read from
 * this list so the user-facing message can never lie about the
 * actual search domain. Add an entry here, get it everywhere.
 */
const EXCLUDED_PATHS: ReadonlyArray<{
  name: string;
  kind: "dir" | "file" | "glob";
}> = [
  { name: ".git", kind: "dir" },
  { name: ".minicode", kind: "dir" },
  { name: "node_modules", kind: "dir" },
  { name: "package-lock.json", kind: "file" },
  { name: "yarn.lock", kind: "file" },
  { name: "pnpm-lock.yaml", kind: "file" },
  { name: "*.min.js", kind: "glob" },
];

function rgGlobArgs(): string[] {
  const args: string[] = [];
  for (const e of EXCLUDED_PATHS) {
    args.push("--glob", e.kind === "dir" ? `!${e.name}/**` : `!${e.name}`);
  }
  return args;
}

function grepExcludeArgs(): string[] {
  return EXCLUDED_PATHS.map((e) =>
    e.kind === "dir" ? `--exclude-dir=${e.name}` : `--exclude=${e.name}`,
  );
}

function excludedPathsForMessage(): string {
  return EXCLUDED_PATHS.map((e) => e.name).join(", ");
}

function getOptionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Input "${key}" must be a non-empty string.`);
  }
  return value;
}

export function createSearchTool(options: SearchToolOptions): ToolDefinition {
  return {
    name: "search",
    description:
      "Search file contents using ripgrep. Use when you don't know the symbol name.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for.",
        },
        path: {
          type: "string",
          description: "Optional path to search under, relative to workspace root.",
        },
        include: {
          type: "string",
          description: "Optional glob include filter to restrict matched files, e.g. \"src/**\".",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const maxOutputChars = 12_000;
      const pattern = expectNonEmptyString(input, "pattern");
      const requestedPath = getOptionalString(input, "path") ?? ".";
      const include = getOptionalString(input, "include");
      const targetPath = resolveWorkspacePath(
        requestedPath,
        options.workspaceRoot,
      );
      const relativeTarget =
        path.relative(options.workspaceRoot, targetPath) || ".";

      // When ripgrep / grep return zero matches we surface the search
      // domain so the agent can tell "the pattern truly isn't there"
      // apart from "the search was filtered or scoped wrong." Without
      // this, the same string ("No matches found.") is returned in
      // both cases and the agent can't escalate.
      const noMatchesMessage = (): string => {
        const filterSuffix = include ? ` matching glob "${include}"` : "";
        return [
          `No matches for /${pattern}/ in "${relativeTarget}"${filterSuffix}.`,
          `Excluded: ${excludedPathsForMessage()}.`,
          `If you expected a hit, try: a broader path, a less restrictive include glob, search_code_map for symbol-name lookups, or read_file on the suspected file directly.`,
        ].join("\n");
      };

      const rgArgs = [
        "--line-number",
        "--color",
        "never",
        "--no-heading",
        "--hidden",
        "--no-ignore",
        ...rgGlobArgs(),
        "-m",
        "50",
      ];
      if (include) {
        rgArgs.push("--glob", include);
      }
      rgArgs.push(pattern, relativeTarget);

      try {
        const result = await runCommand(
          "rg",
          rgArgs,
          options.workspaceRoot,
          options.commandTimeoutMs,
        );

        if (result.code !== 0) {
          if (result.code === 1) {
            return noMatchesMessage();
          }
          throw new Error(result.stderr || "ripgrep search failed.");
        }
        if (result.stdout.trim().length === 0) {
          return noMatchesMessage();
        }
        const output = result.stdout.trimEnd();
        if (output.length > maxOutputChars) {
          return `${output.slice(0, maxOutputChars)}\n\n[... output truncated, ${output.length - maxOutputChars} more chars ...]`;
        }
        return output;
      } catch (error) {
        const commandError = error as NodeJS.ErrnoException;
        if (commandError.code !== "ENOENT") {
          throw error;
        }
      }

      // Minimal fallback for systems without rg installed. Use `-E` so
      // alternation (`|`) and grouping (`()`) are interpreted as in
      // ripgrep — plain grep defaults to BRE where those are literal
      // characters, which silently turns every alternation-style regex
      // into a zero-hit search and traps the model in retry loops.
      const grepArgs = [
        "-ERIn",
        ...grepExcludeArgs(),
        "-m",
        "50",
        pattern,
        relativeTarget,
      ];
      const fallbackResult = await runCommand(
        "grep",
        grepArgs,
        options.workspaceRoot,
        options.commandTimeoutMs,
      );
      if (fallbackResult.code !== 0) {
        if (fallbackResult.code === 1) {
          return noMatchesMessage();
        }
        throw new Error(fallbackResult.stderr || "grep search failed.");
      }
      if (fallbackResult.stdout.trim().length === 0) {
        return "No matches found.";
      }
      const fallbackOutput = fallbackResult.stdout.trimEnd();
      if (fallbackOutput.length > maxOutputChars) {
        return `${fallbackOutput.slice(0, maxOutputChars)}\n\n[... output truncated, ${fallbackOutput.length - maxOutputChars} more chars ...]`;
      }
      return fallbackOutput;
    },
  };
}
