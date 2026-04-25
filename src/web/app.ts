import { initGraph, highlightAgentActivity, resizeGraph, scheduleGraphDataRefresh } from './graph.ts';
import { closeModal, openModal } from './modal-state.ts';
import { filterModelsByQuery, getModelDisplayName } from '../model-utils.ts';
import { createLatestRequestTracker } from './request-tracker.ts';
import { DEFAULT_SETUP_INTRO, deriveSetupOverlayState } from './setup-overlay-state.ts';
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
  configuredProvider?: "anthropic" | "openrouter" | "openai-compatible" | null;
  sessionOpenRouterConnected?: boolean;
  sessionOpenAiCompatibleConnected?: boolean;
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

interface DeleteSessionResponse {
  ok: boolean;
  deleted: boolean;
  id: string;
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
  persistedToEnv: boolean;
  persistedEnvPath: string | null;
  persistWarning: string | null;
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

type OpenAiCompatibleConnectResponse = OpenRouterConnectResponse;

type OpenAiCompatibleDisconnectResponse = OpenRouterDisconnectResponse;

interface ModelSwitchResponse {
  model: string;
  persistedToEnv?: boolean;
  persistedEnvPath?: string | null;
  message?: string;
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
const modelSearchInput = document.getElementById("model-search") as HTMLInputElement;
const modelList = document.getElementById("model-list")!;
const sessionBtn = document.getElementById("session-btn")!;
const sessionDropdown = document.getElementById("session-dropdown")!;
const sessionList = document.getElementById("session-list")!;
const sessionUpdateRow = document.getElementById("session-update-row")!;
const sessionUpdateBtn = document.getElementById("session-update-btn") as HTMLButtonElement;
const sessionAutoSaveToggle = document.getElementById("session-autosave-toggle") as HTMLInputElement;
const saveBtn = document.getElementById("save-btn")!;
const saveLabelInput = document.getElementById("save-label") as HTMLInputElement;
const contextFill = document.getElementById("context-fill")!;
const contextLabel = document.getElementById("context-label")!;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const settingsModal = document.getElementById("settings-modal")!;
const settingsBackdrop = document.getElementById("settings-backdrop")!;
const settingsCloseBtn = document.getElementById("settings-close") as HTMLButtonElement;
const openRouterConnectModal = document.getElementById("openrouter-connect-modal")!;
const openRouterConnectBackdrop = document.getElementById("openrouter-connect-backdrop")!;
const openRouterConnectCloseBtn = document.getElementById("openrouter-connect-close") as HTMLButtonElement;
const openRouterConnectCancelBtn = document.getElementById("openrouter-connect-cancel") as HTMLButtonElement;
const openRouterConnectContinueBtn = document.getElementById("openrouter-connect-continue") as HTMLButtonElement;
const openRouterPersistCheckbox = document.getElementById("openrouter-persist-checkbox") as HTMLInputElement;
const openAiCompatibleConnectModal = document.getElementById("openai-compatible-connect-modal")!;
const openAiCompatibleConnectBackdrop = document.getElementById("openai-compatible-connect-backdrop")!;
const openAiCompatibleConnectCloseBtn = document.getElementById("openai-compatible-connect-close") as HTMLButtonElement;
const openAiCompatibleConnectCancelBtn = document.getElementById("openai-compatible-connect-cancel") as HTMLButtonElement;
const openAiCompatibleConnectContinueBtn = document.getElementById("openai-compatible-connect-continue") as HTMLButtonElement;
const openAiCompatiblePresetSelect = document.getElementById("openai-compatible-preset") as HTMLSelectElement;
const openAiCompatiblePresetHelp = document.getElementById("openai-compatible-preset-help")!;
const openAiCompatibleBaseUrlInput = document.getElementById("openai-compatible-base-url") as HTMLInputElement;
const openAiCompatibleApiKeyInput = document.getElementById("openai-compatible-api-key") as HTMLInputElement;
const openAiCompatiblePersistCheckbox = document.getElementById("openai-compatible-persist-checkbox") as HTMLInputElement;
const openAiCompatibleConnectStatus = document.getElementById("openai-compatible-connect-status")!;
const settingsPath = document.getElementById("settings-path")!;
const settingsList = document.getElementById("settings-list")!;
const settingsBanner = document.getElementById("settings-banner")!;
const settingsOpenRouterSession = document.getElementById("settings-openrouter-session")!;
const settingsOpenRouterSessionMeta = document.getElementById("settings-openrouter-session-meta")!;
const settingsOpenAiCompatibleSession = document.getElementById("settings-openai-compatible-session")!;
const settingsOpenAiCompatibleSessionMeta = document.getElementById("settings-openai-compatible-session-meta")!;
const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsResetBtn = document.getElementById("settings-reset") as HTMLButtonElement;
const disconnectOpenRouterBtn = document.getElementById("disconnect-openrouter-btn") as HTMLButtonElement;
const disconnectOpenAiCompatibleBtn = document.getElementById("disconnect-openai-compatible-btn") as HTMLButtonElement;
const connectOpenRouterButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-openrouter-connect]"),
);
const connectOpenAiCompatibleButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-openai-compatible-connect]"),
);
const GRAPH_REFRESH_TOOL_NAMES = new Set(["write_file", "edit_file", "run_command"]);
const configOverlayQuickConnects = document.getElementById("config-overlay-quick-connects");
const configOverlaySpotlight = document.getElementById("config-overlay-spotlight");
const configOverlayIntro = document.getElementById("config-overlay-intro");
const configConnectStatus = document.getElementById("config-connect-status");

