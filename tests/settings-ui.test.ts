import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const distWeb = join(import.meta.dirname, "..", "dist", "src", "web");

test("built HTML contains settings entry point and modal shell", () => {
  const html = readFileSync(join(distWeb, "index.html"), "utf8");
  assert.ok(html.includes('id="settings-btn"'), "HTML should contain the settings button");
  assert.ok(html.includes('id="settings-modal"'), "HTML should contain the settings modal");
  assert.ok(html.includes('id="connect-openrouter-btn"'), "HTML should contain the OpenRouter connect button");
  assert.ok(html.includes("Try minicode for free with OpenRouter"), "HTML should promote the free OpenRouter quick start");
  assert.ok(html.includes('id="disconnect-openrouter-btn"'), "HTML should contain the OpenRouter disconnect button");
  assert.ok(!html.includes('id="settings-scope"'), "HTML should no longer contain the settings scope selector");
  assert.ok(html.includes('id="settings-save"'), "HTML should contain the settings save action");
});

test("built CSS contains modal and settings layout styles", () => {
  const css = readFileSync(join(distWeb, "style.css"), "utf8");
  assert.ok(css.includes(".modal-panel"), "CSS should contain modal panel styles");
  assert.ok(css.includes(".settings-list"), "CSS should contain settings list styles");
  assert.ok(css.includes(".settings-item-meta"), "CSS should contain settings metadata grid styles");
  assert.ok(css.includes(".settings-help-warning"), "CSS should contain warning styling for env overrides");
  assert.ok(css.includes(".config-overlay-spotlight"), "CSS should style the OpenRouter quick-start spotlight");
  assert.ok(css.includes(".config-connect-status.success"), "CSS should style OpenRouter connect success state");
  assert.ok(css.includes(".settings-session-banner"), "CSS should style the OpenRouter session banner");
  assert.ok(css.includes("body.modal-open"), "CSS should lock scroll while the settings modal is open");
});

test("built JS contains config loading and saving logic for settings", () => {
  const js = readFileSync(join(distWeb, "app.js"), "utf8");
  assert.ok(js.includes("/api/config"), "JS should fetch the config API");
  assert.ok(js.includes("/api/openrouter/connect"), "JS should call the OpenRouter connect API");
  assert.ok(js.includes("/api/openrouter/disconnect"), "JS should call the OpenRouter disconnect API");
  assert.ok(js.includes("code_challenge_method"), "JS should generate an OpenRouter PKCE auth request");
  assert.ok(js.includes("sessionStorage"), "JS should persist the PKCE verifier for the OAuth callback");
  assert.ok(js.includes("sessionOpenRouterConnected"), "JS should track session-only OpenRouter state");
  assert.ok(js.includes("Save settings"), "JS should contain the settings save action text");
  assert.ok(js.includes("settingsPayload"), "JS should track settings payload state");
  assert.ok(js.includes("persistedValue"), "JS should wire persisted settings behavior");
  assert.ok(js.includes("settings-help settings-help-warning"), "JS should mark env override help as warning text");
  assert.ok(js.includes("home-dotenv"), "JS should distinguish home dotenv overrides");
  assert.ok(js.includes("manage this setting here"), "JS should explain how to resolve env overrides");
});
