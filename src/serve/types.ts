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

export type ClientMessage = ClientChatMessage | ClientCancelMessage | ClientSwitchModelMessage;

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
  | ServerModelChangedMessage;
