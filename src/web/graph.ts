// graph.ts — Interactive dependency graph: search -> seed -> expand by clicking
// Start empty. User searches for a symbol, selects it to seed the graph.
// Clicking a node expands its 1-hop neighbors. Walk the graph in real time.

import { escapeHtml, renderMarkdownInto } from './utils.ts';
import {
  buildFindingGraphContext,
  buildFindingMetricChips,
  countFindingsByType,
  findingSeverityLabel,
  findingTypeLabel,
  type StructuralAnalysisReport,
} from './analysis-helpers.ts';
import { KIND_COLORS, buildStylesheet } from '../shared/graph-styles.ts';

declare const cytoscape: (opts: unknown) => CyInstance;
declare const hljs: { highlightElement(el: HTMLElement): void };

interface CyInstance {
  getElementById(id: string): CyCollection;
  nodes(): CyCollection;
  elements(): CyCollection;
  add(def: unknown): CyCollection;
  layout(opts: Record<string, unknown>): { run(): void };
  fit(padding?: number): void;
  animate(target: unknown, opts: unknown): void;
  resize(): void;
  container(): HTMLElement;
  on(event: string, handler: (evt: CyEvent) => void): void;
  on(event: string, selector: string, handler: (evt: CyEvent) => void): void;
}

interface CyCollection {
  length: number;
  data(key: string): unknown;
  id(): string;
  map<T>(fn: (el: CyElement) => T): T[];
  filter(fn: (el: CyElement) => boolean): CyCollection;
  not(other: CyCollection): CyCollection;
  closedNeighborhood(): CyCollection;
  addClass(cls: string): CyCollection;
  removeClass(cls: string): CyCollection;
  hasClass(cls: string): boolean;
  flashClass(cls: string, duration: number): void;
  remove(): void;
}

interface CyElement {
  data(key: string): unknown;
  id(): string;
}

interface CyEvent {
  target: CyCollection & CyInstance;
}

