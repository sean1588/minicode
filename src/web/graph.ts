// graph.ts — Interactive dependency graph: search -> seed -> expand by clicking
// Start empty. User searches for a symbol, selects it to seed the graph.
// Clicking a node expands its 1-hop neighbors. Walk the graph in real time.

import { closeModal, openModal } from './modal-state.ts';
import { escapeHtml, renderMarkdownInto } from './utils.ts';
import {
  buildFindingGraphContext,
  buildFindingMetricChips,
  countFindingsByType,
  filterFindings,
  findingSeverityLabel,
  findingTypeLabel,
  type AnalysisFindingFilter,
  type StructuralAnalysisReport,
} from './analysis-helpers.ts';
import { KIND_COLORS, buildStylesheet } from '../shared/graph-styles.ts';
import {
  buildGraphFileIndex,
  buildGraphSearchResults,
  type GraphSearchResult,
} from '../shared/graph-search.ts';
import {
  buildFileFocusedSelection,
  buildGraphEdgeIndex,
} from '../shared/graph-selection.ts';
import {
  compareGraphNodeIds,
  getGraphNodeLabel,
  resolveGraphNodeIds,
} from '../shared/graph-symbols.ts';

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

interface GraphResponse {
  nodes?: GraphNode[];
  edges?: RawEdge[];
}

interface FocusResponse {
  pinned?: unknown[];
}

interface RefreshGraphDataOptions {
  refreshIndex?: boolean;
  preserveVisible?: boolean;
  showFeedback?: boolean;
}

let cy: CyInstance | null = null;
const graphNodes = new Map<string, GraphNode>();
let graphEdges: GraphEdge[] = [];
let fileToSymbolIds = new Map<string, string[]>();
// Adjacency index: node id → edges touching that node (O(1) neighbor lookup)
let edgeIndex = new Map<string, GraphEdge[]>();
const pinnedNames = new Set<string>();
let allSymbolNames: string[] = [];
let initialized = false;
let analysisReport: StructuralAnalysisReport | null = null;
let activeAnalysisFindingId: string | null = null;
let activeAnalysisFilter: AnalysisFindingFilter = 'all';
const analysisExplanationCache = new Map<string, string>();
let filePreviewModalInitialized = false;
let latestFilePreviewRequestId = 0;
let pendingGraphRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
  setupFilePreviewModal();
  cyEl.innerHTML = '';

  try {
    cy = cytoscape({
      container: cyEl,
      elements: [],
      style: buildStylesheet(),
      minZoom: 0.2,
      maxZoom: 3,
    });
    setupInteractions(cy, detailEl);
    setupToolbar();

    const loaded = await loadGraphSnapshot(false);
    if (!loaded) {
      showOnboardingHint(cyEl, 'No project index is available yet. Refresh after files are available, or restart minicode serve.');
      return;
    }

    seedPinnedSymbolsOrOnboarding(
      graphNodes.size === 0
        ? 'No JavaScript or TypeScript symbols are indexed yet. Create a file, then refresh the graph.'
        : undefined,
    );

  } catch (err) {
    console.error('Graph init failed:', err);
    const msg = err instanceof Error ? err.message : String(err);
    cyEl.innerHTML = `<div class="graph-empty">Failed to load graph: ${msg}</div>`;
  }
}

export async function refreshGraphData(options: RefreshGraphDataOptions = {}): Promise<void> {
  if (!initialized || !cy) return;

  const {
    refreshIndex = false,
    preserveVisible = true,
    showFeedback = false,
  } = options;
  const refreshBtn = document.getElementById('graph-refresh') as HTMLButtonElement | null;
  const visibleIds = preserveVisible ? cy.nodes().map((node: CyElement) => node.id()) : [];

  if (showFeedback && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
  }

  try {
    const loaded = await loadGraphSnapshot(refreshIndex);
    if (!loaded) {
      throw new Error('No project index available');
    }
    renderGraphAfterDataRefresh(visibleIds, preserveVisible);
  } catch (err) {
    console.error('Graph refresh failed:', err);
    if (showFeedback) {
      const cyEl = document.getElementById('cy');
      if (cyEl && graphNodes.size === 0) {
        showOnboardingHint(cyEl, 'Could not refresh the project index. Check the minicode serve logs, then try again.');
      }
    }
  } finally {
    if (showFeedback && refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
    }
  }
}

