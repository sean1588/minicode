import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const distWeb = join(import.meta.dirname, "..", "dist", "src", "web");

test("built HTML contains update action for the current saved session", () => {
  const html = readFileSync(join(distWeb, "index.html"), "utf8");
  assert.ok(html.includes('id="session-update-row"'), "HTML should contain the session update row");
  assert.ok(html.includes('id="session-update-btn"'), "HTML should contain the session update button");
  assert.ok(html.includes('id="session-autosave-toggle"'), "HTML should contain the auto-save sessions toggle");
});

test("built CSS contains active-session styling", () => {
  const css = readFileSync(join(distWeb, "style.css"), "utf8");
  assert.ok(css.includes(".session-item.active"), "CSS should style the active saved session row");
  assert.ok(css.includes(".session-active-badge"), "CSS should style the active session badge");
  assert.ok(css.includes(".session-delete-btn"), "CSS should style the session delete button");
  assert.ok(css.includes(".session-autosave-row"), "CSS should style the auto-save toggle row");
});

test("built JS contains active saved session update logic", () => {
  const js = readFileSync(join(distWeb, "app.js"), "utf8");
  assert.ok(js.includes("activeSavedSession"), "JS should track the active saved session");
  assert.ok(js.includes("currentSessionId"), "JS should read the current session id from the sessions API");
  assert.ok(js.includes("Session updated:"), "JS should emit the update confirmation message");
  assert.ok(js.includes("sessionRefreshTracker"), "JS should guard session list refreshes against stale responses");
  assert.ok(js.includes('saveBtn.setAttribute("disabled", "true")'), "JS should disable saving while the first save is in flight");
  assert.ok(js.includes("renderLoadedSessionMessages"), "JS should render session previews after load");
  assert.ok(js.includes("body.messages"), "JS should read preview messages from the load session response");
  assert.ok(js.includes("SESSION_AUTOSAVE_KEY"), "JS should persist the auto-save preference");
  assert.ok(js.includes("window.confirm"), "JS should confirm before deleting a saved session");
  assert.ok(js.includes('method: "DELETE"'), "JS should call the delete session API");
});
