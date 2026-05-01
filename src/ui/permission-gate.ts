import type {
  BeforeToolCallHook,
  ToolPermissionDecision,
} from "@minicode/agent-sdk";

import type { UiStore } from "./state/ui-store.js";

/** Tools whose execution is gated by the permission prompt. */
const GATED_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

/**
 * Build a `beforeToolCall` hook for the Ink CLI. Read-only tools bypass
 * the gate; mutating tools either auto-allow (when the user has flipped
 * the toggle via `/permissions auto on` or chose "Allow always") or
 * park a `pendingPermission` prompt on the store and wait for the
 * `<PermissionPrompt>` component to resolve it.
 */
export function createPermissionGate(store: UiStore): BeforeToolCallHook {
  return (toolCall) => {
    if (!GATED_TOOLS.has(toolCall.name)) {
      return Promise.resolve<ToolPermissionDecision>({ outcome: "allow" });
    }
    if (store.getAutoAllowWrites()) {
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
            if (response.rememberForSession) {
              store.setAutoAllowWrites(true);
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
