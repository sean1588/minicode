import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text } from "ink";
import { HeaderBar } from "./components/header-bar.js";
import { ActivityPane } from "./components/activity-pane.js";
import { InputComposer } from "./components/input-composer.js";
import { UiStore } from "./state/ui-store.js";

interface AppProps {
  store: UiStore;
  onRunTurn: (input: string) => Promise<void>;
  onCtrlC?: (exit: () => void) => void;
}

function AppInner({ store, onRunTurn, onCtrlC }: AppProps): React.ReactElement {
  const [state, setState] = useState(store.getState());

  useEffect(() => {
    const unsub = store.subscribe(() => {
      setState(store.getState());
    });
    return unsub;
  }, [store]);

  const handleSubmit = useCallback(
    (input: string) => {
      onRunTurn(input);
    },
    [onRunTurn],
  );

  const disabled = state.phase !== "idle" && state.phase !== "loading";

  return (
    <Box flexDirection="column">
      <ActivityPane items={state.items} />
      <HeaderBar
        model={state.model}
        step={state.step}
        maxSteps={state.maxSteps}
        inputTokens={state.inputTokens}
        outputTokens={state.outputTokens}
        workspaceRoot={state.workspaceRoot}
        indexStatus={state.indexStatus}
      />
      <InputComposer
        onSubmit={handleSubmit}
        disabled={disabled}
        {...(onCtrlC && { onCtrlC })}
      />
      {state.errorMessage && (
        <Box paddingX={1}>
          <Box borderStyle="single" borderColor="red" paddingX={1}>
            <Text color="red">Error: {state.errorMessage}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

export function runInkApp(
  store: UiStore,
  onRunTurn: (input: string) => Promise<void>,
  onCtrlC?: (exit: () => void) => void,
): { waitUntilExit: () => Promise<void> } {
  process.stdout.write("\x1b[2J\x1b[H");
  const instance = render(
    React.createElement(AppInner, {
      store,
      onRunTurn,
      ...(onCtrlC && { onCtrlC }),
    }),
    { exitOnCtrlC: false },
  );

  return {
    waitUntilExit: (): Promise<void> =>
      instance.waitUntilExit() as Promise<void>,
  };
}
