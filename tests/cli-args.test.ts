import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CliUsageError,
  parseCliArgs,
  validateCliArgs,
} from "../src/cli/args.js";

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

test("parseCliArgs supports --json and --out path", () => {
  const parsed = parseCliArgs([
    "node",
    "src/index.ts",
    "--oneshot",
    "--json",
    "--out",
    "result.json",
    "summarize",
    "todos",
  ]);

  assert.equal(parsed.oneshot, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.outFile, "result.json");
  assert.equal(parsed.task, "summarize todos");
});

test("parseCliArgs detects benchmark run and preserves subcommand argv", () => {
  const parsed = parseCliArgs([
    "node",
    "src/index.ts",
    "benchmark",
    "run",
    "--config",
    "benchmarks/custom.json",
    "--model",
    "test-model",
    "solve task",
  ]);

  assert.equal(parsed.benchmarkRun, true);
  assert.deepEqual(parsed.benchmarkArgv, [
    "--config",
    "benchmarks/custom.json",
    "--model",
    "test-model",
    "solve task",
  ]);
  assert.equal(parsed.task, "");
});

test("parseCliArgs supports --out=<file>", () => {
  const parsed = parseCliArgs([
    "node",
    "src/index.ts",
    "--oneshot",
    "--out=result.txt",
    "do",
    "work",
  ]);

  assert.equal(parsed.outFile, "result.txt");
  assert.equal(parsed.task, "do work");
});

test("parseCliArgs rejects --out without value", () => {
  assert.throws(
    () => parseCliArgs(["node", "src/index.ts", "--oneshot", "--out"]),
    CliUsageError,
  );
});

test("validateCliArgs rejects oneshot without task", () => {
  assert.throws(
    () => validateCliArgs({ verbose: false, oneshot: true, json: false, serve: false, port: 4567, task: "" }),
    /--oneshot requires a task prompt/,
  );
});

test("validateCliArgs rejects json without oneshot", () => {
  assert.throws(
    () =>
      validateCliArgs({
        verbose: false,
        oneshot: false,
        json: true,
        serve: false,
        port: 4567,
        task: "hello",
      }),
    /only supported with --oneshot/,
  );
});

test("validateCliArgs allows non-oneshot empty task", () => {
  assert.doesNotThrow(() =>
    validateCliArgs({ verbose: false, oneshot: false, json: false, serve: false, port: 4567, task: "" }),
  );
});
