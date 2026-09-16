import assert from "node:assert/strict";
import { test } from "node:test";

import { watchExtensionsFromPlugins } from "../src/serve/agent-bridge.js";
import type { LanguagePlugin } from "../src/indexer/types.js";

function plugin(name: string, extensions: string[]): LanguagePlugin {
  return {
    name,
    extensions,
    canIndex: (f) => extensions.some((e) => f.toLowerCase().endsWith(e)),
    indexFile: () => [],
  };
}

test("watchExtensionsFromPlugins covers every loaded plugin's extensions", () => {
  const exts = watchExtensionsFromPlugins([
    plugin("typescript", [".ts", ".tsx", ".js", ".jsx"]),
    plugin("python", [".py", ".pyi"]),
  ]);

  // Non-TS languages now trigger reindexing — the whole point of the change.
  assert.ok(exts.has(".py"), "should watch .py");
  assert.ok(exts.has(".pyi"), "should watch .pyi");
  assert.ok(exts.has(".ts"), "should still watch .ts");
});

test("watchExtensionsFromPlugins normalizes extensions to lowercase", () => {
  const exts = watchExtensionsFromPlugins([plugin("go", [".GO"])]);
  assert.ok(exts.has(".go"), "extension matching is case-insensitive");
});
