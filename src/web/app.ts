import { initGraph, highlightAgentActivity, resizeGraph } from './graph.ts';
import { createLatestRequestTracker } from './request-tracker.ts';
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
  baseUrl?: string;
  sessionOpenRouterConnected?: boolean;
  needsSetup?: boolean;
  missing?: string[];
}

interface SessionMeta {
  id: string;
  label: string;
  messageCount: number;
}

interface SessionPreviewToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface SessionPreviewUserMessage {
  role: "user";
  content: string;
}

interface SessionPreviewAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: SessionPreviewToolCall[];
}

interface SessionPreviewToolMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
}

type SessionPreviewMessage =
  | SessionPreviewUserMessage
  | SessionPreviewAssistantMessage
  | SessionPreviewToolMessage;

interface LoadSessionResponse {
  label: string;
  messages: SessionPreviewMessage[];
}

interface SessionsResponse {
  sessions: SessionMeta[];
  currentSessionId: string;
}

type SettingsValue = string | number | boolean | null;
type SettingsFieldType = "string" | "number" | "boolean" | "enum";

interface SettingsEntry {
  key: string;
  type: SettingsFieldType;
  description: string;
  envVar: string;
  values?: readonly string[];
  effectiveValue: SettingsValue;
  persistedValue: SettingsValue;
  envValue: string | null;
  envSource: "process" | "home-dotenv" | null;
  envSourcePath: string | null;
  overriddenByEnv: boolean;
}

interface SettingsPayload {
  configPath: string;
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
  scope: "global";
  path: string;
  saved: Array<{ key: string; value: SettingsValue }>;
  restartRequired: boolean;
  message: string;
  settings: SettingsPayload;
}

interface OpenRouterConnectResponse {
  ok: boolean;
  sessionOnly: boolean;
  baseUrl: string;
  provider: string;
  model: string;
  needsSetup: boolean;
  missing: string[];
  message: string;
}

interface OpenRouterDisconnectResponse {
  ok: boolean;
  disconnected: boolean;
  sessionOnly: boolean;
  baseUrl: string;
  provider: string;
  model: string;
  needsSetup: boolean;
  missing: string[];
  message: string;
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
const settingsPath = document.getElementById("settings-path")!;
const settingsList = document.getElementById("settings-list")!;
const settingsBanner = document.getElementById("settings-banner")!;
const settingsOpenRouterSession = document.getElementById("settings-openrouter-session")!;
const settingsOpenRouterSessionMeta = document.getElementById("settings-openrouter-session-meta")!;
const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsResetBtn = document.getElementById("settings-reset") as HTMLButtonElement;
const disconnectOpenRouterBtn = document.getElementById("disconnect-openrouter-btn") as HTMLButtonElement;
const connectOpenRouterBtn = document.getElementById("connect-openrouter-btn") as HTMLButtonElement | null;
const configConnectStatus = document.getElementById("config-connect-status");

let ws: WebSocket;
let currentAssistantEl: HTMLElement | null = null;
let assistantText = "";
let hadToolCalls = false;
let settingsPayload: SettingsPayload | null = null;
let activeSavedSession: SessionMeta | null = null;
let activeBaseUrl = "";
let sessionOpenRouterConnected = false;
const sessionRefreshTracker = createLatestRequestTracker();

const TOOL_RESULT_MAX = 500;
const OPENROUTER_PKCE_VERIFIER_KEY = "minicode:openrouter:pkce-verifier";

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

const configOverlay = document.getElementById("config-overlay")!;

function setConfigConnectStatus(message: string, tone: "info" | "success" | "error"): void {
  if (!configConnectStatus) {
    return;
  }
  configConnectStatus.textContent = message;
  configConnectStatus.className = `config-connect-status ${tone}`;
}

function clearConfigConnectStatus(): void {
  if (!configConnectStatus) {
    return;
  }
  configConnectStatus.textContent = "";
  configConnectStatus.className = "config-connect-status hidden";
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return encodeBase64Url(new Uint8Array(digest));
}

async function startOpenRouterConnect(): Promise<void> {
  const verifier = createPkceVerifier();
  const challenge = await createPkceChallenge(verifier);
  sessionStorage.setItem(OPENROUTER_PKCE_VERIFIER_KEY, verifier);
  setConfigConnectStatus("Redirecting to OpenRouter…", "info");

  const callbackUrl = new URL(location.pathname, location.origin).toString();
  const authUrl = new URL("https://openrouter.ai/auth");
  authUrl.searchParams.set("callback_url", callbackUrl);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  location.assign(authUrl.toString());
}

async function maybeHandleOpenRouterCallback(): Promise<void> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  if (!code) {
    return;
  }

  const cleanedUrl = `${url.pathname}${url.hash}`;
  history.replaceState({}, document.title, cleanedUrl);

  const codeVerifier = sessionStorage.getItem(OPENROUTER_PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OPENROUTER_PKCE_VERIFIER_KEY);

