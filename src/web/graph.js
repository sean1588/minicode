// graph.js — Cytoscape-based dependency graph visualization
// Consumes /api/graph, /api/symbols, /api/focus endpoints

let cy = null;
let symbolMap = new Map();
let pinnedNames = new Set();
let initialized = false;

const KIND_COLORS = {
  function:  { border: '#7aa2f7', bg: 'rgba(122,162,247,0.15)' },
  class:     { border: '#bb9af7', bg: 'rgba(187,154,247,0.15)' },
  interface: { border: '#2ac3de', bg: 'rgba(42,195,222,0.15)' },
  type:      { border: '#e0af68', bg: 'rgba(224,175,104,0.15)' },
  variable:  { border: '#9ece6a', bg: 'rgba(158,206,106,0.15)' },
  method:    { border: '#7dcfff', bg: 'rgba(125,207,255,0.15)' },
};

const EDGE_STYLES = {
  calls:      { lineStyle: 'solid', opacity: 0.5, color: '#565f89', width: 1 },
  imports:    { lineStyle: 'dashed', opacity: 0.4, color: '#565f89', width: 1 },
  extends:    { lineStyle: 'solid', opacity: 0.7, color: '#bb9af7', width: 2 },
  implements: { lineStyle: 'dashed', opacity: 0.6, color: '#2ac3de', width: 1.5 },
  references: { lineStyle: 'dotted', opacity: 0.3, color: '#565f89', width: 1 },
};

const LAYOUT_OPTIONS = {
  name: 'fcose',
  nodeSeparation: 80,
  idealEdgeLength: 120,
  animate: true,
  animationDuration: 400,
  randomize: true,
  quality: 'default',
  nodeDimensionsIncludeLabels: true,
};

// ── Public API ──

window.initGraph = async function initGraph() {
  if (initialized) return;
  initialized = true;

  const cyEl = document.getElementById('cy');
  const detailEl = document.getElementById('symbol-detail');

  try {
    const [graphRes, symbolsRes, focusRes] = await Promise.all([
      fetch('/api/graph'),
      fetch('/api/symbols'),
      fetch('/api/focus'),
    ]);

    if (!graphRes.ok || !symbolsRes.ok) {
      cyEl.innerHTML = '<div class="graph-empty">No index available. Run minicode with a project to generate the code graph.</div>';
      return;
    }

    const graphData = await graphRes.json();
    const symbolsData = await symbolsRes.json();
    const focusData = focusRes.ok ? await focusRes.json() : { focused: [] };

    if (!graphData.nodes || graphData.nodes.length === 0) {
      cyEl.innerHTML = '<div class="graph-empty">No index available. Run minicode with a project to generate the code graph.</div>';
      return;
    }

    // Build symbol map
    const symbols = symbolsData.symbols || symbolsData;
    if (Array.isArray(symbols)) {
      for (const s of symbols) {
        symbolMap.set(s.qualifiedName || s.name, s);
      }
    }

    // Track pinned/focused
    if (focusData.focused) {
      for (const f of focusData.focused) {
        pinnedNames.add(typeof f === 'string' ? f : f.name || f.qualifiedName);
      }
    }

    // Build elements
    const elements = buildElements(graphData);

    // Auto-enable exported filter for large graphs
    const totalNodes = graphData.nodes.length;
    if (totalNodes > 200) {
      document.getElementById('graph-exported-only').checked = true;
    }

    cy = cytoscape({
      container: cyEl,
      elements: elements,
      style: buildStylesheet(),
      layout: LAYOUT_OPTIONS,
      minZoom: 0.1,
      maxZoom: 4,
      textureOnViewport: totalNodes > 200,
    });

    // Apply exported filter if checked on init
    if (document.getElementById('graph-exported-only').checked) {
      applyFilters();
    }

    setupInteractions(cy, detailEl);
    setupToolbar(cy);
    setupZoomLabelToggle(cy);

  } catch (err) {
    console.error('Graph init failed:', err);
    cyEl.innerHTML = '<div class="graph-empty">Failed to load graph data.</div>';
  }
};

window.highlightAgentActivity = function highlightAgentActivity(symbolName) {
  if (!cy) return;
  const node = cy.nodes().filter(n => {
    const name = n.data('name') || '';
    const qname = n.data('qualifiedName') || '';
    return name === symbolName || qname === symbolName || qname.endsWith('.' + symbolName);
  });
  if (node.length === 0) return;

  node.addClass('agent-pulse');
  setTimeout(() => node.removeClass('agent-pulse'), 2000);
};

