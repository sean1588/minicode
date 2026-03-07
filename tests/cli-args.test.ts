import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs, validateCliArgs } from "../src/cli/args.js";

test("parseCliArgs parses oneshot and verbose flags", () => {
  const parsed = parseCliArgs([
    "node",
    "src/index.ts",
    "--oneshot",
    "-v",
    "Fix",
    "lint",
  ]);

  assert.equal(parsed.oneshot, true);
  assert.equal(parsed.verbose, true);
  assert.equal(parsed.task, "Fix lint");
});

test("parseCliArgs supports -1 short flag", () => {
  const parsed = parseCliArgs([
    "node",
    "src/index.ts",
    "-1",
    "refactor",
    "parser",
  ]);

  assert.equal(parsed.oneshot, true);
  assert.equal(parsed.verbose, false);
  assert.equal(parsed.task, "refactor parser");
});

test("validateCliArgs rejects oneshot without task", () => {
  assert.throws(
    () => validateCliArgs({ verbose: false, oneshot: true, task: "" }),
    /--oneshot requires a task prompt/,
  );
});

test("validateCliArgs allows non-oneshot empty task", () => {
  assert.doesNotThrow(() =>
    validateCliArgs({ verbose: false, oneshot: false, task: "" }),
  );
});
