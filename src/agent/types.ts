export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
}

export type SessionMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface AgentConfig {
  modelProvider: "anthropic" | "openai-compatible";
  model: string;
  maxSteps: number;
  maxTokens: number;
  maxContextTokens: number;
  workspaceRoot: string;
  commandTimeoutMs: number;
  maxFileSizeBytes: number;
  commandDenylist: RegExp[];
  confirmDestructive: boolean;
  keepRecentMessages: number;
  loopDetectionWindow: number;
  openAiBaseUrl: string;
  openAiApiKey?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ModelClient {
  chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse>;
}

