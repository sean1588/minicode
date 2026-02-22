import { spawn } from "node:child_process";
import path from "node:path";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";
import { expectNonEmptyString } from "./helpers.js";

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

export function createSearchTool(config: AgentConfig): ToolDefinition {
  return {
    name: "search",
    description:
      "Search file contents using ripgrep and return matching lines.",
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
          description: "Optional glob include filter, e.g. *.ts",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const pattern = expectNonEmptyString(input, "pattern");
      const requestedPath = getOptionalString(input, "path") ?? ".";
      const include = getOptionalString(input, "include");
      const targetPath = resolveWorkspacePath(
        requestedPath,
        config.workspaceRoot,
      );
      const relativeTarget =
        path.relative(config.workspaceRoot, targetPath) || ".";

      const rgArgs = [
        "--line-number",
        "--color",
        "never",
        "--no-heading",
      ];
      if (include) {
        rgArgs.push("--glob", include);
      }
      rgArgs.push(pattern, relativeTarget);

      try {
        const result = await runCommand(
          "rg",
          rgArgs,
          config.workspaceRoot,
          config.commandTimeoutMs,
        );

        if (result.code === 1 || result.stdout.trim().length === 0) {
          return "No matches found.";
        }
        if (result.code !== 0) {
          throw new Error(result.stderr || "ripgrep search failed.");
        }
        return result.stdout.trimEnd();
      } catch (error) {
        const commandError = error as NodeJS.ErrnoException;
        if (commandError.code !== "ENOENT") {
          throw error;
        }
      }

      // Minimal fallback for systems without rg installed.
      const grepArgs = ["-RIn", pattern, relativeTarget];
      const fallbackResult = await runCommand(
        "grep",
        grepArgs,
        config.workspaceRoot,
        config.commandTimeoutMs,
      );
      if (fallbackResult.code === 1 || fallbackResult.stdout.trim().length === 0) {
        return "No matches found.";
      }
      if (fallbackResult.code !== 0) {
        throw new Error(fallbackResult.stderr || "grep search failed.");
      }
      return fallbackResult.stdout.trimEnd();
    },
  };
}

