import { spawn } from "node:child_process";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import {
  isDestructiveCommand,
  validateCommand,
} from "../safety/guardrails.js";
import { expectNonEmptyString, expectOptionalNumber } from "./helpers.js";

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const COMMAND_KILL_GRACE_MS = 1_000;

export interface RunCommandHooks {
  afterCommand?: ((command: string, result: CommandExecutionResult) => Promise<void> | void) | undefined;
}

function executeBashCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandExecutionResult> {
  return new Promise<CommandExecutionResult>((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let forceResolveTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (forceResolveTimeout) clearTimeout(forceResolveTimeout);
    };

    const settle = (result: CommandExecutionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const terminate = (signal: NodeJS.Signals) => {
      if (child.pid && useProcessGroup) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to killing the shell process directly.
        }
      }

      try {
        child.kill(signal);
      } catch {
        // The process may have already exited.
      }
    };

    timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        terminate("SIGKILL");
        forceResolveTimeout = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          settle({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode: null,
            timedOut,
          });
        }, COMMAND_KILL_GRACE_MS);
      }, COMMAND_KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      settle({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code,
        timedOut,
      });
    });
  });
}

function parseTimeout(
  rawTimeout: number | undefined,
  defaultTimeoutMs: number,
): number {
  if (rawTimeout === undefined) {
    return defaultTimeoutMs;
  }
  if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
    throw new Error(`"timeout" must be a positive integer in milliseconds.`);
  }
  return Math.min(rawTimeout, 10 * 60 * 1000);
}

export function createRunCommandTool(
  config: AgentConfig,
  hooks?: RunCommandHooks,
): ToolDefinition {
  return {
    name: "run_command",
    description:
      "Run a shell command in the workspace and return stdout/stderr/exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute within workspace root.",
        },
        timeout: {
          type: "number",
          description:
            "Optional timeout in milliseconds. Defaults to configured command timeout.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const command = expectNonEmptyString(input, "command");
      const rawTimeout = expectOptionalNumber(input, "timeout");
      const timeoutMs = parseTimeout(rawTimeout, config.commandTimeoutMs);

      validateCommand(command, config.commandDenylist);
      if (config.confirmDestructive && isDestructiveCommand(command)) {
        throw new Error(
          `Command "${command}" appears destructive and requires explicit user confirmation.`,
        );
      }

      const result = await executeBashCommand(
        command,
        config.workspaceRoot,
        timeoutMs,
      );

      if (hooks?.afterCommand) {
        await hooks.afterCommand(command, result);
      }

      const maxStdoutChars = 8_000;
      const maxStderrChars = 4_000;

      let stdoutOut = result.stdout.length > 0 ? result.stdout : "(empty)";
      if (stdoutOut.length > maxStdoutChars) {
        stdoutOut = `${stdoutOut.slice(0, maxStdoutChars)}\n[... truncated, ${result.stdout.length - maxStdoutChars} more chars ...]`;
      }

      let stderrOut = result.stderr.length > 0 ? result.stderr : "(empty)";
      if (stderrOut.length > maxStderrChars) {
        stderrOut = `${stderrOut.slice(0, maxStderrChars)}\n[... truncated, ${result.stderr.length - maxStderrChars} more chars ...]`;
      }

      return [
        `exit_code: ${result.exitCode ?? "null"}`,
        `timed_out: ${result.timedOut ? "true" : "false"}`,
        "stdout:",
        stdoutOut,
        "stderr:",
        stderrOut,
      ].join("\n");
    },
  };
}
