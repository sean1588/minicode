const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const cancelBtn = document.getElementById("cancel-btn");
const statusBadge = document.getElementById("status-badge");
const modelInfo = document.getElementById("model-info");
const sessionBtn = document.getElementById("session-btn");
const sessionDropdown = document.getElementById("session-dropdown");
const sessionList = document.getElementById("session-list");
const saveBtn = document.getElementById("save-btn");
const saveLabelInput = document.getElementById("save-label");

let ws;
let currentAssistantEl = null;
let assistantText = "";

// Max chars to show in expanded tool result
const TOOL_RESULT_MAX = 500;

function connect() {
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

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  };
}

function setStatus(state) {
  statusBadge.textContent = state;
  statusBadge.className = `badge ${state}`;
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  sendBtn.classList.toggle("hidden", busy);
  cancelBtn.classList.toggle("hidden", !busy);
  if (busy) {
    setStatus("busy");
  } else {
    setStatus("ready");
  }
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    modelInfo.textContent = `${data.model} · ${data.provider}`;
  } catch {
    // ignore
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "turn_start":
      assistantText = "";
      currentAssistantEl = addMessage("", "assistant");
      currentAssistantEl.classList.add("streaming-cursor");
      setBusy(true);
      break;

    case "streaming_chunk":
      assistantText += msg.content;
      if (currentAssistantEl) {
        currentAssistantEl.textContent = assistantText;
        scrollToBottom();
      }
      break;

    case "thinking":
      addMessage(msg.content, "thinking");
      break;

    case "step":
      // Intentionally not shown — tool calls provide enough context
      break;

    case "tool_call_start":
      addToolCall(msg.name, msg.input);
      // Forward symbol-related tool calls to graph for highlighting
      if (graphMode && typeof window.highlightAgentActivity === 'function') {
        const symbolTools = ['read_symbol', 'get_dependencies', 'find_references'];
        if (symbolTools.includes(msg.name)) {
          const symName = msg.input?.name || msg.input?.symbol || msg.input?.qualifiedName;
          if (symName) window.highlightAgentActivity(symName);
        }
      }
      break;

    case "tool_call_end":
      finalizeToolCall(msg.name, msg.result, msg.elapsedMs);
      break;

    case "turn_end":
      if (currentAssistantEl) {
        currentAssistantEl.classList.remove("streaming-cursor");
        if (!assistantText && msg.text) {
          currentAssistantEl.textContent = msg.text;
        }
      }
      currentAssistantEl = null;
      assistantText = "";
      setBusy(false);
      if (msg.usage) {
        addUsageInfo(msg.usage);
      }
      break;

    case "error":
      addMessage(`Error: ${msg.message}`, "error");
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

function addMessage(text, type) {
  const el = document.createElement("div");
  el.className = `message ${type}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

/**
 * Extract the most meaningful short arg from tool input.
 * e.g. for read_file → the path, for search → the query, for run_command → the command.
 */
function summarizeToolInput(name, input) {
  // Priority keys by tool type
  const key =
    input.path ?? input.file_path ?? input.command ?? input.query ??
    input.pattern ?? input.name ?? input.old_string;

  if (typeof key === "string") {
    return key.length > 60 ? key.slice(0, 57) + "..." : key;
  }

  // Fallback: first string value, truncated
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? v.slice(0, 57) + "..." : v;
    }
  }
  return "";
}

function getOrCreateToolGroup() {
  const last = messagesEl.lastElementChild;
  if (last && last.classList.contains("tool-group")) {
    return last;
  }
  const group = document.createElement("div");
  group.className = "tool-group";
  messagesEl.appendChild(group);
  return group;
}

function addToolCall(name, input) {
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

function finalizeToolCall(name, result, elapsedMs) {
  const toolEls = messagesEl.querySelectorAll(`.tool-call[data-tool-name="${name}"]`);
  const el = toolEls[toolEls.length - 1];
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

function addUsageInfo(usage) {
  const el = document.createElement("div");
  el.className = "usage-info";
  el.textContent = `${usage.inputTokens} in / ${usage.outputTokens} out`;
  messagesEl.appendChild(el);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Form handling
chatForm.addEventListener("submit", (e) => {
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

// Auto-resize textarea
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
});

// Submit on Enter (Shift+Enter for newline)
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

// ── Session management ──

sessionBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !sessionDropdown.classList.contains("hidden");
  sessionDropdown.classList.toggle("hidden");
  if (!isOpen) {
    refreshSessionList();
  }
});

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  if (!sessionDropdown.contains(e.target) && e.target !== sessionBtn) {
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
      const data = await res.json();
      saveLabelInput.value = "";
      addMessage(`Session saved: "${data.label}"`, "thinking");
      refreshSessionList();
    }
  } catch {
    // ignore
  }
});

saveLabelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveBtn.click();
  }
});

async function refreshSessionList() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
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

async function loadSession(label) {
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

// ── View toggle (Chat / Graph) ──

const viewToggle = document.getElementById('view-toggle');
const graphView = document.getElementById('graph-view');
const chatMain = document.getElementById('messages');
const chatFooter = document.querySelector('footer');
const appEl = document.getElementById('app');
let graphMode = false;

viewToggle.addEventListener('click', () => {
  graphMode = !graphMode;
  if (graphMode) {
    chatMain.classList.add('hidden');
    chatFooter.classList.add('hidden');
    graphView.classList.remove('hidden');
    appEl.classList.add('graph-wide');
    viewToggle.textContent = 'Chat';
    viewToggle.classList.add('active');
    // Lazy init graph on first switch
    if (typeof window.initGraph === 'function') {
      window.initGraph();
    }
  } else {
    chatMain.classList.remove('hidden');
    chatFooter.classList.remove('hidden');
    graphView.classList.add('hidden');
    appEl.classList.remove('graph-wide');
    viewToggle.textContent = 'Graph';
    viewToggle.classList.remove('active');
  }
});

// Start connection
connect();
