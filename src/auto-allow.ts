/**
 * Auto-allow mode for the permission gate. Picks which mutating tool calls
 * skip the user prompt and run unattended:
 *
 * - `none`     → prompt for everything (the default)
 * - `writes`   → auto-allow write_file + edit_file
 * - `commands` → auto-allow run_command
 * - `all`      → auto-allow every gated tool
 *
 * The mode lives per-session in the host (web AgentBridge, CLI UiStore).
 * Both surfaces pull this shared definition so they can't drift on which
 * tools belong to which bucket.
 */
export type AutoAllowMode = "none" | "writes" | "commands" | "all";

export const AUTO_ALLOW_MODES: readonly AutoAllowMode[] = [
  "none",
  "writes",
  "commands",
  "all",
] as const;

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const COMMAND_TOOLS = new Set(["run_command"]);

/** Tools whose execution is gated by the permission prompt. */
export function isGatedTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName) || COMMAND_TOOLS.has(toolName);
}

/** True when `mode` would auto-allow `toolName` without prompting. */
export function shouldAutoAllow(mode: AutoAllowMode, toolName: string): boolean {
  if (mode === "all") return isGatedTool(toolName);
  if (mode === "writes") return WRITE_TOOLS.has(toolName);
  if (mode === "commands") return COMMAND_TOOLS.has(toolName);
  return false;
}

export function isAutoAllowMode(value: unknown): value is AutoAllowMode {
  return (
    value === "none" ||
    value === "writes" ||
    value === "commands" ||
    value === "all"
  );
}
