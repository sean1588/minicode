import { createInterface } from "node:readline/promises";
import process from "node:process";

import { CodingAgent } from "./agent/agent.js";
import { loadAgentConfig } from "./agent/config.js";
import { createModelClient } from "./model/client.js";
import { ToolRegistry } from "./tools/registry.js";

function printBanner(): void {
  console.log("mini-coder MVP");
  console.log('Type your request, or "/exit" to quit.');
}

async function runSingleTurn(task: string): Promise<void> {
  const config = await loadAgentConfig();
  const modelClient = createModelClient(config);
  const toolRegistry = ToolRegistry.createDefault(config);
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
  });

  const response = await agent.runTurn(task);
  console.log(response);
}

async function runInteractive(): Promise<void> {
  const config = await loadAgentConfig();
  const modelClient = createModelClient(config);
  const toolRegistry = ToolRegistry.createDefault(config);
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
  });

  printBanner();
  console.log(`Workspace: ${config.workspaceRoot}`);
  console.log(`Provider: ${config.modelProvider}`);
  console.log(`Model: ${config.model}`);

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

  while (!shuttingDown) {
    const input = await rl.question("\nYou> ");
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") {
      break;
    }

    if (trimmed === "/help") {
      console.log('Commands: "/help", "/exit"');
      continue;
    }

    try {
      const response = await agent.runTurn(trimmed);
      console.log(`\nAgent> ${response}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown runtime failure";
      console.error(`\nAgent error: ${message}`);
    }
  }

  rl.close();
}

async function main(): Promise<void> {
  const cliTask = process.argv.slice(2).join(" ").trim();
  if (cliTask.length > 0) {
    await runSingleTurn(cliTask);
    return;
  }

  await runInteractive();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});

