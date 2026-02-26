export type UiPhase =
  | "idle"
  | "loading"
  | "sending"
  | "model_wait"
  | "tool_running"
  | "rendering"
  | "error";

export type ToolRunState = "queued" | "running" | "success" | "error" | "cancelled";

export interface ActivityItemUser {
  type: "user";
  content: string;
}

export interface ActivityItemAssistant {
  type: "assistant";
  content: string;
}

export interface ActivityItemThinking {
  type: "thinking";
  content: string;
}

export interface ActivityItemToolCall {
  type: "tool_call";
  name: string;
  input: Record<string, unknown>;
  state: ToolRunState;
  result?: string;
  elapsedMs?: number;
}

export interface ActivityItemToolResult {
  type: "tool_result";
  name: string;
  content: string;
  elapsedMs?: number;
}

export interface ActivityItemTokenUsage {
  type: "token_usage";
  inputTokens: number;
  outputTokens: number;
}

export interface ActivityItemSystem {
  type: "system";
  content: string;
}

export type ActivityItem =
  | ActivityItemUser
  | ActivityItemAssistant
  | ActivityItemThinking
  | ActivityItemToolCall
  | ActivityItemToolResult
  | ActivityItemTokenUsage
  | ActivityItemSystem;