interface GraphNode {
  id?: string;
  name?: string;
  qualifiedName?: string;
  kind?: string;
  filePath?: string;
  file?: string;
  exported?: boolean;
  startLine?: number;
  endLine?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

interface RawEdge {
  source?: string;
  from?: string;
  target?: string;
  to?: string;
  kind?: string;
  type?: string;
}

let cy: CyInstance | null = null;
const graphNodes = new Map<string, GraphNode>();
let graphEdges: GraphEdge[] = [];
// Adjacency index: node id → edges touching that node (O(1) neighbor lookup)
const edgeIndex = new Map<string, GraphEdge[]>();
const pinnedNames = new Set<string>();
let allSymbolNames: string[] = [];
let initialized = false;
let analysisReport: StructuralAnalysisReport | null = null;
let activeAnalysisFindingId: string | null = null;
const analysisExplanationCache = new Map<string, string>();

const LAYOUT_OPTIONS: Record<string, unknown> = {
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

// -- Public API --

export async function initGraph(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const cyEl = document.getElementById('cy')!;
  const detailEl = document.getElementById('symbol-detail')!;

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
    const focusData = focusRes.ok ? await focusRes.json() : { pinned: [] };

    if (!graphData.nodes || graphData.nodes.length === 0) {
      cyEl.innerHTML = '<div class="graph-empty">No index available. Run minicode with a project to generate the code graph.</div>';
      return;
    }

    // Build lookup maps from full graph data
    for (const node of graphData.nodes as GraphNode[]) {
      const id = node.qualifiedName || node.id || node.name || '';
      graphNodes.set(id, node);
    }
    graphEdges = ((graphData.edges || []) as RawEdge[]).map((e) => ({
      source: e.source || e.from || '',
      target: e.target || e.to || '',
      kind: (e.kind || e.type || 'references').toLowerCase(),
    }));
    buildEdgeIndex();

    allSymbolNames = Array.from(graphNodes.keys()).sort();

    // Track pinned
    const pinned: unknown[] = focusData.pinned || [];
    for (const f of pinned) {
      const name = typeof f === 'string' ? f : (f as Record<string, string>).name || (f as Record<string, string>).qualifiedName;
      if (name) pinnedNames.add(name);
    }

    // Create empty cytoscape instance
    cy = cytoscape({
      container: cyEl,
      elements: [],
      style: buildStylesheet(),
      minZoom: 0.2,
      maxZoom: 3,
    });
    setupInteractions(cy, detailEl);
    setupToolbar();

    // If there are pinned symbols, seed with those; otherwise show onboarding hint
    if (pinnedNames.size > 0) {
      for (const name of pinnedNames) {
        addNodeNeighborhood(name, 1);
      }
      runLayout();
    } else {
      showOnboardingHint(cyEl);
    }

  } catch (err) {
    console.error('Graph init failed:', err);
    const msg = err instanceof Error ? err.message : String(err);
    cyEl.innerHTML = `<div class="graph-empty">Failed to load graph: ${msg}</div>`;
  }
}

export function highlightAgentActivity(symbolName: string): void {
  if (!cy) return;
  void focusSymbolInGraph(symbolName, {
    maxDegrees: 0,
    pulse: true,
    pulseDuration: 2000,
    animate: false,
    openDetail: true,
  });
}

/** Resize the Cytoscape canvas (call after pane resize). */
export function resizeGraph(): void {
  if (cy) cy.resize();
}

// -- Graph building (incremental) --

function showOnboardingHint(container: HTMLElement): void {
  if (container.querySelector('.graph-onboarding')) return;
  const hint = document.createElement('div');
  hint.className = 'graph-onboarding';
  hint.innerHTML =
    '<div class="graph-onboarding-icon">&#9670; &#8212; &#9670;</div>' +
    '<div class="graph-onboarding-title">Code dependency graph</div>' +
    '<div class="graph-onboarding-subtitle">Search for a symbol above to start exploring.<br/>Nodes expand on click to reveal connections.</div>';
  container.appendChild(hint);
}

function removeOnboardingHint(): void {
  const hint = document.querySelector('.graph-onboarding');
  if (hint) hint.remove();
}

function buildEdgeIndex(): void {
  edgeIndex.clear();
  for (const edge of graphEdges) {
    let srcList = edgeIndex.get(edge.source);
    if (!srcList) { srcList = []; edgeIndex.set(edge.source, srcList); }
    srcList.push(edge);
    let tgtList = edgeIndex.get(edge.target);
    if (!tgtList) { tgtList = []; edgeIndex.set(edge.target, tgtList); }
    tgtList.push(edge);
  }
}

function addNodeNeighborhood(symbolId: string, maxDegrees = 1): void {
  const visited = new Set<string>();
  let frontier = new Set<string>([symbolId]);

  for (let degree = 0; degree <= maxDegrees; degree += 1) {
    const next = new Set<string>();
    for (const currentId of frontier) {
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      addNodeToGraph(currentId);

      if (degree === maxDegrees) continue;

      const edges = edgeIndex.get(currentId) || [];
      for (const edge of edges) {
        const neighbor = edge.source === currentId ? edge.target : edge.source;
        addNodeToGraph(neighbor);
        addEdgeToGraph(edge);
        if (!visited.has(neighbor)) {
          next.add(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
}

function renderNodeNeighborhoodAndLayout(symbolId: string, maxDegrees = 1): void {
  if (!cy) return;
  const beforeNodeCount = cy.nodes().length;
  addNodeNeighborhood(symbolId, maxDegrees);
  connectExistingNodes();
  refreshAnalysisGraphState();
  if (cy.nodes().length > beforeNodeCount) {
    runLayout();
  }
}

interface FocusSymbolOptions {
  maxDegrees?: number;
  pulse?: boolean;
  pulseDuration?: number;
  animate?: boolean;
  zoom?: number;
  flashDuration?: number;
  openDetail?: boolean;
}

async function focusSymbolInGraph(symbolId: string, options: FocusSymbolOptions = {}): Promise<void> {
  if (!cy) return;

  const {
    maxDegrees = 0,
    pulse = false,
    pulseDuration = 1500,
    animate = false,
    zoom = 1.2,
    flashDuration = 1200,
    openDetail = false,
  } = options;

  renderNodeNeighborhoodAndLayout(symbolId, maxDegrees);
  const node = findNode(symbolId);
  if (!node) return;

  if (animate) {
    cy.animate({ center: { eles: node }, zoom }, { duration: 300 });
  }

  if (pulse) {
    node.addClass('agent-pulse');
    setTimeout(() => node.removeClass('agent-pulse'), pulseDuration);
  } else {
    node.flashClass('highlighted', flashDuration);
  }

  if (openDetail) {
    const detailEl = document.getElementById('symbol-detail');
    if (detailEl) {
      await showDetail(node, detailEl);
    }
  }
}

/** Add a node + neighbors, connect existing nodes, and re-run layout. */
function expandNodeAndLayout(symbolId: string): void {
  renderNodeNeighborhoodAndLayout(symbolId, 1);
}

function addNodeToGraph(id: string): void {
  if (!cy) return;
  if (cy.getElementById(id).length > 0) return;
  removeOnboardingHint();

  const nodeData = graphNodes.get(id);
  if (!nodeData) return;

  const kind = (nodeData.kind || 'function').toLowerCase();
  const name = nodeData.name || id.split('.').pop() || id;
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

function addEdgeToGraph(edge: GraphEdge): void {
  if (!cy) return;
  const edgeId = `${edge.source}->${edge.target}:${edge.kind}`;
  if (cy.getElementById(edgeId).length > 0) return;
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

function runLayout(): void {
  if (!cy || cy.nodes().length === 0) return;
  cy.layout(LAYOUT_OPTIONS).run();
}

function findNode(name: string): CyCollection | null {
  if (!cy) return null;
  const node = cy.getElementById(name);
  if (node.length > 0) return node;
  const match = cy.nodes().filter((n: CyElement) => {
    const nName = (n.data('name') || '') as string;
    const qName = (n.data('qualifiedName') || '') as string;
    return nName === name || qName.endsWith('.' + name);
  });
  return match.length > 0 ? match : null;
}

interface AnalysisPanelEls {
  panel: HTMLElement;
  status: HTMLElement;
  summary: HTMLElement;
  findings: HTMLElement;
}

function getAnalysisPanelEls(): AnalysisPanelEls {
  return {
    panel: document.getElementById('analysis-panel')!,
    status: document.getElementById('analysis-status')!,
    summary: document.getElementById('analysis-summary')!,
    findings: document.getElementById('analysis-findings')!,
  };
}

function setAnalysisStatus(message: string, tone: 'info' | 'error' = 'info'): void {
  const { status } = getAnalysisPanelEls();
  status.textContent = message;
  status.classList.remove('hidden', 'error');
  if (tone === 'error') {
    status.classList.add('error');
  }
}

function clearAnalysisStatus(): void {
  const { status } = getAnalysisPanelEls();
  status.textContent = '';
  status.classList.add('hidden');
  status.classList.remove('error');
}

function clearAnalysisGraphClasses(): void {
  if (!cy) return;
  cy.elements().removeClass('analysis-flagged');
  cy.elements().removeClass('analysis-selected');
}

function refreshAnalysisGraphState(): void {
  const { panel } = getAnalysisPanelEls();
  if (!cy || !analysisReport || panel.classList.contains('hidden')) {
    clearAnalysisGraphClasses();
    return;
  }

  clearAnalysisGraphClasses();

  const candidateNodeIds = new Set<string>();
  const candidateEdgeIds = new Set<string>();
  for (const finding of analysisReport.findings) {
    const context = buildFindingGraphContext(finding, graphEdges);
    for (const nodeId of context.nodes) candidateNodeIds.add(nodeId);
    for (const edgeId of context.edgeIds) candidateEdgeIds.add(edgeId);
  }

  for (const nodeId of candidateNodeIds) {
    cy.getElementById(nodeId).addClass('analysis-flagged');
  }
  for (const edgeId of candidateEdgeIds) {
    cy.getElementById(edgeId).addClass('analysis-flagged');
  }

  if (!activeAnalysisFindingId) return;
  const activeFinding = analysisReport.findings.find((finding) => finding.id === activeAnalysisFindingId);
  if (!activeFinding) return;

  const activeContext = buildFindingGraphContext(activeFinding, graphEdges);
  for (const nodeId of activeContext.nodes) {
    cy.getElementById(nodeId).addClass('analysis-selected');
  }
  for (const edgeId of activeContext.edgeIds) {
    cy.getElementById(edgeId).addClass('analysis-selected');
  }
}

function renderAnalysisSummary(report: StructuralAnalysisReport): void {
  const { summary } = getAnalysisPanelEls();
  const counts = countFindingsByType(report.findings);
  const cards = [
    { label: 'Findings', value: report.summary.findingCount },
    { label: 'Cycles', value: counts.cycle },
    { label: 'Hotspots', value: counts.hotspot },
    { label: 'Coupling', value: counts.fileCoupling },
  ];
  summary.innerHTML = cards.map((card) => `
    <div class="analysis-summary-card">
      <span class="analysis-summary-value">${card.value}</span>
      <span class="analysis-summary-label">${escapeHtml(card.label)}</span>
    </div>
  `).join('');
}

function renderAnalysisFindings(report: StructuralAnalysisReport): void {
  const { findings } = getAnalysisPanelEls();

  if (report.findings.length === 0) {
    findings.innerHTML = `
      <div class="analysis-empty">
        No structural outliers cleared the current thresholds for this graph snapshot.
      </div>
    `;
    return;
  }

  findings.innerHTML = report.findings.map((finding) => {
    const metricChips = buildFindingMetricChips(finding)
      .map((chip) => `<span class="analysis-metric-chip">${escapeHtml(chip)}</span>`)
      .join('');
    const fileBadges = finding.files.slice(0, 3)
      .map((file) => `<span class="analysis-file-badge">${escapeHtml(file)}</span>`)
      .join('');
    const rationale = finding.rationale.slice(0, 2)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('');

    return `
      <article class="analysis-finding" data-finding-id="${escapeHtml(finding.id)}">
        <div class="analysis-finding-header">
          <div>
            <h3 class="analysis-finding-title">${escapeHtml(finding.title)}</h3>
          </div>
          <div class="analysis-finding-meta">
            <span class="analysis-type-badge">${escapeHtml(findingTypeLabel(finding.type))}</span>
            <span class="analysis-severity-badge ${escapeHtml(finding.severity)}">${escapeHtml(findingSeverityLabel(finding.severity))}</span>
          </div>
        </div>
        <p class="analysis-finding-summary">${escapeHtml(finding.summary)}</p>
        <div class="analysis-chip-row">${metricChips}</div>
        ${fileBadges ? `<div class="analysis-file-row">${fileBadges}</div>` : ''}
        ${rationale ? `<ul class="analysis-rationale">${rationale}</ul>` : ''}
        <div class="analysis-finding-actions">
          <button class="header-btn analysis-select-btn" type="button">Inspect in graph</button>
          <button class="header-btn analysis-explain-btn" type="button">Explain this finding</button>
        </div>
        <div class="analysis-explanation hidden">
          <div class="analysis-explanation-label">AI interpretation</div>
          <div class="analysis-explanation-note">Advisory explanation grounded in the deterministic finding and affected symbols.</div>
          <div class="detail-explain-content analysis-explanation-content"></div>
        </div>
      </article>
    `;
  }).join('');

  findings.querySelectorAll('.analysis-finding').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.findingId || '';
      void selectAnalysisFinding(id);
    });
  });

  findings.querySelectorAll('.analysis-select-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const parent = (button as HTMLElement).closest('.analysis-finding') as HTMLElement | null;
      const id = parent?.dataset.findingId || '';
      void selectAnalysisFinding(id);
    });
  });

  findings.querySelectorAll('.analysis-explain-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const parent = (button as HTMLElement).closest('.analysis-finding') as HTMLElement | null;
      if (!parent) return;
      const id = parent.dataset.findingId || '';
      void explainAnalysisFinding(id, parent);
    });
  });
}

