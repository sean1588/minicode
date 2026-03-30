import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const distWeb = join(import.meta.dirname, "..", "dist", "src", "web");

test("built HTML contains analysis entry point and drawer shell", () => {
  const html = readFileSync(join(distWeb, "index.html"), "utf8");
  assert.ok(html.includes('id="graph-analyze"'), "HTML should contain the Analyze toolbar button");
  assert.ok(html.includes('id="analysis-panel"'), "HTML should contain the analysis panel");
  assert.ok(
    html.includes("These signals come from the dependency graph itself, not from agent judgment."),
    "HTML should explain the deterministic scope of the analysis",
  );
});

test("built CSS contains analysis drawer and finding card styles", () => {
  const css = readFileSync(join(distWeb, "style.css"), "utf8");
  assert.ok(css.includes("#analysis-panel"), "CSS should contain analysis panel styles");
  assert.ok(css.includes(".analysis-finding"), "CSS should contain finding card styles");
  assert.ok(css.includes(".analysis-summary-card"), "CSS should contain summary card styles");
  assert.ok(css.includes(".analysis-explanation"), "CSS should contain AI explanation styles");
});

test("built JS contains structural analysis loading and highlighting logic", () => {
  const js = readFileSync(join(distWeb, "app.js"), "utf8");
  assert.ok(js.includes("/api/analysis"), "JS should fetch the analysis API");
  assert.ok(js.includes("/api/analysis/explain"), "JS should call the analysis explanation API");
  assert.ok(js.includes("analysis-selected"), "JS should apply selected analysis highlight classes");
  assert.ok(js.includes("graph-derived structural signals"), "JS should surface deterministic analysis messaging");
  assert.ok(js.includes("AI interpretation"), "JS should label advisory AI interpretation distinctly");
});