// ── Element building ──

function buildElements(graphData) {
  const elements = [];
  const fileGroups = new Map();

  // Group nodes by file
  for (const node of graphData.nodes) {
    const file = node.file || node.filePath || '';
    if (!fileGroups.has(file)) fileGroups.set(file, []);
    fileGroups.get(file).push(node);
  }

  // Create compound parent nodes for files with >1 symbol
  for (const [file, nodes] of fileGroups) {
    if (nodes.length > 1 && file) {
      elements.push({
        data: {
          id: 'file:' + file,
          label: shortPath(file),
          isFileGroup: true,
        },
      });
    }
  }

  // Create symbol nodes
  for (const node of graphData.nodes) {
    const id = node.qualifiedName || node.name || node.id;
    const file = node.file || node.filePath || '';
    const fileNodes = fileGroups.get(file) || [];
    const parent = (fileNodes.length > 1 && file) ? 'file:' + file : undefined;
    const kind = (node.kind || 'function').toLowerCase();

    elements.push({
      data: {
        id: id,
        label: node.name || id.split('.').pop(),
        name: node.name,
        qualifiedName: id,
        kind: kind,
        file: file,
        exported: !!node.exported,
        parent: parent,
        startLine: node.startLine,
        endLine: node.endLine,
      },
      classes: [kind, pinnedNames.has(id) ? 'pinned' : ''].filter(Boolean).join(' '),
    });
  }

  // Create edges
  if (graphData.edges) {
    for (const edge of graphData.edges) {
      const source = edge.source || edge.from;
      const target = edge.target || edge.to;
      const kind = (edge.kind || edge.type || 'references').toLowerCase();
      elements.push({
        data: {
          id: `${source}->${target}:${kind}`,
          source: source,
          target: target,
          kind: kind,
        },
        classes: kind,
      });
    }
  }

  return elements;
}

function shortPath(filePath) {
  const parts = filePath.split('/');
  return parts.length > 2
    ? '.../' + parts.slice(-2).join('/')
    : filePath;
}

// ── Stylesheet ──

function buildStylesheet() {
  const styles = [
    // File group (compound) nodes
    {
      selector: ':parent',
      style: {
        'background-color': 'rgba(34,35,54,0.6)',
        'border-color': '#33354a',
        'border-width': 1,
        'label': 'data(label)',
        'font-size': 10,
        'color': '#565f89',
        'text-valign': 'top',
        'text-halign': 'center',
        'padding': '12px',
        'shape': 'roundrectangle',
        'font-family': "'JetBrains Mono', monospace",
      },
    },
    // Default node style
    {
      selector: 'node[!isFileGroup]',
      style: {
        'label': 'data(label)',
        'font-size': 11,
        'color': '#c0caf5',
        'text-valign': 'center',
        'text-halign': 'center',
        'width': 'label',
        'height': 28,
        'padding': '8px',
        'shape': 'roundrectangle',
        'border-width': 1.5,
        'border-color': '#565f89',
        'background-color': 'rgba(34,35,54,0.8)',
        'font-family': "'JetBrains Mono', monospace",
        'text-wrap': 'none',
      },
    },
    // Default edge style
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

  // Kind-specific node styles
  for (const [kind, colors] of Object.entries(KIND_COLORS)) {
    styles.push({
      selector: `node.${kind}`,
      style: {
        'border-color': colors.border,
        'background-color': colors.bg,
      },
    });
  }

  // Kind-specific edge styles
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

  // Pinned nodes
  styles.push({
    selector: 'node.pinned',
    style: {
      'border-color': '#e0af68',
      'border-width': 3,
    },
  });

  // Faded state (for hover highlight)
  styles.push({
    selector: 'node.faded',
    style: { 'opacity': 0.15 },
  });
  styles.push({
    selector: 'edge.faded',
    style: { 'opacity': 0.05 },
  });

  // Highlighted state
  styles.push({
    selector: 'node.highlighted',
    style: {
      'border-width': 2.5,
      'z-index': 10,
    },
  });
  styles.push({
    selector: 'edge.highlighted',
    style: {
      'opacity': 0.9,
      'width': 2,
      'z-index': 10,
    },
  });

  // Agent pulse animation
  styles.push({
    selector: 'node.agent-pulse',
    style: {
      'border-color': '#ff9e64',
      'border-width': 4,
      'background-color': 'rgba(255,158,100,0.25)',
    },
  });

  // Search match
  styles.push({
    selector: 'node.search-match',
    style: {
      'border-color': '#e0af68',
      'border-width': 2.5,
    },
  });

  return styles;
}

// ── Interactions ──

function setupInteractions(cy, detailEl) {
  // Node click → show detail panel
  cy.on('tap', 'node[!isFileGroup]', async function (evt) {
    const node = evt.target;
    showDetail(node, detailEl);
  });

  // Node hover → highlight neighborhood
  cy.on('mouseover', 'node[!isFileGroup]', function (evt) {
    const node = evt.target;
    const neighborhood = node.closedNeighborhood();
    cy.elements().not(neighborhood).addClass('faded');
    neighborhood.addClass('highlighted');
  });

  cy.on('mouseout', 'node[!isFileGroup]', function () {
    cy.elements().removeClass('faded highlighted');
  });

  // Background click → dismiss detail
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      detailEl.classList.add('hidden');
    }
  });
}