let ws: WebSocket;
let currentAssistantEl: HTMLElement | null = null;
let assistantText = "";
let hadToolCalls = false;
let settingsPayload: SettingsPayload | null = null;
let activeSavedSession: SessionMeta | null = null;
let activeBaseUrl = "";
let sessionOpenRouterConnected = false;
let sessionOpenAiCompatibleConnected = false;
const sessionRefreshTracker = createLatestRequestTracker();

const TOOL_RESULT_MAX = 500;
const OPENROUTER_PKCE_VERIFIER_KEY = "minicode:openrouter:pkce-verifier";
const OPENROUTER_PERSIST_TO_ENV_KEY = "minicode:openrouter:persist-to-env";
const SESSION_AUTOSAVE_KEY = "minicode:session:auto-save";
const SESSION_AUTOSAVE_LABEL_PREFIX = "Autosave";
type OpenAiCompatiblePreset = "lmstudio" | "openai" | "ollama" | "custom";

const OPENAI_COMPATIBLE_PRESETS: Record<OpenAiCompatiblePreset, {
  baseUrl: string;
  helpText: string;
  apiKeyPlaceholder: string;
}> = {
  lmstudio: {
    baseUrl: "http://localhost:1234/v1",
    helpText: "LM Studio pre-fills the default local server endpoint at http://localhost:1234/v1.",
    apiKeyPlaceholder: "Leave blank for LM Studio unless local auth is enabled",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    helpText: "OpenAI uses https://api.openai.com/v1 and typically requires an API key.",
    apiKeyPlaceholder: "Enter your OpenAI API key",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    helpText: "Ollama pre-fills the default local server endpoint at http://localhost:11434/v1.",
    apiKeyPlaceholder: "Leave blank for Ollama unless your proxy requires auth",
  },
  custom: {
    baseUrl: "",
    helpText: "Custom leaves the endpoint fully editable so you can point minicode at any OpenAI-compatible API.",
    apiKeyPlaceholder: "Add an API key only if this endpoint requires auth",
  },
};

let sessionAutoSaveEnabled = loadSessionAutoSavePreference();
let pendingAutoSaveLabel: string | null = null;
let autoSaveInFlight: Promise<void> | null = null;
let autoSaveQueued = false;

sessionAutoSaveToggle.checked = sessionAutoSaveEnabled;

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus("ready");
    fetchStatus();
    refreshModelList();
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

function setOpenAiCompatibleConnectStatus(message: string, tone: "info" | "success" | "error"): void {
  openAiCompatibleConnectStatus.textContent = message;
  openAiCompatibleConnectStatus.className = `config-connect-status ${tone}`;
}

