import { initGraph, highlightAgentActivity, resizeGraph } from './graph.ts';
import { escapeHtml, renderMarkdownInto } from './utils.ts';

interface ServerMessage {
  type: string;
  content?: string;
  text?: string;
  message?: string;
  name?: string;
  input?: Record<string, string>;
  result?: string;
  elapsedMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

interface StatusResponse {
  model: string;
  provider: string;
}

interface SessionMeta {
  id: string;
  label: string;
  messageCount: number;
}

interface SessionsResponse {
  sessions: SessionMeta[];
  currentSessionId: string;
}

type SettingsScope = "workspace" | "global";
type SettingsValue = string | number | boolean | null;
type SettingsFieldType = "string" | "number" | "boolean" | "enum";

interface SettingsEntry {
  key: string;
  type: SettingsFieldType;
  description: string;
  envVar: string;
  values?: readonly string[];
  effectiveValue: SettingsValue;
  workspaceValue: SettingsValue;
  globalValue: SettingsValue;
  envValue: string | null;
  overriddenByEnv: boolean;
}

interface SettingsPayload {
  workspaceConfigPath: string;
  globalConfigPath: string;
  entries: SettingsEntry[];
}

interface ConfigResponse {
  config: string;
  settings: SettingsPayload;
  restartRequired: boolean;
  secretsUiSupported: boolean;
}

interface ConfigSaveResponse {
  ok: boolean;
  scope: SettingsScope;
  path: string;
  saved: Array<{ key: string; value: SettingsValue }>;
  restartRequired: boolean;
  message: string;
  settings: SettingsPayload;
}

const messagesEl = document.getElementById("messages")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
const statusBadge = document.getElementById("status-badge")!;
const modelInfo = document.getElementById("model-info")!;
const modelBtn = document.getElementById("model-btn")!;
const modelDropdown = document.getElementById("model-dropdown")!;
const modelList = document.getElementById("model-list")!;
const sessionBtn = document.getElementById("session-btn")!;
const sessionDropdown = document.getElementById("session-dropdown")!;
const sessionList = document.getElementById("session-list")!;
const sessionUpdateRow = document.getElementById("session-update-row")!;
const sessionUpdateBtn = document.getElementById("session-update-btn") as HTMLButtonElement;
const saveBtn = document.getElementById("save-btn")!;
const saveLabelInput = document.getElementById("save-label") as HTMLInputElement;
const contextFill = document.getElementById("context-fill")!;
const contextLabel = document.getElementById("context-label")!;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const settingsModal = document.getElementById("settings-modal")!;
const settingsBackdrop = document.getElementById("settings-backdrop")!;
const settingsCloseBtn = document.getElementById("settings-close") as HTMLButtonElement;
const settingsScopeSelect = document.getElementById("settings-scope") as HTMLSelectElement;
const settingsPath = document.getElementById("settings-path")!;
const settingsList = document.getElementById("settings-list")!;
const settingsBanner = document.getElementById("settings-banner")!;
const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsResetBtn = document.getElementById("settings-reset") as HTMLButtonElement;

let ws: WebSocket;
let currentAssistantEl: HTMLElement | null = null;
let assistantText = "";
let hadToolCalls = false;
let settingsPayload: SettingsPayload | null = null;
let activeSettingsScope: SettingsScope = "workspace";
let activeSavedSession: SessionMeta | null = null;

const TOOL_RESULT_MAX = 500;

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus("ready");
    fetchStatus();
    fetchContext();
  };

  ws.onclose = () => {
    setStatus("error");
    setTimeout(connect, 2000);
  };

  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    handleServerMessage(msg);
  };
}

function setStatus(state: string): void {
  statusBadge.textContent = state;
  statusBadge.className = `badge ${state}`;
}

