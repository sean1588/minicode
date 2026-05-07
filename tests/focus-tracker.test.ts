import { test } from "node:test";
import assert from "node:assert/strict";

import { FocusTracker } from "@sean.holung/minicode-sdk";

test("FocusTracker tracks added symbols", () => {
  const tracker = new FocusTracker();
  tracker.addSymbol("Foo");
  tracker.addSymbol("Bar");

  const focused = tracker.getFocusedSymbols();
  assert.equal(focused.size, 2);
  assert.ok(focused.has("Foo"));
  assert.ok(focused.has("Bar"));
});

test("FocusTracker evicts oldest symbol when exceeding limit", () => {
  const tracker = new FocusTracker();

  // Add 31 symbols (limit is 30)
  for (let i = 0; i < 31; i++) {
    tracker.addSymbol(`sym_${i}`);
  }

  const focused = tracker.getFocusedSymbols();
  assert.equal(focused.size, 30);
  // The first symbol should have been evicted
  assert.ok(!focused.has("sym_0"), "oldest symbol should be evicted");
  assert.ok(focused.has("sym_30"), "newest symbol should remain");
});

test("FocusTracker refreshes existing symbol generation on re-add", () => {
  const tracker = new FocusTracker();

  // Add initial symbols
  tracker.addSymbol("first");
  for (let i = 0; i < 29; i++) {
    tracker.addSymbol(`filler_${i}`);
  }

  // Re-add "first" to refresh its generation
  tracker.addSymbol("first");

  // Add one more to trigger eviction — "first" should survive since it was refreshed
  tracker.addSymbol("extra");

  const focused = tracker.getFocusedSymbols();
  assert.ok(focused.has("first"), "re-added symbol should survive eviction");
  assert.equal(focused.size, 30);
});

test("FocusTracker.hasFocus returns correct status", () => {
  const tracker = new FocusTracker();
  tracker.addSymbol("Foo");

  assert.ok(tracker.hasFocus("Foo"));
  assert.ok(!tracker.hasFocus("Bar"));
});

test("FocusTracker.clear resets all state", () => {
  const tracker = new FocusTracker();
  tracker.addSymbol("Foo");
  tracker.addSymbol("Bar");
  tracker.clear();

  assert.equal(tracker.getFocusedSymbols().size, 0);
  assert.ok(!tracker.hasFocus("Foo"));
});

test("FocusTracker.addSymbols adds multiple symbols at once", () => {
  const tracker = new FocusTracker();
  tracker.addSymbols(["A", "B", "C"]);

  const focused = tracker.getFocusedSymbols();
  assert.equal(focused.size, 3);
  assert.ok(focused.has("A"));
  assert.ok(focused.has("B"));
  assert.ok(focused.has("C"));
});
