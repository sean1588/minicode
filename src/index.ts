#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { CodingAgent } from "./agent/agent.js";
import { formatConfigForDisplay, loadAgentConfig } from "./agent/config.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "./indexer/cache.js";
import { buildProjectIndex } from "./indexer/project-index.js";
import { createModelClient } from "./model/client.js";
import { ToolRegistry } from "./tools/registry.js";

function parseArgs(argv: string[]): { verbose: boolean; task: string } {
  const args = argv.slice(2);
  const verbose =
    args.includes("--verbose") || args.includes("-v");
  const filtered = args.filter((a) => a !== "--verbose" && a !== "-v");
  const task = filtered.join(" ").trim();
  return { verbose, task };
}

function printBanner(): void {
  console.log("minicode");

  console.log('Type your request, or "/exit" to quit.');
}

async function runInteractive(
  verbose: boolean,
  initialTask?: string,
): Promise<void> {
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
  const toolRegistry = ToolRegistry.createDefault(config, projectIndex);
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
    verbose,
    ...(projectIndex !== undefined ? { projectIndex } : {}),
    onProgress: (msg) => console.error(`  ${msg}`),
  });

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
  process.on("SIGINT", () => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nReceived interrupt. Exiting gracefully.");
    rl.close();
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

    try {
      const { text, usage } = await agent.runTurn(trimmed);
      console.log(`\nAgent> ${text}`);
      if (usage) {
        console.error(`  tokens: ${usage.inputTokens} in, ${usage.outputTokens} out`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown runtime failure";
      console.error(`\nAgent error: ${message}`);
    }
  }

  rl.close();
}

async function main(): Promise<void> {
  const { verbose, task } = parseArgs(process.argv);
  const uiMode = process.env.CLI_UI_MODE ?? "ink";

  if (uiMode !== "legacy" && process.stdin.isTTY) {
    const { runInkCli } = await import("./ui/cli-ink.js");
    await runInkCli(verbose, task.length > 0 ? task : undefined);
    return;
  }

  await runInteractive(verbose, task.length > 0 ? task : undefined);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});