export function scheduleGraphDataRefresh(): void {
  if (!initialized) return;
  if (pendingGraphRefreshTimer) {
    clearTimeout(pendingGraphRefreshTimer);
  }
  pendingGraphRefreshTimer = setTimeout(() => {
    pendingGraphRefreshTimer = null;
    void refreshGraphData({ preserveVisible: true });
  }, 250);
}

export function highlightAgentActivity(symbolName: string): void {
  if (!cy) return;
  void focusResolvedSymbolsInGraph(symbolName, {
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

/**
 * Notify cytoscape that its container's width changed. The
 * symbol-detail side panel is a real flex sibling of `#cy`, so showing
 * or hiding it (via the `hidden` class) automatically redistributes
 * width. Cytoscape doesn't pick that up on its own — we have to call
 * `cy.resize()` so it re-measures. Optionally re-fits the visible
 * graph into the new canvas bounds.
 *
 * @param fit when true, also re-fit the visible graph after resize.
 *   Use this on panel open (so right-side nodes that just got hidden
 *   behind the panel get repacked). Skip on close and during
 *   drag-resize so the user's current view stays put.
 */
function syncDetailPanelLayout({ fit = false }: { fit?: boolean } = {}): void {
  if (!cy) return;
  cy.resize();
  if (fit && cy.nodes().length > 0) {
    cy.fit(80);
  }
}

// -- Graph building (incremental) --

async function loadGraphSnapshot(refreshIndex: boolean): Promise<boolean> {
  if (refreshIndex) {
    const refreshRes = await fetch('/api/index/refresh', { method: 'POST' });
    if (!refreshRes.ok) {
      return false;
    }
  }

  const [graphRes, focusRes] = await Promise.all([
    fetch('/api/graph'),
    fetch('/api/focus'),
  ]);

  if (!graphRes.ok) {
    return false;
  }

  const graphData = await graphRes.json() as GraphResponse;
  const focusData = focusRes.ok ? await focusRes.json() as FocusResponse : { pinned: [] };
  applyGraphSnapshot(graphData, focusData);
  return true;
}

function applyGraphSnapshot(graphData: GraphResponse, focusData: FocusResponse): void {
  graphNodes.clear();
  for (const node of graphData.nodes || []) {
    const id = node.qualifiedName || node.id || node.name || '';
    if (id) {
      graphNodes.set(id, node);
    }
  }

  graphEdges = (graphData.edges || []).map((e) => ({
    source: e.source || e.from || '',
    target: e.target || e.to || '',
    kind: (e.kind || e.type || 'references').toLowerCase(),
  })).filter((edge) => edge.source && edge.target);
  edgeIndex = buildGraphEdgeIndex(graphEdges);
  fileToSymbolIds = buildGraphFileIndex(graphNodes);
  allSymbolNames = Array.from(graphNodes.keys()).sort();

  pinnedNames.clear();
  for (const pinned of focusData.pinned || []) {
    const name = typeof pinned === 'string'
      ? pinned
      : (pinned as Record<string, string>).name || (pinned as Record<string, string>).qualifiedName;
    if (name) pinnedNames.add(name);
  }

  resetAnalysisForGraphRefresh();
}

function resetAnalysisForGraphRefresh(): void {
  analysisReport = null;
  activeAnalysisFindingId = null;
  activeAnalysisFilter = 'all';
  analysisExplanationCache.clear();
  clearAnalysisGraphClasses();

  const panel = document.getElementById('analysis-panel');
  if (!panel || panel.classList.contains('hidden')) {
    return;
  }

  const { summary, findings } = getAnalysisPanelEls();
  summary.innerHTML = '';
  findings.innerHTML = '<div class="analysis-empty">Graph refreshed. Re-run analysis to inspect the latest dependency graph.</div>';
  setAnalysisStatus('Graph refreshed. Re-run analysis to inspect the latest snapshot.');
}

function renderGraphAfterDataRefresh(previousVisibleIds: string[], preserveVisible: boolean): void {
  if (!cy) return;

  cy.elements().remove();
  document.getElementById('symbol-detail')?.classList.add('hidden');
  syncDetailPanelLayout();

  const visibleIds = preserveVisible
    ? [...new Set(previousVisibleIds)].filter((id) => graphNodes.has(id))
    : [];

  for (const id of visibleIds) {
    addNodeToGraph(id);
  }
  connectExistingNodes();

  if (cy.nodes().length > 0) {
    refreshAnalysisGraphState();
    runLayout();
    return;
  }

  seedPinnedSymbolsOrOnboarding(
    graphNodes.size === 0
      ? 'No JavaScript or TypeScript symbols are indexed yet. Create a file, then refresh the graph.'
      : undefined,
  );
}

function seedPinnedSymbolsOrOnboarding(subtitle?: string): void {
  if (!cy) return;
  for (const name of pinnedNames) {
    addNodeNeighborhood(name, 1);
  }
  connectExistingNodes();

  if (cy.nodes().length > 0) {
    refreshAnalysisGraphState();
    runLayout();
    return;
  }

  const cyEl = document.getElementById('cy');
  if (cyEl) showOnboardingHint(cyEl, subtitle);
  refreshAnalysisGraphState();
}

function showOnboardingHint(container: HTMLElement, subtitle = 'Search for a symbol or file above to start exploring.<br/>Nodes expand on click to reveal connections.'): void {
  const existing = container.querySelector('.graph-onboarding');
  if (existing) {
    const subtitleEl = existing.querySelector('.graph-onboarding-subtitle');
    if (subtitleEl) subtitleEl.innerHTML = subtitle;
    return;
  }
  const hint = document.createElement('div');
  hint.className = 'graph-onboarding';
  hint.innerHTML =
    '<div class="graph-onboarding-icon">&#9670; &#8212; &#9670;</div>' +
    '<div class="graph-onboarding-title">Code dependency graph</div>' +
    `<div class="graph-onboarding-subtitle">${subtitle}</div>`;
  container.appendChild(hint);
}

function removeOnboardingHint(): void {
  const hint = document.querySelector('.graph-onboarding');
  if (hint) hint.remove();
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

function focusFileInGraph(filePath: string): void {
  if (!cy) return;

  const selection = buildFileFocusedSelection({
    filePath,
    fileIndex: fileToSymbolIds,
    edgeIndex,
  });
  cy.elements().remove();
  document.getElementById('symbol-detail')?.classList.add('hidden');
  syncDetailPanelLayout();

  if (selection.nodeIds.length === 0) {
    const cyEl = document.getElementById('cy');
    if (cyEl) showOnboardingHint(cyEl);
    refreshAnalysisGraphState();
    return;
  }

  for (const symbolId of selection.nodeIds) {
    addNodeToGraph(symbolId);
  }
  for (const edge of selection.edges) {
    addEdgeToGraph(edge);
  }
  refreshAnalysisGraphState();
  runLayout();
}

/**
 * Map a file path to a highlight.js language name. Falls back to `plaintext`
 * for unknown extensions — never to a guessed language, since a wrong guess
 * (e.g. rendering Python as TypeScript) is worse than no highlighting.
 *
 * Adding a new language: add the extension here AND load the matching
 * `languages/<lang>.min.js` script in `index.html`.
 */
function getHljsLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    pyi: 'python',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'xml',
  };
  return langMap[ext] || 'plaintext';
}

function closeFilePreview(): void {
  const modal = document.getElementById('file-preview-modal');
  if (!modal) return;
  closeModal(modal);
}

function setupFilePreviewModal(): void {
  if (filePreviewModalInitialized) return;
  filePreviewModalInitialized = true;

  const modal = document.getElementById('file-preview-modal') as HTMLElement | null;
  const backdrop = document.getElementById('file-preview-backdrop') as HTMLElement | null;
  const closeBtn = document.getElementById('file-preview-close') as HTMLButtonElement | null;
  if (!modal || !backdrop || !closeBtn) {
    return;
  }

  backdrop.addEventListener('click', () => closeFilePreview());
  closeBtn.addEventListener('click', () => closeFilePreview());
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeFilePreview();
    }
  });
}