function clearOpenAiCompatibleConnectStatus(): void {
  openAiCompatibleConnectStatus.textContent = "";
  openAiCompatibleConnectStatus.className = "config-connect-status hidden";
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function inferOpenAiCompatiblePreset(baseUrl: string): OpenAiCompatiblePreset {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl).toLowerCase();
  if (normalizedBaseUrl === OPENAI_COMPATIBLE_PRESETS.lmstudio.baseUrl) {
    return "lmstudio";
  }
  if (normalizedBaseUrl === OPENAI_COMPATIBLE_PRESETS.openai.baseUrl) {
    return "openai";
  }
  if (normalizedBaseUrl === OPENAI_COMPATIBLE_PRESETS.ollama.baseUrl) {
    return "ollama";
  }
  return "custom";
}

function applyOpenAiCompatiblePreset(
  preset: OpenAiCompatiblePreset,
  options: { preserveCustomValue?: boolean } = {},
): void {
  const presetConfig = OPENAI_COMPATIBLE_PRESETS[preset];
  openAiCompatiblePresetHelp.textContent = presetConfig.helpText;
  openAiCompatibleApiKeyInput.placeholder = presetConfig.apiKeyPlaceholder;

  if (preset === "custom" && options.preserveCustomValue) {
    return;
  }

  openAiCompatibleBaseUrlInput.value = presetConfig.baseUrl;
}

function isModalOpen(modal: HTMLElement): boolean {
  return !modal.classList.contains("hidden");
}

function isSettingsModalOpen(): boolean {
  return isModalOpen(settingsModal);
}

function isOpenRouterConnectModalOpen(): boolean {
  return isModalOpen(openRouterConnectModal);
}

function isOpenAiCompatibleConnectModalOpen(): boolean {
  return isModalOpen(openAiCompatibleConnectModal);
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

async function startOpenRouterConnect(persistToEnv: boolean): Promise<void> {
  const verifier = createPkceVerifier();
  const challenge = await createPkceChallenge(verifier);
  sessionStorage.setItem(OPENROUTER_PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OPENROUTER_PERSIST_TO_ENV_KEY, persistToEnv ? "1" : "0");
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
  const persistToEnv = sessionStorage.getItem(OPENROUTER_PERSIST_TO_ENV_KEY) === "1";
  sessionStorage.removeItem(OPENROUTER_PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OPENROUTER_PERSIST_TO_ENV_KEY);

  if (!codeVerifier) {
    setConfigConnectStatus(
      "OpenRouter sign-in could not be completed because the local PKCE verifier was missing. Start the connect flow again.",
      "error",
    );
    return;
  }

  for (const button of connectOpenRouterButtons) {
    button.disabled = true;
  }
  setConfigConnectStatus("Connecting OpenRouter to this serve session…", "info");

  try {
    const res = await fetch("/api/openrouter/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier, persistToEnv }),
    });
    const body = await res.json() as OpenRouterConnectResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to connect OpenRouter (${res.status})`);
    }

    activeBaseUrl = body.baseUrl;
    addMessage(body.message, "thinking");
    const statusTone = body.persistWarning
      ? "info"
      : (body.needsSetup ? "info" : "success");
    setConfigConnectStatus(body.message, statusTone);
    await fetchStatus();
    await refreshModelList();

    const onlyModelMissing =
      body.needsSetup &&
      body.missing.length === 1 &&
      body.missing[0]?.includes("MODEL");
    if (onlyModelMissing) {
      modelDropdown.classList.remove("hidden");
      sessionDropdown.classList.add("hidden");
      focusModelSearchInput();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to connect OpenRouter";
    setConfigConnectStatus(message, "error");
  } finally {
    for (const button of connectOpenRouterButtons) {
      button.disabled = false;
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

async function connectOpenAiCompatible(): Promise<void> {
  const baseUrl = normalizeBaseUrl(openAiCompatibleBaseUrlInput.value);
  const apiKey = openAiCompatibleApiKeyInput.value.trim();

  if (!baseUrl) {
    setOpenAiCompatibleConnectStatus("Endpoint is required.", "error");
    return;
  }

  clearOpenAiCompatibleConnectStatus();
  clearSettingsBanner();
  openAiCompatibleConnectContinueBtn.disabled = true;

  try {
    const res = await fetch("/api/openai-compatible/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        persistToEnv: openAiCompatiblePersistCheckbox.checked,
      }),
    });
    const body = await res.json() as OpenAiCompatibleConnectResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to connect OpenAI-compatible provider (${res.status})`);
    }

    activeBaseUrl = body.baseUrl;
    addMessage(body.message, "thinking");
    const tone = body.persistWarning
      ? "info"
      : (body.needsSetup ? "info" : "success");
    setConfigConnectStatus(body.message, tone);
    setSettingsBanner(body.message, tone === "success" ? "success" : "info");
    closeOpenAiCompatibleConnectModal();
    await fetchStatus();
    await refreshModelList();

    const onlyModelMissing =
      body.needsSetup &&
      body.missing.length === 1 &&
      body.missing[0]?.includes("MODEL");
    if (onlyModelMissing) {
      modelDropdown.classList.remove("hidden");
      sessionDropdown.classList.add("hidden");
      focusModelSearchInput();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to connect OpenAI-compatible provider";
    setOpenAiCompatibleConnectStatus(message, "error");
  } finally {
    openAiCompatibleConnectContinueBtn.disabled = false;
  }
}

