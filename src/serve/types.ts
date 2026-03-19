/** WebSocket message protocol types for minicode serve mode. */

// ── Client → Server ──

export interface ClientChatMessage {
  type: "chat";
  message: string;
}

export interface ClientCancelMessage {
  type: "cancel";
}

export type ClientMessage = ClientChatMessage | ClientCancelMessage;

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

export type ServerMessage =
  | ServerTurnStartMessage
  | ServerThinkingMessage
  | ServerStreamingChunkMessage
  | ServerStepMessage
  | ServerToolCallStartMessage
  | ServerToolCallEndMessage
  | ServerTurnEndMessage
  | ServerErrorMessage
  | ServerBusyMessage;
