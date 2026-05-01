/** WebSocket message protocol types for minicode serve mode. */

// ── Client → Server ──

export interface ClientChatMessage {
  type: "chat";
  message: string;
}

export interface ClientCancelMessage {
  type: "cancel";
}

export interface ClientSwitchModelMessage {
  type: "switch_model";
  model: string;
}

/** User responds to a permission prompt for a gated tool call. */
export interface ClientPermissionResponseMessage {
  type: "permission_response";
  /** Matches the `requestId` of the corresponding `permission_required` event. */
  requestId: string;
  decision: "allow" | "deny";
  /**
   * When true, the user wants to skip future prompts for the rest of this
   * session. Server flips its `autoAllowWrites` flag on. Implies `allow`.
   */
  rememberForSession?: boolean;
}

/** Toggle the per-session auto-allow flag without responding to a prompt. */
export interface ClientSetAutoAllowMessage {
  type: "set_auto_allow";
  autoAllow: boolean;
}

export type ClientMessage =
  | ClientChatMessage
  | ClientCancelMessage
  | ClientSwitchModelMessage
  | ClientPermissionResponseMessage
  | ClientSetAutoAllowMessage;

// ── Server → Client ──

export interface ServerTurnStartMessage {
  type: "turn_start";
}

export interface ServerThinkingMessage {
  type: "thinking";
  content: string;
}

export interface ServerStreamingChunkMessage {
  type: "streaming_chunk";
  content: string;
}

export interface ServerStepMessage {
  type: "step";
  step: number;
}

export interface ServerToolCallStartMessage {
  type: "tool_call_start";
  name: string;
  input: Record<string, unknown>;
}

export interface ServerToolCallEndMessage {
  type: "tool_call_end";
  name: string;
  input: Record<string, unknown>;
  result: string;
  elapsedMs: number;
}

export interface ServerTurnEndMessage {
  type: "turn_end";
  text: string;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface ServerErrorMessage {
  type: "error";
  message: string;
}

export interface ServerBusyMessage {
  type: "busy";
}

export interface ServerContextStatusMessage {
  type: "context_status";
  contextTokens: number;
  maxContextTokens: number;
}

export interface ServerModelChangedMessage {
  type: "model_changed";
  model: string;
}

/**
 * Sent when a gated tool call is awaiting the user's decision. The agent
 * loop is paused until a matching `permission_response` arrives. The
 * client should render a modal with the tool name and input, plus
 * Allow/Deny buttons (and ideally an "Allow always" shortcut that
 * sets `rememberForSession`).
 */
export interface ServerPermissionRequiredMessage {
  type: "permission_required";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Pushed when the per-session auto-allow flag changes (so the UI checkbox can stay in sync across clients). */
export interface ServerAutoAllowChangedMessage {
  type: "auto_allow_changed";
  autoAllow: boolean;
}

export type ServerMessage =
  | ServerTurnStartMessage
  | ServerThinkingMessage
  | ServerStreamingChunkMessage
  | ServerStepMessage
  | ServerToolCallStartMessage
  | ServerToolCallEndMessage
  | ServerTurnEndMessage
  | ServerErrorMessage
  | ServerBusyMessage
  | ServerContextStatusMessage
  | ServerModelChangedMessage
  | ServerPermissionRequiredMessage
  | ServerAutoAllowChangedMessage;