function setBusy(busy: boolean): void {
  sendBtn.disabled = busy;
  sendBtn.classList.toggle("hidden", busy);
  cancelBtn.classList.toggle("hidden", !busy);
  if (busy) {
    setStatus("busy");
  } else {
    setStatus("ready");
  }
}

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch("/api/status");
    const data = await res.json() as StatusResponse;
    modelInfo.textContent = `${data.model}`;
    activeModel = data.model;
  } catch {
    // ignore
  }
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "turn_start":
      assistantText = "";
      hadToolCalls = false;
      currentAssistantEl = addMessage("", "assistant");
      currentAssistantEl.classList.add("streaming-cursor");
      setBusy(true);
      break;

    case "streaming_chunk":
      if (hadToolCalls) {
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("streaming-cursor");
        }
        assistantText = "";
        hadToolCalls = false;
        currentAssistantEl = addMessage("", "assistant");
        currentAssistantEl.classList.add("streaming-cursor");
      }
      assistantText += msg.content || '';
      if (currentAssistantEl) {
        renderMarkdownInto(currentAssistantEl, assistantText);
        scrollToBottom();
      }
      break;

    case "thinking":
      addMessage(msg.content || '', "thinking");
      break;

    case "step":
      break;

    case "tool_call_start":
      hadToolCalls = true;
      addToolCall(msg.name || '', msg.input || {});
      {
        const symbolTools = ['read_symbol', 'get_dependencies', 'find_references'];
        if (symbolTools.includes(msg.name || '')) {
          const symName = msg.input?.name || msg.input?.symbol || msg.input?.qualifiedName;
          if (symName) highlightAgentActivity(symName);
        }
      }
      break;

    case "tool_call_end":
      finalizeToolCall(msg.name || '', msg.result || '', msg.elapsedMs || 0);
      break;

    case "turn_end":
      if (hadToolCalls && msg.text) {
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("streaming-cursor");
        }
        currentAssistantEl = addMessage(msg.text, "assistant", true);
      } else if (currentAssistantEl) {
        currentAssistantEl.classList.remove("streaming-cursor");
        if (!assistantText && msg.text) {
          renderMarkdownInto(currentAssistantEl, msg.text);
        }
      }
      currentAssistantEl = null;
      assistantText = "";
      hadToolCalls = false;
      setBusy(false);
      if (msg.usage) {
        addUsageInfo(msg.usage);
      }
      break;

    case "error":
      addMessage(`Error: ${msg.message || ''}`, "error");
      if (currentAssistantEl) {
        currentAssistantEl.classList.remove("streaming-cursor");
      }
      currentAssistantEl = null;
      assistantText = "";
      setBusy(false);
      break;

    case "busy":
      addMessage("Agent is busy. Please wait for the current turn to finish.", "error");
      break;

    case "context_status":
      updateContextIndicator(
        (msg as ServerMessage & { contextTokens: number }).contextTokens,
        (msg as ServerMessage & { maxContextTokens: number }).maxContextTokens,
      );
      break;

    case "model_changed":
      modelInfo.textContent = (msg as ServerMessage & { model: string }).model;
      break;
  }
}

function addMessage(text: string, type: string, markdown = false): HTMLElement {
  const el = document.createElement("div");
  el.className = `message ${type}`;
  if (markdown && type === "assistant") {
    renderMarkdownInto(el, text);
  } else {
    el.textContent = text;
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function summarizeToolInput(name: string, input: Record<string, string>): string {
  const key =
    input.path ?? input.file_path ?? input.command ?? input.query ??
    input.pattern ?? input.name ?? input.old_string;

  if (typeof key === "string") {
    return key.length > 60 ? key.slice(0, 57) + "..." : key;
  }

  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? v.slice(0, 57) + "..." : v;
    }
  }
  return "";
}

function getOrCreateToolGroup(): HTMLElement {
  const last = messagesEl.lastElementChild;
  if (last && last.classList.contains("tool-group")) {
    return last as HTMLElement;
  }
  const group = document.createElement("div");
  group.className = "tool-group";
  messagesEl.appendChild(group);
  return group;
}

