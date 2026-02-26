import path from "node:path";
import process from "node:process";

import { CodingAgent } from "../agent/agent.js";
import { loadAgentConfig } from "../agent/config.js";
import {
  computeFileHashes,
  loadIndex,
  saveIndex,
} from "../indexer/cache.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import { createModelClient } from "../model/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { UiStore } from "./state/ui-store.js";
import { runInkApp } from "./app.js";

const CACHE_DIR = ".mini-coder/cache";

export async function runInkCli(
  verbose: boolean,
  initialTask?: string,
): Promise<void> {
  const store = new UiStore();
  store.setPhase("loading");

  const config = await loadAgentConfig();
  const modelClient = createModelClient(config);
  let projectIndex: Awaited<ReturnType<typeof buildProjectIndex>> | undefined;
  let indexStatus = "building...";

  try {
    const cacheDir = path.join(config.workspaceRoot, CACHE_DIR);
    const fileHashes = await computeFileHashes(config.workspaceRoot);
    const cached = await loadIndex(cacheDir, fileHashes);
    if (cached) {
      projectIndex = cached;
      indexStatus = "ready (cached)";
    } else {
      projectIndex = await buildProjectIndex(config.workspaceRoot);
      await saveIndex(projectIndex, cacheDir, fileHashes);
      indexStatus = "ready";
    }
  } catch {
    projectIndex = undefined;
    indexStatus = "unavailable (degraded)";
  }

  store.setConfig({
    model: config.model,
    workspaceRoot: config.workspaceRoot,
    maxSteps: config.maxSteps,
    indexStatus,
  });
  store.setPhase("idle");

  const toolRegistry = ToolRegistry.createDefault(config, projectIndex);
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
    verbose,
    ...(projectIndex !== undefined ? { projectIndex } : {}),
    ...(verbose
      ? {
          onProgress: (msg: string) =>
            store.addActivityItem({ type: "system", content: msg }),
        }
      : {}),
    onUiUpdate: (event) => {
      switch (event.type) {
        case "step":
          store.setStep(event.step);
          break;
        case "thinking":
          store.addActivityItem({ type: "thinking", content: event.content });
          break;
        case "tool_call_start":
          store.addActivityItem({
            type: "tool_call",
            name: event.name,
            input: event.input,
            state: "running",
          });
          store.setPhase("tool_running");
          break;
        case "tool_call_end":
          store.updateLastToolCall({
            state: "success",
            elapsedMs: event.elapsedMs,
          });
          store.addActivityItem({
            type: "tool_result",
            name: event.name,
            content: event.result,
            elapsedMs: event.elapsedMs,
          });
          store.setPhase("model_wait");
          break;
      }
    },
  });

  const onRunTurn = async (input: string): Promise<void> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;

    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") {
      process.exit(0);
    }

    if (trimmed === "/help") {
      store.addActivityItem({
        type: "system",
        content: 'Commands: "/help", "/exit". Start with --verbose or -v for detailed logs.',
      });
      return;
    }

    store.addActivityItem({ type: "user", content: trimmed });
    store.setPhase("sending");
    store.setStep(0);

    try {
      const { text, usage } = await agent.runTurn(trimmed);
      store.addActivityItem({ type: "assistant", content: text });
      if (usage) {
        store.setTokenUsage(usage.inputTokens, usage.outputTokens);
        store.addActivityItem({
          type: "token_usage",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      }
      store.setPhase("idle");
      store.setStep(0);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown runtime failure";
      store.setError(message);
    }
  };

  const { waitUntilExit } = runInkApp(store, onRunTurn);

  if (initialTask && initialTask.trim().length > 0) {
    await onRunTurn(initialTask);
  }

  await waitUntilExit();
}
