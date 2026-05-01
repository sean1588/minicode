import { CodingAgent, Session, createModelClient } from "@minicode/agent-sdk";
import type {
  BeforeToolCallHook,
  ModelInfo,
  ToolPermissionDecision,
  UiUpdate,
} from "@minicode/agent-sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { analyzeProjectStructure, type StructuralAnalysisReport } from "../analysis/structural-analysis.js";
import { loadAgentConfig } from "../agent/config.js";
import {
  computeFileHashes,
  getWorkspaceCacheDir,
  loadIndex,
  saveIndex,
} from "../indexer/cache.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import type { ProjectIndex } from "../indexer/types.js";
import { sortModelsAlphabetically } from "../model-utils.js";
import { createToolRegistry } from "../tools/registry.js";
import {
  deleteSession,
  listSessions,
  loadSession,
  loadSessionByLabel,
  saveSession,
} from "../session/session-store.js";
import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import type { ServerMessage } from "./types.js";

export type UiListener = (msg: ServerMessage) => void;

export class AgentBridge {
  private agent: CodingAgent | undefined;
  private config!: Awaited<ReturnType<typeof loadAgentConfig>>;
  private baseConfig!: Awaited<ReturnType<typeof loadAgentConfig>>;
  private modelClient: ReturnType<typeof createModelClient> | undefined;
  private projectIndex: ProjectIndex | undefined;
  private toolRegistry: ReturnType<typeof createToolRegistry> | undefined;
  private sessionProviderConnection: "openrouter" | "openai-compatible" | null = null;
  private busy = false;
  private abortController: AbortController | null = null;
  private broadcast: (msg: ServerMessage) => void;
  private verbose: boolean;
  private readonly listeners = new Set<UiListener>();
  private readonly pinnedSymbols = new Set<string>();
  private readonly annotations = new Map<string, string[]>();
  private fileWatcher: FSWatcher | null = null;
  private reindexTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * When true, mutating tool calls (write_file, edit_file, run_command) skip
   * the user-approval prompt and run immediately. Default: false — the user
   * must approve each call. Toggleable from the web UI checkbox or by
   * answering "Allow always" on a permission prompt.
   */
  private autoAllowWrites = false;

  /**
   * In-flight permission requests keyed by `requestId`. The agent loop is
   * paused on the promise; the WebSocket handler calls
   * `resolvePermissionRequest(requestId, ...)` when the user responds.
   */
  private readonly pendingPermissions = new Map<
    string,
    (decision: ToolPermissionDecision) => void
  >();

  /** Tools that go through the gate. Read-only tools (read_file, search, …) bypass it. */
  private static readonly GATED_TOOLS = new Set([
    "write_file",
    "edit_file",
    "run_command",
  ]);

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
    try {
      this.modelClient = createModelClient(config);
    } catch {
      // Model client may fail to initialize if API keys are missing.
      // Serve mode continues so the web UI can show setup instructions.
    }

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

    this.config = config;
    this.baseConfig = AgentBridge.cloneConfig(config);
    this.projectIndex = projectIndex;
    this.installToolRegistry(projectIndex);