function addToolCall(name: string, input: Record<string, string>): void {
  const group = getOrCreateToolGroup();

  const el = document.createElement("div");
  el.className = "tool-call";
  el.dataset.toolName = name;

  const summary = summarizeToolInput(name, input);
  const summaryHtml = summary ? ` <span class="tool-arg">${escapeHtml(summary)}</span>` : "";

  el.innerHTML =
    `<span class="tool-header">` +
    `<span class="tool-name">${escapeHtml(name)}</span>${summaryHtml}` +
    `<span class="tool-time"></span>` +
    `</span>` +
    `<div class="tool-result"></div>`;

  el.addEventListener("click", () => el.classList.toggle("expanded"));
  group.appendChild(el);
  scrollToBottom();
}

function finalizeToolCall(name: string, result: string, elapsedMs: number): void {
  const toolEls = messagesEl.querySelectorAll(`.tool-call[data-tool-name="${name}"]`);
  const el = toolEls[toolEls.length - 1] as HTMLElement | undefined;
  if (!el) return;

  const timeEl = el.querySelector(".tool-time");
  if (timeEl) {
    timeEl.textContent = `${elapsedMs}ms`;
  }

  const resultEl = el.querySelector(".tool-result");
  if (resultEl && result) {
    const truncated = result.length > TOOL_RESULT_MAX
      ? result.slice(0, TOOL_RESULT_MAX) + `\n\n... (${result.length - TOOL_RESULT_MAX} more chars)`
      : result;
    resultEl.textContent = truncated;
  }
}

function updateContextIndicator(contextTokens: number, maxContextTokens: number): void {
  const pct = maxContextTokens > 0 ? Math.min(100, Math.round((contextTokens / maxContextTokens) * 100)) : 0;
  contextFill.style.width = pct + "%";
  contextFill.classList.remove("warn", "critical");
  if (pct >= 80) {
    contextFill.classList.add("critical");
  } else if (pct >= 60) {
    contextFill.classList.add("warn");
  }
  contextLabel.textContent = pct + "%";
  const indicator = document.getElementById("context-indicator")!;
  indicator.title = `Context: ~${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens (${pct}%)`;
}

async function fetchContext(): Promise<void> {
  try {
    const res = await fetch("/api/context");
    const data = await res.json() as { contextTokens: number; maxContextTokens: number };
    updateContextIndicator(data.contextTokens, data.maxContextTokens);
  } catch {
    // ignore
  }
}

function addUsageInfo(usage: { inputTokens: number; outputTokens: number }): void {
  const el = document.createElement("div");
  el.className = "usage-info";
  el.textContent = `${usage.inputTokens} in / ${usage.outputTokens} out`;
  messagesEl.appendChild(el);
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function closeHeaderMenus(): void {
  modelDropdown.classList.add("hidden");
  sessionDropdown.classList.add("hidden");
}

function isSettingsModalOpen(): boolean {
  return !settingsModal.classList.contains("hidden");
}

function getScopeValue(entry: SettingsEntry, scope: SettingsScope): SettingsValue {
  return scope === "workspace" ? entry.workspaceValue : entry.globalValue;
}

function getScopePath(settings: SettingsPayload, scope: SettingsScope): string {
  return scope === "workspace" ? settings.workspaceConfigPath : settings.globalConfigPath;
}

function formatSettingsValue(value: SettingsValue): string {
  return value === null ? "(unset)" : String(value);
}

function setSettingsBanner(message: string, tone: "info" | "success" | "error"): void {
  settingsBanner.textContent = message;
  settingsBanner.className = `settings-banner ${tone}`;
}

function clearSettingsBanner(): void {
  settingsBanner.textContent = "";
  settingsBanner.className = "settings-banner hidden";
}

function createSettingsControl(entry: SettingsEntry, inputId: string): HTMLElement {
  const value = getScopeValue(entry, activeSettingsScope);

  if (entry.type === "boolean") {
    const select = document.createElement("select");
    select.id = inputId;
    select.className = "settings-select";
    select.dataset.settingKey = entry.key;
    select.innerHTML = `
      <option value="">Use default</option>
      <option value="true">True</option>
      <option value="false">False</option>
    `;
    select.value = value === null ? "" : String(value);
    return select;
  }

  if (entry.type === "enum") {
    const select = document.createElement("select");
    select.id = inputId;
    select.className = "settings-select";
    select.dataset.settingKey = entry.key;

    const unsetOption = document.createElement("option");
    unsetOption.value = "";
    unsetOption.textContent = "Use default";
    select.appendChild(unsetOption);

    for (const optionValue of entry.values ?? []) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      select.appendChild(option);
    }

    select.value = value === null ? "" : String(value);
    return select;
  }

  const input = document.createElement("input");
  input.id = inputId;
  input.className = "settings-control";
  input.dataset.settingKey = entry.key;
  input.type = entry.type === "number" ? "number" : "text";
  if (entry.type === "number") {
    input.step = "any";
    input.inputMode = "numeric";
  }
  input.placeholder = "Use default";
  input.value = value === null ? "" : String(value);
  return input;
}

