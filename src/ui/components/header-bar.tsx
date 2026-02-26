import React from "react";
import { Box, Text } from "ink";
import { c } from "../theme.js";

interface HeaderBarProps {
  model: string;
  step: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  workspaceRoot: string;
  indexStatus: string;
}

export function HeaderBar({
  model,
  step,
  maxSteps,
  inputTokens,
  outputTokens,
  workspaceRoot,
  indexStatus,
}: HeaderBarProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Box>
        <Text bold>{c.cyan("mini-coder")}</Text>
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
      </Box>
    </Box>
  );
}
