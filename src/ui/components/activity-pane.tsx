import React from "react";
import { Box, Text, useStdout } from "ink";
import { c } from "../theme.js";
import { ToolTimelineItem } from "./tool-timeline-item.js";
import type { ActivityItem } from "../events.js";

const MAX_TOOL_OUTPUT_PREVIEW = 200;

interface ActivityPaneProps {
  items: ActivityItem[];
}

function ActivityItemRow({ item }: { item: ActivityItem }): React.ReactElement {
  switch (item.type) {
    case "user":
      return (
        <Box>
          <Text bold>{c.blue("You:")} </Text>
          <Text>{item.content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column">
          <Text bold>{c.cyan("Agent:")} </Text>
          <Text>{item.content}</Text>
        </Box>
      );
    case "thinking":
      return (
        <Box flexDirection="column">
          <Text bold>{c.magenta("Thinking:")} </Text>
          <Text dimColor>{item.content}</Text>
        </Box>
      );
    case "tool_call":
      return <ToolTimelineItem item={item} />;
    case "tool_result":
      const preview =
        item.content.length > MAX_TOOL_OUTPUT_PREVIEW
          ? item.content.slice(0, MAX_TOOL_OUTPUT_PREVIEW) +
            "\n[... truncated ...]"
          : item.content;
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>{preview}</Text>
        </Box>
      );
    case "token_usage":
      return (
        <Box>
          <Text dimColor>
            tokens: {item.inputTokens} in, {item.outputTokens} out
          </Text>
        </Box>
      );
    case "system":
      return (
        <Box>
          <Text dimColor>{item.content}</Text>
        </Box>
      );
    default:
      return <Box />;
  }
}

export function ActivityPane({ items }: ActivityPaneProps): React.ReactElement {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const paneHeight = Math.max(8, terminalHeight - 10);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      paddingX={1}
      minHeight={paneHeight}
      flexGrow={1}
    >
      {items.length === 0 ? (
        <Text dimColor>Conversation will appear here. Type your request below.</Text>
      ) : (
        items.map((item, i) => (
          <Box key={`activity-${i}-${item.type}`} marginY={0}>
            <ActivityItemRow item={item} />
          </Box>
        ))
      )}
    </Box>
  );
}