function renderSettings(): void {
  if (!settingsPayload) {
    return;
  }

  settingsScopeSelect.value = activeSettingsScope;
  settingsPath.textContent = getScopePath(settingsPayload, activeSettingsScope);
  settingsList.innerHTML = "";

  for (const entry of settingsPayload.entries) {
    const item = document.createElement("section");
    item.className = "settings-item";

    const header = document.createElement("div");
    header.className = "settings-item-header";

    const heading = document.createElement("div");
    const title = document.createElement("div");
    title.className = "settings-item-title";
    title.textContent = entry.key;
    const description = document.createElement("div");
    description.className = "settings-item-description";
    description.textContent = entry.description;
    heading.append(title, description);

    const badges = document.createElement("div");
    badges.className = "settings-item-badges";
    const envBadge = document.createElement("span");
    envBadge.className = "settings-badge env";
    envBadge.textContent = `Env: ${entry.envVar}`;
    badges.appendChild(envBadge);

    if (entry.overriddenByEnv) {
      const overrideBadge = document.createElement("span");
      overrideBadge.className = "settings-badge override";
      overrideBadge.textContent = "Env override active";
      badges.appendChild(overrideBadge);
    }

    header.append(heading, badges);

    const meta = document.createElement("div");
    meta.className = "settings-item-meta";
    meta.innerHTML = `
      <div class="settings-meta-block">
        <span class="settings-meta-label">Effective</span>
        <div class="settings-meta-value">${escapeHtml(formatSettingsValue(entry.effectiveValue))}</div>
      </div>
      <div class="settings-meta-block">
        <span class="settings-meta-label">Workspace</span>
        <div class="settings-meta-value">${escapeHtml(formatSettingsValue(entry.workspaceValue))}</div>
      </div>
      <div class="settings-meta-block">
        <span class="settings-meta-label">Global</span>
        <div class="settings-meta-value">${escapeHtml(formatSettingsValue(entry.globalValue))}</div>
      </div>
    `;

    const controls = document.createElement("div");
    controls.className = "settings-item-controls";
    const inputId = `setting-${entry.key}`;
    const label = document.createElement("label");
    label.className = "settings-help";
    label.htmlFor = inputId;
    label.textContent = activeSettingsScope === "workspace"
      ? "Saved in this workspace"
      : "Saved in your global minicode config";
    const control = createSettingsControl(entry, inputId);
    controls.append(label, control);

    if (entry.overriddenByEnv) {
      const overrideHelp = document.createElement("div");
      overrideHelp.className = "settings-help";
      overrideHelp.textContent = `${entry.envVar} currently overrides this setting with ${formatSettingsValue(entry.envValue)}. Saving here updates the persisted default underneath that env value.`;
      controls.appendChild(overrideHelp);
    }

    item.append(header, meta, controls);
    settingsList.appendChild(item);
  }

  updateSettingsActions();
}

