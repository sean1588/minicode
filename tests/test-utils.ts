import type { AgentConfig } from "../src/agent/types.js";

export function createTestAgentConfig(workspaceRoot: string): AgentConfig {
  return {
    model: "test-model",
    maxSteps: 10,
    maxTokens: 1024,
    maxContextTokens: 16_000,
    workspaceRoot,
    commandTimeoutMs: 2_000,
    maxFileSizeBytes: 1_000_000,
    commandDenylist: [],
    confirmDestructive: false,
    keepRecentMessages: 10,
    loopDetectionWindow: 6,
  };
}