function setActiveFindingCard(findingId: string | null): void {
  const { findings } = getAnalysisPanelEls();
  findings.querySelectorAll('.analysis-finding').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.findingId === findingId);
  });
}

async function runStructuralAnalysis(): Promise<void> {
  const { panel, findings } = getAnalysisPanelEls();
  panel.classList.remove('hidden');
  findings.innerHTML = '<div class="analysis-empty">Running structural analysis on the current dependency graph...</div>';
  setAnalysisStatus('Analyzing the current graph snapshot...');

  try {
    const res = await fetch('/api/analysis');
    if (!res.ok) {
      throw new Error(res.status === 404 ? 'No project index available for analysis yet.' : `Analysis request failed (${res.status})`);
    }

    const report = await res.json() as StructuralAnalysisReport;
    analysisReport = report;
    activeAnalysisFindingId = null;
    analysisExplanationCache.clear();
    clearAnalysisStatus();
    setAnalysisStatus(
      `Analyzed ${report.summary.symbolCount} symbols across ${report.summary.fileCount} files. These are graph-derived structural signals.`,
    );
    renderAnalysisSummary(report);
    renderAnalysisFindings(report);
    refreshAnalysisGraphState();
  } catch (error) {
    analysisReport = null;
    activeAnalysisFindingId = null;
    analysisExplanationCache.clear();
    clearAnalysisGraphClasses();
    getAnalysisPanelEls().summary.innerHTML = '';
    const message = error instanceof Error ? error.message : 'Failed to run structural analysis.';
    findings.innerHTML = `<div class="analysis-empty">${escapeHtml(message)}</div>`;
    setAnalysisStatus(message, 'error');
  }
}

