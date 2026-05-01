import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text } from "ink";
import { HeaderBar } from "./components/header-bar.js";
import { ActivityPane } from "./components/activity-pane.js";
import { InputComposer } from "./components/input-composer.js";
import { PermissionPrompt } from "./components/permission-prompt.js";
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

  // Disable the chat input while the agent is working OR while a permission
  // prompt is active. The prompt's `useInput` hook would otherwise compete
  // with InputComposer's for keystrokes, and any non-{y,n,a,Esc} key would
  // get echoed into the chat buffer.
  const disabled =
    (state.phase !== "idle" && state.phase !== "loading") ||
    state.pendingPermission !== null;

  return (
    <Box flexDirection="column">
      <ActivityPane items={state.items} />
      <HeaderBar
        model={state.model}
        step={state.step}
        maxSteps={state.maxSteps}
        inputTokens={state.inputTokens}
        outputTokens={state.outputTokens}
        contextTokens={state.contextTokens}
        maxContextTokens={state.maxContextTokens}
        workspaceRoot={state.workspaceRoot}
        indexStatus={state.indexStatus}
      />
      {state.pendingPermission && (
        <PermissionPrompt prompt={state.pendingPermission} />
      )}
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
