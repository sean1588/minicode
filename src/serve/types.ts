/** WebSocket message protocol types for minicode serve mode. */

import type { AutoAllowMode } from "../auto-allow.js";

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
   * Optional: when present and `decision === "allow"`, the server flips the
   * per-session auto-allow mode to this value. Lets a CLI shortcut like
   * `[a] allow all (session)` set the mode without sending a separate
   * `set_auto_allow_mode` message.
   */
  setAutoAllowMode?: AutoAllowMode;
}

/** Set the per-session auto-allow mode (drives the dropdown in the web UI). */
export interface ClientSetAutoAllowModeMessage {
  type: "set_auto_allow_mode";
  mode: AutoAllowMode;
}

export type ClientMessage =
  | ClientChatMessage
  | ClientCancelMessage
  | ClientSwitchModelMessage
  | ClientPermissionResponseMessage
  | ClientSetAutoAllowModeMessage;

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

/** Pushed when the per-session auto-allow mode changes (so any open client can keep the dropdown in sync). */
export interface ServerAutoAllowModeChangedMessage {
  type: "auto_allow_mode_changed";
  mode: AutoAllowMode;
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
  | ServerAutoAllowModeChangedMessage;
