import process from "node:process";

import { CodingAgent } from "../agent/agent.js";
import { formatConfigForDisplay, loadAgentConfig } from "../agent/config.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "../indexer/cache.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import { createModelClient } from "../model/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { UiStore } from "./state/ui-store.js";
import { runInkApp } from "./app.js";

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
    const cacheDir = getWorkspaceCacheDir(config.workspaceRoot);
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
            store.addItem({ type: "system", content: msg }),
        }
      : {}),
    onUiUpdate: (event) => {
      switch (event.type) {
        case "streaming_chunk":
          store.appendToStreamingContent(event.content);
          break;
        case "step":
          store.setStep(event.step);
          break;
        case "thinking":
          store.addItem({ type: "thinking", content: event.content });
          break;
        case "tool_call_start":
          store.addItem({
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
          store.addItem({
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

  let turnAbortController: AbortController | null = null;

  const handleCtrlC = (inkExit?: () => void): void => {
    if (turnAbortController) {
      turnAbortController.abort();
    } else if (inkExit) {
      inkExit();
    } else {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => handleCtrlC());

  const onCtrlC = (exit: () => void): void => handleCtrlC(exit);

  const onRunTurn = async (input: string): Promise<void> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;

    store.setError(null);

    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit") {
      process.exit(0);
    }

    if (trimmed === "/help") {
      store.addItem({
        type: "system",
        content: 'Commands: "/help", "/config", "/exit". Start with --verbose or -v for detailed logs.',
      });
      return;
    }

    if (trimmed === "/config") {
      store.addItem({
        type: "system",
        content: formatConfigForDisplay(config),
      });
      return;
    }

    store.addItem({ type: "user", content: trimmed });
    store.setPhase("sending");
    store.setStep(0);

    turnAbortController = new AbortController();
    try {
      const { text, usage, streamed } = await agent.runTurn(trimmed, {
        signal: turnAbortController.signal,
      });
      if (!streamed) {
        store.addItem({ type: "assistant", content: text });
      }
      if (usage) {
        store.setTokenUsage(usage.inputTokens, usage.outputTokens);
        store.addItem({
          type: "token_usage",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      }
      store.setPhase("idle");
      store.setStep(0);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        store.addItem({ type: "system", content: "Cancelled" });
      } else {
        const message =
          error instanceof Error ? error.message : "Unknown runtime failure";
        store.setError(message);
      }
      store.setPhase("idle");
      store.setStep(0);
    } finally {
      turnAbortController = null;
    }
  };

  const { waitUntilExit } = runInkApp(store, onRunTurn, onCtrlC);

  if (initialTask && initialTask.trim().length > 0) {
    await onRunTurn(initialTask);
  }

  await waitUntilExit();
}
