import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildProjectIndex } from "../src/indexer/project-index.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";

test("file watcher reindexes external Go and Python edits through loaded plugins", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minicode-watch-"));
  const bridge = new AgentBridge(() => {}, false);
  t.after(async () => {
    bridge.stopFileWatcher();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "main.go"), "package main\nfunc BeforeGo() {}\n");
  await writeFile(path.join(root, "main.py"), "def before_python(): pass\n");
  const index = await buildProjectIndex(root);
  // Exercise the watcher and real index without initializing a model client or user config.
  Object.assign(bridge, { projectIndex: index, config: { workspaceRoot: root } });
  bridge.startFileWatcher();
  await writeFile(path.join(root, "main.go"), "package main\nfunc AfterGo() {}\n");
  await writeFile(path.join(root, "main.py"), "def after_python(): pass\n");
  const deadline = Date.now() + 5000;
  while ((!index.getSymbol("AfterGo") || !index.getSymbol("after_python")) && Date.now() < deadline) {
    await delay(50);
  }
  assert.ok(index.getSymbol("AfterGo"));
  assert.ok(index.getSymbol("after_python"));
  assert.equal(index.getSymbol("BeforeGo"), undefined);
  assert.equal(index.getSymbol("before_python"), undefined);
});
