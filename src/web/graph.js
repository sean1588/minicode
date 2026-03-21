// graph.js — Interactive dependency graph: search → seed → expand by clicking
// Start empty. User searches for a symbol, selects it to seed the graph.
// Clicking a node expands its 1-hop neighbors. Walk the graph in real time.

let cy = null;
let symbolMap = new Map();       // qualifiedName → symbol detail
let graphNodes = new Map();      // id → node element data (from /api/graph)
let graphEdges = [];             // all edges from /api/graph
let pinnedNames = new Set();
let allSymbolNames = [];         // for search autocomplete
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
  name: 'cose',
  nodeRepulsion: function () { return 4000; },
  idealEdgeLength: function () { return 80; },
  edgeElasticity: function () { return 100; },
  animate: true,
  animationDuration: 300,
  randomize: false,
  nodeDimensionsIncludeLabels: true,
  gravity: 0.5,
  numIter: 300,
  fit: true,
  padding: 50,
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
    const focusData = focusRes.ok ? await focusRes.json() : { pinned: [] };

    if (!graphData.nodes || graphData.nodes.length === 0) {
      cyEl.innerHTML = '<div class="graph-empty">No index available. Run minicode with a project to generate the code graph.</div>';
      return;
    }

    // Build lookup maps from full graph data
    for (const node of graphData.nodes) {
      const id = node.qualifiedName || node.id || node.name;
      graphNodes.set(id, node);
    }
    graphEdges = (graphData.edges || []).map(e => ({
      source: e.source || e.from,
      target: e.target || e.to,
      kind: (e.kind || e.type || 'references').toLowerCase(),
    }));

    // Build symbol map for detail panel
    const symbols = symbolsData.symbols || symbolsData;
    if (Array.isArray(symbols)) {
      for (const s of symbols) {
        symbolMap.set(s.qualifiedName || s.name, s);
      }
    }
    allSymbolNames = Array.from(graphNodes.keys()).sort();

    // Track pinned
    const pinned = focusData.pinned || [];
    for (const f of pinned) {
      pinnedNames.add(typeof f === 'string' ? f : f.name || f.qualifiedName);
    }

    // Create empty cytoscape instance
    cy = cytoscape({
      container: cyEl,
      elements: [],
      style: buildStylesheet(),
      minZoom: 0.2,
      maxZoom: 3,
    });
    window.cy = cy;

    setupInteractions(cy, detailEl);
    setupToolbar();

    // If there are pinned symbols, seed with those
    if (pinnedNames.size > 0) {
      for (const name of pinnedNames) {
        addNodeAndNeighbors(name);
      }
      runLayout();
    }

  } catch (err) {
    console.error('Graph init failed:', err);
    cyEl.innerHTML = `<div class="graph-empty">Failed to load graph: ${err.message || err}</div>`;
  }
};

window.highlightAgentActivity = function highlightAgentActivity(symbolName) {
  if (!cy) return;
  // If node is already in graph, pulse it
  const node = findNode(symbolName);
  if (node) {
    node.addClass('agent-pulse');
    setTimeout(() => node.removeClass('agent-pulse'), 2000);
    return;
  }
  // Otherwise, add it to the graph with neighbors
  addNodeAndNeighbors(symbolName);
  runLayout();
  const added = findNode(symbolName);
  if (added) {
    added.addClass('agent-pulse');
    setTimeout(() => added.removeClass('agent-pulse'), 2000);
  }
};

// ── Graph building (incremental) ──

function addNodeAndNeighbors(symbolId) {
  // Add the center node
  addNodeToGraph(symbolId);

  // Find all edges involving this node and add neighbors
  for (const edge of graphEdges) {
    if (edge.source === symbolId) {
      addNodeToGraph(edge.target);
      addEdgeToGraph(edge);
    } else if (edge.target === symbolId) {
      addNodeToGraph(edge.source);
      addEdgeToGraph(edge);
    }
  }
}

function addNodeToGraph(id) {
  // Skip if already in graph
  if (cy.getElementById(id).length > 0) return;

  const nodeData = graphNodes.get(id);
  if (!nodeData) return;

  const kind = (nodeData.kind || 'function').toLowerCase();
  const name = nodeData.name || id.split('.').pop();
  const file = nodeData.filePath || nodeData.file || '';

  cy.add({
    data: {
      id: id,
      label: name,
      name: name,
      qualifiedName: id,
      kind: kind,
      file: file,
      exported: !!nodeData.exported,
      startLine: nodeData.startLine,
      endLine: nodeData.endLine,
    },
    classes: [kind, pinnedNames.has(id) ? 'pinned' : ''].filter(Boolean).join(' '),
  });
}