  if (!codeVerifier) {
    setConfigConnectStatus(
      "OpenRouter sign-in could not be completed because the local PKCE verifier was missing. Start the connect flow again.",
      "error",
    );
    return;
  }

  if (connectOpenRouterBtn) {
    connectOpenRouterBtn.disabled = true;
  }
  setConfigConnectStatus("Connecting OpenRouter to this serve session…", "info");

  try {
    const res = await fetch("/api/openrouter/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });
    const body = await res.json() as OpenRouterConnectResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to connect OpenRouter (${res.status})`);
    }

    activeBaseUrl = body.baseUrl;
    addMessage(body.message, "thinking");
    setConfigConnectStatus(body.message, body.needsSetup ? "info" : "success");
    await fetchStatus();
    await refreshModelList();

    const onlyModelMissing =
      body.needsSetup &&
      body.missing.length === 1 &&
      body.missing[0]?.includes("MODEL");
    if (onlyModelMissing) {
      modelDropdown.classList.remove("hidden");
      sessionDropdown.classList.add("hidden");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to connect OpenRouter";
    setConfigConnectStatus(message, "error");
  } finally {
    if (connectOpenRouterBtn) {
      connectOpenRouterBtn.disabled = false;
    }
  }
}

async function disconnectOpenRouter(): Promise<void> {
  disconnectOpenRouterBtn.disabled = true;
  clearSettingsBanner();

  try {
    const res = await fetch("/api/openrouter/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = await res.json() as OpenRouterDisconnectResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to disconnect OpenRouter (${res.status})`);
    }

    activeBaseUrl = body.baseUrl;
    addMessage(body.message, "thinking");
    setSettingsBanner(body.message, body.disconnected ? "success" : "info");
    clearConfigConnectStatus();
    await fetchStatus();
    await refreshModelList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to disconnect OpenRouter";
    setSettingsBanner(message, "error");
  } finally {
    disconnectOpenRouterBtn.disabled = false;
  }
}

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch("/api/status");
    const data = await res.json() as StatusResponse;
    modelInfo.textContent = data.model || "Select model";
    modelInfo.classList.toggle("placeholder", !data.model);
    activeModel = data.model;
    activeBaseUrl = data.baseUrl ?? "";
    sessionOpenRouterConnected = data.sessionOpenRouterConnected ?? false;
    renderOpenRouterSessionControls();

    if (data.needsSetup) {
      configOverlay.classList.remove("hidden");
      chatInput.disabled = true;
      sendBtn.disabled = true;
      // Show specific missing items
      const missingEl = document.getElementById("config-missing");
      if (missingEl && data.missing && data.missing.length > 0) {
        const isOnlyModelMissing = data.missing.length === 1 && data.missing[0]!.includes("MODEL");
        const hint = isOnlyModelMissing
          ? ` — select one from the <strong>model dropdown</strong> above, or set it in config`
          : "";
        missingEl.innerHTML = `<strong>Missing:</strong> ${data.missing.map(escapeHtml).join(", ")}${hint}`;
        missingEl.classList.remove("hidden");
      }
    } else {
      configOverlay.classList.add("hidden");
      chatInput.disabled = false;
      sendBtn.disabled = false;
      const missingEl = document.getElementById("config-missing");
      if (missingEl) {
        missingEl.classList.add("hidden");
        missingEl.innerHTML = "";
      }
    }
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

    case "model_changed": {
      const changedModel = (msg as ServerMessage & { model: string }).model;
      modelInfo.textContent = changedModel || "Select model";
      modelInfo.classList.toggle("placeholder", !changedModel);
      activeModel = changedModel;
      // Re-check setup status — model selection may dismiss the config overlay
      void fetchStatus();
      break;
    }
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

function clearChatTranscript(): void {
  messagesEl.innerHTML = "";
  currentAssistantEl = null;
  assistantText = "";
  hadToolCalls = false;
}

function stringifyToolInput(input: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(input).flatMap(([key, value]) => {
    if (value === undefined || value === null) {
      return [];
    }

    if (typeof value === "string") {
      return [[key, value] as const];
    }

    return [[key, JSON.stringify(value)] as const];
  });

  return Object.fromEntries(entries);
}

function addToolResultPreview(name: string, result: string): void {
  const toolEls = messagesEl.querySelectorAll(`.tool-call[data-tool-name="${name}"]`);
  if (toolEls.length === 0) {
    addToolCall(name, {});
  }
  finalizeToolCall(name, result);
}

function renderLoadedSessionMessages(messages: SessionPreviewMessage[]): void {
  clearChatTranscript();

  for (const message of messages) {
    if (message.role === "user") {
      addMessage(message.content, "user");
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.trim().length > 0) {
        addMessage(message.content, "assistant", true);
      }

      for (const toolCall of message.toolCalls ?? []) {
        addToolCall(toolCall.name, stringifyToolInput(toolCall.input));
      }
      continue;
    }

    addToolResultPreview(message.toolName, message.content);
  }
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

