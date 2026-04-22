import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETUP_INTRO, deriveSetupOverlayState } from "../src/web/setup-overlay-state.js";

test("fresh install hides MODEL missing copy until a provider is configured", () => {
  const state = deriveSetupOverlayState({
    configuredProvider: null,
    missing: ["MODEL is not set"],
  });

  assert.equal(state.introText, DEFAULT_SETUP_INTRO);
  assert.equal(state.hideQuickConnects, false);
  assert.equal(state.hideOpenRouterSpotlight, false);
  assert.deepEqual(state.missingItems, []);
  assert.equal(state.showModelSelectionHint, false);
  assert.equal(state.modelSelectionNote, null);
});

test("configured OpenAI-compatible provider keeps model guidance visible", () => {
  const state = deriveSetupOverlayState({
    configuredProvider: "openai-compatible",
    missing: ["MODEL is not set"],
  });

  assert.equal(
    state.introText,
    "An OpenAI-compatible provider is already configured. Select a model to continue:",
  );
  assert.equal(state.hideQuickConnects, true);
  assert.equal(state.hideOpenRouterSpotlight, false);
  assert.deepEqual(state.missingItems, ["MODEL is not set"]);
  assert.equal(state.showModelSelectionHint, true);
  assert.equal(state.modelSelectionNote, null);
});

test("configured OpenRouter provider keeps model guidance and hides spotlight", () => {
  const state = deriveSetupOverlayState({
    configuredProvider: "openrouter",
    missing: ["MODEL is not set"],
  });

  assert.equal(
    state.introText,
    "OpenRouter is already configured. Select a model to continue:",
  );
  assert.equal(state.hideQuickConnects, true);
  assert.equal(state.hideOpenRouterSpotlight, true);
  assert.deepEqual(state.missingItems, ["MODEL is not set"]);
  assert.equal(state.showModelSelectionHint, true);
  assert.equal(
    state.modelSelectionNote,
    'If you are on the OpenRouter free tier, search "free" in the model dropdown to find supported free models.',
  );
});

test("non-model missing items still surface before provider selection", () => {
  const state = deriveSetupOverlayState({
    configuredProvider: null,
    missing: ["SOME_OTHER_SETTING is not set"],
  });

  assert.equal(state.introText, DEFAULT_SETUP_INTRO);
  assert.deepEqual(state.missingItems, ["SOME_OTHER_SETTING is not set"]);
  assert.equal(state.showModelSelectionHint, false);
  assert.equal(state.modelSelectionNote, null);
});
