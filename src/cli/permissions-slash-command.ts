import {
  AUTO_ALLOW_MODES,
  isAutoAllowMode,
  type AutoAllowMode,
} from "../auto-allow.js";
import type { UiStore } from "../ui/state/ui-store.js";

export interface PermissionsCommandResult {
  handled: boolean;
  message?: string;
}

const MODE_LIST = AUTO_ALLOW_MODES.join("|");

const HELP =
  `Usage: /permissions auto ${MODE_LIST}\n` +
  "\n" +
  "  none      prompt for every write_file, edit_file, and run_command call (default)\n" +
  "  writes    auto-allow write_file and edit_file; still prompt for run_command\n" +
  "  commands  auto-allow run_command; still prompt for write_file and edit_file\n" +
  "  all       auto-allow every gated tool (YOLO)\n" +
  "\n" +
  "Or: /permissions status  (show current mode).";

function describeMode(mode: AutoAllowMode): string {
  switch (mode) {
    case "none":
      return "Auto-allow is OFF. You'll be prompted before every write_file, edit_file, and run_command.";
    case "writes":
      return "Auto-allow is set to WRITES. write_file and edit_file run without prompting; run_command still prompts.";
    case "commands":
      return "Auto-allow is set to COMMANDS. run_command runs without prompting; write_file and edit_file still prompt.";
    case "all":
      return "Auto-allow is set to ALL. Every gated tool runs without prompting (YOLO).";
  }
}

/**
 * Handle the `/permissions` slash command, used to view and set the
 * per-session auto-allow mode. Returns `{ handled: false }` for any
 * input that isn't a permissions command.
 */
export function handlePermissionsSlashCommand(
  input: string,
  store: UiStore,
): PermissionsCommandResult {
  const trimmed = input.trim();
  if (trimmed !== "/permissions" && !trimmed.startsWith("/permissions ")) {
    return { handled: false };
  }

  const args = trimmed
    .slice("/permissions".length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0 || args[0] === "status") {
    return { handled: true, message: describeMode(store.getAutoAllowMode()) };
  }

  if (args[0] === "auto") {
    const value = args[1];
    if (isAutoAllowMode(value)) {
      store.setAutoAllowMode(value);
      return { handled: true, message: describeMode(value) };
    }
    return { handled: true, message: HELP };
  }

  return { handled: true, message: HELP };
}
