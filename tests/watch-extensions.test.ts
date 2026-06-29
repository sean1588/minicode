import assert from "node:assert/strict";
import { test } from "node:test";

import type { LanguagePlugin } from "../src/indexer/types.js";

function stubPlugin(name: string, extensions: string[]): LanguagePlugin {
  return {
    name,
    extensions,
    canIndex: (filePath) => extensions.some((e) => filePath.endsWith(e)),
    indexFile: () => [],
  };
}

test("watchExtensionsForPlugins derives the watch set from plugin extensions", async () => {
  const { watchExtensionsForPlugins } = await import(
    "../src/serve/agent-bridge.js"
  );

  const exts = watchExtensionsForPlugins([
    stubPlugin("typescript", [".ts", ".tsx", ".js", ".jsx"]),
    stubPlugin("python", [".py", ".pyi"]),
  ]);

  assert.equal(exts.has(".ts"), true);
  assert.equal(exts.has(".jsx"), true);
  assert.equal(exts.has(".py"), true);
  assert.equal(exts.has(".pyi"), true);
  // A language with no loaded plugin is not watched.
  assert.equal(exts.has(".go"), false);
});