async function openFilePreview(filePath: string): Promise<void> {
  const modal = document.getElementById('file-preview-modal') as HTMLElement | null;
  const pathEl = document.getElementById('file-preview-path') as HTMLElement | null;
  const codeEl = document.getElementById('file-preview-code') as HTMLPreElement | null;
  if (!modal || !pathEl || !codeEl) {
    return;
  }

  latestFilePreviewRequestId += 1;
  const requestId = latestFilePreviewRequestId;

  pathEl.textContent = filePath;
  codeEl.className = 'file-preview-code';
  codeEl.textContent = 'Loading...';
  openModal(modal);

  try {
    const res = await fetch(`/api/file-source?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) {
      codeEl.textContent = '(file unavailable)';
      return;
    }

    const data = await res.json() as { filePath: string; source: string };
    if (requestId !== latestFilePreviewRequestId) {
      return;
    }

    pathEl.textContent = data.filePath;
    codeEl.className = `file-preview-code language-${getHljsLanguage(data.filePath)}`;
    codeEl.textContent = data.source;
    if (typeof hljs !== 'undefined') {
      hljs.highlightElement(codeEl);
    }
  } catch {
    if (requestId !== latestFilePreviewRequestId) {
      return;
    }
    codeEl.textContent = '(file unavailable)';
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
  await focusSymbolsInGraph([symbolId], options);
}

async function focusResolvedSymbolsInGraph(symbolName: string, options: FocusSymbolOptions = {}): Promise<void> {
  const matches = resolveGraphNodeIds(graphNodes, symbolName);
  if (matches.length === 0) {
    return;
  }

  await focusSymbolsInGraph(matches, options);
}

async function focusSymbolsInGraph(symbolIds: string[], options: FocusSymbolOptions = {}): Promise<void> {
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

  const uniqueIds = [...new Set(symbolIds)];
  let addedNodes = false;
  for (const symbolId of uniqueIds) {
    const beforeNodeCount = cy.nodes().length;
    addNodeNeighborhood(symbolId, maxDegrees);
    if (cy.nodes().length > beforeNodeCount) {
      addedNodes = true;
    }
  }

  connectExistingNodes();
  refreshAnalysisGraphState();
  if (addedNodes) {
    runLayout();
  }

  const nodes = uniqueIds
    .map((symbolId) => findNode(symbolId))
    .filter((node): node is CyCollection => node !== null);
  if (nodes.length === 0) return;
  const primaryNode = nodes[0];

  if (animate && primaryNode) {
    cy.animate({ center: { eles: primaryNode }, zoom }, { duration: 300 });
  }

  for (const node of nodes) {
    if (pulse) {
      node.addClass('agent-pulse');
      setTimeout(() => node.removeClass('agent-pulse'), pulseDuration);
    } else {
      node.flashClass('highlighted', flashDuration);
    }
  }

  if (openDetail && primaryNode && uniqueIds.length === 1) {
    const detailEl = document.getElementById('symbol-detail');
    if (detailEl) {
      const node = primaryNode;
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
  const name = getGraphNodeLabel(nodeData, id);
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
  const matchingIds = new Set(resolveGraphNodeIds(graphNodes, name));
  const match = cy.nodes().filter((n: CyElement) =>
    matchingIds.has((n.data('qualifiedName') || n.data('id') || '') as string),
  );
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
  for (const finding of getVisibleAnalysisFindings()) {
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
  const activeFinding = getVisibleAnalysisFindings().find((finding) => finding.id === activeAnalysisFindingId);
  if (!activeFinding) return;

  const activeContext = buildFindingGraphContext(activeFinding, graphEdges);
  for (const nodeId of activeContext.nodes) {
    cy.getElementById(nodeId).addClass('analysis-selected');
  }
  for (const edgeId of activeContext.edgeIds) {
    cy.getElementById(edgeId).addClass('analysis-selected');
  }
}

function getVisibleAnalysisFindings(): ReturnType<typeof filterFindings> {
  return analysisReport ? filterFindings(analysisReport.findings, activeAnalysisFilter) : [];
}

function renderAnalysisSummary(report: StructuralAnalysisReport): void {
  const { summary } = getAnalysisPanelEls();
  const counts = countFindingsByType(report.findings);
  const cards = [
    { label: 'Findings', value: report.summary.findingCount, filter: 'all' as const },
    { label: 'Cycles', value: counts.cycle, filter: 'cycle' as const },
    { label: 'Hotspots', value: counts.hotspot, filter: 'hotspot' as const },
    { label: 'Coupling', value: counts.fileCoupling, filter: 'fileCoupling' as const },
  ];
  summary.innerHTML = cards.map((card) => `
    <button
      class="analysis-summary-card ${card.filter === activeAnalysisFilter ? 'active' : ''}"
      data-filter="${card.filter}"
      type="button"
    >
      <span class="analysis-summary-value">${card.value}</span>
      <span class="analysis-summary-label">${escapeHtml(card.label)}</span>
    </button>
  `).join('');

  summary.querySelectorAll('.analysis-summary-card').forEach((el) => {
    el.addEventListener('click', () => {
      const filter = ((el as HTMLElement).dataset.filter || 'all') as AnalysisFindingFilter;
      setAnalysisFilter(filter);
    });
  });
}

function renderAnalysisFindings(report: StructuralAnalysisReport): void {
  const { findings } = getAnalysisPanelEls();
  const visibleFindings = filterFindings(report.findings, activeAnalysisFilter);

  if (visibleFindings.length === 0) {
    findings.innerHTML = `
      <div class="analysis-empty">
        No ${escapeHtml(activeAnalysisFilter === 'all' ? 'structural outliers' : findingTypeLabel(activeAnalysisFilter).toLowerCase())} cleared the current thresholds for this graph snapshot.
      </div>
    `;
    return;
  }

  findings.innerHTML = visibleFindings.map((finding) => {
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

function setAnalysisFilter(filter: AnalysisFindingFilter): void {
  const nextFilter = activeAnalysisFilter === filter ? 'all' : filter;
  activeAnalysisFilter = nextFilter;

  if (!analysisReport) {
    return;
  }

  const visibleFindings = filterFindings(analysisReport.findings, activeAnalysisFilter);
  if (activeAnalysisFindingId && !visibleFindings.some((finding) => finding.id === activeAnalysisFindingId)) {
    activeAnalysisFindingId = null;
  }

  renderAnalysisSummary(analysisReport);
  renderAnalysisFindings(analysisReport);
  refreshAnalysisGraphState();
  setActiveFindingCard(activeAnalysisFindingId);
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
    activeAnalysisFilter = 'all';
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
    activeAnalysisFilter = 'all';
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
      syncDetailPanelLayout();
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
    <div class="detail-file">${
      data.file
        ? `<button type="button" class="detail-file-link" data-file="${escapeHtml(data.file)}">${escapeHtml(data.file)}${data.startLine ? ':' + data.startLine : ''}</button>`
        : 'unknown'
    }</div>
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
  // Shrink the cytoscape canvas to make room for the panel and re-fit so
  // any nodes the panel just covered get repacked into the visible area.
  syncDetailPanelLayout({ fit: true });

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
      // Track the panel's width live so the canvas grows/shrinks with the
      // drag. Skip the fit — the user is actively manipulating the layout
      // and would find auto-fit jarring.
      syncDetailPanelLayout();
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

  const fileLink = detailEl.querySelector('.detail-file-link') as HTMLButtonElement | null;
  fileLink?.addEventListener('click', () => {
    const filePath = fileLink.dataset.file || '';
    if (!filePath) return;
    void openFilePreview(filePath);
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
      const lang = getHljsLanguage(data.filePath || '');
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
  const refreshBtn = document.getElementById('graph-refresh') as HTMLButtonElement;
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

  function showDropdownResults(results: GraphSearchResult[]): void {
    if (results.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }

    dropdown.innerHTML = results.map((result) => {
      const kindColor = result.type === 'file'
        ? 'var(--accent)'
        : (KIND_COLORS[result.kind] ? KIND_COLORS[result.kind]!.border : '#565f89');
      return `<div class="search-result" data-id="${escapeHtml(result.id)}" data-type="${result.type}">
        <div class="search-result-body">
          <span class="search-result-name">${escapeHtml(result.label)}</span>
          <span class="search-result-subtitle">${escapeHtml(result.subtitle)}</span>
        </div>
        <span class="search-result-kind${result.type === 'file' ? ' file' : ''}" style="color:${kindColor}">${escapeHtml(result.kind)}</span>
      </div>`;
    }).join('');

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.search-result').forEach((el) => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.id || '';
        const type = (el as HTMLElement).dataset.type || 'symbol';
        searchInput.value = '';
        dropdown.classList.add('hidden');
        if (type === 'file') {
          focusFileInGraph(id);
          void openFilePreview(id);
          return;
        }
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

  function updateDropdownResults(): void {
    // Rank symbols from the latest graph snapshot so new files appear after refresh.
    const rankedSymbols = allSymbolNames.slice().sort((a, b) => compareGraphNodeIds(a, b, graphNodes));
    const results = buildGraphSearchResults({
      query: searchInput.value,
      symbolIds: rankedSymbols,
      nodes: graphNodes,
      fileIndex: fileToSymbolIds,
    });
    showDropdownResults(results);
  }

  searchInput.addEventListener('focus', () => {
    updateDropdownResults();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      updateDropdownResults();
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

  refreshBtn.addEventListener('click', () => {
    void refreshGraphData({ refreshIndex: true, preserveVisible: true, showFeedback: true });
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
    syncDetailPanelLayout();
    const cyEl = document.getElementById('cy');
    if (cyEl) showOnboardingHint(cyEl);
    refreshAnalysisGraphState();
  });
}
