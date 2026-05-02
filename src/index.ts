#!/usr/bin/env node
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { CodingAgent, Session, createModelClient, type ModelClient, type ReasoningEffort } from "@minicode/agent-sdk";
import { loadAgentConfig, getConfigSetupMessage } from "./agent/config.js";
import {
  listSessions,
  loadSession,
  loadSessionByLabel,
  saveSession,
} from "./session/session-store.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "./indexer/cache.js";
import { buildProjectIndex } from "./indexer/project-index.js";
import { sortModelsAlphabetically } from "./model-utils.js";
import { createToolRegistry } from "./tools/registry.js";
import {
  CliUsageError,
  parseCliArgs,
  validateCliArgs,
} from "./cli/args.js";
import { handleConfigSlashCommand } from "./cli/config-slash-command.js";

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_RUNTIME_ERROR = 1;
const EXIT_CODE_USAGE_ERROR = 2;

function printBanner(): void {
  console.log("minicode");
  console.log('Type your request, or "/exit" to quit.');
}

interface AgentRuntime {
  agent: CodingAgent;
  config: Awaited<ReturnType<typeof loadAgentConfig>>;
  modelClient: ModelClient;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  projectIndex: Awaited<ReturnType<typeof buildProjectIndex>> | undefined;
  buildAgent: (session?: Session) => CodingAgent;
}

async function createAgentRuntime(
  verbose: boolean,
  onProgress?: (message: string) => void,
): Promise<AgentRuntime> {
  const config = await loadAgentConfig();
  const setupMessage = getConfigSetupMessage(config);
  if (setupMessage) {
    console.error(setupMessage);
    process.exit(EXIT_CODE_USAGE_ERROR);
  }
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

  function buildAgent(session?: Session): CodingAgent {
    return new CodingAgent({
      config,
      modelClient,
      toolRegistry,
      verbose,
      ...(session ? { session } : {}),
      ...(projectIndex !== undefined
        ? { getCodeMap: (focusSymbols?: Set<string>) => projectIndex.getCodeMap(undefined, focusSymbols) }
        : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  }

  return { agent: buildAgent(), config, modelClient, toolRegistry, projectIndex, buildAgent };
}

async function runInteractive(
  verbose: boolean,
  initialTask?: string,
): Promise<void> {
  const runtime = await createAgentRuntime(
    verbose,
    (msg) => console.error(`  ${msg}`),
  );
  let { agent } = runtime;
  const { config, modelClient, buildAgent } = runtime;

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
      console.log('Commands: "/help", "/config [keys|get|set|unset]", "/compact", "/reasoning [level]", "/models", "/model [name]", "/save [label]", "/load [label]", "/sessions", "/exit"');
      console.log("Start with --verbose or -v to log prompts, responses, and tool calls.");
      continue;
    }

    const configCommand = await handleConfigSlashCommand(trimmed, { config });
    if (configCommand.handled) {
      console.log("\n" + (configCommand.message ?? "") + "\n");
      continue;
    }

    if (trimmed === "/compact") {
      const session = agent.getSession();
      const tokensBefore = session.getTokenEstimate();
      const result = await agent.compactContext();
      if (result) {
        const method = result.method === "llm" ? "LLM" : "mechanical";
        console.log(
          `Compacted (${method}): ${result.removedMessages} messages summarized, ` +
          `${result.previousTokens} → ${result.newTokens} tokens ` +
          `(saved ${result.previousTokens - result.newTokens} tokens)`,
        );
      } else {
        console.log(`Nothing to compact (${tokensBefore} tokens, ${session.getMessages().length} messages).`);
      }
      continue;
    }

    if (trimmed === "/reasoning" || trimmed.startsWith("/reasoning ")) {
      const VALID_LEVELS: ReasoningEffort[] = ["xhigh", "high", "medium", "low", "minimal", "none"];
      const arg = trimmed.slice("/reasoning".length).trim().toLowerCase();
      if (arg.length === 0) {
        const current = agent.getReasoningEffort() ?? "(unset)";
        console.log(`Current reasoning effort: ${current}`);
        console.log(`Valid levels: ${VALID_LEVELS.join(", ")}, off`);
        continue;
      }
      if (arg === "off") {
        agent.setReasoningEffort(undefined);
        console.log("Reasoning effort disabled.");
        continue;
      }
      if (VALID_LEVELS.includes(arg as ReasoningEffort)) {
        agent.setReasoningEffort(arg as ReasoningEffort);
        console.log(`Reasoning effort set to: ${arg}`);
      } else {
        console.log(`Invalid reasoning level "${arg}". Valid levels: ${VALID_LEVELS.join(", ")}, off`);
      }
      continue;
    }

    if (trimmed === "/models") {
      if (modelClient.listModels) {
        console.log("Fetching models...");
        const models = sortModelsAlphabetically(await modelClient.listModels());
        if (models.length === 0) {
          console.log("No models found (provider may not support listing).");
        } else {
          console.log(`Available models (${models.length}):`);
          for (const m of models) {
            const marker = m.id === config.model ? " (active)" : "";
            console.log(`  ${m.id}${marker}`);
          }
        }
      } else {
        console.log("Current provider does not support listing models.");
      }
      continue;
    }

    if (trimmed.startsWith("/model ")) {
      const newModel = trimmed.slice("/model ".length).trim();
      if (newModel.length === 0) {
        console.log(`Current model: ${config.model}`);
        continue;
      }
      (config as { model: string }).model = newModel;
      console.log(`Model switched to: ${newModel}`);
      continue;
    }

    if (trimmed === "/model") {
      console.log(`Current model: ${config.model}`);
      continue;
    }

    if (trimmed === "/save" || trimmed.startsWith("/save ")) {
      const label = trimmed.slice("/save".length).trim() || undefined;
      try {
        const meta = await saveSession(
          agent.getSession(),
          label,
        );
        console.log(`Session saved as "${meta.label}" (${meta.messageCount} messages)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error(`Failed to save session: ${msg}`);
      }
      continue;
    }

    if (trimmed === "/sessions") {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log("No saved sessions found.");
      } else {
        console.log("Saved sessions:");
        for (const s of sessions) {
          console.log(`  ${s.label} (${s.messageCount} msgs, saved ${s.savedAt})`);
        }
      }
      continue;
    }

    if (trimmed === "/load" || trimmed.startsWith("/load ")) {
      const arg = trimmed.slice("/load".length).trim();
      if (arg.length === 0) {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          console.log("No saved sessions found.");
        } else {
          console.log("Saved sessions:");
          for (const s of sessions) {
            console.log(`  ${s.label} (${s.messageCount} msgs, saved ${s.savedAt})`);
          }
          console.log('\nUse "/load <label>" to restore a session.');
        }
        continue;
      }

      const result =
        (await loadSessionByLabel(arg)) ??
        (await loadSession(arg));
      if (!result) {
        console.log(`No session found matching "${arg}".`);
        continue;
      }
      agent = buildAgent(result.session);
      console.log(`Session "${result.label}" restored (${result.session.getMessages().length} messages).`);
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

  if (cliArgs.pluginInstall) {
    const { installPlugin } = await import("./cli/plugin-install.js");
    await installPlugin();
    return;
  }

  if (cliArgs.benchmarkRun) {
    const { runBenchmarkCommand } = await import("./cli/benchmark-run.js");
    await runBenchmarkCommand(cliArgs.benchmarkArgv ?? []);
    process.exitCode = EXIT_CODE_SUCCESS;
    return;
  }

  if (cliArgs.serve) {
    const { runServe } = await import("./serve/server.js");
    await runServe(cliArgs.verbose, cliArgs.port);
    return;
  }

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
