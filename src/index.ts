#!/usr/bin/env node
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { CodingAgent, createModelClient } from "@minicode/agent-sdk";
import { formatConfigForDisplay, loadAgentConfig } from "./agent/config.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "./indexer/cache.js";
import { buildProjectIndex } from "./indexer/project-index.js";
import { createToolRegistry } from "./tools/registry.js";
import {
  CliUsageError,
  parseCliArgs,
  validateCliArgs,
} from "./cli/args.js";

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_RUNTIME_ERROR = 1;
const EXIT_CODE_USAGE_ERROR = 2;

function printBanner(): void {
  console.log("minicode");
  console.log('Type your request, or "/exit" to quit.');
}

async function createAgentRuntime(
  verbose: boolean,
  onProgress?: (message: string) => void,
): Promise<{ agent: CodingAgent; config: Awaited<ReturnType<typeof loadAgentConfig>> }> {
  const config = await loadAgentConfig();
  const modelClient = createModelClient(config);
  let projectIndex: Awaited<ReturnType<typeof buildProjectIndex>> | undefined;
  try {
    const cacheDir = getWorkspaceCacheDir(config.workspaceRoot);
    const fileHashes = await computeFileHashes(config.workspaceRoot);
    const cached = await loadIndex(cacheDir, fileHashes);
    if (cached) {
      projectIndex = cached;
    } else {
      projectIndex = await buildProjectIndex(config.workspaceRoot);
      await saveIndex(projectIndex, cacheDir, fileHashes);
    }
  } catch {
    projectIndex = undefined;
  }
  const toolRegistry = createToolRegistry(config, projectIndex);
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
    verbose,
    ...(projectIndex !== undefined
      ? { getCodeMap: () => projectIndex.getCodeMap() }
      : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  return { agent, config };
}

async function runInteractive(
  verbose: boolean,
  initialTask?: string,
): Promise<void> {
  const { agent, config } = await createAgentRuntime(
    verbose,
    (msg) => console.error(`  ${msg}`),
  );

  printBanner();
  console.log(`Workspace: ${config.workspaceRoot}`);
  console.log(`Provider: ${config.modelProvider}`);
  console.log(`Model: ${config.model}`);
  if (verbose) {
    console.log("Verbose: enabled");
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let shuttingDown = false;
  let turnAbortController: AbortController | null = null;

  process.on("SIGINT", () => {
    if (turnAbortController) {
      turnAbortController.abort();
    } else if (shuttingDown) {
      process.exit(EXIT_CODE_RUNTIME_ERROR);
    } else {
      shuttingDown = true;
      console.log("\nReceived interrupt. Exiting gracefully.");
      rl.close();
    }
  });

  let pendingInput: string | null = initialTask ?? null;

  while (!shuttingDown) {
    const input =
      pendingInput !== null
        ? pendingInput
        : await rl.question("\nYou> ");
    if (pendingInput !== null) {
      console.log(`\nYou> ${input}`);
    }
    pendingInput = null;
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") {
      break;
    }

    if (trimmed === "/help") {
      console.log('Commands: "/help", "/config", "/exit"');
      console.log("Start with --verbose or -v to log prompts, responses, and tool calls.");
      continue;
    }

    if (trimmed === "/config") {
      console.log("\n" + formatConfigForDisplay(config) + "\n");
      continue;
    }

    turnAbortController = new AbortController();
    try {
      const { text, usage } = await agent.runTurn(trimmed, {
        signal: turnAbortController.signal,
      });
      console.log(`\nAgent> ${text}`);
      if (usage) {
        console.error(`  tokens: ${usage.inputTokens} in, ${usage.outputTokens} out`);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Cancelled"
          : error instanceof Error
            ? error.message
            : "Unknown runtime failure";
      console.error(`\nAgent error: ${message}`);
    } finally {
      turnAbortController = null;
    }
  }

  rl.close();
}

async function runOneshot(params: {
  verbose: boolean;
  task: string;
  json: boolean;
  outFile?: string;
}): Promise<void> {
  const { agent } = await createAgentRuntime(params.verbose);

  const { text, usage } = await agent.runTurn(params.task);
  const payload = params.json
    ? JSON.stringify({ text, usage: usage ?? null }, null, 2)
    : text;

  if (params.outFile) {
    await writeFile(params.outFile, payload + "\n", "utf8");
    return;
  }

  console.log(payload);
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv);
  validateCliArgs(cliArgs);

  if (cliArgs.oneshot) {
    await runOneshot(cliArgs);
    process.exitCode = EXIT_CODE_SUCCESS;
    return;
  }

  const uiMode = process.env.CLI_UI_MODE ?? "ink";
  if (uiMode !== "legacy" && process.stdin.isTTY) {
    const { runInkCli } = await import("./ui/cli-ink.js");
    await runInkCli(cliArgs.verbose, cliArgs.task.length > 0 ? cliArgs.task : undefined);
    process.exitCode = EXIT_CODE_SUCCESS;
    return;
  }

  await runInteractive(cliArgs.verbose, cliArgs.task.length > 0 ? cliArgs.task : undefined);
  process.exitCode = EXIT_CODE_SUCCESS;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  if (error instanceof CliUsageError) {
    process.exit(EXIT_CODE_USAGE_ERROR);
  }
  process.exit(EXIT_CODE_RUNTIME_ERROR);
});