function addEdgeToGraph(edge) {
  const edgeId = `${edge.source}->${edge.target}:${edge.kind}`;
  if (cy.getElementById(edgeId).length > 0) return;
  // Only add if both endpoints exist in graph
  if (cy.getElementById(edge.source).length === 0) return;
  if (cy.getElementById(edge.target).length === 0) return;

  cy.add({
    data: {
      id: edgeId,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
    },
    classes: edge.kind,
  });
}

function runLayout() {
  if (!cy || cy.nodes().length === 0) return;
  cy.layout(LAYOUT_OPTIONS).run();
}

function findNode(name) {
  const node = cy.getElementById(name);
  if (node.length > 0) return node;
  // Try matching by short name
  const match = cy.nodes().filter(n => {
    const nName = n.data('name') || '';
    const qName = n.data('qualifiedName') || '';
    return nName === name || qName.endsWith('.' + name);
  });
  return match.length > 0 ? match : null;
}

// ── Stylesheet ──

function buildStylesheet() {
  const styles = [
    {
      selector: 'node',
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

  return styles;
}

// ── Interactions ──

function setupInteractions(cy, detailEl) {
  // Node click → expand neighbors + show detail
  cy.on('tap', 'node', function (evt) {
    const node = evt.target;
    const id = node.data('qualifiedName') || node.data('id');

    // Expand 1-hop neighbors if not already expanded
    if (!node.hasClass('expanded')) {
      addNodeAndNeighbors(id);
      node.addClass('expanded');
      // Also add edges between existing nodes that we may have missed
      connectExistingNodes();
      runLayout();
    }

    showDetail(node, detailEl);
  });

  // Node hover → highlight neighborhood
  cy.on('mouseover', 'node', function (evt) {
    const node = evt.target;
    const neighborhood = node.closedNeighborhood();
    cy.elements().not(neighborhood).addClass('faded');
    neighborhood.addClass('highlighted');
  });

  cy.on('mouseout', 'node', function () {
    cy.elements().removeClass('faded highlighted');
  });

  // Background click → dismiss detail
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      detailEl.classList.add('hidden');
    }
  });
}

// Add any edges between nodes already in the graph
function connectExistingNodes() {
  const nodeIds = new Set(cy.nodes().map(n => n.id()));
  for (const edge of graphEdges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      addEdgeToGraph(edge);
    }
  }
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

  html += `<div id="detail-source"><div class="detail-section-title">Source</div><pre class="detail-code">Loading...</pre></div>`;

  html += `<button class="detail-pin header-btn" data-name="${esc(data.qualifiedName)}">${isPinned ? 'Unpin' : 'Pin to focus'}</button>`;

  html += '<div class="detail-section" id="detail-deps"><div class="detail-section-title">Dependencies</div><div class="detail-section-list">Loading...</div></div>';
  html += '<div class="detail-section" id="detail-refs"><div class="detail-section-title">References</div><div class="detail-section-list">Loading...</div></div>';

  detailEl.innerHTML = '<div class="resize-handle"></div>' + html;
  detailEl.classList.remove('hidden');

  // Setup resize handle drag
  const handle = detailEl.querySelector('.resize-handle');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX = e.clientX;
    const startWidth = detailEl.offsetWidth;
    function onMove(e) {
      const newWidth = startWidth - (e.clientX - startX);
      detailEl.style.width = Math.max(200, newWidth) + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  detailEl.querySelector('.detail-pin').addEventListener('click', async (e) => {
    const name = e.target.dataset.name;
    await togglePin(name, node, e.target);
  });

  loadSource(data.qualifiedName || data.name, detailEl);
  loadDepsAndRefs(data.qualifiedName || data.name, detailEl);
}