async function streamExplanationInto(
  request: () => Promise<Response>,
  content: HTMLElement,
  loadingLabel: string,
  unavailableText: string,
  failureText: string,
  onComplete?: (markdown: string) => void,
): Promise<void> {
  content.innerHTML = `<span class="explain-status"><span class="explain-spinner"></span> ${escapeHtml(loadingLabel)}</span>`;

  let streaming = false;
  let rawText = '';

  function showToolStatus(toolName: string, input: Record<string, unknown>): void {
    if (streaming) return;
    const arg = input.name || input.path || input.symbol || input.query || '';
    content.innerHTML = `<span class="explain-status"><span class="explain-spinner"></span> ${escapeHtml(toolName)}(${escapeHtml(String(arg))})</span>`;
  }

  function startStreaming(): void {
    if (streaming) return;
    streaming = true;
    rawText = '';
    content.textContent = '';
  }

  function finalize(): void {
    if (!rawText) return;
    onComplete?.(rawText);
    renderMarkdownInto(content, rawText);
  }

  try {
    const res = await request();
    if (!res.ok || !res.body) {
      content.textContent = unavailableText;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          finalize();
          return;
        }
        try {
          const event = JSON.parse(payload);
          if (event.type === 'tool_call_start') {
            showToolStatus(event.name, event.input || {});
          } else if (event.type === 'streaming_chunk' && event.content) {
            startStreaming();
            rawText += event.content;
            content.textContent = rawText;
            content.scrollTop = content.scrollHeight;
          } else if (event.type === 'error') {
            startStreaming();
            rawText += `\n[Error: ${event.message}]`;
            content.textContent = rawText;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
    finalize();
  } catch {
    if (!streaming) {
      content.textContent = failureText;
    } else {
      finalize();
    }
  }
}

async function selectAnalysisFinding(findingId: string): Promise<void> {
  if (!analysisReport || !cy) return;
  const finding = analysisReport.findings.find((item) => item.id === findingId);
  if (!finding) return;

  const beforeNodeCount = cy.nodes().length;
  for (const symbol of finding.symbols) {
    addNodeNeighborhood(symbol, 1);
  }
  connectExistingNodes();

  activeAnalysisFindingId = findingId;
  refreshAnalysisGraphState();
  setActiveFindingCard(findingId);

  const afterNodeCount = cy.nodes().length;
  if (afterNodeCount > beforeNodeCount) {
    runLayout();
  }

  const primarySymbol = finding.symbols[0];
  if (!primarySymbol) return;

  const primaryNode = cy.getElementById(primarySymbol);
  if (primaryNode.length > 0) {
    if (finding.symbols.length > 1) {
      cy.fit(80);
    } else {
      cy.animate({ center: { eles: primaryNode }, zoom: 1.35 }, { duration: 300 });
    }
    primaryNode.flashClass('highlighted', 1200);
    await showDetail(primaryNode, document.getElementById('symbol-detail')!);
  }
}

async function explainAnalysisFinding(findingId: string, findingEl: HTMLElement): Promise<void> {
  await selectAnalysisFinding(findingId);

  const explanationEl = findingEl.querySelector('.analysis-explanation') as HTMLElement | null;
  const contentEl = findingEl.querySelector('.analysis-explanation-content') as HTMLElement | null;
  if (!explanationEl || !contentEl) return;

  explanationEl.classList.remove('hidden');

  const cached = analysisExplanationCache.get(findingId);
  if (cached) {
    renderMarkdownInto(contentEl, cached);
    return;
  }

  if (findingEl.dataset.explaining === 'true') {
    return;
  }
  findingEl.dataset.explaining = 'true';

  try {
    await streamExplanationInto(
      () => fetch('/api/analysis/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId }),
      }),
      contentEl,
      'Interpreting deterministic finding...',
      '(analysis explanation unavailable)',
      '(analysis explanation failed)',
      (markdown) => {
        if (!markdown.includes('[Error:')) {
          analysisExplanationCache.set(findingId, markdown);
        }
      },
    );
  } finally {
    delete findingEl.dataset.explaining;
  }
}

// -- Interactions --

function setupInteractions(cyInst: CyInstance, detailEl: HTMLElement): void {
  // Single click → show detail panel only
  cyInst.on('tap', 'node', function (evt: CyEvent) {
    const node = evt.target as unknown as CyCollection;
    showDetail(node, detailEl);
  });

  // Double click → expand 1-hop neighbors
  cyInst.on('dbltap', 'node', function (evt: CyEvent) {
    const node = evt.target as unknown as CyCollection;
    const id = (node.data('qualifiedName') || node.data('id')) as string;

    if (!node.hasClass('expanded')) {
      node.addClass('expanded');
      expandNodeAndLayout(id);
    }
  });

  const containerEl = cyInst.container();

  cyInst.on('mouseover', 'node', function (evt: CyEvent) {
    if (!cy) return;
    const node = evt.target as unknown as CyCollection;
    const neighborhood = node.closedNeighborhood();
    cy.elements().not(neighborhood).addClass('faded');
    neighborhood.addClass('highlighted');
    node.addClass('hover-target');
    containerEl.style.cursor = 'pointer';
  });

  cyInst.on('mouseout', 'node', function (evt: CyEvent) {
    if (!cy) return;
    const node = evt.target as unknown as CyCollection;
    node.removeClass('hover-target');
    cy.elements().removeClass('faded highlighted');
    containerEl.style.cursor = '';
  });

  cyInst.on('tap', function (evt: CyEvent) {
    if (evt.target === (cyInst as unknown)) {
      detailEl.classList.add('hidden');
    }
  });
}

function connectExistingNodes(): void {
  if (!cy) return;
  const nodeIds = new Set(cy.nodes().map((n: CyElement) => n.id()));
  const visited = new Set<string>();
  for (const id of nodeIds) {
    const edges = edgeIndex.get(id) || [];
    for (const edge of edges) {
      const edgeId = `${edge.source}->${edge.target}:${edge.kind}`;
      if (visited.has(edgeId)) continue;
      visited.add(edgeId);
      if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        addEdgeToGraph(edge);
      }
    }
  }
}

