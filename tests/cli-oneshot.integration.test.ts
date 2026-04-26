import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(repoRoot, "src", "index.ts");

function runCli(args: string[]) {
  return spawnSync("node", ["--import", "tsx", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLI_UI_MODE: "legacy",
    },
    encoding: "utf8",
  });
}

test("oneshot mode exits with usage code when prompt is missing", () => {
  const result = runCli(["--oneshot"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--oneshot requires a task prompt/);
});

test("oneshot mode exits with usage code when --out has no value", () => {
  const result = runCli(["--oneshot", "--out"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--out requires a file path/);
});

test("benchmark run exits with usage code when prompt is missing", () => {
  const result = runCli(["benchmark", "run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /benchmark run requires prompt text or --prompt-file/);
});
