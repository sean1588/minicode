import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const distWeb = join(import.meta.dirname, '..', 'dist', 'src', 'web');

test('built CSS contains graph-onboarding styles', () => {
  const css = readFileSync(join(distWeb, 'style.css'), 'utf-8');
  assert.ok(css.includes('.graph-onboarding'), 'CSS should contain .graph-onboarding class');
  assert.ok(css.includes('.graph-onboarding-icon'), 'CSS should contain .graph-onboarding-icon class');
  assert.ok(css.includes('.graph-onboarding-title'), 'CSS should contain .graph-onboarding-title class');
  assert.ok(css.includes('.graph-onboarding-subtitle'), 'CSS should contain .graph-onboarding-subtitle class');
  assert.ok(css.includes('pointer-events: none'), 'onboarding overlay should not block interactions');
});

test('built JS contains onboarding hint logic', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  assert.ok(js.includes('graph-onboarding'), 'JS should create onboarding hint element');
  assert.ok(js.includes('showOnboardingHint'), 'JS should define showOnboardingHint function');
  assert.ok(js.includes('removeOnboardingHint'), 'JS should define removeOnboardingHint function');
});

test('built HTML contains #cy graph container', () => {
  const html = readFileSync(join(distWeb, 'index.html'), 'utf-8');
  assert.ok(html.includes('id="cy"'), 'HTML should contain the #cy graph container');
  assert.ok(html.includes('id="graph-pane"'), 'HTML should contain the #graph-pane wrapper');
});

test('onboarding hint includes user-facing guidance text in built JS', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  assert.ok(
    js.includes('Code dependency graph'),
    'onboarding title should mention the code dependency graph',
  );
  assert.ok(
    js.includes('Search for a symbol'),
    'onboarding subtitle should guide users to search',
  );
});

test('onboarding hint is re-shown on clear in built JS', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  // The clear handler should call showOnboardingHint after removing elements
  assert.ok(
    js.includes('graph-clear'),
    'JS should reference the clear button',
  );
  // Verify that showOnboardingHint appears more than once (init + clear handler)
  const matches = js.match(/showOnboardingHint/g);
  assert.ok(matches && matches.length >= 2, 'showOnboardingHint should be called at init and on clear');
});

test('onboarding hint is removed when nodes are added in built JS', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  // removeOnboardingHint should be called inside addNodeToGraph
  assert.ok(
    js.includes('removeOnboardingHint'),
    'JS should call removeOnboardingHint when adding nodes',
  );
});