async function showDetail(node: CyCollection, detailEl: HTMLElement): Promise<void> {
  const data = {
    label: node.data('label') as string,
    qualifiedName: node.data('qualifiedName') as string,
    name: node.data('name') as string,
    kind: node.data('kind') as string,
    file: node.data('file') as string,
    startLine: node.data('startLine') as number | undefined,
  };
  const isPinned = pinnedNames.has(data.qualifiedName);
  const kind = data.kind || 'unknown';
  const kindColor = KIND_COLORS[kind] ? KIND_COLORS[kind]!.border : '#565f89';

  let html = `
    <div class="detail-header">
      <span class="detail-name">${escapeHtml(data.label)}</span>
      <span class="detail-kind-badge" style="background:${kindColor}20;color:${kindColor}">${kind}</span>
    </div>
    <div class="detail-file">${escapeHtml(data.file || 'unknown')}${data.startLine ? ':' + data.startLine : ''}</div>
  `;

  // Action buttons row
  html += `<div class="detail-actions">`;
  html += `<button class="detail-pin header-btn" data-name="${escapeHtml(data.qualifiedName)}">${isPinned ? 'Unpin' : 'Pin to focus'}</button>`;
  html += `<button class="detail-explain-btn header-btn" data-name="${escapeHtml(data.qualifiedName)}">Explain</button>`;
  html += `</div>`;

  // Source
  html += `<div id="detail-source"><div class="detail-section-title">Source</div><pre class="detail-code">Loading...</pre></div>`;

  // Annotations section
  html += `<div class="detail-section" id="detail-annotations">`;
  html += `<div class="detail-section-title">Annotations</div>`;
  html += `<div class="detail-annotation-list"></div>`;
  html += `<div class="detail-annotation-input">`;
  html += `<textarea class="detail-annotation-textarea" placeholder="Add a note..." rows="1"></textarea>`;
  html += `<button class="dropdown-action detail-annotation-add">Add</button>`;
  html += `</div></div>`;

  // Explain section (hidden until clicked)
  html += `<div class="detail-section hidden" id="detail-explain"><div class="detail-section-title">Explanation</div><div class="detail-explain-content"></div></div>`;

  // Dependencies & References
  html += '<div class="detail-section" id="detail-deps"><div class="detail-section-title">Dependencies</div><div class="detail-section-list">Loading...</div></div>';
  html += '<div class="detail-section" id="detail-refs"><div class="detail-section-title">References</div><div class="detail-section-list">Loading...</div></div>';

  detailEl.innerHTML = '<div class="resize-handle"></div>' + html;
  detailEl.classList.remove('hidden');

  // Setup resize handle drag
  const handle = detailEl.querySelector('.resize-handle') as HTMLElement;
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX = e.clientX;
    const startWidth = detailEl.offsetWidth;
    function onMove(ev: MouseEvent) {
      const newWidth = startWidth - (ev.clientX - startX);
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

  const pinBtn = detailEl.querySelector('.detail-pin') as HTMLButtonElement;
  pinBtn.addEventListener('click', async () => {
    const name = pinBtn.dataset.name || '';
    await togglePin(name, node, pinBtn);
  });

  // Explain button
  const explainBtn = detailEl.querySelector('.detail-explain-btn') as HTMLButtonElement;
  explainBtn.addEventListener('click', () => {
    const name = explainBtn.dataset.name || '';
    explainSymbol(name, detailEl);
  });

  // Annotation add
  const symName = data.qualifiedName || data.name;
  const addBtn = detailEl.querySelector('.detail-annotation-add') as HTMLButtonElement;
  const textarea = detailEl.querySelector('.detail-annotation-textarea') as HTMLTextAreaElement;
  addBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    await addAnnotation(symName, text);
    textarea.value = '';
    loadAnnotations(symName, detailEl);
  });
  textarea.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addBtn.click();
    }
  });

  loadSource(symName, detailEl);
  loadAnnotations(symName, detailEl);
  loadDepsAndRefs(symName, detailEl);
}

