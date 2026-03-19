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
import type { ProjectIndex } from "../indexer/types.js";
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
  private projectIndex: ProjectIndex | undefined;
  private buildAgent!: (session?: Session) => CodingAgent;
  private busy = false;
  private abortController: AbortController | null = null;
  private broadcast: (msg: ServerMessage) => void;
  private verbose: boolean;
  private readonly listeners = new Set<UiListener>();
  private readonly pinnedSymbols = new Set<string>();

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
    this.projectIndex = projectIndex;

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

  // ── Project index queries ──

  hasIndex(): boolean {
    return this.projectIndex !== undefined;
  }

  getSymbols() {
    if (!this.projectIndex) return [];
    const symbols: Array<{
      name: string;
      qualifiedName: string;
      kind: string;
      filePath: string;
      startLine: number;
      endLine: number;
      signature: string;
      exported: boolean;
    }> = [];
    for (const sym of this.projectIndex.symbols.values()) {
      symbols.push({
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        signature: sym.signature,
        exported: sym.exported,
      });
    }
    return symbols;
  }

  getSymbol(name: string) {
    if (!this.projectIndex) return undefined;
    return this.projectIndex.getSymbol(name);
  }

  getDependencies(symbolName: string, depth?: number) {
    if (!this.projectIndex) return undefined;
    const cone = this.projectIndex.getDependencyCone(symbolName, depth);
    if (cone.length === 0) return undefined;
    return cone.map((sym) => ({
      name: sym.name,
      qualifiedName: sym.qualifiedName,
      kind: sym.kind,
      filePath: sym.filePath,
      signature: sym.signature,
    }));
  }

  getReferences(symbolName: string) {
    if (!this.projectIndex) return undefined;
    const sym = this.projectIndex.getSymbol(symbolName);
    if (!sym) return undefined;
    // Find all edges pointing TO this symbol
    const refs = this.projectIndex.dependencyEdges
      .filter((e) => e.to === sym.qualifiedName || e.to === sym.name)
      .map((e) => ({ from: e.from, kind: e.kind }));
    return refs;
  }

  getCodeMap(tokenBudget?: number) {
    if (!this.projectIndex) return undefined;
    const focus = this.pinnedSymbols.size > 0 ? this.pinnedSymbols : undefined;
    return this.projectIndex.getCodeMap(tokenBudget, focus);
  }

  getGraph() {
    if (!this.projectIndex) return undefined;
    const nodes: Array<{
      id: string;
      name: string;
      kind: string;
      filePath: string;
      exported: boolean;
    }> = [];
    for (const sym of this.projectIndex.symbols.values()) {
      nodes.push({
        id: sym.qualifiedName,
        name: sym.name,
        kind: sym.kind,
        filePath: sym.filePath,
        exported: sym.exported,
      });
    }
    const edges = this.projectIndex.dependencyEdges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
    }));
    return { nodes, edges };
  }

  getPinnedSymbols(): string[] {
    return [...this.pinnedSymbols];
  }

  pinSymbol(name: string): boolean {
    if (!this.projectIndex) return false;
    const sym = this.projectIndex.getSymbol(name);
    if (!sym) return false;
    this.pinnedSymbols.add(sym.qualifiedName);
    return true;
  }

  unpinSymbol(name: string): boolean {
    if (!this.projectIndex) return false;
    const sym = this.projectIndex.getSymbol(name);
    if (!sym) return false;
    this.pinnedSymbols.delete(sym.qualifiedName);
    return true;
  }
}
