import assert from "node:assert/strict";
import { test } from "node:test";

import { handlePermissionsSlashCommand } from "../src/cli/permissions-slash-command.js";
import { createPermissionGate } from "../src/ui/permission-gate.js";
import { UiStore } from "../src/ui/state/ui-store.js";

test("/permissions status reports the current mode", () => {
  const store = new UiStore();

  const off = handlePermissionsSlashCommand("/permissions status", store);
  assert.equal(off.handled, true);
  assert.match(off.message ?? "", /OFF/);

  store.setAutoAllowMode("writes");
  const writes = handlePermissionsSlashCommand("/permissions status", store);
  assert.match(writes.message ?? "", /WRITES/);

  store.setAutoAllowMode("all");
  const all = handlePermissionsSlashCommand("/permissions status", store);
  assert.match(all.message ?? "", /ALL/);
});

test("/permissions with no args defaults to status", () => {
  const store = new UiStore();
  const result = handlePermissionsSlashCommand("/permissions", store);
  assert.equal(result.handled, true);
  assert.match(result.message ?? "", /OFF/);
});

test("/permissions auto MODE sets each mode", () => {
  const store = new UiStore();

  for (const mode of ["none", "writes", "commands", "all"] as const) {
    const result = handlePermissionsSlashCommand(`/permissions auto ${mode}`, store);
    assert.equal(result.handled, true);
    assert.equal(store.getAutoAllowMode(), mode);
  }
});

test("/permissions auto with bad value shows usage", () => {
  const store = new UiStore();
  store.setAutoAllowMode("writes");
  const result = handlePermissionsSlashCommand("/permissions auto maybe", store);
  assert.equal(result.handled, true);
  assert.match(result.message ?? "", /Usage/i);
  assert.equal(
    store.getAutoAllowMode(),
    "writes",
    "bad value should not change state",
  );
});

test("non-permissions input is not handled", () => {
  const store = new UiStore();
  assert.equal(handlePermissionsSlashCommand("hello", store).handled, false);
  assert.equal(handlePermissionsSlashCommand("/help", store).handled, false);
  assert.equal(
    handlePermissionsSlashCommand("/permissionsXYZ", store).handled,
    false,
    "prefix-only matches must include space or be exact",
  );
});

test("createPermissionGate: read-only tools allow without parking a prompt", async () => {
  const store = new UiStore();
  const gate = createPermissionGate(store);

  const decision = await gate({ name: "read_file", input: { path: "x" } });

  assert.deepEqual(decision, { outcome: "allow" });
  assert.equal(store.getState().pendingPermission, null);
});

test("createPermissionGate: mode 'all' short-circuits every mutating tool", async () => {
  const store = new UiStore();
  store.setAutoAllowMode("all");
  const gate = createPermissionGate(store);

  for (const name of ["write_file", "edit_file", "run_command"]) {
    const decision = await gate({ name, input: {} });
    assert.deepEqual(decision, { outcome: "allow" }, `${name} should auto-allow under 'all'`);
  }
  assert.equal(store.getState().pendingPermission, null);
});

test("createPermissionGate: mode 'writes' auto-allows write_file/edit_file but prompts run_command", async () => {
  const store = new UiStore();
  store.setAutoAllowMode("writes");
  const gate = createPermissionGate(store);

  for (const name of ["write_file", "edit_file"]) {
    const d = await gate({ name, input: {} });
    assert.deepEqual(d, { outcome: "allow" });
  }
  assert.equal(store.getState().pendingPermission, null);

  void gate({ name: "run_command", input: { command: "ls" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(store.getState().pendingPermission, "run_command should still prompt");
});

test("createPermissionGate: mode 'commands' auto-allows run_command but prompts writes", async () => {
  const store = new UiStore();
  store.setAutoAllowMode("commands");
  const gate = createPermissionGate(store);

  const cmd = await gate({ name: "run_command", input: { command: "ls" } });
  assert.deepEqual(cmd, { outcome: "allow" });
  assert.equal(store.getState().pendingPermission, null);

  void gate({ name: "write_file", input: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(store.getState().pendingPermission);
});

test("createPermissionGate: parks a pending prompt and resolves on user allow", async () => {
  const store = new UiStore();
  const gate = createPermissionGate(store);

  const pending = gate({ name: "edit_file", input: { path: "src/x.ts" } });
  await new Promise((resolve) => setImmediate(resolve));

  const prompt = store.getState().pendingPermission;
  assert.ok(prompt, "prompt should be parked on the store");
  assert.equal(prompt!.toolName, "edit_file");

  prompt!.resolve({ decision: "allow" });

  const decision = await pending;
  assert.deepEqual(decision, { outcome: "allow" });
  assert.equal(store.getState().pendingPermission, null, "prompt cleared after resolve");
  assert.equal(
    store.getAutoAllowMode(),
    "none",
    "mode unchanged when no setMode is sent",
  );
});

test("createPermissionGate: deny resolves with a reason", async () => {
  const store = new UiStore();
  const gate = createPermissionGate(store);

  const pending = gate({ name: "run_command", input: { command: "ls" } });
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = store.getState().pendingPermission;
  assert.ok(prompt);

  prompt!.resolve({ decision: "deny" });

  const decision = await pending;
  assert.equal(decision.outcome, "deny");
  if (decision.outcome === "deny") {
    assert.match(decision.reason, /declined/i);
  }
  assert.equal(store.getState().pendingPermission, null);
});

test("createPermissionGate: setMode='all' on allow flips the mode (used by [a] shortcut)", async () => {
  const store = new UiStore();
  const gate = createPermissionGate(store);

  const pending = gate({ name: "write_file", input: { path: "x" } });
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = store.getState().pendingPermission;
  assert.ok(prompt);

  prompt!.resolve({ decision: "allow", setMode: "all" });
  await pending;

  assert.equal(store.getAutoAllowMode(), "all");
});
