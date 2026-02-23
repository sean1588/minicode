import assert from "node:assert/strict";
import { test } from "node:test";

import { plugin } from "../src/index.js";

test("plugin has required interface", () => {
  assert.equal(typeof plugin.name, "string");
  assert.ok(Array.isArray(plugin.extensions));
  assert.equal(typeof plugin.canIndex, "function");
  assert.equal(typeof plugin.indexFile, "function");
});

test("canIndex returns true for supported extensions", () => {
  assert.equal(plugin.canIndex("file.example"), true);
  assert.equal(plugin.canIndex("path/to/file.EXAMPLE"), true);
});

test("canIndex returns false for unsupported extensions", () => {
  assert.equal(plugin.canIndex("file.ts"), false);
  assert.equal(plugin.canIndex("file.py"), false);
});

test("indexFile returns array", () => {
  const result = plugin.indexFile("sample.example", "content");
  assert.ok(Array.isArray(result));
});
