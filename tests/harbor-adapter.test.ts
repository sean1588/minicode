import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const adapterPath = path.join(repoRoot, "benchmarks", "harbor", "minicode_agent.py");
const readAdapter = () => readFile(adapterPath, "utf8");

test("Harbor adapter exposes the expected importable class and name", async () => {
  const source = await readAdapter();

  assert.match(source, /class MinicodeAgent\(BaseInstalledAgent\):/);
  assert.match(source, /def name\(\) -> str:/);
  assert.match(source, /return "minicode"/);
});

test("Harbor adapter shells out through benchmark mode with artifact outputs", async () => {
  const source = await readAdapter();

  assert.match(source, /"minicode",\s*"benchmark",\s*"run"/s);
  assert.match(source, /"--workspace-root",\s*"\."/s);
  assert.match(source, /"--out",\s*RESULT_PATH/s);
  assert.match(source, /"--diff-out",\s*PATCH_PATH/s);
  assert.match(source, /shlex\.quote\(arg\)/);
  assert.match(source, /set -o pipefail/);
});

test("Harbor adapter forwards benchmark env knobs", async () => {
  const source = await readAdapter();

  for (const [sourceKey, targetKey] of [
    ["MINICODE_BENCHMARK_MAX_STEPS", "MAX_STEPS"],
    ["MINICODE_BENCHMARK_MAX_CONTEXT_TOKENS", "MAX_CONTEXT_TOKENS"],
    ["MINICODE_BENCHMARK_MODEL_TIMEOUT_SECONDS", "MODEL_TIMEOUT_SECONDS"],
    ["MINICODE_BENCHMARK_COMMAND_TIMEOUT_MS", "COMMAND_TIMEOUT_MS"],
    ["MINICODE_BENCHMARK_MAX_TOOL_OUTPUT_CHARS", "MAX_TOOL_OUTPUT_CHARS"],
  ]) {
    assert.match(source, new RegExp(`"${sourceKey}",\\s*"${targetKey}"`));
  }
});

test("Harbor adapter defaults OpenAI-compatible runs through OpenRouter", async () => {
  const source = await readAdapter();

  assert.match(source, /DEFAULT_OPENROUTER_BASE_URL = "https:\/\/openrouter\.ai\/api\/v1"/);
  assert.match(source, /return "openai-compatible", self\._base_url or DEFAULT_OPENROUTER_BASE_URL/);
});

test("Harbor adapter documents a module import path for Harbor", async () => {
  const readme = await readFile(
    path.join(repoRoot, "benchmarks", "harbor", "README.md"),
    "utf8",
  );

  assert.match(readme, /export PYTHONPATH=\/path\/to\/minicode/);
  assert.match(readme, /--agent-import-path benchmarks\.harbor\.minicode_agent:MinicodeAgent/);
});

test("Harbor adapter installs native build prerequisites for fresh containers", async () => {
  const source = await readAdapter();

  assert.match(source, /build-essential python3/);
});

test("Harbor adapter installs Node when npm is missing from benchmark containers", async () => {
  const source = await readAdapter();

  assert.match(source, /command -v npm/);
});

test("Harbor adapter documents local tarball smoke testing", async () => {
  const readme = await readFile(
    path.join(repoRoot, "benchmarks", "harbor", "README.md"),
    "utf8",
  );

  assert.match(readme, /npm pack --pack-destination \/tmp/);
  assert.match(readme, /package_spec=http:\/\/host\.docker\.internal:18081\/sean\.holung-minicode-0\.2\.0\.tgz/);
  assert.match(readme, /reward `1\.0`/);
});
