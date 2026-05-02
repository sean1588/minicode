import process from "node:process";

import { CodingAgent, Session, createModelClient } from "@minicode/agent-sdk";
import type { UiUpdate, ReasoningEffort } from "@minicode/agent-sdk";
import { loadAgentConfig, getConfigSetupMessage } from "../agent/config.js";
import { handleConfigSlashCommand } from "../cli/config-slash-command.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "../indexer/cache.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import { sortModelsAlphabetically } from "../model-utils.js";
import {
  listSessions,
  loadSession,
  loadSessionByLabel,
  saveSession,
} from "../session/session-store.js";
import { createToolRegistry } from "../tools/registry.js";
import { UiStore } from "./state/ui-store.js";
import { runInkApp } from "./app.js";
import { createPermissionGate } from "./permission-gate.js";
import { handlePermissionsSlashCommand } from "../cli/permissions-slash-command.js";

export async function runInkCli(
  verbose: boolean,
  initialTask?: string,
): Promise<void> {
  const store = new UiStore();
  store.setPhase("loading");

  const config = await loadAgentConfig();
  const setupMessage = getConfigSetupMessage(config);
  if (setupMessage) {
    console.error(setupMessage);
    process.exit(2);
  }
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
  store.setContextStatus(0, config.maxContextTokens);
  store.setPhase("idle");

  const toolRegistry = createToolRegistry(config, projectIndex);

  function createUiUpdateHandler(): (event: UiUpdate) => void {
    return (event) => {
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
        case "context_status":
          store.setContextStatus(event.contextTokens, event.maxContextTokens);
          break;
      }
    };
  }

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
      ...(verbose
        ? {
            onProgress: (msg: string) =>
              store.addItem({ type: "system", content: msg }),
            onVerbose: (msg: string) =>
              store.addItem({ type: "system", content: msg }),
          }
        : {}),
      onUiUpdate: createUiUpdateHandler(),
      beforeToolCall: createPermissionGate(store),
    });
  }

  let agent = buildAgent();
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
        content:
          'Commands: "/help", "/config [keys|get|set|unset]", "/permissions [auto on|off|status]", "/compact", "/reasoning [level]", "/models", "/model [name]", "/save [label]", "/load [label]", "/sessions", "/exit".',
      });
      return;
    }

    const permissionsCommand = handlePermissionsSlashCommand(trimmed, store);
    if (permissionsCommand.handled) {
      store.addItem({
        type: "system",
        content: permissionsCommand.message ?? "",
      });
      return;
    }

    const configCommand = await handleConfigSlashCommand(trimmed, { config });
    if (configCommand.handled) {
      store.addItem({
        type: "system",
        content: configCommand.message ?? "",
      });
      return;
    }

    if (trimmed === "/compact") {
      const session = agent.getSession();
      const result = await agent.compactContext();
      if (result) {
        const method = result.method === "llm" ? "LLM" : "mechanical";
        store.addItem({
          type: "system",
          content:
            `Compacted (${method}): ${result.removedMessages} messages summarized, ` +
            `${result.previousTokens} → ${result.newTokens} tokens ` +
            `(saved ${result.previousTokens - result.newTokens} tokens)`,
        });
      } else {
        store.addItem({
          type: "system",
          content: `Nothing to compact (${session.getTokenEstimate()} tokens, ${session.getMessages().length} messages).`,
        });
      }
      return;
    }

    if (trimmed === "/reasoning" || trimmed.startsWith("/reasoning ")) {
      const VALID_LEVELS: ReasoningEffort[] = ["xhigh", "high", "medium", "low", "minimal", "none"];
      const arg = trimmed.slice("/reasoning".length).trim().toLowerCase();
      if (arg.length === 0) {
        const current = agent.getReasoningEffort() ?? "(unset)";
        store.addItem({
          type: "system",
          content: `Current reasoning effort: ${current}\nValid levels: ${VALID_LEVELS.join(", ")}, off`,
        });
        return;
      }
      if (arg === "off") {
        agent.setReasoningEffort(undefined);
        store.addItem({ type: "system", content: "Reasoning effort disabled." });
        return;
      }
      if (VALID_LEVELS.includes(arg as ReasoningEffort)) {
        agent.setReasoningEffort(arg as ReasoningEffort);
        store.addItem({ type: "system", content: `Reasoning effort set to: ${arg}` });
      } else {
        store.addItem({
          type: "system",
          content: `Invalid reasoning level "${arg}". Valid levels: ${VALID_LEVELS.join(", ")}, off`,
        });
      }
      return;
    }

    if (trimmed === "/models") {
      if (modelClient.listModels) {
        store.addItem({ type: "system", content: "Fetching models..." });
        const models = sortModelsAlphabetically(await modelClient.listModels());
        if (models.length === 0) {
          store.addItem({ type: "system", content: "No models found (provider may not support listing)." });
        } else {
          const lines = models.map((m) => {
            const marker = m.id === config.model ? " (active)" : "";
            return `  ${m.id}${marker}`;
          });
          store.addItem({ type: "system", content: `Available models (${models.length}):\n${lines.join("\n")}` });
        }
      } else {
        store.addItem({ type: "system", content: "Current provider does not support listing models." });
      }
      return;
    }

    if (trimmed.startsWith("/model ")) {
      const newModel = trimmed.slice("/model ".length).trim();
      if (newModel.length === 0) {
        store.addItem({ type: "system", content: `Current model: ${config.model}` });
        return;
      }
      (config as { model: string }).model = newModel;
      store.setConfig({ model: newModel, workspaceRoot: config.workspaceRoot, maxSteps: config.maxSteps, indexStatus: "" });
      store.addItem({ type: "system", content: `Model switched to: ${newModel}` });
      return;
    }

    if (trimmed === "/model") {
      store.addItem({ type: "system", content: `Current model: ${config.model}` });
      return;
    }

    if (trimmed === "/save" || trimmed.startsWith("/save ")) {
      const label = trimmed.slice("/save".length).trim() || undefined;
      try {
        const meta = await saveSession(
          agent.getSession(),
          label,
        );
        store.addItem({
          type: "system",
          content: `Session saved as "${meta.label}" (${meta.messageCount} messages)`,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        store.addItem({ type: "system", content: `Failed to save session: ${msg}` });
      }
      return;
    }

    if (trimmed === "/sessions") {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        store.addItem({ type: "system", content: "No saved sessions found." });
      } else {
        const lines = sessions.map(
          (s) => `  ${s.label} (${s.messageCount} msgs, saved ${s.savedAt})`,
        );
        store.addItem({
          type: "system",
          content: "Saved sessions:\n" + lines.join("\n"),
        });
      }
      return;
    }

    if (trimmed === "/load" || trimmed.startsWith("/load ")) {
      const arg = trimmed.slice("/load".length).trim();
      if (arg.length === 0) {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          store.addItem({ type: "system", content: "No saved sessions found." });
        } else {
          const lines = sessions.map(
            (s) => `  ${s.label} (${s.messageCount} msgs, saved ${s.savedAt})`,
          );
          store.addItem({
            type: "system",
            content:
              "Saved sessions:\n" +
              lines.join("\n") +
              '\n\nUse "/load <label>" to restore a session.',
          });
        }
        return;
      }

      const result =
        (await loadSessionByLabel(arg)) ??
        (await loadSession(arg));
      if (!result) {
        store.addItem({
          type: "system",
          content: `No session found matching "${arg}".`,
        });
        return;
      }
      agent = buildAgent(result.session);
      store.addItem({
        type: "system",
        content: `Session "${result.label}" restored (${result.session.getMessages().length} messages).`,
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
