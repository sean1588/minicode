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

test("permission gate: auto-allow on short-circuits mutating tools", async () => {
  const { bridge, events } = captureBridge();
  bridge.setAutoAllowWrites(true);
  // Drain the auto_allow_changed broadcast.
  events.length = 0;

  for (const tool of ["write_file", "edit_file", "run_command"]) {
    const decision = await bridge.invokeToolPermissionGateForTesting({
      name: tool,
      input: { path: "x" },
    });
    assert.deepEqual(
      decision,
      { outcome: "allow" },
      `${tool} should allow without prompting when auto-allow is on`,
    );
  }
  assert.equal(events.length, 0, "no permission_required events should be emitted");
});

test("permission gate: emits permission_required and resolves on allow", async () => {
  const { bridge, events } = captureBridge();

  const pending = bridge.invokeToolPermissionGateForTesting({
    name: "write_file",
    input: { path: "src/new.ts", content: "hello" },
  });

  // Tick the microtask queue so the promise body runs and the event lands.
  await new Promise((resolve) => setImmediate(resolve));

  const required = events.find((e) => e.type === "permission_required");
  assert.ok(required, "permission_required event should be emitted");
  assert.equal(required!.toolName, "write_file");
  assert.deepEqual(required!.input, { path: "src/new.ts", content: "hello" });

  bridge.resolvePermissionRequest(required!.requestId, {
    decision: "allow",
    rememberForSession: false,
  });

  const decision = await pending;
  assert.deepEqual(decision, { outcome: "allow" });
  assert.equal(
    bridge.getAutoAllowWrites(),
    false,
    "auto-allow should still be off when rememberForSession is false",
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

  bridge.resolvePermissionRequest(required!.requestId, {
    decision: "deny",
    rememberForSession: false,
  });

  const decision = await pending;
  assert.equal(decision.outcome, "deny");
  if (decision.outcome === "deny") {
    assert.match(decision.reason, /declined/i);
  }
});

test("permission gate: rememberForSession=true on allow flips auto-allow on", async () => {
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
    rememberForSession: true,
  });
  await pending;

  assert.equal(bridge.getAutoAllowWrites(), true);
  const broadcast = events.find((e) => e.type === "auto_allow_changed");
  assert.ok(broadcast, "auto_allow_changed should be broadcast");
  assert.equal(broadcast!.autoAllow, true);
});

test("permission gate: setAutoAllowWrites is idempotent and broadcasts only on change", () => {
  const { bridge, events } = captureBridge();

  bridge.setAutoAllowWrites(true);
  bridge.setAutoAllowWrites(true);
  bridge.setAutoAllowWrites(true);

  const broadcasts = events.filter((e) => e.type === "auto_allow_changed");
  assert.equal(broadcasts.length, 1, "duplicate sets should not re-broadcast");
  assert.equal(bridge.getAutoAllowWrites(), true);

  bridge.setAutoAllowWrites(false);
  const allBroadcasts = events.filter((e) => e.type === "auto_allow_changed");
  assert.equal(allBroadcasts.length, 2);
  assert.equal(bridge.getAutoAllowWrites(), false);
});

test("permission gate: resolving an unknown requestId is silently ignored (no throw)", () => {
  const { bridge } = captureBridge();
  // Should not throw — duplicate or stale responses are harmless.
  bridge.resolvePermissionRequest("nonexistent-id", {
    decision: "allow",
    rememberForSession: false,
  });
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

  bridge.resolvePermissionRequest(required!.requestId, {
    decision: "allow",
    rememberForSession: false,
  });
  // Second call should be ignored — promise already resolved.
  bridge.resolvePermissionRequest(required!.requestId, {
    decision: "deny",
    rememberForSession: false,
  });

  const decision = await pending;
  assert.deepEqual(decision, { outcome: "allow" });
});