function finalizeToolCall(name: string, result: string, elapsedMs?: number): void {
  const toolEls = messagesEl.querySelectorAll(`.tool-call[data-tool-name="${name}"]`);
  const el = toolEls[toolEls.length - 1] as HTMLElement | undefined;
  if (!el) return;

  const timeEl = el.querySelector(".tool-time");
  if (timeEl) {
    timeEl.textContent = elapsedMs && elapsedMs > 0 ? `${elapsedMs}ms` : "";
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

function renderOpenRouterSessionControls(): void {
  if (sessionOpenRouterConnected) {
    settingsOpenRouterSession.classList.remove("hidden");
    settingsOpenRouterSessionMeta.textContent = activeBaseUrl
      ? `Endpoint: ${activeBaseUrl}. This session-only connection overrides your original provider settings until you disconnect or restart serve.`
      : "This session-only connection overrides your original provider settings until you disconnect or restart serve.";
    disconnectOpenRouterBtn.disabled = false;
    return;
  }

  settingsOpenRouterSession.classList.add("hidden");
  settingsOpenRouterSessionMeta.textContent = "";
  disconnectOpenRouterBtn.disabled = false;
}

function createSettingsControl(entry: SettingsEntry, inputId: string): HTMLElement {
  const value = entry.persistedValue;

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
    select.disabled = entry.overriddenByEnv;
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
    select.disabled = entry.overriddenByEnv;
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
  input.disabled = entry.overriddenByEnv;
  return input;
}

function renderSettings(): void {
  if (!settingsPayload) {
    return;
  }

  settingsPath.textContent = settingsPayload.configPath;
  settingsList.innerHTML = "";

  for (const entry of settingsPayload.entries) {
    const item = document.createElement("section");
    item.className = "settings-item";
    if (entry.overriddenByEnv) {
      item.classList.add("is-disabled");
    }

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
        <span class="settings-meta-label">Saved</span>
        <div class="settings-meta-value">${escapeHtml(formatSettingsValue(entry.persistedValue))}</div>
      </div>
    `;

    const controls = document.createElement("div");
    controls.className = "settings-item-controls";
    const inputId = `setting-${entry.key}`;
    const label = document.createElement("label");
    label.className = "settings-help";
    label.htmlFor = inputId;
    label.textContent = "Saved in your global minicode config";
    const control = createSettingsControl(entry, inputId);
    controls.append(label, control);

    if (entry.overriddenByEnv) {
      const overrideHelp = document.createElement("div");
      overrideHelp.className = "settings-help settings-help-warning";
      overrideHelp.textContent = entry.envSource === "home-dotenv" && entry.envSourcePath
        ? `Defined by ${entry.envVar} in ${entry.envSourcePath}. Update or remove that env var there to manage this setting here.`
        : `${entry.envVar} is currently defined by the running environment. Remove or update that env var to manage this setting here.`;
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
    const baseline = entry.persistedValue;
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
  modelInfo.textContent = modelId || "Select model";
  modelInfo.classList.toggle("placeholder", !modelId);
  activeModel = modelId;
  modelDropdown.classList.add("hidden");
  addMessage(`Model switched to: ${modelId}`, "thinking");
  // Re-check setup status so the overlay dismisses if model was the missing piece
  void fetchStatus();
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
    saveBtn.setAttribute("disabled", "true");
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
      await refreshSessionList();
    }
  } catch {
    // ignore
  } finally {
    saveBtn.removeAttribute("disabled");
  }
});

saveLabelInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    (saveBtn as HTMLButtonElement).click();
  }
});

async function refreshSessionList(): Promise<void> {
  const requestToken = sessionRefreshTracker.begin();
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json() as SessionsResponse;
    if (!sessionRefreshTracker.isCurrent(requestToken)) {
      return;
    }
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
    if (!sessionRefreshTracker.isCurrent(requestToken)) {
      return;
    }
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
      const body = await res.json() as LoadSessionResponse;
      sessionDropdown.classList.add("hidden");
      renderLoadedSessionMessages(body.messages);
      if (body.messages.length === 0) {
        addMessage(`Session "${body.label}" restored`, "thinking");
      }
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

settingsResetBtn.addEventListener("click", () => {
  clearSettingsBanner();
  renderSettings();
  renderOpenRouterSessionControls();
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
    setSettingsBanner("No changes to save.", "info");
    return;
  }

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving...";

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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

disconnectOpenRouterBtn.addEventListener("click", () => {
  void disconnectOpenRouter();
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && isSettingsModalOpen()) {
    closeSettings();
  }
});

connectOpenRouterBtn?.addEventListener("click", () => {
  void startOpenRouterConnect();
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
void maybeHandleOpenRouterCallback();