async function loadSource(name, detailEl) {
  const codeEl = detailEl.querySelector('#detail-source .detail-code');
  if (!codeEl) return;
  try {
    const res = await fetch(`/api/symbols/${encodeURIComponent(name)}/source`);
    if (res.ok) {
      const data = await res.json();
      // Detect language from file extension
      const ext = (data.filePath || '').split('.').pop() || '';
      const langMap = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript' };
      const lang = langMap[ext] || 'typescript';
      codeEl.className = 'detail-code language-' + lang;
      codeEl.textContent = data.source;
      if (typeof hljs !== 'undefined') {
        hljs.highlightElement(codeEl);
      }
    } else {
      codeEl.textContent = '(source unavailable)';
    }
  } catch {
    codeEl.textContent = '(source unavailable)';
  }
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
        ? items.map(r => {
            const id = typeof r === 'string' ? r : r.from || r.qualifiedName || r.name;
            const label = id.split('.').pop();
            return `<a class="detail-link" data-target="${esc(id)}">${esc(label)} <span style="opacity:0.5">${esc(r.kind || '')}</span></a>`;
          }).join('')
        : '<span class="detail-empty">None</span>';
    } else {
      refsEl.innerHTML = '<span class="detail-empty">None</span>';
    }

    // Clicking a dep/ref link adds it to the graph and navigates
    detailEl.querySelectorAll('.detail-link').forEach(link => {
      link.addEventListener('click', () => {
        const target = link.dataset.target;
        addNodeAndNeighbors(target);
        connectExistingNodes();
        runLayout();
        const node = cy.getElementById(target);
        if (node.length) {
          cy.animate({ center: { eles: node }, zoom: 1.5 }, { duration: 300 });
          node.flashClass('highlighted', 1000);
          showDetail(node, detailEl);
        }
      });
    });
  } catch {
    // Silently fail
  }
}

async function togglePin(name, node, btnEl) {
  const wasPinned = pinnedNames.has(name);

  try {
    await fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: wasPinned ? 'unpin' : 'pin',
        symbol: name,
      }),
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
  const fitBtn = document.getElementById('graph-fit');
  const relayoutBtn = document.getElementById('graph-relayout');
  const clearBtn = document.getElementById('graph-clear');

  // Search: show dropdown of matching symbol names
  let searchTimeout;
  let dropdown = document.createElement('div');
  dropdown.className = 'search-dropdown hidden';
  searchInput.parentNode.style.position = 'relative';
  searchInput.parentNode.appendChild(dropdown);

  // Rank symbols: exported first, then alphabetical by short name
  const rankedSymbols = allSymbolNames.slice().sort((a, b) => {
    const nodeA = graphNodes.get(a);
    const nodeB = graphNodes.get(b);
    const expA = nodeA ? nodeA.exported : false;
    const expB = nodeB ? nodeB.exported : false;
    if (expA !== expB) return expA ? -1 : 1;
    const nameA = a.split('.').pop().toLowerCase();
    const nameB = b.split('.').pop().toLowerCase();
    return nameA.localeCompare(nameB);
  });

  function showDropdownResults(matches) {
    if (matches.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }

    dropdown.innerHTML = matches.map(name => {
      const node = graphNodes.get(name);
      const kind = node ? (node.kind || '').toLowerCase() : '';
      const shortName = name.split('.').pop();
      const kindColor = KIND_COLORS[kind] ? KIND_COLORS[kind].border : '#565f89';
      return `<div class="search-result" data-id="${esc(name)}">
        <span class="search-result-name">${esc(shortName)}</span>
        <span class="search-result-kind" style="color:${kindColor}">${kind}</span>
      </div>`;
    }).join('');

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        addNodeAndNeighbors(id);
        connectExistingNodes();
        runLayout();
        searchInput.value = '';
        dropdown.classList.add('hidden');

        const node = cy.getElementById(id);
        if (node.length) {
          setTimeout(() => {
            cy.animate({ center: { eles: node }, zoom: 1.2 }, { duration: 300 });
            node.flashClass('highlighted', 1500);
          }, 350);
        }
      });
    });
  }

  // Show top-ranked symbols on focus
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length < 2) {
      showDropdownResults(rankedSymbols.slice(0, 20));
    }
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const query = searchInput.value.trim().toLowerCase();
      if (query.length < 2) {
        showDropdownResults(rankedSymbols.slice(0, 20));
        return;
      }

      const matches = rankedSymbols.filter(name => {
        const shortName = name.split('.').pop().toLowerCase();
        return shortName.includes(query) || name.toLowerCase().includes(query);
      }).slice(0, 15);

      showDropdownResults(matches);
    }, 150);
  });

  // Close dropdown on escape or outside click
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      dropdown.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  // Fit
  fitBtn.addEventListener('click', () => {
    if (cy.nodes().length > 0) {
      cy.fit(40);
    }
  });

  // Re-layout
  relayoutBtn.addEventListener('click', () => {
    runLayout();
  });

  // Clear
  clearBtn.addEventListener('click', () => {
    cy.elements().remove();
    document.getElementById('symbol-detail').classList.add('hidden');
  });
}

// ── Helpers ──

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