async function loadSource(name: string, detailEl: HTMLElement): Promise<void> {
  const codeEl = detailEl.querySelector('#detail-source .detail-code') as HTMLPreElement | null;
  if (!codeEl) return;
  try {
    const res = await fetch(`/api/symbols/${encodeURIComponent(name)}/source`);
    if (res.ok) {
      const data = await res.json();
      const ext = (data.filePath || '').split('.').pop() || '';
      const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript' };
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

interface DepItem {
  qualifiedName?: string;
  name?: string;
}

interface RefItem {
  from?: string;
  qualifiedName?: string;
  name?: string;
  kind?: string;
}

async function loadDepsAndRefs(name: string, detailEl: HTMLElement): Promise<void> {
  const encodedName = encodeURIComponent(name);

  try {
    const [depsRes, refsRes] = await Promise.all([
      fetch(`/api/symbols/${encodedName}/dependencies?depth=1`).catch(() => null),
      fetch(`/api/symbols/${encodedName}/references`).catch(() => null),
    ]);

    const depsEl = detailEl.querySelector('#detail-deps .detail-section-list') as HTMLElement;
    const refsEl = detailEl.querySelector('#detail-refs .detail-section-list') as HTMLElement;

    if (depsRes && depsRes.ok) {
      const deps = await depsRes.json();
      const items: (string | DepItem)[] = deps.dependencies || deps || [];
      depsEl.innerHTML = items.length
        ? items.map((d) => {
            const target = typeof d === 'string' ? d : d.qualifiedName || d.name || '';
            const label = typeof d === 'string' ? d : d.name || d.qualifiedName || '';
            return `<a class="detail-link" data-target="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
          }).join('')
        : '<span class="detail-empty">None</span>';
    } else {
      depsEl.innerHTML = '<span class="detail-empty">None</span>';
    }

    if (refsRes && refsRes.ok) {
      const refs = await refsRes.json();
      const items: (string | RefItem)[] = refs.references || refs || [];
      refsEl.innerHTML = items.length
        ? items.map((r) => {
            const id = typeof r === 'string' ? r : r.from || r.qualifiedName || r.name || '';
            const label = typeof r === 'string' ? id : r.name || id.split('.').pop() || id;
            const kind = typeof r === 'string' ? '' : r.kind || '';
            return `<a class="detail-link" data-target="${escapeHtml(id)}">${escapeHtml(label)} <span style="opacity:0.5">${escapeHtml(kind)}</span></a>`;
          }).join('')
        : '<span class="detail-empty">None</span>';
    } else {
      refsEl.innerHTML = '<span class="detail-empty">None</span>';
    }

    // Clicking a dep/ref link adds it to the graph and navigates
    detailEl.querySelectorAll('.detail-link').forEach((link) => {
      link.addEventListener('click', () => {
        const target = (link as HTMLElement).dataset.target || '';
        expandNodeAndLayout(target);
        if (!cy) return;
        const targetNode = cy.getElementById(target);
        if (targetNode.length) {
          cy.animate({ center: { eles: targetNode }, zoom: 1.5 }, { duration: 300 });
          targetNode.flashClass('highlighted', 1000);
          showDetail(targetNode, detailEl);
        }
      });
    });
  } catch {
    // Silently fail
  }
}

async function loadAnnotations(name: string, detailEl: HTMLElement): Promise<void> {
  const listEl = detailEl.querySelector('.detail-annotation-list') as HTMLElement;
  if (!listEl) return;
  try {
    const res = await fetch(`/api/symbols/${encodeURIComponent(name)}/annotations`);
    if (!res.ok) { listEl.innerHTML = ''; return; }
    const data = await res.json();
    const notes: string[] = data.annotations || [];
    if (notes.length === 0) {
      listEl.innerHTML = '<span class="detail-empty">No annotations</span>';
      return;
    }
    listEl.innerHTML = notes.map((text: string, i: number) =>
      `<div class="detail-annotation-item">
        <span class="annotation-text">${escapeHtml(text)}</span>
        <button class="annotation-remove" data-index="${i}" title="Remove">&times;</button>
      </div>`
    ).join('');
    listEl.querySelectorAll('.annotation-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number((btn as HTMLElement).dataset.index);
        await fetch(`/api/symbols/${encodeURIComponent(name)}/annotations/${idx}`, { method: 'DELETE' });
        loadAnnotations(name, detailEl);
      });
    });
  } catch {
    listEl.innerHTML = '';
  }
}

async function addAnnotation(name: string, text: string): Promise<void> {
  await fetch(`/api/symbols/${encodeURIComponent(name)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function explainSymbol(name: string, detailEl: HTMLElement): Promise<void> {
  const section = detailEl.querySelector('#detail-explain') as HTMLElement;
  const content = section.querySelector('.detail-explain-content') as HTMLElement;
  section.classList.remove('hidden');
  await streamExplanationInto(
    () => fetch(`/api/symbols/${encodeURIComponent(name)}/explain`),
    content,
    'Researching...',
    '(explain unavailable)',
    '(explain failed)',
  );
}

async function togglePin(name: string, node: CyCollection, btnEl: HTMLButtonElement): Promise<void> {
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

// -- Toolbar --

function setupToolbar(): void {
  const searchInput = document.getElementById('graph-search') as HTMLInputElement;
  const analyzeBtn = document.getElementById('graph-analyze') as HTMLButtonElement;
  const fitBtn = document.getElementById('graph-fit') as HTMLButtonElement;
  const relayoutBtn = document.getElementById('graph-relayout') as HTMLButtonElement;
  const clearBtn = document.getElementById('graph-clear') as HTMLButtonElement;
  const analysisCloseBtn = document.getElementById('analysis-close') as HTMLButtonElement;
  const analysisRerunBtn = document.getElementById('analysis-rerun') as HTMLButtonElement;
  const analysisPanel = document.getElementById('analysis-panel')!;

  let searchTimeout: ReturnType<typeof setTimeout>;
  const dropdown = document.createElement('div');
  dropdown.className = 'search-dropdown hidden';
  (searchInput.parentNode as HTMLElement).style.position = 'relative';
  searchInput.parentNode!.appendChild(dropdown);

  // Rank symbols: exported first, then alphabetical by short name
  const rankedSymbols = allSymbolNames.slice().sort((a, b) => {
    const nodeA = graphNodes.get(a);
    const nodeB = graphNodes.get(b);
    const expA = nodeA ? !!nodeA.exported : false;
    const expB = nodeB ? !!nodeB.exported : false;
    if (expA !== expB) return expA ? -1 : 1;
    const nameA = (a.split('.').pop() || '').toLowerCase();
    const nameB = (b.split('.').pop() || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  function showDropdownResults(matches: string[]): void {
    if (matches.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }

    dropdown.innerHTML = matches.map((name) => {
      const node = graphNodes.get(name);
      const kind = node ? (node.kind || '').toLowerCase() : '';
      const shortName = name.split('.').pop() || name;
      const kindColor = KIND_COLORS[kind] ? KIND_COLORS[kind]!.border : '#565f89';
      return `<div class="search-result" data-id="${escapeHtml(name)}">
        <span class="search-result-name">${escapeHtml(shortName)}</span>
        <span class="search-result-kind" style="color:${kindColor}">${kind}</span>
      </div>`;
    }).join('');

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.search-result').forEach((el) => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.id || '';
        searchInput.value = '';
        dropdown.classList.add('hidden');
        void focusSymbolInGraph(id, {
          maxDegrees: 1,
          animate: true,
          zoom: 1.2,
          flashDuration: 1500,
          openDetail: true,
        });
      });
    });
  }

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

      const matches = rankedSymbols.filter((name) => {
        const shortName = (name.split('.').pop() || '').toLowerCase();
        return shortName.includes(query) || name.toLowerCase().includes(query);
      }).slice(0, 15);

      showDropdownResults(matches);
    }, 150);
  });

  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      dropdown.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e: Event) => {
    if (!searchInput.contains(e.target as Node) && !dropdown.contains(e.target as Node)) {
      dropdown.classList.add('hidden');
    }
  });

  fitBtn.addEventListener('click', () => {
    if (cy && cy.nodes().length > 0) {
      cy.fit(40);
    }
  });

  analyzeBtn.addEventListener('click', () => {
    void runStructuralAnalysis();
  });

  analysisRerunBtn.addEventListener('click', () => {
    void runStructuralAnalysis();
  });

  analysisCloseBtn.addEventListener('click', () => {
    analysisPanel.classList.add('hidden');
    activeAnalysisFindingId = null;
    clearAnalysisStatus();
    clearAnalysisGraphClasses();
    setActiveFindingCard(null);
  });

  relayoutBtn.addEventListener('click', () => {
    runLayout();
  });

  clearBtn.addEventListener('click', () => {
    if (!cy) return;
    cy.elements().remove();
    document.getElementById('symbol-detail')!.classList.add('hidden');
    const cyEl = document.getElementById('cy');
    if (cyEl) showOnboardingHint(cyEl);
    refreshAnalysisGraphState();
  });
}
