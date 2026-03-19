const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const cancelBtn = document.getElementById("cancel-btn");
const statusBadge = document.getElementById("status-badge");
const modelInfo = document.getElementById("model-info");

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

// Start connection
connect();
