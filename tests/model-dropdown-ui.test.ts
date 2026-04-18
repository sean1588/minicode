import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const distWeb = join(import.meta.dirname, "..", "dist", "src", "web");

test("built HTML contains model search input", () => {
  const html = readFileSync(join(distWeb, "index.html"), "utf8");
  assert.ok(html.includes('id="model-search"'), "HTML should expose a dedicated model search input");
  assert.ok(html.includes('placeholder="Search models..."'), "HTML should prompt users to search models");
});

test("built CSS contains searchable model dropdown styling", () => {
  const css = readFileSync(join(distWeb, "style.css"), "utf8");
  assert.ok(css.includes("#model-search"), "CSS should style the model search input");
  assert.ok(css.includes(".model-item-body"), "CSS should support stacked model result content");
  assert.ok(css.includes(".model-item-badge"), "CSS should style the active model badge");
});

test("built JS contains searchable model dropdown behavior", () => {
  const js = readFileSync(join(distWeb, "app.js"), "utf8");
  assert.ok(js.includes("filterModelsByQuery"), "JS should filter models by the dropdown query");
  assert.ok(js.includes("focusModelSearchInput"), "JS should focus the search field when opening the dropdown");
  assert.ok(js.includes("No matching models"), "JS should render an empty state for unmatched queries");
  assert.ok(js.includes('modelSearchInput.addEventListener("input"'), "JS should update results as the user types");
});