async function disconnectOpenAiCompatible(): Promise<void> {
  disconnectOpenAiCompatibleBtn.disabled = true;
  clearSettingsBanner();

  try {
    const res = await fetch("/api/openai-compatible/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = await res.json() as OpenAiCompatibleDisconnectResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to disconnect OpenAI-compatible provider (${res.status})`);
    }

    activeBaseUrl = body.baseUrl;
    addMessage(body.message, "thinking");
    setSettingsBanner(body.message, body.disconnected ? "success" : "info");
    clearConfigConnectStatus();
    await fetchStatus();
    await refreshModelList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to disconnect OpenAI-compatible provider";
    setSettingsBanner(message, "error");
  } finally {
    disconnectOpenAiCompatibleBtn.disabled = false;
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
    sessionOpenAiCompatibleConnected = data.sessionOpenAiCompatibleConnected ?? false;
    renderSessionProviderControls();

    if (data.needsSetup) {
      configOverlay.classList.remove("hidden");
      chatInput.disabled = true;
      sendBtn.disabled = true;
      // Show specific missing items
      const missingEl = document.getElementById("config-missing");
      const overlayState = deriveSetupOverlayState({
        configuredProvider: data.configuredProvider ?? null,
        missing: data.missing ?? [],
      });
      if (configOverlayIntro) {
        configOverlayIntro.textContent = overlayState.introText;
      }
      configOverlayQuickConnects?.classList.toggle("hidden", overlayState.hideQuickConnects);
      configOverlaySpotlight?.classList.toggle("hidden", overlayState.hideOpenRouterSpotlight);
      if (missingEl) {
        if (overlayState.missingItems.length > 0) {
          const hint = overlayState.showModelSelectionHint
            ? ` — select one from the <strong>model dropdown</strong> above, or set it in config`
            : "";
          const note = overlayState.modelSelectionNote
            ? ` ${escapeHtml(overlayState.modelSelectionNote)}`
            : "";
          missingEl.innerHTML =
            `<strong>Missing:</strong> ${overlayState.missingItems.map(escapeHtml).join(", ")}${hint}${note}`;
          missingEl.classList.remove("hidden");
        } else {
          missingEl.classList.add("hidden");
          missingEl.innerHTML = "";
        }
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
      if (configOverlayIntro) {
        configOverlayIntro.textContent = DEFAULT_SETUP_INTRO;
      }
      configOverlayQuickConnects?.classList.remove("hidden");
      configOverlaySpotlight?.classList.remove("hidden");
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
      if (GRAPH_REFRESH_TOOL_NAMES.has(msg.name || "")) {
        scheduleGraphDataRefresh();
      }
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
      queueSessionAutoSave();
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
  indicator.title =
    `Context: ~${contextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens (${pct}%)\n` +
    "Adjust context size in Settings if you want it larger or smaller.";
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

function closeModelDropdown(): void {
  modelDropdown.classList.add("hidden");
  modelSearchInput.value = "";
}

function closeHeaderMenus(): void {
  closeModelDropdown();
  sessionDropdown.classList.add("hidden");
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

function renderSessionProviderControls(): void {
  if (sessionOpenRouterConnected) {
    settingsOpenRouterSession.classList.remove("hidden");
    settingsOpenRouterSessionMeta.textContent = activeBaseUrl
      ? `Endpoint: ${activeBaseUrl}. This session-only connection overrides your original provider settings until you disconnect or restart serve.`
      : "This session-only connection overrides your original provider settings until you disconnect or restart serve.";
    settingsOpenAiCompatibleSession.classList.add("hidden");
    settingsOpenAiCompatibleSessionMeta.textContent = "";
    disconnectOpenRouterBtn.disabled = false;
    disconnectOpenAiCompatibleBtn.disabled = false;
    return;
  }

  if (sessionOpenAiCompatibleConnected) {
    settingsOpenAiCompatibleSession.classList.remove("hidden");
    settingsOpenAiCompatibleSessionMeta.textContent = activeBaseUrl
      ? `Endpoint: ${activeBaseUrl}. This session-only connection overrides your original provider settings until you disconnect or restart serve.`
      : "This session-only connection overrides your original provider settings until you disconnect or restart serve.";
    settingsOpenRouterSession.classList.add("hidden");
    settingsOpenRouterSessionMeta.textContent = "";
    disconnectOpenRouterBtn.disabled = false;
    disconnectOpenAiCompatibleBtn.disabled = false;
    return;
  }

  settingsOpenRouterSession.classList.add("hidden");
  settingsOpenRouterSessionMeta.textContent = "";
  settingsOpenAiCompatibleSession.classList.add("hidden");
  settingsOpenAiCompatibleSessionMeta.textContent = "";
  disconnectOpenRouterBtn.disabled = false;
  disconnectOpenAiCompatibleBtn.disabled = false;
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
  openModal(settingsModal);
  void loadSettings();
}

function closeSettings(): void {
  closeModal(settingsModal);
  clearSettingsBanner();
}

function openOpenRouterConnectModal(): void {
  closeHeaderMenus();
  openModal(openRouterConnectModal);
  openRouterPersistCheckbox.checked = false;
  openRouterConnectContinueBtn.disabled = false;
}

function closeOpenRouterConnectModal(): void {
  closeModal(openRouterConnectModal);
  openRouterConnectContinueBtn.disabled = false;
}

function openOpenAiCompatibleConnectModal(): void {
  closeHeaderMenus();
  openModal(openAiCompatibleConnectModal);
  const preset = inferOpenAiCompatiblePreset(activeBaseUrl);
  openAiCompatiblePresetSelect.value = preset;
  openAiCompatibleBaseUrlInput.value = preset === "custom"
    ? activeBaseUrl
    : OPENAI_COMPATIBLE_PRESETS[preset].baseUrl;
  openAiCompatibleApiKeyInput.value = "";
  openAiCompatiblePersistCheckbox.checked = false;
  openAiCompatibleConnectContinueBtn.disabled = false;
  applyOpenAiCompatiblePreset(preset, { preserveCustomValue: preset === "custom" });
  clearOpenAiCompatibleConnectStatus();
  requestAnimationFrame(() => {
    openAiCompatibleBaseUrlInput.focus();
    openAiCompatibleBaseUrlInput.select();
  });
}

function closeOpenAiCompatibleConnectModal(): void {
  closeModal(openAiCompatibleConnectModal);
  openAiCompatibleConnectContinueBtn.disabled = false;
  clearOpenAiCompatibleConnectStatus();
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
let availableModels: Array<{ id: string; name?: string }> = [];

function focusModelSearchInput(): void {
  requestAnimationFrame(() => {
    modelSearchInput.focus();
    modelSearchInput.select();
  });
}

function renderModelList(): void {
  const filteredModels = filterModelsByQuery(availableModels, modelSearchInput.value);

  if (availableModels.length === 0) {
    modelList.innerHTML = '<div class="dropdown-empty">No models available</div>';
    return;
  }

  if (filteredModels.length === 0) {
    modelList.innerHTML = '<div class="dropdown-empty">No matching models</div>';
    return;
  }

  modelList.innerHTML = "";
  for (const model of filteredModels) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "model-item" + (model.id === activeModel ? " active" : "");
    el.title = model.id;

    const body = document.createElement("div");
    body.className = "model-item-body";

    const name = document.createElement("span");
    name.className = "model-item-name";
    name.textContent = getModelDisplayName(model);
    body.appendChild(name);

    if ((model.name ?? "").trim() && getModelDisplayName(model) !== model.id) {
      const subtitle = document.createElement("span");
      subtitle.className = "model-item-subtitle";
      subtitle.textContent = model.id;
      body.appendChild(subtitle);
    }

    el.appendChild(body);

    if (model.id === activeModel) {
      const badge = document.createElement("span");
      badge.className = "model-item-badge";
      badge.textContent = "Active";
      el.appendChild(badge);
    }

    el.addEventListener("click", () => {
      void switchModel(model.id);
    });
    modelList.appendChild(el);
  }
}

modelBtn.addEventListener("click", (e: Event) => {
  e.stopPropagation();
  const isOpen = !modelDropdown.classList.contains("hidden");
  if (isOpen) {
    closeModelDropdown();
    return;
  }

  closeHeaderMenus();
  modelDropdown.classList.remove("hidden");
  modelSearchInput.value = "";
  void refreshModelList({ focusSearch: true });
});

document.addEventListener("click", (e: Event) => {
  if (!modelDropdown.contains(e.target as Node) && e.target !== modelBtn) {
    closeModelDropdown();
  }
});

modelSearchInput.addEventListener("input", () => {
  renderModelList();
});

modelSearchInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    if (modelSearchInput.value) {
      modelSearchInput.value = "";
      renderModelList();
      return;
    }

    closeModelDropdown();
  }
});

modelSearchInput.addEventListener("click", (e: Event) => {
  e.stopPropagation();
});

async function refreshModelList(options: { focusSearch?: boolean } = {}): Promise<void> {
  try {
    const res = await fetch("/api/models");
    const data = await res.json() as { models: Array<{ id: string; name?: string }>; activeModel: string };
    activeModel = data.activeModel;
    availableModels = data.models ?? [];
    const hasActiveModel = !!activeModel && data.models.some((model) => model.id === activeModel);

    if (!data.models || data.models.length === 0) {
      modelInfo.textContent = "Select model";
      modelInfo.classList.add("placeholder");
      availableModels = [];
      renderModelList();
      return;
    }

    if (hasActiveModel) {
      modelInfo.textContent = activeModel;
      modelInfo.classList.remove("placeholder");
    } else {
      modelInfo.textContent = "Select model";
      modelInfo.classList.add("placeholder");
    }

    renderModelList();

    if (options.focusSearch && !modelDropdown.classList.contains("hidden")) {
      focusModelSearchInput();
    }
  } catch {
    availableModels = [];
    modelList.innerHTML = '<div class="dropdown-empty">Failed to load models</div>';
  }
}

async function switchModel(modelId: string): Promise<void> {
  try {
    const res = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        persistToHomeEnv: true,
      }),
    });
    const body = await res.json() as ModelSwitchResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to switch model (${res.status})`);
    }

    modelInfo.textContent = modelId || "Select model";
    modelInfo.classList.toggle("placeholder", !modelId);
    activeModel = modelId;
    renderModelList();
    closeModelDropdown();

    if (body.persistedToEnv) {
      addMessage(`Model switched to: ${modelId}. Saved as the default in ~/.minicode/.env.`, "thinking");
    } else {
      addMessage(`Model switched to: ${modelId}`, "thinking");
    }

    await fetchStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to switch model";
    addMessage(message, "error");
  }
}

// -- Session management --

sessionBtn.addEventListener("click", (e: Event) => {
  e.stopPropagation();
  const isOpen = !sessionDropdown.classList.contains("hidden");
  sessionDropdown.classList.toggle("hidden");
  closeModelDropdown();
  if (!isOpen) {
    refreshSessionList();
  }
});

document.addEventListener("click", (e: Event) => {
  if (!sessionDropdown.contains(e.target as Node) && e.target !== sessionBtn) {
    sessionDropdown.classList.add("hidden");
  }
});

function loadSessionAutoSavePreference(): boolean {
  try {
    return localStorage.getItem(SESSION_AUTOSAVE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSessionAutoSavePreference(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(SESSION_AUTOSAVE_KEY, "1");
    } else {
      localStorage.removeItem(SESSION_AUTOSAVE_KEY);
    }
  } catch {
    // ignore
  }
}

function buildAutoSaveLabel(): string {
  return `${SESSION_AUTOSAVE_LABEL_PREFIX} ${new Date().toLocaleString()}`;
}

async function persistCurrentSession(label?: string): Promise<SessionMeta> {
  const res = await fetch("/api/sessions/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const body = await res.json() as SessionMeta | { error: string };
  if (!res.ok) {
    throw new Error("error" in body ? body.error : `Failed to save session (${res.status})`);
  }
  return body as SessionMeta;
}

async function deleteSavedSession(session: SessionMeta): Promise<void> {
  const isCurrentSavedSession = activeSavedSession?.id === session.id;
  const confirmed = window.confirm(`Delete saved session "${session.label}"?`);
  if (!confirmed) {
    return;
  }

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
    });
    const body = await res.json() as DeleteSessionResponse | { error: string };
    if (!res.ok) {
      throw new Error("error" in body ? body.error : `Failed to delete session (${res.status})`);
    }

    if (isCurrentSavedSession) {
      activeSavedSession = null;
    }
    if (pendingAutoSaveLabel === session.label) {
      pendingAutoSaveLabel = null;
    }

    addMessage(
      isCurrentSavedSession
        ? `Deleted saved session "${session.label}". The current chat stays open until you load another session or refresh.`
        : `Session deleted: "${session.label}"`,
      "thinking",
    );
    await refreshSessionList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete session";
    addMessage(message, "error");
  }
}

async function maybeAutoSaveSession(): Promise<void> {
  if (!sessionAutoSaveEnabled) {
    return;
  }

  const label = activeSavedSession?.label ?? pendingAutoSaveLabel ?? buildAutoSaveLabel();
  try {
    const data = await persistCurrentSession(label);
    pendingAutoSaveLabel = data.label;
    await refreshSessionList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to auto-save session";
    addMessage(message, "error");
  }
}

function queueSessionAutoSave(): void {
  if (!sessionAutoSaveEnabled) {
    return;
  }

  if (autoSaveInFlight) {
    autoSaveQueued = true;
    return;
  }

  autoSaveInFlight = (async () => {
    await maybeAutoSaveSession();
  })();

  void autoSaveInFlight.finally(() => {
    autoSaveInFlight = null;
    if (autoSaveQueued) {
      autoSaveQueued = false;
      queueSessionAutoSave();
    }
  });
}

sessionAutoSaveToggle.addEventListener("change", () => {
  sessionAutoSaveEnabled = sessionAutoSaveToggle.checked;
  persistSessionAutoSavePreference(sessionAutoSaveEnabled);

  if (sessionAutoSaveEnabled) {
    addMessage(
      activeSavedSession
        ? `Auto-save enabled. minicode will update "${activeSavedSession.label}" after each completed turn.`
        : "Auto-save enabled. minicode will save this chat after the next completed turn.",
      "thinking",
    );
  } else {
    addMessage("Auto-save disabled.", "thinking");
  }
});

saveBtn.addEventListener("click", async () => {
  const requestedLabel = saveLabelInput.value.trim();
  const label = requestedLabel || activeSavedSession?.label || undefined;
  const isUpdatingCurrentSession =
    !!activeSavedSession && (requestedLabel.length === 0 || requestedLabel === activeSavedSession.label);
  try {
    saveBtn.setAttribute("disabled", "true");
    const data = await persistCurrentSession(label);
    saveLabelInput.value = "";
    pendingAutoSaveLabel = data.label;
    addMessage(
      `${isUpdatingCurrentSession ? "Session updated" : "Session saved"}: "${data.label}"`,
      "thinking",
    );
    await refreshSessionList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save session";
    addMessage(message, "error");
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
      pendingAutoSaveLabel = activeSavedSession.label;
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
      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "session-load-btn";
      loadBtn.innerHTML =
        `<span class="session-label">${escapeHtml(s.label)}</span>` +
        `<span class="session-meta">${s.messageCount} msgs${isActive ? ' <span class="session-active-badge">• active</span>' : ""}</span>`;
      loadBtn.addEventListener("click", () => loadSession(s.label));

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "session-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.title = `Delete "${s.label}"`;
      deleteBtn.addEventListener("click", (event: Event) => {
        event.stopPropagation();
        void deleteSavedSession(s);
      });

      el.appendChild(loadBtn);
      el.appendChild(deleteBtn);
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
      pendingAutoSaveLabel = body.label;
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
    const data = await persistCurrentSession(activeSavedSession.label);
    pendingAutoSaveLabel = data.label;
    addMessage(`Session updated: "${data.label}"`, "thinking");
    await refreshSessionList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update session";
    addMessage(message, "error");
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

openRouterConnectBackdrop.addEventListener("click", () => {
  closeOpenRouterConnectModal();
});

openRouterConnectCloseBtn.addEventListener("click", () => {
  closeOpenRouterConnectModal();
});

openRouterConnectCancelBtn.addEventListener("click", () => {
  closeOpenRouterConnectModal();
});

openAiCompatibleConnectBackdrop.addEventListener("click", () => {
  closeOpenAiCompatibleConnectModal();
});

openAiCompatibleConnectCloseBtn.addEventListener("click", () => {
  closeOpenAiCompatibleConnectModal();
});

openAiCompatibleConnectCancelBtn.addEventListener("click", () => {
  closeOpenAiCompatibleConnectModal();
});

settingsResetBtn.addEventListener("click", () => {
  clearSettingsBanner();
  renderSettings();
  renderSessionProviderControls();
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

disconnectOpenAiCompatibleBtn.addEventListener("click", () => {
  void disconnectOpenAiCompatible();
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "Escape") {
    return;
  }
  if (isOpenRouterConnectModalOpen()) {
    closeOpenRouterConnectModal();
    return;
  }
  if (isOpenAiCompatibleConnectModalOpen()) {
    closeOpenAiCompatibleConnectModal();
    return;
  }
  if (isSettingsModalOpen()) {
    closeSettings();
  }
});

for (const button of connectOpenRouterButtons) {
  button.addEventListener("click", () => {
    openOpenRouterConnectModal();
  });
}

for (const button of connectOpenAiCompatibleButtons) {
  button.addEventListener("click", () => {
    openOpenAiCompatibleConnectModal();
  });
}

openAiCompatiblePresetSelect.addEventListener("change", () => {
  applyOpenAiCompatiblePreset(openAiCompatiblePresetSelect.value as OpenAiCompatiblePreset);
  clearOpenAiCompatibleConnectStatus();
});

openAiCompatibleBaseUrlInput.addEventListener("input", () => {
  clearOpenAiCompatibleConnectStatus();
});

openAiCompatibleApiKeyInput.addEventListener("input", () => {
  clearOpenAiCompatibleConnectStatus();
});

openRouterConnectContinueBtn.addEventListener("click", () => {
  openRouterConnectContinueBtn.disabled = true;
  closeOpenRouterConnectModal();
  void startOpenRouterConnect(openRouterPersistCheckbox.checked);
});

openAiCompatibleConnectContinueBtn.addEventListener("click", () => {
  void connectOpenAiCompatible();
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
