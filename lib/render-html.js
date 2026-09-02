/**
 * Standalone readable HTML rendering for the trace step: the mermaid
 * `--cover-overlay` drawing (`lib/render-graph.js` `renderMermaid`) is unreadable once a
 * real route's fan-out fights the mermaid layout engine, so this module draws the same
 * folded graph its own way instead — one section per traced route, each flow written as
 * a wrapping horizontal chain of node "pills" with arrow glyphs between them, and a
 * fan-out rendered as an indented sub-chain under the node that branches. No mermaid, no
 * SVG layout, no dependency: plain strings, inline CSS, nothing fetched.
 *
 * Coverage tiers (`asserted` / `stubbed-only` / `none`) come from the same
 * `buildCoverOverlay` evidence index `renderMermaid` reads; a node earns one of those
 * three only when it is a `route` node and an overlay was actually passed in. Every
 * other node, and every route node when no overlay was requested at all, draws
 * `neutral` — a fourth, uncoloured tier meaning "not evaluated", kept visually and
 * semantically distinct from `none` ("evaluated, nothing covers it").
 */

import { resolveGraph, tierOf } from './render-graph.js';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function refOf(node) {
  return node.ref ?? node.id;
}

function shortLabel(node) {
  const label = String(refOf(node));
  return label.length > 42 ? `${label.slice(0, 39)}…` : label;
}

function locationOf(node) {
  return node.file ? `${node.file}:${node.line ?? '?'}` : '(no location)';
}

function fullTitle(node) {
  return `${refOf(node)} — ${locationOf(node)}`;
}

const TIER_KEY = Object.freeze({
  asserted: 'asserted',
  'stubbed-only': 'stubbed',
  none: 'none',
});

const TIER_TEXT = Object.freeze({
  asserted: 'asserted',
  stubbed: 'stubbed-only',
  none: 'none',
  neutral: 'neutral',
});

/** The tier key a node draws in: `neutral` for anything that is not a route, or when no overlay was requested at all. */
function tierKeyFor(node, overlay) {
  if (!overlay || node.kind !== 'route') return 'neutral';
  return TIER_KEY[tierOf(overlay, refOf(node))] ?? 'none';
}

function buildAdjacency(nodes, edges) {
  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node);
  const outgoing = new Map();
  const incoming = new Map();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    if (outgoing.has(edge.from)) outgoing.get(edge.from).push(edge);
    if (incoming.has(edge.to)) incoming.get(edge.to).push(edge);
  }
  return { byId, outgoing, incoming };
}

/** Nodes no edge in this graph points at, in the graph's own node order — the walk's own start points. */
function findRoots(nodes, incoming) {
  const roots = nodes.filter((node) => (incoming.get(node.id) || []).length === 0);
  return roots.length > 0 ? roots : nodes.slice(0, 1);
}

/** Every node reachable from `rootId` following outgoing edges, visited once regardless of how many paths reach it. */
function reachableFrom(rootId, outgoing) {
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const edge of outgoing.get(current) || []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      stack.push(edge.to);
    }
  }
  return seen;
}

function pillHtml(node, overlay) {
  const tier = tierKeyFor(node, overlay);
  return (
    `<span class="pill tier-${tier}" title="${escapeHtml(fullTitle(node))}">` +
    `${escapeHtml(shortLabel(node))}</span>`
  );
}

const ARROW_HTML = '<span class="arrow" aria-hidden="true">→</span>';
const CYCLE_ARROW_HTML = '<span class="arrow cycle" aria-hidden="true">↻</span>';

/**
 * One chain, in flow order, plus the fan-out beneath it: `pathVisited` names every node
 * already drawn earlier on *this* path, so a genuine back-edge (a message that re-enters
 * a node its own trigger came from) stops and draws a "loops back" marker instead of
 * recursing forever. A node reached again from a *different* branch is not on this path
 * and draws again in full — the same "print every occurrence" choice the unfolded tree
 * renderer made, and the honest one here: two branches converging on the same sink is a
 * real fact about the flow, not noise to collapse away.
 */