async function loadSettings(): Promise<void> {
  settingsList.innerHTML = '<div class="dropdown-empty">Loading settings...</div>';
  settingsSaveBtn.disabled = true;
  settingsResetBtn.disabled = true;
  settingsSaveBtn.textContent = "Save settings";
  clearSettingsBanner();

  try {
    const res = await fetch("/api/config");
    if (!res.ok) {
      throw new Error(`Failed to load settings (${res.status})`);
    }
    const data = await res.json() as ConfigResponse;
    settingsPayload = data.settings;
    renderSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load settings";
    settingsList.innerHTML = '<div class="dropdown-empty">Failed to load settings</div>';
    setSettingsBanner(message, "error");
  }
}

function readSettingsControlValue(entry: SettingsEntry): SettingsValue {
  const control = settingsList.querySelector<HTMLElement>(`[data-setting-key="${entry.key}"]`);
  if (!control) {
    throw new Error(`Missing control for ${entry.key}`);
  }

  if (entry.type === "boolean" || entry.type === "enum") {
    const value = (control as HTMLSelectElement).value.trim();
    return value === "" ? null : entry.type === "boolean" ? value === "true" : value;
  }

  const rawValue = (control as HTMLInputElement).value.trim();
  if (rawValue === "") {
    return null;
  }

  if (entry.type === "number") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Expected a number for "${entry.key}".`);
    }
    return parsed;
  }

  return rawValue;
}

function collectSettingsUpdates(): Record<string, SettingsValue> {
  if (!settingsPayload) {
    return {};
  }

  const updates: Record<string, SettingsValue> = {};
  for (const entry of settingsPayload.entries) {
    const nextValue = readSettingsControlValue(entry);
    const baseline = getScopeValue(entry, activeSettingsScope);
    if (nextValue !== baseline) {
      updates[entry.key] = nextValue;
    }
  }
  return updates;
}

function updateSettingsActions(): void {
  if (!settingsPayload) {
    settingsSaveBtn.disabled = true;
    settingsResetBtn.disabled = true;
    settingsSaveBtn.textContent = "Save settings";
    return;
  }

  try {
    const changeCount = Object.keys(collectSettingsUpdates()).length;
    settingsSaveBtn.disabled = changeCount === 0;
    settingsResetBtn.disabled = changeCount === 0;
    settingsSaveBtn.textContent = changeCount === 0
      ? "Save settings"
      : `Save ${changeCount} change${changeCount === 1 ? "" : "s"}`;
  } catch {
    settingsSaveBtn.disabled = true;
    settingsResetBtn.disabled = false;
    settingsSaveBtn.textContent = "Save settings";
  }
}

function openSettings(): void {
  closeHeaderMenus();
  settingsModal.classList.remove("hidden");
  settingsModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  void loadSettings();
}

function closeSettings(): void {
  settingsModal.classList.add("hidden");
  settingsModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  clearSettingsBanner();
}

// Form handling
chatForm.addEventListener("submit", (e: Event) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  addMessage(message, "user");
  ws.send(JSON.stringify({ type: "chat", message }));
  chatInput.value = "";
  chatInput.style.height = "auto";
});

cancelBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "cancel" }));
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
});

chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

// -- Model selection --

let activeModel = "";

modelBtn.addEventListener("click", (e: Event) => {
  e.stopPropagation();
  const isOpen = !modelDropdown.classList.contains("hidden");
  modelDropdown.classList.toggle("hidden");
  sessionDropdown.classList.add("hidden");
  if (!isOpen) {
    refreshModelList();
  }
});

document.addEventListener("click", (e: Event) => {
  if (!modelDropdown.contains(e.target as Node) && e.target !== modelBtn) {
    modelDropdown.classList.add("hidden");
  }
});

async function refreshModelList(): Promise<void> {
  try {
    const res = await fetch("/api/models");
    const data = await res.json() as { models: Array<{ id: string; name?: string }>; activeModel: string };
    activeModel = data.activeModel;

    if (!data.models || data.models.length === 0) {
      modelList.innerHTML = '<div class="dropdown-empty">No models available</div>';
      return;
    }

    modelList.innerHTML = "";
    for (const m of data.models) {
      const el = document.createElement("div");
      el.className = "model-item" + (m.id === activeModel ? " active" : "");
      el.textContent = m.name ?? m.id;
      el.title = m.id;
      el.addEventListener("click", () => switchModel(m.id));
      modelList.appendChild(el);
    }
  } catch {
    modelList.innerHTML = '<div class="dropdown-empty">Failed to load models</div>';
  }
}

function switchModel(modelId: string): void {
  ws.send(JSON.stringify({ type: "switch_model", model: modelId }));
  modelInfo.textContent = modelId;
  activeModel = modelId;
  modelDropdown.classList.add("hidden");
  addMessage(`Model switched to: ${modelId}`, "thinking");
}

// -- Session management --

sessionBtn.addEventListener("click", (e: Event) => {
  e.stopPropagation();
  const isOpen = !sessionDropdown.classList.contains("hidden");
  sessionDropdown.classList.toggle("hidden");
  modelDropdown.classList.add("hidden");
  if (!isOpen) {
    refreshSessionList();
  }
});

document.addEventListener("click", (e: Event) => {
  if (!sessionDropdown.contains(e.target as Node) && e.target !== sessionBtn) {
    sessionDropdown.classList.add("hidden");
  }
});

saveBtn.addEventListener("click", async () => {
  const requestedLabel = saveLabelInput.value.trim();
  const label = requestedLabel || activeSavedSession?.label || undefined;
  const isUpdatingCurrentSession =
    !!activeSavedSession && (requestedLabel.length === 0 || requestedLabel === activeSavedSession.label);
  try {
    const res = await fetch("/api/sessions/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (res.ok) {
      const data = await res.json() as SessionMeta;
      saveLabelInput.value = "";
      addMessage(
        `${isUpdatingCurrentSession ? "Session updated" : "Session saved"}: "${data.label}"`,
        "thinking",
      );
      void refreshSessionList();
    }
  } catch {
    // ignore
  }
});

saveLabelInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    (saveBtn as HTMLButtonElement).click();
  }
});

async function refreshSessionList(): Promise<void> {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json() as SessionsResponse;
    const sessions = data.sessions;
    activeSavedSession =
      sessions.find((session) => session.id === data.currentSessionId) ?? null;

    if (activeSavedSession) {
      sessionUpdateRow.classList.remove("hidden");
      sessionUpdateBtn.textContent = `Update "${activeSavedSession.label}"`;
      sessionUpdateBtn.title = `Save changes back to "${activeSavedSession.label}"`;
    } else {
      sessionUpdateRow.classList.add("hidden");
      sessionUpdateBtn.textContent = "Update current saved session";
      sessionUpdateBtn.title = "";
    }

    if (!sessions || sessions.length === 0) {
      sessionList.innerHTML = '<div class="dropdown-empty">No saved sessions</div>';
      return;
    }

    sessionList.innerHTML = "";
    for (const s of sessions) {
      const el = document.createElement("div");
      const isActive = activeSavedSession?.id === s.id;
      el.className = "session-item" + (isActive ? " active" : "");
      el.innerHTML =
        `<span class="session-label">${escapeHtml(s.label)}</span>` +
        `<span class="session-meta">${s.messageCount} msgs${isActive ? ' <span class="session-active-badge">• active</span>' : ""}</span>`;
      el.addEventListener("click", () => loadSession(s.label));
      sessionList.appendChild(el);
    }
  } catch {
    activeSavedSession = null;
    sessionUpdateRow.classList.add("hidden");
    sessionList.innerHTML = '<div class="dropdown-empty">Failed to load sessions</div>';
  }
}

async function loadSession(label: string): Promise<void> {
  try {
    const res = await fetch("/api/sessions/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (res.ok) {
      sessionDropdown.classList.add("hidden");
      messagesEl.innerHTML = "";
      addMessage(`Session "${label}" restored`, "thinking");
      void refreshSessionList();
    }
  } catch {
    // ignore
  }
}

sessionUpdateBtn.addEventListener("click", async () => {
  if (!activeSavedSession) {
    return;
  }

  try {
    sessionUpdateBtn.disabled = true;
    const res = await fetch("/api/sessions/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: activeSavedSession.label }),
    });
    if (res.ok) {
      const data = await res.json() as SessionMeta;
      addMessage(`Session updated: "${data.label}"`, "thinking");
      await refreshSessionList();
    }
  } catch {
    // ignore
  } finally {
    sessionUpdateBtn.disabled = false;
  }
});

// -- Settings modal --

settingsBtn.addEventListener("click", () => {
  openSettings();
});

settingsCloseBtn.addEventListener("click", () => {
  closeSettings();
});

settingsBackdrop.addEventListener("click", () => {
  closeSettings();
});

settingsScopeSelect.addEventListener("change", () => {
  activeSettingsScope = settingsScopeSelect.value === "global" ? "global" : "workspace";
  clearSettingsBanner();
  renderSettings();
});

settingsResetBtn.addEventListener("click", () => {
  clearSettingsBanner();
  renderSettings();
});

settingsSaveBtn.addEventListener("click", async () => {
  if (!settingsPayload) {
    return;
  }

  let updates: Record<string, SettingsValue>;
  try {
    updates = collectSettingsUpdates();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read settings";
    setSettingsBanner(message, "error");
    return;
  }

  if (Object.keys(updates).length === 0) {
    setSettingsBanner("No changes to save for this scope.", "info");
    return;
  }

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving...";

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: activeSettingsScope,
        updates,
      }),
    });
    const body = await res.json() as ConfigSaveResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to save settings (${res.status})`);
    }

    settingsPayload = body.settings;
    renderSettings();
    setSettingsBanner(body.message, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save settings";
    setSettingsBanner(message, "error");
    updateSettingsActions();
  }
});

