import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ensureStepWithinLimit,
  formatStepLimitMessage,
  isDestructiveCommand,
  resolveWorkspacePath,
  validateCommand,
  validateFileReadSize,
  validatePath,
} from "../src/safety/guardrails.js";

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

test("resolveWorkspacePath resolves relative paths", () => {
  const workspaceRoot = "/tmp/workspace";
  const result = resolveWorkspacePath("src/index.ts", workspaceRoot);
  assert.equal(result, "/tmp/workspace/src/index.ts");
});

test("validateCommand blocks denylisted commands", () => {
  assert.throws(
    () => validateCommand("rm -rf /", [/\brm\s+-rf\s+\//i]),
    /blocked by safety denylist/,
  );
});

test("validateCommand allows non-denylisted commands", () => {
  assert.doesNotThrow(
    () => validateCommand("ls -la", [/\brm\s+-rf\s+\//i]),
  );
});

test("isDestructiveCommand detects rm -rf", () => {
  assert.equal(isDestructiveCommand("rm -rf ."), true);
});

test("isDestructiveCommand detects git reset --hard", () => {
  assert.equal(isDestructiveCommand("git reset --hard HEAD~1"), true);
});

test("isDestructiveCommand returns false for safe commands", () => {
  assert.equal(isDestructiveCommand("npm test"), false);
});

test("ensureStepWithinLimit throws at limit", () => {
  assert.throws(
    () => ensureStepWithinLimit(10, 10),
    /turn call limit/,
  );
});

test("ensureStepWithinLimit allows steps below limit", () => {
  assert.doesNotThrow(() => ensureStepWithinLimit(5, 10));
});

test("formatStepLimitMessage explains how to continue and adjust the limit", () => {
  const message = formatStepLimitMessage(10);
  assert.match(message, /Type "continue"/);
  assert.match(message, /Settings/);
  assert.match(message, /maxSteps/);
});

test("validateFileReadSize throws for oversized files", () => {
  assert.throws(
    () => validateFileReadSize(2_000_000, 1_000_000),
    /File too large/,
  );
});

test("validateFileReadSize allows files within limit", () => {
  assert.doesNotThrow(() => validateFileReadSize(500_000, 1_000_000));
});
