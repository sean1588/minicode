import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentBridge } from "../src/serve/agent-bridge.js";
import type { ServerMessage } from "../src/serve/types.js";

function captureBridge(): {
  bridge: AgentBridge;
  events: ServerMessage[];
} {
  const events: ServerMessage[] = [];
  const bridge = new AgentBridge((msg) => events.push(msg), false);
  return { bridge, events };
}

test("permission gate: read-only tools bypass entirely (no event, immediate allow)", async () => {
  const { bridge, events } = captureBridge();

  const decision = await bridge.invokeToolPermissionGateForTesting({
    name: "read_file",
    input: { path: "src/foo.ts" },
  });

  assert.deepEqual(decision, { outcome: "allow" });
  assert.equal(events.length, 0, "no event should be emitted for read_file");
});

test("permission gate: search and other read-only tools bypass too", async () => {
  const { bridge, events } = captureBridge();

  for (const tool of ["search", "list_files", "find_references", "get_dependencies"]) {
    const decision = await bridge.invokeToolPermissionGateForTesting({
      name: tool,
      input: {},
    });
    assert.equal(decision.outcome, "allow", `${tool} should allow without prompting`);
  }
  assert.equal(events.length, 0);
});

test("permission gate: mode 'all' short-circuits every gated tool", async () => {
  const { bridge, events } = captureBridge();
  bridge.setAutoAllowMode("all");
  events.length = 0;

  for (const tool of ["write_file", "edit_file", "run_command"]) {
    const decision = await bridge.invokeToolPermissionGateForTesting({
      name: tool,
      input: { path: "x" },
    });
    assert.deepEqual(
      decision,
      { outcome: "allow" },
      `${tool} should allow without prompting when mode is 'all'`,
    );
  }
  assert.equal(events.length, 0, "no permission_required events should be emitted");
});

test("permission gate: mode 'writes' auto-allows write_file/edit_file but still prompts run_command", async () => {
  const { bridge, events } = captureBridge();
  bridge.setAutoAllowMode("writes");
  events.length = 0;

  for (const tool of ["write_file", "edit_file"]) {
    const decision = await bridge.invokeToolPermissionGateForTesting({
      name: tool,
      input: {},
    });
    assert.deepEqual(decision, { outcome: "allow" }, `${tool} should auto-allow under 'writes'`);
  }
  assert.equal(events.length, 0, "no events for auto-allowed tools");

  // run_command should still prompt.
  void bridge.invokeToolPermissionGateForTesting({
    name: "run_command",
    input: { command: "ls" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required, "run_command should still prompt under 'writes'");
});

test("permission gate: mode 'commands' auto-allows run_command but still prompts write_file/edit_file", async () => {
  const { bridge, events } = captureBridge();
  bridge.setAutoAllowMode("commands");
  events.length = 0;

  const cmd = await bridge.invokeToolPermissionGateForTesting({
    name: "run_command",
    input: { command: "ls" },
  });
  assert.deepEqual(cmd, { outcome: "allow" });

  void bridge.invokeToolPermissionGateForTesting({
    name: "write_file",
    input: { path: "x" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required, "write_file should still prompt under 'commands'");
});

test("permission gate: emits permission_required and resolves on allow", async () => {
  const { bridge, events } = captureBridge();

  const pending = bridge.invokeToolPermissionGateForTesting({
    name: "write_file",
    input: { path: "src/new.ts", content: "hello" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required, "permission_required event should be emitted");
  assert.equal(required!.toolName, "write_file");
  assert.deepEqual(required!.input, { path: "src/new.ts", content: "hello" });

  bridge.resolvePermissionRequest(required!.requestId, { decision: "allow" });

  const decision = await pending;
  assert.deepEqual(decision, { outcome: "allow" });
  assert.equal(
    bridge.getAutoAllowMode(),
    "none",
    "mode should still be 'none' when no setAutoAllowMode was sent",
  );
});

test("permission gate: deny resolves with reason fed back to the model", async () => {
  const { bridge, events } = captureBridge();

  const pending = bridge.invokeToolPermissionGateForTesting({
    name: "run_command",
    input: { command: "rm -rf /tmp/x" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required);

  bridge.resolvePermissionRequest(required!.requestId, { decision: "deny" });

  const decision = await pending;
  assert.equal(decision.outcome, "deny");
  if (decision.outcome === "deny") {
    assert.match(decision.reason, /declined/i);
  }
});

test("permission gate: setAutoAllowMode on allow flips the mode and broadcasts", async () => {
  const { bridge, events } = captureBridge();

  const pending = bridge.invokeToolPermissionGateForTesting({
    name: "write_file",
    input: { path: "x" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required);

  bridge.resolvePermissionRequest(required!.requestId, {
    decision: "allow",
    setAutoAllowMode: "all",
  });
  await pending;

  assert.equal(bridge.getAutoAllowMode(), "all");
  const broadcast = events.find((e) => e.type === "auto_allow_mode_changed");
  assert.ok(broadcast, "auto_allow_mode_changed should be broadcast");
  assert.equal(broadcast!.mode, "all");
});

test("permission gate: setAutoAllowMode is idempotent and broadcasts only on change", () => {
  const { bridge, events } = captureBridge();

  bridge.setAutoAllowMode("all");
  bridge.setAutoAllowMode("all");
  bridge.setAutoAllowMode("all");

  const broadcasts = events.filter((e) => e.type === "auto_allow_mode_changed");
  assert.equal(broadcasts.length, 1, "duplicate sets should not re-broadcast");
  assert.equal(bridge.getAutoAllowMode(), "all");

  bridge.setAutoAllowMode("writes");
  const allBroadcasts = events.filter((e) => e.type === "auto_allow_mode_changed");
  assert.equal(allBroadcasts.length, 2);
  assert.equal(bridge.getAutoAllowMode(), "writes");
});

test("permission gate: resolving an unknown requestId is silently ignored (no throw)", () => {
  const { bridge } = captureBridge();
  bridge.resolvePermissionRequest("nonexistent-id", { decision: "allow" });
});

test("permission gate: duplicate response for same requestId is ignored", async () => {
  const { bridge, events } = captureBridge();

  const pending = bridge.invokeToolPermissionGateForTesting({
    name: "write_file",
    input: { path: "x" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required);

  bridge.resolvePermissionRequest(required!.requestId, { decision: "allow" });
  // Second call should be ignored — promise already resolved.
  bridge.resolvePermissionRequest(required!.requestId, { decision: "deny" });

  const decision = await pending;
  assert.deepEqual(decision, { outcome: "allow" });
});
