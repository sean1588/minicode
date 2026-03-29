import React from "react";
import { Box, Text } from "ink";
import { c } from "../theme.js";

interface HeaderBarProps {
  model: string;
  step: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  maxContextTokens: number;
  workspaceRoot: string;
  indexStatus: string;
}

export function HeaderBar({
  model,
  step,
  maxSteps,
  inputTokens,
  outputTokens,
  contextTokens,
  maxContextTokens,
  workspaceRoot,
  indexStatus,
}: HeaderBarProps): React.ReactElement {
  const contextPct =
    maxContextTokens > 0
      ? Math.min(100, Math.round((contextTokens / maxContextTokens) * 100))
      : 0;
  const contextColor =
    contextPct >= 80 ? c.red : contextPct >= 60 ? c.yellow : c.green;

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Box>
        <Text bold>{c.cyan("minicode")}</Text>
        <Text>  </Text>
        <Text>{c.dim("model:")} </Text>
        <Text>{model || "—"}</Text>
        <Text>  </Text>
        <Text>{c.dim("steps:")} </Text>
        <Text>
          {step}/{maxSteps}
        </Text>
        <Text>  </Text>
        <Text>{c.dim("tokens:")} </Text>
        <Text>
          {inputTokens} in / {outputTokens} out
        </Text>
      </Box>
      <Box>
        <Text>{c.dim("cwd:")} </Text>
        <Text>{workspaceRoot || "—"}</Text>
        <Text>  </Text>
        <Text>{c.dim("index:")} </Text>
        <Text>{indexStatus || "—"}</Text>
        <Text>  </Text>
        <Text>{c.dim("context:")} </Text>
        <Text>{contextColor(`${contextPct}%`)}</Text>
        <Text> </Text>
        <Text dimColor>
          (~{contextTokens.toLocaleString()}/{maxContextTokens.toLocaleString()})
        </Text>
      </Box>
    </Box>
  );
}
