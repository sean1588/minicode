import React, { useState, useEffect, useCallback } from "react";
import { render, Box } from "ink";
import { HeaderBar } from "./components/header-bar.js";
import { ActivityPane } from "./components/activity-pane.js";
import { InputComposer } from "./components/input-composer.js";
import { UiStore } from "./state/ui-store.js";

interface AppProps {
  store: UiStore;
  onRunTurn: (input: string) => Promise<void>;
}

function AppInner({ store, onRunTurn }: AppProps): React.ReactElement {
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
    <Box flexDirection="column" padding={1}>
      <HeaderBar
        model={state.model}
        step={state.step}
        maxSteps={state.maxSteps}
        inputTokens={state.inputTokens}
        outputTokens={state.outputTokens}
        workspaceRoot={state.workspaceRoot}
        indexStatus={state.indexStatus}
      />
      <Box marginY={1} />
      <ActivityPane items={state.activityItems} />
      <Box marginY={1} />
      <InputComposer onSubmit={handleSubmit} disabled={disabled} />
      {state.errorMessage && (
        <Box marginY={1}>
          <Box borderStyle="single" borderColor="red" paddingX={1}>
            Error: {state.errorMessage}
          </Box>
        </Box>
      )}
    </Box>
  );
}

export function runInkApp(
  store: UiStore,
  onRunTurn: (input: string) => Promise<void>,
): { waitUntilExit: () => Promise<void> } {
  const instance = render(
    React.createElement(AppInner, {
      store,
      onRunTurn,
    }),
  );

  return {
    waitUntilExit: (): Promise<void> =>
      instance.waitUntilExit() as Promise<void>,
  };
}