    if (this.modelClient) {
      this.agent = this.createAgent();
    }
  }

  private static cloneConfig(
    config: Awaited<ReturnType<typeof loadAgentConfig>>,
  ): Awaited<ReturnType<typeof loadAgentConfig>> {
    return {
      ...config,
      commandDenylist: [...config.commandDenylist],
    };
  }

  private static applyConfig(
    target: Awaited<ReturnType<typeof loadAgentConfig>>,
    source: Awaited<ReturnType<typeof loadAgentConfig>>,
  ): void {
    const targetRecord = target as unknown as Record<string, unknown>;
    for (const key of Object.keys(targetRecord)) {
      if (!(key in source)) {
        delete targetRecord[key];
      }
    }

    Object.assign(targetRecord, AgentBridge.cloneConfig(source));
  }

  private installToolRegistry(projectIndex: ProjectIndex | undefined): void {
    const toolRegistry = createToolRegistry(this.config, projectIndex);

    // Wrap tool registry execute to inject annotations into tool results.
    const originalExecute = toolRegistry.execute.bind(toolRegistry);
    toolRegistry.execute = async (name: string, input: unknown) => {
      const result = await originalExecute(name, input);
      return this.appendAnnotationsToResult(name, input, result);
    };

    this.toolRegistry = toolRegistry;
  }

  private createAgent(
    session?: Session,
    onUiUpdate?: (event: UiUpdate) => void,
  ): CodingAgent {
    if (!this.modelClient || !this.toolRegistry) {
      throw new Error("Agent runtime is not initialized.");
    }

    return new CodingAgent({
      config: this.config,
      modelClient: this.modelClient,
      toolRegistry: this.toolRegistry,
      verbose: this.verbose,
      ...(session ? { session } : {}),
      ...(this.projectIndex !== undefined
        ? { getCodeMap: (focusSymbols?: Set<string>) => this.projectIndex!.getCodeMap(undefined, focusSymbols) }
        : {}),
      onUiUpdate: onUiUpdate ?? ((event: UiUpdate) => {
        this.emit(event as ServerMessage);
      }),
      getSystemPromptSuffix: () => this.buildAnnotationSuffix(),
      beforeToolCall: this.gateToolCall,
    });
  }

  /**
   * Permission gate for tool calls. Read-only tools bypass; mutating tools
   * either auto-allow (when the user has flipped the toggle) or open a
   * round-trip prompt against the connected web client.
   *
   * Defined as an arrow-property so `this` binding survives passing it
   * straight into `CodingAgent` as `beforeToolCall`.
   */
  private gateToolCall: BeforeToolCallHook = async (toolCall) => {
    if (!AgentBridge.GATED_TOOLS.has(toolCall.name)) {
      return { outcome: "allow" };
    }
    if (this.autoAllowWrites) {
      return { outcome: "allow" };
    }
    return new Promise<ToolPermissionDecision>((resolve) => {
      const requestId = randomUUID();
      this.pendingPermissions.set(requestId, resolve);
      this.emit({
        type: "permission_required",
        requestId,
        toolName: toolCall.name,
        input: toolCall.input,
      });
    });
  };

  /**
   * Resolve a pending permission request. Called by the WebSocket handler
   * when a `permission_response` arrives. Idempotent: a duplicate response
   * for the same requestId is silently ignored.
   */
  resolvePermissionRequest(
    requestId: string,
    response: { decision: "allow" | "deny"; rememberForSession: boolean },
  ): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);

    if (response.decision === "allow" && response.rememberForSession) {
      this.setAutoAllowWrites(true);
    }

    if (response.decision === "allow") {
      resolve({ outcome: "allow" });
    } else {
      resolve({
        outcome: "deny",
        reason: "User declined the tool call.",
      });
    }
  }

  /**
   * Toggle the per-session auto-allow flag and broadcast the new state so
   * any connected client UI stays in sync.
   */
  setAutoAllowWrites(value: boolean): void {
    if (this.autoAllowWrites === value) return;
    this.autoAllowWrites = value;
    this.emit({ type: "auto_allow_changed", autoAllow: value });
  }

  getAutoAllowWrites(): boolean {
    return this.autoAllowWrites;
  }

  /**
   * @internal
   * Exposed for tests so the gating logic can be exercised without spinning
   * up a full agent + model client.
   */
  invokeToolPermissionGateForTesting(toolCall: {
    name: string;
    input: Record<string, unknown>;
  }): Promise<ToolPermissionDecision> {
    return this.gateToolCall(toolCall);
  }

  // ── File watcher for automatic reindexing ──

  private static readonly WATCH_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
  private static readonly SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
  private static readonly REINDEX_DEBOUNCE_MS = 300;

  /**
   * Start watching the workspace for file changes and reindex automatically.
   * Call after init(). Safe to call if no project index exists (no-ops).
   */
  startFileWatcher(): void {
    if (!this.projectIndex || this.fileWatcher) return;

    const workspaceRoot = this.config.workspaceRoot;

    try {
      this.fileWatcher = watch(workspaceRoot, { recursive: true }, (_event, filename) => {
        if (!filename || !this.projectIndex) return;

        const normalized = filename.replace(/\\/g, "/");

        // Skip ignored directories
        const parts = normalized.split("/");
        if (parts.some((p) => AgentBridge.SKIP_DIRS.has(p) || p.startsWith("."))) return;

        // Skip non-indexable extensions
        const ext = path.extname(normalized).toLowerCase();
        if (!AgentBridge.WATCH_EXTENSIONS.has(ext)) return;

        // Debounce: if same file changes rapidly, only reindex once
        const existing = this.reindexTimers.get(normalized);
        if (existing) clearTimeout(existing);

        this.reindexTimers.set(
          normalized,
          setTimeout(() => {
            this.reindexTimers.delete(normalized);
            void this.reindexChangedFile(normalized);
          }, AgentBridge.REINDEX_DEBOUNCE_MS),
        );
      });
    } catch {
      console.warn(
        "[warn] File watcher could not start (recursive fs.watch may not be supported on this platform).\n" +
        "       File changes will not trigger automatic reindexing. Restart minicode serve to pick up changes.",
      );
    }
  }

  stopFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    for (const timer of this.reindexTimers.values()) {
      clearTimeout(timer);
    }
    this.reindexTimers.clear();
  }

  private async reindexChangedFile(relPath: string): Promise<void> {
    if (!this.projectIndex) return;

    const absPath = path.resolve(this.config.workspaceRoot, relPath);
    try {
      const content = await readFile(absPath, "utf-8");
      await this.projectIndex.reindexFile(relPath, content);
      if (this.verbose) {
        console.error(`[watch] Reindexed: ${relPath}`);
      }
    } catch {
      // File may have been deleted or renamed. A workspace refresh prunes stale symbols.
      await this.refreshIndex();
    }
  }

  isReady(): boolean {
    return this.agent !== undefined;
  }

  isBusy(): boolean {
    return this.busy;
  }

  getConfig(): Awaited<ReturnType<typeof loadAgentConfig>> {
    return this.config;
  }

  isOpenRouterSessionConnected(): boolean {
    return this.sessionProviderConnection === "openrouter";
  }

  isOpenAiCompatibleSessionConnected(): boolean {
    return this.sessionProviderConnection === "openai-compatible";
  }

  connectOpenRouter(apiKey: string): void {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      throw new Error("OpenRouter OAuth exchange did not return an API key.");
    }
    if (this.busy) {
      throw new Error("busy");
    }

    const currentSession = this.agent?.getSession();
    (this.config as {
      modelProvider: "openai-compatible";
      openAiBaseUrl: string;
      openAiApiKey: string;
    }).modelProvider = "openai-compatible";
    (this.config as { openAiBaseUrl: string }).openAiBaseUrl = "https://openrouter.ai/api/v1";
    (this.config as { openAiApiKey: string }).openAiApiKey = trimmedKey;
    this.sessionProviderConnection = "openrouter";

    this.modelClient = createModelClient(this.config);
    this.agent = this.createAgent(currentSession);
  }

  connectOpenAiCompatible(baseUrl: string, apiKey?: string): void {
    const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmedBaseUrl) {
      throw new Error("OpenAI-compatible endpoint is required.");
    }
    if (this.busy) {
      throw new Error("busy");
    }

    const currentSession = this.agent?.getSession();
    (this.config as {
      modelProvider: "openai-compatible";
      openAiBaseUrl: string;
      openAiApiKey?: string;
    }).modelProvider = "openai-compatible";
    (this.config as { openAiBaseUrl: string }).openAiBaseUrl = trimmedBaseUrl;

    const trimmedApiKey = apiKey?.trim() ?? "";
    if (trimmedApiKey) {
      (this.config as { openAiApiKey: string }).openAiApiKey = trimmedApiKey;
    } else {
      delete (this.config as { openAiApiKey?: string }).openAiApiKey;
    }

    this.sessionProviderConnection = "openai-compatible";
    this.modelClient = createModelClient(this.config);
    this.agent = this.createAgent(currentSession);
  }

  disconnectOpenRouter(): boolean {
    if (this.busy) {
      throw new Error("busy");
    }
    if (this.sessionProviderConnection !== "openrouter") {
      return false;
    }

    return this.disconnectSessionProvider();
  }

  disconnectOpenAiCompatible(): boolean {
    if (this.busy) {
      throw new Error("busy");
    }
    if (this.sessionProviderConnection !== "openai-compatible") {
      return false;
    }

    return this.disconnectSessionProvider();
  }

  private disconnectSessionProvider(): boolean {
    const currentSession = this.agent?.getSession();
    AgentBridge.applyConfig(this.config, this.baseConfig);
    this.sessionProviderConnection = null;

    try {
      this.modelClient = createModelClient(this.config);
      this.agent = this.createAgent(currentSession);
    } catch {
      this.modelClient = undefined;
      this.agent = undefined;
    }

    return true;
  }

  private requireAgent(): CodingAgent {
    if (!this.agent) {
      throw new Error("Agent is not configured. Set MODEL and provider settings in ~/.minicode/.env");
    }
    return this.agent;
  }

  getAgent(): CodingAgent {
    return this.requireAgent();
  }

  getCurrentSessionId(): string {
    return this.requireAgent().getSession().id;
  }

  async runTurn(message: string): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> {
    const agent = this.requireAgent();
    if (this.busy) {
      throw new Error("busy");
    }

    this.busy = true;
    this.abortController = new AbortController();

    try {
      this.emit({ type: "turn_start" });
      const result = await agent.runTurn(message, {
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
    const agent = this.requireAgent();
    const annotationsObj = this.annotations.size > 0
      ? Object.fromEntries(this.annotations)
      : undefined;
    return saveSession(agent.getSession(), label, annotationsObj);
  }

  async loadSess(label: string) {
    if (!this.modelClient) {
      throw new Error("Agent is not configured.");
    }
    const result =
      (await loadSessionByLabel(label)) ?? (await loadSession(label));
    if (!result) return null;
    this.agent = this.createAgent(result.session);
    // Restore annotations from saved session
    this.annotations.clear();
    if (result.annotations) {
      for (const [name, notes] of Object.entries(result.annotations)) {
        this.annotations.set(name, notes);
      }
    }
    return result;
  }

  async listSess() {
    return listSessions();
  }

  async deleteSess(sessionId: string) {
    return deleteSession(sessionId);
  }

  // ── Project index queries ──

  hasIndex(): boolean {
    return this.projectIndex !== undefined;
  }

  async refreshIndex(): Promise<boolean> {
    try {
      if (this.projectIndex) {
        await this.projectIndex.refreshFromWorkspace();
      } else {
        this.projectIndex = await buildProjectIndex(this.config.workspaceRoot);
        this.installToolRegistry(this.projectIndex);
        if (this.modelClient) {
          this.agent = this.createAgent(this.agent?.getSession());
        }
      }

      const index = this.projectIndex;
      if (!index) {
        return false;
      }

      const cacheDir = getWorkspaceCacheDir(this.config.workspaceRoot);
      const fileHashes = await computeFileHashes(this.config.workspaceRoot);
      await saveIndex(index, cacheDir, fileHashes);
      this.evictStaleAnnotations();
      return true;
    } catch (error) {
      if (this.verbose) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[index] Refresh failed: ${message}`);
      }
      return false;
    }
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
        name: getSymbolDisplayName(sym),
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

  getSymbolMatches(name: string) {
    if (!this.projectIndex) return [];
    return this.projectIndex.getSymbolMatches(name);
  }

  getDependencies(symbolName: string, depth?: number) {
    if (!this.projectIndex) return undefined;
    const matches = this.projectIndex.getSymbolMatches(symbolName);
    if (matches.length !== 1) return undefined;
    const cone = this.projectIndex.getDependencyCone(matches[0]!.qualifiedName, depth);
    if (cone.length === 0) return undefined;
    return cone.map((sym) => ({
      name: getSymbolDisplayName(sym),
      qualifiedName: sym.qualifiedName,
      kind: sym.kind,
      filePath: sym.filePath,
      signature: sym.signature,
    }));
  }

  getReferences(symbolName: string) {
    if (!this.projectIndex) return undefined;
    const matches = this.projectIndex.getSymbolMatches(symbolName);
    if (matches.length !== 1) return undefined;
    const sym = matches[0]!;
    // Find all edges pointing TO this symbol
    const refs = this.projectIndex.dependencyEdges
      .filter((e) => e.to === sym.qualifiedName || e.to === sym.name)
      .map((e) => {
        const fromSymbol = this.projectIndex!.getSymbol(e.from);
        return {
          from: e.from,
          kind: e.kind,
          ...(fromSymbol ? { name: getSymbolDisplayName(fromSymbol) } : {}),
        };
      });
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
        name: getSymbolDisplayName(sym),
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

  getStructuralAnalysis(): StructuralAnalysisReport | undefined {
    if (!this.projectIndex) return undefined;
    return analyzeProjectStructure(this.projectIndex);
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

  // ── Annotations ──

  getAnnotations(): Record<string, string[]> {
    this.evictStaleAnnotations();
    return Object.fromEntries(this.annotations);
  }

  getAnnotationsForSymbol(name: string): string[] {
    return this.annotations.get(name) ?? [];
  }

  addAnnotation(name: string, text: string): boolean {
    if (!this.projectIndex) return false;
    const sym = this.projectIndex.getSymbol(name);
    if (!sym) return false;
    const trimmed = text.slice(0, 500).trim();
    if (trimmed.length === 0) return false;
    const key = sym.qualifiedName;
    const existing = this.annotations.get(key) ?? [];
    existing.push(trimmed);
    this.annotations.set(key, existing);
    return true;
  }

  removeAnnotation(name: string, index: number): boolean {
    const notes = this.annotations.get(name);
    if (!notes || index < 0 || index >= notes.length) return false;
    notes.splice(index, 1);
    if (notes.length === 0) {
      this.annotations.delete(name);
    }
    return true;
  }

  clearAnnotations(name: string): void {
    this.annotations.delete(name);
  }

  private evictStaleAnnotations(): void {
    if (!this.projectIndex) return;
    for (const name of [...this.annotations.keys()]) {
      if (!this.projectIndex.getSymbol(name)) {
        this.annotations.delete(name);
      }
    }
  }

  private buildAnnotationSuffix(): string | undefined {
    this.evictStaleAnnotations();
    if (this.annotations.size === 0) return undefined;
    return `[Annotated symbols: ${[...this.annotations.keys()].join(", ")}]`;
  }

  private appendAnnotationsToResult(toolName: string, input: unknown, result: string): string {
    if (this.annotations.size === 0) return result;
    const inp = input as Record<string, unknown>;

    if (toolName === "read_symbol" || toolName === "find_references" || toolName === "get_dependencies") {
      const symName = (inp.name ?? inp.symbol ?? inp.query) as string | undefined;
      if (!symName) return result;
      // Try direct match, then resolve via index
      let notes = this.annotations.get(symName);
      if (!notes && this.projectIndex) {
        const sym = this.projectIndex.getSymbol(symName);
        if (sym) notes = this.annotations.get(sym.qualifiedName);
      }
      if (notes && notes.length > 0) {
        return result + `\n[User annotation: ${notes.join("; ")}]`;
      }
    }

    if (toolName === "read_file") {
      const filePath = inp.path as string | undefined;
      if (!filePath) return result;
      const fileAnnotations: string[] = [];
      for (const [name, notes] of this.annotations) {
        if (!this.projectIndex) continue;
        const sym = this.projectIndex.getSymbol(name);
        if (sym && (sym.filePath === filePath || filePath.endsWith(sym.filePath))) {
          fileAnnotations.push(`- ${sym.name}: ${notes.join("; ")}`);
        }
      }
      if (fileAnnotations.length > 0) {
        return result + `\n[User annotations for symbols in this file:]\n${fileAnnotations.join("\n")}`;
      }
    }

    return result;
  }

  // ── Model selection ──

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelClient?.listModels) {
      return sortModelsAlphabetically(await this.modelClient.listModels());
    }
    return [];
  }

  switchModel(modelId: string): void {
    (this.config as { model: string }).model = modelId;
  }

  // ── Explain ──

  async explainSymbol(
    name: string,
    onEvent: (event: UiUpdate) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.projectIndex) throw new Error("No project index");
    if (!this.modelClient) throw new Error("Agent is not configured.");
    const sym = this.projectIndex.getSymbol(name);
    if (!sym) throw new Error(`Symbol "${name}" not found`);

    const explainAgent = this.createAgent(undefined, onEvent);
    const prompt = `Explain "${sym.name}" (${sym.kind} in ${sym.filePath}).
Use read_symbol, get_dependencies, find_references to gather context.
Explain what it does, how it works, what depends on it, and key design decisions.
Be concise but thorough.`;
    const opts = signal ? { signal } : undefined;
    const result = await explainAgent.runTurn(prompt, opts);
    return result.text;
  }

  async explainStructuralFinding(
    findingId: string,
    onEvent: (event: UiUpdate) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const report = this.getStructuralAnalysis();
    if (!report) throw new Error("No project index");
    if (!this.modelClient) throw new Error("Agent is not configured.");

    const finding = report.findings.find((item) => item.id === findingId);
    if (!finding) throw new Error(`Structural finding "${findingId}" not found`);

    const explainAgent = this.createAgent(undefined, onEvent);
    const affectedSymbols = finding.symbols.length > 0
      ? finding.symbols.slice(0, 8).join(", ")
      : "(none)";
    const affectedFiles = finding.files.length > 0
      ? finding.files.slice(0, 6).join(", ")
      : "(none)";
    const rationale = finding.rationale.map((item) => `- ${item}`).join("\n");
    const metrics = Object.entries(finding.metrics)
      .map(([key, value]) => `- ${key}: ${String(value)}`)
      .join("\n");

    const prompt = `Interpret this deterministic structural analysis finding for the current codebase.

Finding type: ${finding.type}
Severity: ${finding.severity}
Title: ${finding.title}
Summary: ${finding.summary}

Affected symbols:
${affectedSymbols}

Affected files:
${affectedFiles}

Deterministic rationale:
${rationale || "- No extra rationale provided."}

Metrics:
${metrics || "- No metrics provided."}

Important constraints:
- This finding came from deterministic graph analysis, not from the model.
- Your job is to interpret the finding, not to replace it.
- Keep the explanation advisory and note where the signal may be noisy or incomplete.
- If useful, inspect a few affected symbols with read_symbol, get_dependencies, and find_references before explaining.

Respond with short sections for:
1. What this likely means
2. Why it may matter
3. Caveats / false-positive risk
4. Potential next steps`;

    const opts = signal ? { signal } : undefined;
    const result = await explainAgent.runTurn(prompt, opts);
    return result.text;
  }
}
