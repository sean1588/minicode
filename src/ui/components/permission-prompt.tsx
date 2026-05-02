import React from "react";
import { Box, Text, useInput } from "ink";

import type { PendingPermissionPrompt } from "../state/ui-store.js";

interface PermissionPromptProps {
  prompt: PendingPermissionPrompt;
}

const MAX_FIELD_CHARS = 600;

/**
 * Render the tool input compactly. Long string fields (file content, full
 * commands) are truncated with a marker so the prompt stays readable.
 */
function formatInput(input: Record<string, unknown>): string {
  const truncated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > MAX_FIELD_CHARS) {
      truncated[key] =
        value.slice(0, MAX_FIELD_CHARS) +
        `… [${value.length - MAX_FIELD_CHARS} more chars]`;
    } else {
      truncated[key] = value;
    }
  }
  return JSON.stringify(truncated, null, 2);
}

/**
 * Mid-turn permission prompt for gated tool calls. Captures the agent's
 * input loop while visible — `useInput` here pre-empts the InputComposer
 * because Ink delivers raw stdin events to every mounted `useInput`. The
 * InputComposer is rendered with `disabled` while a prompt is active so
 * keystrokes here don't bleed into the chat input.
 *
 * Keys:
 *   y / Return  → allow once
 *   a           → allow every gated tool for the rest of the session
 *                 (equivalent to `/permissions auto all`). For narrower
 *                 modes (writes-only or commands-only), use the slash
 *                 command directly.
 *   n / Esc     → deny
 */
export function PermissionPrompt({ prompt }: PermissionPromptProps): React.ReactElement {
  useInput((input, key) => {
    if (input === "y" || key.return) {
      prompt.resolve({ decision: "allow" });
    } else if (input === "a") {
      // Flip the auto-allow mode to "all" so the rest of the session
      // skips the prompt for every gated tool. Equivalent to running
      // `/permissions auto all`.
      prompt.resolve({ decision: "allow", setMode: "all" });
    } else if (input === "n" || key.escape) {
      prompt.resolve({ decision: "deny" });
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text bold color="yellow">⚠ Permission required</Text>
      </Box>
      <Box>
        <Text>The agent wants to run </Text>
        <Text bold color="cyan">{prompt.toolName}</Text>
        <Text>:</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{formatInput(prompt.input)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold color="green">[y]</Text>
          <Text> allow once  </Text>
          <Text bold color="green">[a]</Text>
          <Text> allow all (session)  </Text>
          <Text bold color="red">[n]</Text>
          <Text> deny</Text>
        </Text>
      </Box>
      <Box>
        <Text dimColor>For finer control: /permissions auto writes|commands|all</Text>
      </Box>
    </Box>
  );
}
