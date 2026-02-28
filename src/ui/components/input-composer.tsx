import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { c } from "../theme.js";

interface InputComposerProps {
  onSubmit: (input: string) => void;
  disabled?: boolean;
  onCtrlC?: (exit: () => void) => void;
}

export function InputComposer({
  onSubmit,
  disabled = false,
  onCtrlC,
}: InputComposerProps): React.ReactElement {
  const [value, setValue] = useState("");
  const { exit } = useApp();

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !disabled) {
      onSubmit(trimmed);
      setValue("");
    }
  }, [value, disabled, onSubmit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (onCtrlC) {
        onCtrlC(exit);
      } else {
        exit();
      }
      return;
    }
    if (key.ctrl && input === "l") {
      setValue("");
      return;
    }
    if (key.escape) {
      setValue("");
      return;
    }
    if (key.return) {
      handleSubmit();
      return;
    }
    if (!disabled && (key.backspace || key.delete || input === "\x7f")) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (!disabled && !key.ctrl && !key.meta && input) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Box>
        <Text bold>{c.dim("Input:")} </Text>
        <Text>{value}</Text>
        <Text>{disabled ? "" : "_"}</Text>
      </Box>
      <Box>
        <Text dimColor>
          [Enter send] [Ctrl+C cancel/quit] [Esc clear]
        </Text>
      </Box>
    </Box>
  );
}
