import type { UiStore } from "../ui/state/ui-store.js";

export interface PermissionsCommandResult {
  handled: boolean;
  message?: string;
}

const HELP =
  'Usage: /permissions auto on|off  (toggle YOLO mode for write_file, edit_file, run_command).\n' +
  'Or: /permissions status  (show current setting).';

/**
 * Handle the `/permissions` slash command, used to view and toggle the
 * per-session auto-allow flag for mutating tool calls. Returns
 * `{ handled: false }` for any input that isn't a permissions command.
 */
export function handlePermissionsSlashCommand(
  input: string,
  store: UiStore,
): PermissionsCommandResult {
  const trimmed = input.trim();
  if (trimmed !== "/permissions" && !trimmed.startsWith("/permissions ")) {
    return { handled: false };
  }

  const args = trimmed.slice("/permissions".length).trim().split(/\s+/).filter(Boolean);

  if (args.length === 0 || args[0] === "status") {
    return {
      handled: true,
      message: store.getAutoAllowWrites()
        ? "Permissions: auto-allow is ON (mutating tools run without prompting)."
        : "Permissions: auto-allow is OFF (you'll be prompted before write_file, edit_file, run_command).",
    };
  }

  if (args[0] === "auto") {
    const value = args[1];
    if (value === "on") {
      store.setAutoAllowWrites(true);
      return {
        handled: true,
        message: "Auto-allow is ON. Mutating tool calls will run without prompting.",
      };
    }
    if (value === "off") {
      store.setAutoAllowWrites(false);
      return {
        handled: true,
        message: "Auto-allow is OFF. You'll be prompted before each mutating tool call.",
      };
    }
    return { handled: true, message: HELP };
  }

  return { handled: true, message: HELP };
}
