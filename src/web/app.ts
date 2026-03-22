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
  label: string;
  messageCount: number;
}

const messagesEl = document.getElementById("messages")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
const statusBadge = document.getElementById("status-badge")!;
const modelInfo = document.getElementById("model-info")!;
const sessionBtn = document.getElementById("session-btn")!;
const sessionDropdown = document.getElementById("session-dropdown")!;
const sessionList = document.getElementById("session-list")!;
const saveBtn = document.getElementById("save-btn")!;
const saveLabelInput = document.getElementById("save-label") as HTMLInputElement;

let ws: WebSocket;
let currentAssistantEl: HTMLElement | null = null;
let assistantText = "";
let hadToolCalls = false;

const TOOL_RESULT_MAX = 500;

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus("ready");
    fetchStatus();
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
    modelInfo.textContent = `${data.model} · ${data.provider}`;
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

function addUsageInfo(usage: { inputTokens: number; outputTokens: number }): void {
  const el = document.createElement("div");
  el.className = "usage-info";
  el.textContent = `${usage.inputTokens} in / ${usage.outputTokens} out`;
  messagesEl.appendChild(el);
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

// -- Session management --

sessionBtn.addEventListener("click", (e: Event) => {
  e.stopPropagation();
  const isOpen = !sessionDropdown.classList.contains("hidden");
  sessionDropdown.classList.toggle("hidden");
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
  const label = saveLabelInput.value.trim() || undefined;
  try {
    const res = await fetch("/api/sessions/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (res.ok) {
      const data = await res.json() as { label: string };
      saveLabelInput.value = "";
      addMessage(`Session saved: "${data.label}"`, "thinking");
      refreshSessionList();
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
    const data = await res.json() as { sessions: SessionMeta[] };
    const sessions = data.sessions;

    if (!sessions || sessions.length === 0) {
      sessionList.innerHTML = '<div class="dropdown-empty">No saved sessions</div>';
      return;
    }

    sessionList.innerHTML = "";
    for (const s of sessions) {
      const el = document.createElement("div");
      el.className = "session-item";
      el.innerHTML =
        `<span class="session-label">${escapeHtml(s.label)}</span>` +
        `<span class="session-meta">${s.messageCount} msgs</span>`;
      el.addEventListener("click", () => loadSession(s.label));
      sessionList.appendChild(el);
    }
  } catch {
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
    }
  } catch {
    // ignore
  }
}

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