settingsList.addEventListener("input", () => {
  clearSettingsBanner();
  updateSettingsActions();
});

settingsList.addEventListener("change", () => {
  clearSettingsBanner();
  updateSettingsActions();
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && isSettingsModalOpen()) {
    closeSettings();
  }
});

// -- Resizable pane divider --

const chatPane = document.getElementById('chat-pane')!;
const divider = document.getElementById('pane-divider')!;

divider.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault();
  divider.classList.add('dragging');
  const startX = e.clientX;
  const startWidth = chatPane.offsetWidth;

  function onMove(ev: MouseEvent): void {
    const newWidth = startWidth + (ev.clientX - startX);
    const clamped = Math.max(280, Math.min(newWidth, window.innerWidth - 300));
    chatPane.style.width = clamped + 'px';
  }

  function onUp(): void {
    divider.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    resizeGraph();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// -- Graph toggle --

const workspace = document.getElementById('workspace')!;
const graphToggle = document.getElementById('graph-toggle')!;

graphToggle.classList.add('active');

graphToggle.addEventListener('click', () => {
  const isChatOnly = workspace.classList.toggle('chat-only');
  graphToggle.classList.toggle('active', !isChatOnly);
  if (!isChatOnly) {
    // Restore inline width so the 33% CSS rule applies again
    chatPane.style.width = '';
    resizeGraph();
  }
});

// -- Init --

connect();
initGraph();
