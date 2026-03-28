// graph-styles.ts — Pure style definitions for the Cytoscape graph.
// Extracted so they can be tested without browser globals.

export interface KindColor {
  border: string;
  bg: string;
}

export interface EdgeStyle {
  lineStyle: string;
  opacity: number;
  color: string;
  width: number;
}

export const KIND_COLORS: Record<string, KindColor> = {
  function:  { border: '#7aa2f7', bg: 'rgba(122,162,247,0.15)' },
  class:     { border: '#bb9af7', bg: 'rgba(187,154,247,0.15)' },
  interface: { border: '#2ac3de', bg: 'rgba(42,195,222,0.15)' },
  type:      { border: '#e0af68', bg: 'rgba(224,175,104,0.15)' },
  variable:  { border: '#9ece6a', bg: 'rgba(158,206,106,0.15)' },
  method:    { border: '#7dcfff', bg: 'rgba(125,207,255,0.15)' },
};

export const EDGE_STYLES: Record<string, EdgeStyle> = {
  calls:      { lineStyle: 'solid', opacity: 0.5, color: '#565f89', width: 1 },
  imports:    { lineStyle: 'dashed', opacity: 0.4, color: '#565f89', width: 1 },
  extends:    { lineStyle: 'solid', opacity: 0.7, color: '#bb9af7', width: 2 },
  implements: { lineStyle: 'dashed', opacity: 0.6, color: '#2ac3de', width: 1.5 },
  references: { lineStyle: 'dotted', opacity: 0.3, color: '#565f89', width: 1 },
};

export function buildStylesheet(): unknown[] {
  const styles: unknown[] = [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'font-size': 11,
        'color': '#c0caf5',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 5,
        'width': 20,
        'height': 20,
        'shape': 'roundrectangle',
        'border-width': 1.5,
        'border-color': '#565f89',
        'background-color': 'rgba(34,35,54,0.8)',
        'font-family': "'JetBrains Mono', monospace",
        'text-wrap': 'none',
      },
    },
    {
      selector: 'edge',
      style: {
        'width': 1,
        'line-color': '#565f89',
        'target-arrow-color': '#565f89',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.6,
        'curve-style': 'bezier',
        'opacity': 0.4,
      },
    },
  ];

  for (const [kind, colors] of Object.entries(KIND_COLORS)) {
    styles.push({
      selector: `node.${kind}`,
      style: {
        'color': colors.border,
        'border-color': colors.border,
        'background-color': colors.bg,
      },
    });
  }

  for (const [kind, s] of Object.entries(EDGE_STYLES)) {
    styles.push({
      selector: `edge.${kind}`,
      style: {
        'line-style': s.lineStyle,
        'line-color': s.color,
        'target-arrow-color': s.color,
        'opacity': s.opacity,
        'width': s.width,
      },
    });
  }

  styles.push({ selector: 'node.pinned', style: { 'border-color': '#e0af68', 'border-width': 3 } });
  styles.push({ selector: 'node.faded', style: { 'opacity': 0.15 } });
  styles.push({ selector: 'edge.faded', style: { 'opacity': 0.05 } });
  styles.push({ selector: 'node.highlighted', style: { 'border-width': 2.5, 'z-index': 10 } });
  styles.push({ selector: 'edge.highlighted', style: { 'opacity': 0.9, 'width': 2, 'z-index': 10 } });
  styles.push({ selector: 'node.agent-pulse', style: { 'border-color': '#ff9e64', 'border-width': 4, 'background-color': 'rgba(255,158,100,0.25)' } });
  styles.push({ selector: 'node.search-match', style: { 'border-color': '#e0af68', 'border-width': 2.5 } });
  styles.push({ selector: 'node.expanded', style: { 'border-width': 2.5 } });
  styles.push({ selector: 'node.hover-target', style: { 'border-width': 3, 'width': 24, 'height': 24, 'overlay-color': '#c0caf5', 'overlay-opacity': 0.08, 'z-index': 20 } });

  return styles;
}
