import assert from "node:assert/strict";
import { test } from "node:test";

import { createLatestRequestTracker } from "../src/web/request-tracker.js";

test("latest request tracker only accepts the most recent request token", () => {
  const tracker = createLatestRequestTracker();

  const first = tracker.begin();
  const second = tracker.begin();

  assert.equal(tracker.isCurrent(first), false);
  assert.equal(tracker.isCurrent(second), true);
});

test("latest request tracker treats the current token as active until superseded", () => {
  const tracker = createLatestRequestTracker();

  const token = tracker.begin();

  assert.equal(tracker.isCurrent(token), true);
});
