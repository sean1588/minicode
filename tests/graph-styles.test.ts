import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildStylesheet, KIND_COLORS } from '../src/shared/graph-styles.js';

interface StyleEntry {
  selector: string;
  style: Record<string, unknown>;
}

describe('buildStylesheet', () => {
  const styles = buildStylesheet() as StyleEntry[];

  it('returns an array of style entries', () => {
    assert.ok(Array.isArray(styles));
    assert.ok(styles.length > 0);
  });

  it('includes base node style', () => {
    const base = styles.find((s) => s.selector === 'node');
    assert.ok(base, 'base node style should exist');
    assert.equal(base.style['shape'], 'roundrectangle');
    assert.equal(base.style['label'], 'data(label)');
  });

  it('includes base edge style', () => {
    const edge = styles.find((s) => s.selector === 'edge');
    assert.ok(edge, 'base edge style should exist');
    assert.equal(edge.style['curve-style'], 'bezier');
  });

  it('includes a style for each kind color', () => {
    for (const kind of Object.keys(KIND_COLORS)) {
      const entry = styles.find((s) => s.selector === `node.${kind}`);
      assert.ok(entry, `style for node.${kind} should exist`);
      assert.equal(entry.style['border-color'], KIND_COLORS[kind]!.border);
      assert.equal(entry.style['background-color'], KIND_COLORS[kind]!.bg);
    }
  });

  it('includes hover-target style with pointer affordance cues', () => {
    const hover = styles.find((s) => s.selector === 'node.hover-target');
    assert.ok(hover, 'hover-target style should exist');
    // Increased size signals interactivity
    assert.equal(hover.style['width'], 24, 'hover-target should enlarge node width');
    assert.equal(hover.style['height'], 24, 'hover-target should enlarge node height');
    // Thicker border for visual highlight
    assert.equal(hover.style['border-width'], 3, 'hover-target should have thicker border');
    // Overlay provides subtle glow
    assert.ok(
      (hover.style['overlay-opacity'] as number) > 0,
      'hover-target should have a visible overlay',
    );
    // Higher z-index to pop above neighbors
    assert.ok(
      (hover.style['z-index'] as number) >= 20,
      'hover-target should have high z-index',
    );
  });

  it('includes highlighted style for neighborhood nodes', () => {
    const highlighted = styles.find((s) => s.selector === 'node.highlighted');
    assert.ok(highlighted, 'highlighted style should exist');
    assert.ok(
      (highlighted.style['border-width'] as number) > 1.5,
      'highlighted should increase border width',
    );
  });

  it('includes faded style for non-neighborhood elements', () => {
    const fadedNode = styles.find((s) => s.selector === 'node.faded');
    assert.ok(fadedNode, 'faded node style should exist');
    assert.ok(
      (fadedNode.style['opacity'] as number) < 1,
      'faded nodes should reduce opacity',
    );
    const fadedEdge = styles.find((s) => s.selector === 'edge.faded');
    assert.ok(fadedEdge, 'faded edge style should exist');
  });
});
