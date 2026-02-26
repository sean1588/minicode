import React from "react";
import { Box, Text, Static } from "ink";
import { c } from "../theme.js";
import { ToolTimelineItem } from "./tool-timeline-item.js";
import type { ActivityItem } from "../events.js";

const MAX_TOOL_OUTPUT_PREVIEW = 200;

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
    case "tool_result": {
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
    }
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

interface ActivityPaneProps {
  items: ActivityItem[];
}

export function ActivityPane({ items }: ActivityPaneProps): React.ReactElement {
  const completedItems = items.length > 0 ? items.slice(0, -1) : [];
  const lastItem = items.length > 0 ? items[items.length - 1] : undefined;

  return (
    <Box flexDirection="column">
      <Static items={completedItems}>
        {(item, index) => (
          <Box key={`item-${index}`}>
            <ActivityItemRow item={item} />
          </Box>
        )}
      </Static>
      {lastItem && (
        <Box key="last-item">
          <ActivityItemRow item={lastItem} />
        </Box>
      )}
    </Box>
  );
}
