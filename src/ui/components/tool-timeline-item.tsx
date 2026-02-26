import React from "react";
import { Box, Text } from "ink";
import { c } from "../theme.js";
import type { ActivityItemToolCall } from "../events.js";

interface ToolTimelineItemProps {
  item: ActivityItemToolCall;
}

function formatInput(input: Record<string, unknown>, maxLen = 60): string {
  const s = JSON.stringify(input);
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

export function ToolTimelineItem({ item }: ToolTimelineItemProps): React.ReactElement {
  const { name, input, state, elapsedMs } = item;
  const argsStr = formatInput(input);

  let icon: string;
  let colorFn: (s: string) => string;
  switch (state) {
    case "running":
    case "queued":
      icon = "▶";
      colorFn = c.cyan;
      break;
    case "success":
      icon = "✓";
      colorFn = c.green;
      break;
    case "error":
      icon = "✗";
      colorFn = c.red;
      break;
    case "cancelled":
      icon = "—";
      colorFn = c.dim;
      break;
    default:
      icon = "?";
      colorFn = c.dim;
  }

  const timeStr = elapsedMs !== undefined ? ` (${elapsedMs}ms)` : "";

  return (
    <Box>
      <Text>{colorFn(`  ${icon} `)}</Text>
      <Text>{colorFn(`${name}(${argsStr})${timeStr}`)}</Text>
    </Box>
  );
}
