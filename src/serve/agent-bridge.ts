import { CodingAgent, Session, createModelClient } from "@minicode/agent-sdk";
import type { UiUpdate } from "@minicode/agent-sdk";
import { loadAgentConfig } from "../agent/config.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "../indexer/cache.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import { createToolRegistry } from "../tools/registry.js";
import {
  listSessions,
  loadSession,
  loadSessionByLabel,
  saveSession,
} from "../session/session-store.js";
import type { ServerMessage } from "./types.js";

export type UiListener = (msg: ServerMessage) => void;

export class AgentBridge {
  private agent!: CodingAgent;
  private config!: Awaited<ReturnType<typeof loadAgentConfig>>;
  private buildAgent!: (session?: Session) => CodingAgent;
  private busy = false;
  private abortController: AbortController | null = null;
  private broadcast: (msg: ServerMessage) => void;
  private verbose: boolean;
  private readonly listeners = new Set<UiListener>();

  constructor(broadcast: (msg: ServerMessage) => void, verbose: boolean) {
    this.broadcast = broadcast;
    this.verbose = verbose;
  }

  addListener(fn: UiListener): void {
    this.listeners.add(fn);
  }

  removeListener(fn: UiListener): void {
    this.listeners.delete(fn);
  }

  protected emit(msg: ServerMessage): void {
    this.broadcast(msg);
    for (const fn of this.listeners) {
      fn(msg);
    }
  }

  async init(): Promise<void> {
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
    this.config = config;

    this.buildAgent = (session?: Session): CodingAgent => {
      return new CodingAgent({
        config,
        modelClient,
        toolRegistry,
        verbose: this.verbose,
        ...(session ? { session } : {}),
        ...(projectIndex !== undefined
          ? { getCodeMap: (focusSymbols?: Set<string>) => projectIndex.getCodeMap(undefined, focusSymbols) }
          : {}),
        onUiUpdate: (event: UiUpdate) => {
          this.emit(event as ServerMessage);
        },
      });
    };

    this.agent = this.buildAgent();
  }

  isBusy(): boolean {
    return this.busy;
  }

  getConfig(): Awaited<ReturnType<typeof loadAgentConfig>> {
    return this.config;
  }

  getAgent(): CodingAgent {
    return this.agent;
  }

  async runTurn(message: string): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> {
    if (this.busy) {
      throw new Error("busy");
    }

    this.busy = true;
    this.abortController = new AbortController();

    try {
      this.emit({ type: "turn_start" });
      const result = await this.agent.runTurn(message, {
        signal: this.abortController.signal,
      });
      this.emit({
        type: "turn_end",
        text: result.text,
        usage: result.usage,
      });
      return result;
    } catch (error) {
      const msg =
        error instanceof Error && error.name === "AbortError"
          ? "Cancelled"
          : error instanceof Error
            ? error.message
            : "Unknown error";
      this.emit({ type: "error", message: msg });
      throw error;
    } finally {
      this.busy = false;
      this.abortController = null;
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // Session operations
  async saveSess(label?: string) {
    return saveSession(this.agent.getSession(), label);
  }

  async loadSess(label: string) {
    const result =
      (await loadSessionByLabel(label)) ?? (await loadSession(label));
    if (!result) return null;
    this.agent = this.buildAgent(result.session);
    return result;
  }

  async listSess() {
    return listSessions();
  }
}