async function showDetail(node, detailEl) {
  const data = node.data();
  const sym = symbolMap.get(data.qualifiedName) || symbolMap.get(data.name) || {};
  const isPinned = pinnedNames.has(data.qualifiedName);
  const kind = data.kind || 'unknown';
  const kindColor = KIND_COLORS[kind] ? KIND_COLORS[kind].border : '#565f89';

  let html = `
    <div class="detail-header">
      <span class="detail-name">${esc(data.label)}</span>
      <span class="detail-kind-badge" style="background:${kindColor}20;color:${kindColor}">${kind}</span>
    </div>
    <div class="detail-file">${esc(data.file || 'unknown')}${data.startLine ? ':' + data.startLine : ''}</div>
  `;

  if (sym.signature) {
    html += `<pre class="detail-signature">${esc(sym.signature)}</pre>`;
  }

  html += `<button class="detail-pin header-btn" data-name="${esc(data.qualifiedName)}">${isPinned ? 'Unpin' : 'Pin to focus'}</button>`;

  // Deps and refs sections (will load async)
  html += '<div class="detail-section" id="detail-deps"><div class="detail-section-title">Dependencies</div><div class="detail-section-list">Loading...</div></div>';
  html += '<div class="detail-section" id="detail-refs"><div class="detail-section-title">References</div><div class="detail-section-list">Loading...</div></div>';

  detailEl.innerHTML = html;
  detailEl.classList.remove('hidden');

  // Pin button handler
  detailEl.querySelector('.detail-pin').addEventListener('click', async (e) => {
    const name = e.target.dataset.name;
    await togglePin(name, node, e.target);
  });

  // Load deps and refs
  loadDepsAndRefs(data.qualifiedName || data.name, detailEl);
}

async function loadDepsAndRefs(name, detailEl) {
  const encodedName = encodeURIComponent(name);

  try {
    const [depsRes, refsRes] = await Promise.all([
      fetch(`/api/symbols/${encodedName}/dependencies?depth=1`).catch(() => null),
      fetch(`/api/symbols/${encodedName}/references`).catch(() => null),
    ]);

    const depsEl = detailEl.querySelector('#detail-deps .detail-section-list');
    const refsEl = detailEl.querySelector('#detail-refs .detail-section-list');

    if (depsRes && depsRes.ok) {
      const deps = await depsRes.json();
      const items = deps.dependencies || deps || [];
      depsEl.innerHTML = items.length
        ? items.map(d => `<a class="detail-link" data-target="${esc(typeof d === 'string' ? d : d.qualifiedName || d.name)}">${esc(typeof d === 'string' ? d : d.name || d.qualifiedName)}</a>`).join('')
        : '<span class="detail-empty">None</span>';
    } else {
      depsEl.innerHTML = '<span class="detail-empty">None</span>';
    }

    if (refsRes && refsRes.ok) {
      const refs = await refsRes.json();
      const items = refs.references || refs || [];
      refsEl.innerHTML = items.length
        ? items.map(r => `<a class="detail-link" data-target="${esc(typeof r === 'string' ? r : r.qualifiedName || r.name)}">${esc(typeof r === 'string' ? r : r.name || r.qualifiedName)}</a>`).join('')
        : '<span class="detail-empty">None</span>';
    } else {
      refsEl.innerHTML = '<span class="detail-empty">None</span>';
    }

    // Make dep/ref links navigable
    detailEl.querySelectorAll('.detail-link').forEach(link => {
      link.addEventListener('click', () => {
        const target = link.dataset.target;
        navigateToNode(target);
      });
    });
  } catch {
    // Silently fail — sections just show "None"
  }
}

