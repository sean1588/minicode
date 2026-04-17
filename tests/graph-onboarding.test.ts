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
  assert.ok(css.includes('.search-result-subtitle'), 'CSS should contain secondary search result text styling');
  assert.ok(css.includes('pointer-events: none'), 'onboarding overlay should not block interactions');
  assert.ok(css.includes('width: 380px;'), 'symbol detail panel should have a wider default width');
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
  assert.ok(html.includes('Search symbols or files...'), 'HTML should expose mixed symbol/file search');
  assert.ok(html.includes('id="file-preview-modal"'), 'HTML should contain the file preview modal shell');
  assert.ok(html.includes('id="file-preview-code"'), 'HTML should contain the file preview code surface');
});

test('onboarding hint includes user-facing guidance text in built JS', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  assert.ok(
    js.includes('Code dependency graph'),
    'onboarding title should mention the code dependency graph',
  );
  assert.ok(
    js.includes('Search for a symbol or file'),
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

test('built JS keeps agent activity reveals narrower than manual expansion', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  assert.ok(
    js.includes('renderNodeNeighborhoodAndLayout'),
    'JS should define a configurable graph-rendering helper',
  );
  assert.ok(
    js.includes('maxDegrees: 0'),
    'agent activity should reveal only the active symbol instead of expanding neighbors',
  );
  assert.ok(
    js.includes('maxDegrees: 1'),
    'intentional graph exploration should still render first-degree neighbors',
  );
});

test('built JS auto-opens symbol details for agent activity and graph search selection', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  assert.ok(
    js.includes('focusSymbolInGraph'),
    'JS should define a shared focus helper for graph-driven symbol selection',
  );
  assert.ok(
    js.includes('openDetail: true'),
    'JS should request the detail panel when focusing symbols from agent activity or search',
  );
  assert.ok(
    js.includes('await showDetail(node, detailEl)'),
    'JS should populate the symbol detail panel when focus requests it',
  );
});

test('built JS supports file search results and file-centered neighborhood rendering', () => {
  const js = readFileSync(join(distWeb, 'app.js'), 'utf-8');
  assert.ok(
    js.includes('focusFileInGraph'),
    'JS should define a file-focused graph seeding helper',
  );
  assert.ok(
    js.includes('buildGraphSearchResults'),
    'JS should use the shared mixed search result helper',
  );
  assert.ok(
    js.includes('el.dataset.type') && js.includes('focusFileInGraph(id)'),
    'JS should branch on file search results when handling selection',
  );
  assert.ok(
    js.includes('buildFileFocusedSelection'),
    'file-focused graph seeding should use the shared file selection helper',
  );
  assert.ok(
    js.includes('openFilePreview'),
    'JS should define a file preview helper for file search selections',
  );
  assert.ok(
    js.includes('/api/file-source?path='),
    'JS should fetch full file contents for the preview modal',
  );
  assert.ok(
    js.includes('detail-file-link'),
    'JS should wire the symbol detail filename into the preview modal',
  );
});

test('built CSS contains file preview modal sizing and link styling', () => {
  const css = readFileSync(join(distWeb, 'style.css'), 'utf-8');
  assert.ok(css.includes('.modal-panel-file-preview'), 'CSS should contain the file preview modal panel class');
  assert.ok(css.includes('width: min(1200px, 80vw);'), 'file preview modal should open at roughly 80% width');
  assert.ok(css.includes('height: 80vh;'), 'file preview modal should open at roughly 80% height');
  assert.ok(css.includes('.detail-file-link'), 'CSS should style the clickable filename in the detail panel');
});