function renderChain(nodeId, byId, outgoing, overlay, pathVisited) {
  const path = new Set(pathVisited);
  const node = byId.get(nodeId);
  const pieces = [pillHtml(node, overlay)];
  path.add(nodeId);

  let current = nodeId;
  let outEdges = (outgoing.get(current) || []).filter((edge) => byId.has(edge.to));
  while (outEdges.length === 1 && !path.has(outEdges[0].to)) {
    const nextId = outEdges[0].to;
    path.add(nextId);
    pieces.push(ARROW_HTML, pillHtml(byId.get(nextId), overlay));
    current = nextId;
    outEdges = (outgoing.get(current) || []).filter((edge) => byId.has(edge.to));
  }

  const chainLine = `<div class="chain-line">${pieces.join('')}</div>`;

  if (outEdges.length === 1 && path.has(outEdges[0].to)) {
    const loopTarget = byId.get(outEdges[0].to);
    const loop =
      `<div class="chain-line">${CYCLE_ARROW_HTML}` +
      `<span class="pill tier-neutral loop" title="loops back to ${escapeHtml(fullTitle(loopTarget))}">` +
      `↻ ${escapeHtml(shortLabel(loopTarget))}</span></div>`;
    return chainLine + loop;
  }

  if (outEdges.length === 0) return chainLine;

  const branches = outEdges
    .map((edge) => `<li>${renderChain(edge.to, byId, outgoing, overlay, path)}</li>`)
    .join('');
  return `${chainLine}<ul class="branches">${branches}</ul>`;
}

function tierCounts(routeNodes, overlay) {
  const counts = { asserted: 0, stubbed: 0, none: 0, neutral: 0 };
  for (const node of routeNodes) counts[tierKeyFor(node, overlay)] += 1;
  return counts;
}

function totalsLine(counts) {
  const total = counts.asserted + counts.stubbed + counts.none + counts.neutral;
  const label = `${total} route${total === 1 ? '' : 's'}`;
  if (counts.neutral === total) return `${label} traced, no coverage overlay`;
  return `${label}: ${counts.asserted} asserted / ${counts.stubbed} stubbed / ${counts.none} uncovered`;
}

function routeHeaderHtml(node, overlay) {
  const ref = refOf(node);
  const spaceAt = ref.indexOf(' ');
  const verb = spaceAt === -1 ? '' : ref.slice(0, spaceAt);
  const path = spaceAt === -1 ? ref : ref.slice(spaceAt + 1);
  const tier = tierKeyFor(node, overlay);
  return (
    `<h2><span class="tier-badge tier-${tier}">${escapeHtml(TIER_TEXT[tier])}</span> ` +
    (verb ? `<span class="verb">${escapeHtml(verb)}</span> ` : '') +
    `<code class="path">${escapeHtml(path)}</code></h2>`
  );
}

function genericHeaderHtml(node) {
  return `<h2>${escapeHtml(shortLabel(node))} <span class="kind-tag">(${escapeHtml(node.kind || 'node')})</span></h2>`;
}

function renderSection(root, byId, outgoing, overlay) {
  const reachable = reachableFrom(root.id, outgoing);
  const routeNodes = [...reachable].map((id) => byId.get(id)).filter((node) => node.kind === 'route');
  const header = root.kind === 'route' ? routeHeaderHtml(root, overlay) : genericHeaderHtml(root);
  const sectionTotals = `<p class="section-totals">${escapeHtml(totalsLine(tierCounts(routeNodes, overlay)))}</p>`;
  const chain = renderChain(root.id, byId, outgoing, overlay, new Set());
  return `<section class="route-section">${header}${sectionTotals}${chain}</section>`;
}

const LEGEND_ENTRIES = [
  ['asserted', 'an executing test names this route and asserts in the same test'],
  ['stubbed', 'an executing test names this route, no assertion recorded'],
  ['none', 'no executing test names this route'],
  ['neutral', 'not a route, or the coverage overlay was not requested'],
];

function legendHtml() {
  const rows = LEGEND_ENTRIES.map(
    ([tier, text]) =>
      `<span class="swatch"><span class="dot tier-${tier}"></span>${escapeHtml(TIER_TEXT[tier])} — ${escapeHtml(text)}</span>`,
  ).join('');
  return `<div class="legend">${rows}</div>`;
}

