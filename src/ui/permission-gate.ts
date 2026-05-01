import type {
  BeforeToolCallHook,
  ToolPermissionDecision,
} from "@minicode/agent-sdk";

import { isGatedTool, shouldAutoAllow } from "../auto-allow.js";
import type { UiStore } from "./state/ui-store.js";

/**
 * Build a `beforeToolCall` hook for the Ink CLI. Read-only tools bypass
 * the gate; mutating tools either auto-allow (when the current
 * `autoAllowMode` covers that tool — set via `/permissions auto MODE`
 * or via the `[a]` shortcut on a prompt) or park a `pendingPermission`
 * on the store and wait for the `<PermissionPrompt>` component to
 * resolve it.
 */
export function createPermissionGate(store: UiStore): BeforeToolCallHook {
  return (toolCall) => {
    if (!isGatedTool(toolCall.name)) {
      return Promise.resolve<ToolPermissionDecision>({ outcome: "allow" });
    }
    if (shouldAutoAllow(store.getAutoAllowMode(), toolCall.name)) {
      return Promise.resolve<ToolPermissionDecision>({ outcome: "allow" });
    }
    return new Promise<ToolPermissionDecision>((resolve) => {
      store.setPendingPermission({
        toolName: toolCall.name,
        input: toolCall.input,
        resolve: (response) => {
          // Clear the prompt before resolving so the UI redraws without
          // the modal in the same React tick the agent resumes.
          store.setPendingPermission(null);
          if (response.decision === "allow") {
            if (response.setMode) {
              store.setAutoAllowMode(response.setMode);
            }
            resolve({ outcome: "allow" });
          } else {
            resolve({
              outcome: "deny",
              reason: "User declined the tool call.",
            });
          }
        },
      });
    });
  };
}