function navigateToNode(name) {
  if (!cy) return;
  const node = cy.nodes().filter(n =>
    n.data('qualifiedName') === name || n.data('name') === name
  );
  if (node.length) {
    cy.animate({ center: { eles: node }, zoom: 1.5 }, { duration: 300 });
    node.flashClass('highlighted', 1000);
    // Also show detail
    const detailEl = document.getElementById('symbol-detail');
    showDetail(node[0], detailEl);
  }
}

async function togglePin(name, node, btnEl) {
  const wasPinned = pinnedNames.has(name);

  try {
    await fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wasPinned
        ? { remove: [name] }
        : { add: [name] }
      ),
    });

    if (wasPinned) {
      pinnedNames.delete(name);
      node.removeClass('pinned');
      btnEl.textContent = 'Pin to focus';
    } else {
      pinnedNames.add(name);
      node.addClass('pinned');
      btnEl.textContent = 'Unpin';
    }
  } catch {
    // ignore
  }
}

// ── Toolbar ──

function setupToolbar() {
  const searchInput = document.getElementById('graph-search');
  const kindFilter = document.getElementById('graph-filter-kind');
  const exportedOnly = document.getElementById('graph-exported-only');
  const fitBtn = document.getElementById('graph-fit');
  const relayoutBtn = document.getElementById('graph-relayout');

  // Debounced search
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const query = searchInput.value.trim().toLowerCase();
      cy.nodes('[!isFileGroup]').removeClass('search-match faded');

      if (!query) return;

      const matches = cy.nodes('[!isFileGroup]').filter(n => {
        const label = (n.data('label') || '').toLowerCase();
        const qname = (n.data('qualifiedName') || '').toLowerCase();
        return label.includes(query) || qname.includes(query);
      });

      if (matches.length) {
        cy.elements().addClass('faded');
        matches.removeClass('faded').addClass('search-match');
        matches.connectedEdges().removeClass('faded');
        cy.animate({ center: { eles: matches[0] }, zoom: 1.2 }, { duration: 300 });
      }
    }, 200);
  });

  // Clear search fading on empty
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      cy.elements().removeClass('faded search-match');
    }
  });

  // Kind filter and exported-only
  kindFilter.addEventListener('change', applyFilters);
  exportedOnly.addEventListener('change', applyFilters);

  // Fit
  fitBtn.addEventListener('click', () => {
    cy.animate({ fit: { padding: 40 } }, { duration: 300 });
  });

  // Re-layout
  relayoutBtn.addEventListener('click', () => {
    cy.layout(LAYOUT_OPTIONS).run();
  });
}

function applyFilters() {
  if (!cy) return;
  const kind = document.getElementById('graph-filter-kind').value;
  const exportedOnly = document.getElementById('graph-exported-only').checked;

  cy.nodes('[!isFileGroup]').forEach(node => {
    const data = node.data();
    let visible = true;

    if (kind !== 'all' && data.kind !== kind) visible = false;
    if (exportedOnly && !data.exported) visible = false;

    if (visible) {
      node.style('display', 'element');
    } else {
      node.style('display', 'none');
    }
  });

  // Hide edges connected to hidden nodes
  cy.edges().forEach(edge => {
    const srcVisible = edge.source().style('display') !== 'none';
    const tgtVisible = edge.target().style('display') !== 'none';
    edge.style('display', (srcVisible && tgtVisible) ? 'element' : 'none');
  });

  // Hide empty file groups
  cy.nodes(':parent').forEach(parent => {
    const visibleChildren = parent.children().filter(c => c.style('display') !== 'none');
    parent.style('display', visibleChildren.length > 0 ? 'element' : 'none');
  });

  // Re-run layout on visible elements
  cy.elements().filter(e => e.style('display') !== 'none').layout({
    ...LAYOUT_OPTIONS,
    animate: true,
    animationDuration: 300,
  }).run();
}

// ── Zoom-dependent label visibility ──

function setupZoomLabelToggle(cy) {
  cy.on('zoom', () => {
    const zoom = cy.zoom();
    const fontSize = zoom < 0.5 ? 0 : 11;
    cy.nodes('[!isFileGroup]').style('font-size', fontSize);
  });
}

// ── Helpers ──

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