const CSS_TEXT = `
:root {
  --ft-bg: #ffffff;
  --ft-fg: #1c1c22;
  --ft-muted: #5b5b66;
  --ft-border: #d8d8e0;
  --ft-panel: #f8f8fb;
  --ft-asserted-bg: #e4f6e9;
  --ft-asserted-fg: #205c34;
  --ft-asserted-border: #3f9e5e;
  --ft-stubbed-bg: #fdf1d0;
  --ft-stubbed-fg: #664611;
  --ft-stubbed-border: #b98a2e;
  --ft-none-bg: #fadcdc;
  --ft-none-fg: #7a2222;
  --ft-none-border: #c1504f;
  --ft-neutral-bg: #eceef1;
  --ft-neutral-fg: #3d3d45;
  --ft-neutral-border: #a9a9b4;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: var(--ft-bg);
  color: var(--ft-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
header.page-header {
  margin: 0 0 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ft-border);
}
header.page-header h1 { margin: 0 0 8px; font-size: 18px; }
.page-totals { margin: 0 0 10px; font-weight: 600; }
.spec-note { margin: 0 0 10px; color: var(--ft-muted); font-size: 12.5px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 12px; color: var(--ft-muted); }
.legend .swatch { display: inline-flex; align-items: center; gap: 6px; }
.legend .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; border: 1px solid var(--ft-border); }
.dot.tier-asserted, .pill.tier-asserted, .tier-badge.tier-asserted { background: var(--ft-asserted-bg); border-color: var(--ft-asserted-border); }
.dot.tier-stubbed, .pill.tier-stubbed, .tier-badge.tier-stubbed { background: var(--ft-stubbed-bg); border-color: var(--ft-stubbed-border); }
.dot.tier-none, .pill.tier-none, .tier-badge.tier-none { background: var(--ft-none-bg); border-color: var(--ft-none-border); }
.dot.tier-neutral, .pill.tier-neutral, .tier-badge.tier-neutral { background: var(--ft-neutral-bg); border-color: var(--ft-neutral-border); }
.tier-badge.tier-asserted { color: var(--ft-asserted-fg); }
.tier-badge.tier-stubbed { color: var(--ft-stubbed-fg); }
.tier-badge.tier-none { color: var(--ft-none-fg); }
.tier-badge.tier-neutral { color: var(--ft-neutral-fg); }
.route-section {
  border: 1px solid var(--ft-border);
  border-radius: 10px;
  padding: 14px 18px;
  margin: 0 0 18px;
  background: var(--ft-panel);
}
.route-section h2 { margin: 0 0 8px; font-size: 15px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tier-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1.5px solid var(--ft-neutral-border);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.verb { font-weight: 700; }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.kind-tag { color: var(--ft-muted); font-weight: 400; font-size: 12px; }
.section-totals { margin: 0 0 12px; color: var(--ft-muted); font-size: 12px; }
.chain-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 2px;
  margin: 4px 0;
}
.pill {
  display: inline-flex;
  align-items: center;
  max-width: 320px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1.5px solid var(--ft-neutral-border);
  background: var(--ft-neutral-bg);
  color: var(--ft-fg);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill.loop { font-style: italic; }
.arrow { color: var(--ft-muted); margin: 0 2px; }
.arrow.cycle { color: var(--ft-none-fg); }
.branches {
  list-style: none;
  margin: 2px 0 8px 18px;
  padding-left: 14px;
  border-left: 2px solid var(--ft-border);
}
.branches > li { margin: 6px 0; }
`;

/**
 * A self-contained HTML page for one traced flow: one `<section>` per root the resolved
 * graph starts from (almost always the one route `trace <route-glob>` was pointed at; a
 * component or page walk may reach several routes, one section each). No mermaid, no
 * SVG, no external request of any kind — every asset is inline, so the file opens
 * straight off disk. `coverOverlay` (from `buildCoverOverlay`, or `null`) is the same
 * evidence overlay `renderMermaid` takes; passing it colours every route pill by tier,
 * leaving it out (or passing `null`) draws every pill `neutral`.
 */
export function renderHtml(graph, { title = 'flowtrace trace', coverOverlay = null } = {}) {
  const resolved = resolveGraph(graph);
  const { byId, outgoing, incoming } = buildAdjacency(resolved.nodes, resolved.edges);
  const roots = findRoots(resolved.nodes, incoming);
  const allRouteNodes = resolved.nodes.filter((node) => node.kind === 'route');
  const totals = totalsLine(tierCounts(allRouteNodes, coverOverlay));
  const specsNote =
    coverOverlay && coverOverlay.specs.length > 0
      ? `<p class="spec-note">evidence filtered to ${coverOverlay.specs.length} spec selector${
          coverOverlay.specs.length === 1 ? '' : 's'
        }: ${escapeHtml(coverOverlay.specs.join(', '))}</p>`
      : '';
  const sections =
    roots.length > 0
      ? roots.map((root) => renderSection(root, byId, outgoing, coverOverlay)).join('')
      : '<p>No nodes in this trace.</p>';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${CSS_TEXT}</style>`,
    '</head>',
    '<body>',
    '<header class="page-header">',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="page-totals">${escapeHtml(totals)}</p>`,
    specsNote,
    legendHtml(),
    '</header>',
    '<main>',
    sections,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}
