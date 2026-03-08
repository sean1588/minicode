import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveWorkspacePath,
  validateCommand,
  validatePath,
} from "@minicode/agent-sdk";

test("validatePath allows files within workspace", () => {
  const workspaceRoot = "/tmp/workspace";
  assert.equal(validatePath("src/index.ts", workspaceRoot), true);
});

test("validatePath rejects escape attempts", () => {
  const workspaceRoot = "/tmp/workspace";
  assert.equal(validatePath("../etc/passwd", workspaceRoot), false);
});

test("resolveWorkspacePath rejects absolute escape paths", () => {
  const workspaceRoot = "/tmp/workspace";
  assert.throws(
    () => resolveWorkspacePath("/etc/passwd", workspaceRoot),
    /outside workspace root/,
  );
});

test("validateCommand blocks denylisted commands", () => {
  assert.throws(
    () => validateCommand("rm -rf /", [/\brm\s+-rf\s+\//i]),
    /blocked by safety denylist/,
  );
});

