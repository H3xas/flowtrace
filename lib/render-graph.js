/**
 * Graph rendering for the trace step: turns the folded `{ nodes, edges }`
 * graph `lib/render-tree.js` `foldedGraph()` already built into a mermaid
 * flowchart and a self-contained HTML DAG viewer. Neither renderer re-walks anything —
 * both read the same in-memory graph the trace produced.
 *
 * A folded stub — `{ id, ref }`, `ref` here being the canonical node's own `id`, not a
 * label (see `lib/render-tree.js`) — is resolved to the full node it points at before
 * either renderer sees it: `resolveGraph` is the one place that happens, so a caller
 * reached from several places draws as one node with several incoming edges rather than
 * once per caller.
 */

import { buildEvidenceIndex } from './cover.js';

/** A stub carries only `{ id, ref }`; a full node always carries `repo` alongside it. */
function isFullNode(node) {
  return node !== null && typeof node === 'object' && 'repo' in node;
}

/**
 * Collapses every folded stub to the full node it points at: edges are re-pointed to
 * the canonical id and de-duplicated, and the returned node list carries only full
 * nodes — a stub's own id never appears in the result. An edge with either end missing
 * from the walk's own node list (should not happen, but a renderer should not crash on
 * it) is dropped rather than kept dangling.
 */
export function resolveGraph(graph) {
  const canonicalOf = new Map();
  const fullById = new Map();
  for (const node of graph.nodes || []) {
    if (isFullNode(node)) {
      canonicalOf.set(node.id, node.id);
      fullById.set(node.id, node);
    }
  }
  for (const node of graph.nodes || []) {
    if (!isFullNode(node)) canonicalOf.set(node.id, node.ref);
  }
  const resolve = (id) => (canonicalOf.has(id) ? canonicalOf.get(id) : id);

  const seen = new Set();
  const edges = [];
  for (const edge of graph.edges || []) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    if (!fullById.has(from) || !fullById.has(to)) continue;
    const key = `${from}|${to}|${edge.via ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, via: edge.via });
  }
  return { nodes: [...fullById.values()], edges };
}

/**
 * Layered DAG layout: longest-path layering by each node's own `hops` (falling back to
 * longest path over `edges` when `hops` is missing or not a number), then a few passes
 * of barycenter ordering within each layer to reduce edge crossings. Deliberately pure
 * and self-contained — it never references anything outside its own parameters — because
 * its source is embedded verbatim (`toString()`) into the HTML page's inline script,
 * where it runs with nothing else from this module in scope.
 */
export function computeLayout(nodes, edges, options) {
  const layerGap = (options && options.layerGap) || 220;
  const nodeGap = (options && options.nodeGap) || 90;

  var byId = new Map();
  for (var i = 0; i < nodes.length; i += 1) byId.set(nodes[i].id, nodes[i]);

  var incoming = new Map();
  var outgoing = new Map();
  for (var j = 0; j < nodes.length; j += 1) {
    incoming.set(nodes[j].id, []);
    outgoing.set(nodes[j].id, []);
  }
  for (var e = 0; e < edges.length; e += 1) {
    var edge = edges[e];
    if (incoming.has(edge.to)) incoming.get(edge.to).push(edge.from);
    if (outgoing.has(edge.from)) outgoing.get(edge.from).push(edge.to);
  }

  var layerOf = new Map();
  var visiting = new Set();
  function layerFor(id) {
    if (layerOf.has(id)) return layerOf.get(id);
    var node = byId.get(id);
    if (node && typeof node.hops === 'number') {
      layerOf.set(id, node.hops);
      return node.hops;
    }
    if (visiting.has(id)) {
      layerOf.set(id, 0);
      return 0;
    }
    visiting.add(id);
    var preds = incoming.get(id) || [];
    var layer = 0;
    for (var p = 0; p < preds.length; p += 1) {
      if (!byId.has(preds[p])) continue;
      var predLayer = layerFor(preds[p]);
      if (predLayer + 1 > layer) layer = predLayer + 1;
    }
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  }
  for (var k = 0; k < nodes.length; k += 1) layerFor(nodes[k].id);

  var orderIndex = new Map();
  for (var o = 0; o < nodes.length; o += 1) orderIndex.set(nodes[o].id, o);

  var layers = new Map();
  for (var n = 0; n < nodes.length; n += 1) {
    var layer2 = layerOf.get(nodes[n].id);
    if (!layers.has(layer2)) layers.set(layer2, []);
    layers.get(layer2).push(nodes[n].id);
  }
  var layerKeys = Array.from(layers.keys()).sort(function (a, b) { return a - b; });
  for (var lk = 0; lk < layerKeys.length; lk += 1) {
    layers.get(layerKeys[lk]).sort(function (a, b) { return orderIndex.get(a) - orderIndex.get(b); });
  }

  var positionOf = new Map();
  function refreshPositions() {
    for (var rl = 0; rl < layerKeys.length; rl += 1) {
      var ids = layers.get(layerKeys[rl]);
      for (var ri = 0; ri < ids.length; ri += 1) positionOf.set(ids[ri], ri);
    }
  }
  refreshPositions();

  for (var pass = 0; pass < 4; pass += 1) {
    var forward = pass % 2 === 0;
    var order = forward ? layerKeys : layerKeys.slice().reverse();
    for (var oi = 0; oi < order.length; oi += 1) {
      var key = order[oi];
      var ids2 = layers.get(key);
      var scored = ids2.map(function (id) {
        var refs = forward ? incoming.get(id) : outgoing.get(id);
        var positions = (refs || [])
          .map(function (ref) { return positionOf.get(ref); })
          .filter(function (p) { return p !== undefined; });
        var bary = positions.length > 0
          ? positions.reduce(function (sum, p) { return sum + p; }, 0) / positions.length
          : positionOf.get(id);
        return { id: id, bary: bary };
      });
      scored.sort(function (a, b) { return a.bary - b.bary; });
      layers.set(key, scored.map(function (entry) { return entry.id; }));
      refreshPositions();
    }
  }

  return nodes.map(function (node) {
    var layer = layerOf.get(node.id);
    var index = positionOf.get(node.id);
    return { id: node.id, layer: layer, x: layer * layerGap, y: index * nodeGap };
  });
}

const SHAPE_WRAP = {
  stadium: (label) => `(["${label}"])`,
  cylinder: (label) => `[("${label}")]`,
  hexagon: (label) => `{{"${label}"}}`,
  diamond: (label) => `{"${label}"}`,
  rounded: (label) => `("${label}")`,
  rect: (label) => `["${label}"]`,
};

/**
 * Shape family by kind: route (stadium), db sink (cylinder), bus message (hexagon),
 * branch (diamond), component or handler hop (rounded); everything else — class,
 * method, service, page, action, consumer, processor, store_action, push, http_out — a
 * plain rectangle.
 */
function shapeFor(node) {
  if (node.kind === 'route') return 'stadium';
  if (node.kind === 'db') return 'cylinder';
  if (node.kind === 'message') return 'hexagon';
  if (node.kind === 'branch') return 'diamond';
  if (node.kind === 'component' || node.via === 'handler') return 'rounded';
  return 'rect';
}

/** A route's own `ref` is already `${VERB} ${path}` (`lib/normalize.js` `routeKey`); every other kind labels by `ref` alone. */
function labelFor(node) {
  return node.ref ?? node.id;
}

function escapeLabel(text) {
  return String(text).replace(/"/g, "'").replace(/\r?\n/g, ' ');
}

function mermaidId(prefix, raw) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_]/g, '_');
  return `${prefix}${cleaned}`;
}

/**
 * Coverage-tier overlay. The tiers are read off the *same* evidence index
 * `cover` and `cases` already build (`lib/cover.js` `buildEvidenceIndex`) — nothing here
 * re-derives which test touches which route. Three tiers, per route key:
 *
 * - `asserted`     — an executing test names the route *and* that same `(spec, test)`
 *                    carries at least one `pw_assert` fact.
 * - `stubbed-only` — an executing test names the route (a Cypress `cy.intercept`, a
 *                    Playwright `pw_request` or `page.route` `pw_stub`) but no assertion
 *                    fact is recorded for that test.
 * - `none`         — nothing executing names the route at all.
 *
 * Two limits the legend states out loud rather than hiding. A `skipped` test proves
 * nothing ran, so skipped-only evidence tiers `none`, matching `cover`'s own refusal to
 * promote a seed a skipped test reached. And the fact schema carries no Cypress
 * assertion fact at all (`pw_assert` is Playwright-only), so a route whose only evidence
 * is Cypress can never reach `asserted` — it is a schema gap, not a verdict about the
 * spec.
 */
export const COVER_TIERS = Object.freeze(['asserted', 'stubbed-only', 'none']);

const TIER_CLASS = Object.freeze({
  asserted: 'ftAsserted',
  'stubbed-only': 'ftStubbedOnly',
  none: 'ftNone',
});

const TIER_STYLE = Object.freeze({
  asserted: 'fill:#dff3e3,stroke:#2f7d4f,stroke-width:2px,color:#10331f',
  'stubbed-only': 'fill:#fdf1d0,stroke:#a8792a,stroke-width:2px,color:#3a2c07',
  none: 'fill:#fadcdc,stroke:#b04747,stroke-width:2px,color:#3a1414',
});

const TIER_LEGEND = Object.freeze({
  asserted: 'asserted - an executing test hits this route and asserts in the same test',
  'stubbed-only': 'stubbed-only - an executing test hits this route, no assertion recorded',
  none: 'none - no executing test names this route',
});

/**
 * A `--specs` value into a token list: comma-separated, newline-separated, or both —
 * the same text whether it came from the command line or from a file. Blank tokens and
 * `#` comment lines are dropped; order and duplicates are normalised away so two runs
 * over the same selection filter identically.
 */
export function parseSpecList(text) {
  const tokens = [];
  const seen = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const stripped = line.split('#')[0];
    for (const raw of stripped.split(',')) {
      const token = raw.trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * A spec path matches a `--specs` token when the token is the whole path, a trailing
 * path segment of it, or its bare file name — so `cart.pw.ts`, `checkout/cart.pw.ts`
 * and the full repository-relative path all select the same spec.
 */
function specMatches(specPath, token) {
  const path = String(specPath ?? '');
  const want = String(token ?? '');
  if (!path || !want) return false;
  if (path === want) return true;
  if (path.endsWith(`/${want}`)) return true;
  return path.slice(path.lastIndexOf('/') + 1) === want;
}

function assertedTests(factSets) {
  const tests = new Set();
  for (const set of factSets || []) {
    for (const fact of set.facts || []) {
      if (fact.type === 'pw_assert') tests.add(`${fact.spec}::${fact.test}`);
    }
  }
  return tests;
}

/**
 * Tier every route key the evidence index knows about, optionally narrowed to a set of
 * specs. Returns `{ tiers, evidence, specs, unmatchedSpecs }`: `tiers` maps a
 * route key to one of `COVER_TIERS`, `evidence` maps it to the executing evidence rows
 * that survived the filter, and `unmatchedSpecs` names any `--specs` token no spec in
 * the fact sets answers to — the caller warns rather than silently tiering everything
 * `none`.
 */
export function buildCoverOverlay(factSets, { specs = [], aliases = [] } = {}) {
  const index = buildEvidenceIndex(factSets || [], { aliases });
  const asserted = assertedTests(factSets);
  const tokens = parseSpecList(Array.isArray(specs) ? specs.join('\n') : specs);

  const tiers = new Map();
  const evidence = new Map();
  for (const [routeKey, entries] of index.byRoute) {
    const kept = entries.filter(
      (entry) =>
        !entry.skipped && (tokens.length === 0 || tokens.some((token) => specMatches(entry.spec, token))),
    );
    const tier =
      kept.length === 0
        ? 'none'
        : kept.some((entry) => asserted.has(`${entry.spec}::${entry.test}`))
          ? 'asserted'
          : 'stubbed-only';
    tiers.set(routeKey, tier);
    evidence.set(routeKey, kept);
  }

  const knownSpecs = [...index.specs.keys()];
  const unmatchedSpecs = tokens.filter((token) => !knownSpecs.some((spec) => specMatches(spec, token)));
  return { tiers, evidence, specs: tokens, unmatchedSpecs };
}

/** The tier a route node draws in — an unseen route key is `none`, never absent. */
export function tierOf(overlay, routeRef) {
  if (!overlay || !overlay.tiers) return 'none';
  return overlay.tiers.get(routeRef) ?? 'none';
}

/**
 * The overlay's own lines: three `classDef`s, a legend `subgraph` keyed to them, one
 * `class` assignment per non-empty tier, and `%%` comments stating what the colouring
 * does *not* claim. Emitted only when an overlay was passed; an un-overlaid render contains
 * only the neutral base drawing.
 */
function overlayLines(overlay, routeNodes) {
  const lines = [];
  const buckets = new Map(COVER_TIERS.map((tier) => [tier, []]));
  for (const node of routeNodes) buckets.get(tierOf(overlay, node.ref)).push(mermaidId('n', node.id));

  lines.push('  subgraph ft_legend["coverage overlay - evidence tier"]');
  for (const tier of COVER_TIERS) {
    lines.push(`    ft_legend_${TIER_CLASS[tier]}["${escapeLabel(TIER_LEGEND[tier])}"]`);
  }
  lines.push('  end');
  for (const tier of COVER_TIERS) {
    lines.push(`  classDef ${TIER_CLASS[tier]} ${TIER_STYLE[tier]}`);
  }
  for (const tier of COVER_TIERS) {
    lines.push(`  class ft_legend_${TIER_CLASS[tier]} ${TIER_CLASS[tier]}`);
    const ids = buckets.get(tier);
    if (ids.length > 0) lines.push(`  class ${ids.join(',')} ${TIER_CLASS[tier]}`);
  }
  lines.push('%% cover-overlay: a tier is a claim about the route node alone. A node downstream of');
  lines.push('%% a tiered route carries no evidence of its own and is left uncoloured.');
  lines.push('%% A skipped test is not evidence: a route only a skipped test names tiers `none`.');
  lines.push('%% Cypress evidence can never reach `asserted` - the fact schema records no Cypress');
  lines.push('%% assertion fact, only `pw_assert`.');
  if (overlay.specs.length > 0) {
    lines.push(`%% evidence filtered to ${overlay.specs.length} spec selector${overlay.specs.length === 1 ? '' : 's'}: ${overlay.specs.join(', ')}`);
  }
  return lines;
}

/**
 * `flowchart LR` text from the folded graph: one `subgraph` per repo a node belongs
 * to, one shaped node line per full node, `-->|via|` edges with stubs re-pointed to
 * their canonical node. Capped at `maxNodes` (default 120, the render cap — distinct
 * from `--max-nodes`, which bounds the walk itself): past the cap, a trailing `%%`
 * comment names how many nodes were cut and says `--max-nodes` is the walk's own
 * control, not this render cap.
 *
 * `coverOverlay` (from `buildCoverOverlay`) additionally colours every `route`
 * node by its evidence tier and appends a legend subgraph; without it not one extra
 * byte is emitted.
 */
export function renderMermaid(graph, { maxNodes = 120, coverOverlay = null } = {}) {
  const resolved = resolveGraph(graph);
  const cut = Math.max(0, resolved.nodes.length - maxNodes);
  const kept = cut > 0 ? resolved.nodes.slice(0, maxNodes) : resolved.nodes;
  const keptIds = new Set(kept.map((node) => node.id));
  const edges = resolved.edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));

  const byRepo = new Map();
  for (const node of kept) {
    const repo = node.repo ?? '(unknown)';
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(node);
  }

  const lines = ['flowchart LR'];
  for (const [repo, repoNodes] of byRepo) {
    lines.push(`  subgraph ${mermaidId('repo_', repo)}["${escapeLabel(repo)}"]`);
    for (const node of repoNodes) {
      const wrap = SHAPE_WRAP[shapeFor(node)];
      lines.push(`    ${mermaidId('n', node.id)}${wrap(escapeLabel(labelFor(node)))}`);
    }
    lines.push('  end');
  }
  for (const edge of edges) {
    const label = edge.via ? `|${escapeLabel(edge.via)}|` : '';
    lines.push(`  ${mermaidId('n', edge.from)} -->${label} ${mermaidId('n', edge.to)}`);
  }
  if (coverOverlay) {
    lines.push(...overlayLines(coverOverlay, kept.filter((node) => node.kind === 'route')));
  }
  if (cut > 0) {
    lines.push(
      `%% cut ${cut} node${cut === 1 ? '' : 's'} past the ${maxNodes}-node render cap ` +
        `(--max-nodes controls the walk that built this graph, not this render cap)`,
    );
  }
  return lines.join('\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS_TEXT = `
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #62626c;
  --panel-bg: #f4f4f7;
  --border: #d3d3da;
  --edge: #83838f;
  --accent: #2f5fc0;
  --band-a: rgba(47, 95, 192, 0.07);
  --band-b: rgba(190, 90, 40, 0.07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14151a;
    --fg: #e8e8ec;
    --muted: #9a9aa6;
    --panel-bg: #1d1e25;
    --border: #34353e;
    --edge: #75757f;
    --accent: #7fa4ff;
    --band-a: rgba(127, 164, 255, 0.08);
    --band-b: rgba(230, 150, 90, 0.08);
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; width: 100%; height: 100%;
  background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  overflow: hidden;
}
header#summary {
  position: fixed; top: 0; left: 0; right: 0; z-index: 5;
  padding: 8px 14px; font-size: 13px; line-height: 1.4;
  background: var(--panel-bg); border-bottom: 1px solid var(--border);
}
#stage-wrap {
  position: absolute; top: 42px; left: 0; right: 0; bottom: 0;
  overflow: hidden; cursor: grab;
}
#stage-wrap.dragging { cursor: grabbing; }
svg#stage { width: 100%; height: 100%; display: block; }
.band-label { fill: var(--muted); font-size: 11px; font-weight: 600; }
.edge { stroke: var(--edge); stroke-width: 1.4; fill: none; }
.edge-label { fill: var(--muted); font-size: 10px; }
.edge-label-bg { fill: var(--bg); opacity: 0.85; }
.node-shape { stroke: var(--accent); stroke-width: 1.4; fill: var(--panel-bg); }
.node { cursor: pointer; }
.node text { fill: var(--fg); font-size: 11px; }
.node.selected .node-shape { stroke-width: 3; }
#legend {
  position: fixed; right: 10px; bottom: 10px; z-index: 5; max-width: 230px;
  background: var(--panel-bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; font-size: 11px;
}
#legend h2 { font-size: 11px; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
#legend .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
#legend svg { flex: none; }
#panel {
  position: fixed; top: 42px; right: 0; bottom: 0; width: 300px; z-index: 6;
  background: var(--panel-bg); border-left: 1px solid var(--border);
  padding: 14px; overflow: auto; font-size: 12px;
  transform: translateX(100%); transition: transform 0.15s ease;
}
#panel.open { transform: translateX(0); }
#panel h2 { font-size: 13px; margin: 0 0 8px; padding-right: 20px; }
#panel dt { color: var(--muted); font-size: 10px; text-transform: uppercase; margin-top: 8px; }
#panel dd { margin: 2px 0 0; word-break: break-word; }
#panel ul { list-style: none; margin: 4px 0 0; padding: 0; }
#panel li { padding: 3px 0; border-bottom: 1px solid var(--border); }
#panel-close {
  position: absolute; top: 10px; right: 10px; cursor: pointer;
  background: none; border: none; color: var(--fg); font-size: 16px; line-height: 1;
}
#hint { position: fixed; left: 10px; bottom: 10px; z-index: 5; font-size: 11px; color: var(--muted); }
`;

/**
 * The browser-side script, written without template literals or backticks anywhere in
 * its own body (it is embedded as literal text inside this module's own template
 * literal, and `computeLayout`'s source is spliced in ahead of it the same way) — plain
 * string concatenation throughout keeps that splice unambiguous.
 */
const BOOTSTRAP_JS = `
(function () {
  'use strict';
  var stage = document.getElementById('stage');
  var stageWrap = document.getElementById('stage-wrap');
  var panel = document.getElementById('panel');
  var panelBody = document.getElementById('panel-body');
  var panelClose = document.getElementById('panel-close');
  var legend = document.getElementById('legend');

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncate(text, max) {
    var value = String(text);
    return value.length > max ? value.slice(0, max - 1) + '\\u2026' : value;
  }

  var SHAPES = {
    route: 'stadium',
    db: 'cylinder',
    message: 'hexagon',
    branch: 'diamond'
  };

  function shapeFor(node) {
    if (SHAPES[node.kind]) return SHAPES[node.kind];
    if (node.kind === 'component' || node.via === 'handler') return 'rounded';
    return 'rect';
  }

  function labelFor(node) {
    return node.ref || node.id;
  }

  var nodesById = {};
  for (var i = 0; i < GRAPH.nodes.length; i += 1) nodesById[GRAPH.nodes[i].id] = GRAPH.nodes[i];

  var incomingOf = {};
  var outgoingOf = {};
  for (var j = 0; j < GRAPH.nodes.length; j += 1) {
    incomingOf[GRAPH.nodes[j].id] = [];
    outgoingOf[GRAPH.nodes[j].id] = [];
  }
  for (var k = 0; k < GRAPH.edges.length; k += 1) {
    var edge = GRAPH.edges[k];
    if (outgoingOf[edge.from]) outgoingOf[edge.from].push(edge);
    if (incomingOf[edge.to]) incomingOf[edge.to].push(edge);
  }

  var LAYOUT = computeLayout(GRAPH.nodes, GRAPH.edges, {});
  var posById = {};
  for (var p = 0; p < LAYOUT.length; p += 1) posById[LAYOUT[p].id] = LAYOUT[p];

  var BOX_H = 44;
  var BOX_PAD_Y = 30;

  function boxWidth(label) {
    var width = 24 + String(label).length * 6.4;
    if (width < 100) width = 100;
    if (width > 240) width = 240;
    return width;
  }

  var maxX = 0;
  var maxY = 0;
  var boxOf = {};
  for (var b = 0; b < GRAPH.nodes.length; b += 1) {
    var node = GRAPH.nodes[b];
    var pos = posById[node.id];
    var w = boxWidth(truncate(labelFor(node), 34));
    boxOf[node.id] = { x: pos.x, y: pos.y, w: w, h: BOX_H };
    if (pos.x + w > maxX) maxX = pos.x + w;
    if (pos.y + BOX_H > maxY) maxY = pos.y + BOX_H;
  }
  var width = maxX + 160;
  var height = maxY + 160;

  function shapeMarkup(shape, w, h) {
    if (shape === 'stadium') {
      return '<rect class="node-shape" x="0" y="0" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '" ry="' + (h / 2) + '"></rect>';
    }
    if (shape === 'rounded') {
      return '<rect class="node-shape" x="0" y="0" width="' + w + '" height="' + h + '" rx="10" ry="10"></rect>';
    }
    if (shape === 'diamond') {
      var pts = (w / 2) + ',0 ' + w + ',' + (h / 2) + ' ' + (w / 2) + ',' + h + ' 0,' + (h / 2);
      return '<polygon class="node-shape" points="' + pts + '"></polygon>';
    }
    if (shape === 'hexagon') {
      var hx = w * 0.15;
      var hpts = hx + ',0 ' + (w - hx) + ',0 ' + w + ',' + (h / 2) + ' ' + (w - hx) + ',' + h + ' ' + hx + ',' + h + ' 0,' + (h / 2);
      return '<polygon class="node-shape" points="' + hpts + '"></polygon>';
    }
    if (shape === 'cylinder') {
      var ry = h * 0.22;
      var body = '<rect class="node-shape" x="0" y="' + (ry / 2) + '" width="' + w + '" height="' + (h - ry) + '"></rect>';
      var bottom = '<path class="node-shape" d="M0,' + (h - ry / 2) + ' A ' + (w / 2) + ',' + ry + ' 0 0 0 ' + w + ',' + (h - ry / 2) + '"></path>';
      var top = '<ellipse class="node-shape" cx="' + (w / 2) + '" cy="' + (ry / 2) + '" rx="' + (w / 2) + '" ry="' + ry + '"></ellipse>';
      return body + bottom + top;
    }
    return '<rect class="node-shape" x="0" y="0" width="' + w + '" height="' + h + '"></rect>';
  }

  var byRepo = {};
  var repoOrder = [];
  for (var r = 0; r < GRAPH.nodes.length; r += 1) {
    var repoNode = GRAPH.nodes[r];
    var repo = repoNode.repo || '(unknown)';
    if (!byRepo[repo]) { byRepo[repo] = []; repoOrder.push(repo); }
    byRepo[repo].push(boxOf[repoNode.id]);
  }

  var bandsMarkup = '';
  for (var rb = 0; rb < repoOrder.length; rb += 1) {
    var repoName = repoOrder[rb];
    var boxes = byRepo[repoName];
    var minY = Infinity;
    var maxYb = -Infinity;
    for (var bb = 0; bb < boxes.length; bb += 1) {
      if (boxes[bb].y < minY) minY = boxes[bb].y;
      if (boxes[bb].y + boxes[bb].h > maxYb) maxYb = boxes[bb].y + boxes[bb].h;
    }
    var top = minY - 20;
    var bandH = (maxYb - minY) + 40;
    var fill = rb % 2 === 0 ? 'var(--band-a)' : 'var(--band-b)';
    bandsMarkup += '<rect x="0" y="' + top + '" width="' + width + '" height="' + bandH + '" fill="' + fill + '"></rect>';
    bandsMarkup += '<text class="band-label" x="8" y="' + (top + 14) + '">' + escapeXml(repoName) + '</text>';
  }

  function anchor(box) {
    return { x: box.x + box.w, y: box.y + box.h / 2, x2: box.x, y2: box.y + box.h / 2 };
  }

  var edgesMarkup = '';
  for (var em = 0; em < GRAPH.edges.length; em += 1) {
    var e = GRAPH.edges[em];
    var fromBox = boxOf[e.from];
    var toBox = boxOf[e.to];
    if (!fromBox || !toBox) continue;
    var a = anchor(fromBox);
    var midX = (a.x + toBox.x) / 2;
    var midY = (a.y + toBox.y + toBox.h / 2) / 2;
    var d = 'M' + a.x + ',' + a.y + ' L' + toBox.x + ',' + (toBox.y + toBox.h / 2);
    edgesMarkup += '<path class="edge" marker-end="url(#arrow)" d="' + d + '"></path>';
    if (e.via) {
      var label = escapeXml(e.via);
      var lw = label.length * 5.6 + 6;
      edgesMarkup += '<rect class="edge-label-bg" x="' + (midX - lw / 2) + '" y="' + (midY - 8) + '" width="' + lw + '" height="14"></rect>';
      edgesMarkup += '<text class="edge-label" x="' + midX + '" y="' + (midY + 3) + '" text-anchor="middle">' + label + '</text>';
    }
  }

  var nodesMarkup = '';
  for (var nm = 0; nm < GRAPH.nodes.length; nm += 1) {
    var n = GRAPH.nodes[nm];
    var box = boxOf[n.id];
    var shape = shapeFor(n);
    var label = escapeXml(truncate(labelFor(n), 34));
    nodesMarkup += '<g class="node" data-id="' + n.id + '" transform="translate(' + box.x + ',' + box.y + ')">';
    nodesMarkup += '<title>' + escapeXml(labelFor(n)) + '</title>';
    nodesMarkup += shapeMarkup(shape, box.w, box.h);
    nodesMarkup += '<text x="' + (box.w / 2) + '" y="' + (box.h / 2 + 4) + '" text-anchor="middle">' + label + '</text>';
    nodesMarkup += '</g>';
  }

  var viewport = document.getElementById('viewport');
  viewport.innerHTML = bandsMarkup + edgesMarkup + nodesMarkup;
  stage.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

  var scale = 1;
  var panX = 0;
  var panY = 0;

  function applyTransform() {
    viewport.setAttribute('transform', 'translate(' + panX + ',' + panY + ') scale(' + scale + ')');
  }
  applyTransform();

  stageWrap.addEventListener('wheel', function (event) {
    event.preventDefault();
    var delta = event.deltaY > 0 ? 0.9 : 1.1;
    var next = scale * delta;
    if (next < 0.15) next = 0.15;
    if (next > 4) next = 4;
    var rect = stageWrap.getBoundingClientRect();
    var cx = event.clientX - rect.left;
    var cy = event.clientY - rect.top;
    panX = cx - ((cx - panX) / scale) * next;
    panY = cy - ((cy - panY) / scale) * next;
    scale = next;
    applyTransform();
  }, { passive: false });

  var dragging = false;
  var lastX = 0;
  var lastY = 0;
  stageWrap.addEventListener('mousedown', function (event) {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    stageWrap.classList.add('dragging');
  });
  window.addEventListener('mousemove', function (event) {
    if (!dragging) return;
    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    applyTransform();
  });
  window.addEventListener('mouseup', function () {
    dragging = false;
    stageWrap.classList.remove('dragging');
  });

  var selected = null;
  function selectNode(id) {
    if (selected) selected.classList.remove('selected');
    var el = stage.querySelector('.node[data-id="' + id + '"]');
    if (!el) return;
    el.classList.add('selected');
    selected = el;
    showPanel(id);
  }

  function showPanel(id) {
    var node = nodesById[id];
    if (!node) return;
    var where = node.file ? (node.file + ':' + (node.line || 0)) : '(no location)';
    var html = '';
    html += '<h2>' + escapeXml(labelFor(node)) + '</h2>';
    html += '<dl>';
    html += '<dt>Repo</dt><dd>' + escapeXml(node.repo || '') + '</dd>';
    html += '<dt>Kind</dt><dd>' + escapeXml(node.kind || '') + '</dd>';
    html += '<dt>Location</dt><dd>' + escapeXml(where) + '</dd>';
    html += '<dt>Via</dt><dd>' + escapeXml(node.via || '') + '</dd>';
    html += '</dl>';

    var incoming = incomingOf[id] || [];
    html += '<dt>Incoming (' + incoming.length + ')</dt><ul>';
    for (var ii = 0; ii < incoming.length; ii += 1) {
      var fromNode = nodesById[incoming[ii].from];
      html += '<li>' + escapeXml(fromNode ? labelFor(fromNode) : incoming[ii].from) + ' &rarr; [' + escapeXml(incoming[ii].via || '') + ']</li>';
    }
    html += '</ul>';

    var outgoing = outgoingOf[id] || [];
    html += '<dt>Outgoing (' + outgoing.length + ')</dt><ul>';
    for (var oo = 0; oo < outgoing.length; oo += 1) {
      var toNode = nodesById[outgoing[oo].to];
      html += '<li>[' + escapeXml(outgoing[oo].via || '') + '] &rarr; ' + escapeXml(toNode ? labelFor(toNode) : outgoing[oo].to) + '</li>';
    }
    html += '</ul>';

    panelBody.innerHTML = html;
    panel.classList.add('open');
  }

  stage.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('.node') : null;
    if (!target) return;
    selectNode(target.getAttribute('data-id'));
  });

  panelClose.addEventListener('click', function () {
    panel.classList.remove('open');
    if (selected) { selected.classList.remove('selected'); selected = null; }
  });

  var legendRows = [
    ['stadium', 'route'],
    ['cylinder', 'db sink'],
    ['hexagon', 'bus message'],
    ['diamond', 'branch'],
    ['rounded', 'component / handler'],
    ['rect', 'everything else']
  ];
  var legendHtml = '<h2>Legend</h2>';
  for (var lr = 0; lr < legendRows.length; lr += 1) {
    var shapeName = legendRows[lr][0];
    var swatch = '<svg width="26" height="18"><g transform="translate(2,1)">' + shapeMarkup(shapeName, 22, 16) + '</g></svg>';
    legendHtml += '<div class="row">' + swatch + '<span>' + escapeXml(legendRows[lr][1]) + '</span></div>';
  }
  legend.innerHTML = legendHtml;
})();
`;

/**
 * One self-contained HTML page: inline CSS and JS, zero external requests (no CDN, no
 * fetched fonts), a layered DAG computed client-side by \`computeLayout\` (embedded by
 * source, so the same function this module exports is what actually runs in the
 * browser). Pan (drag) and zoom (wheel) apply a transform to a single \`<g>\`; a click
 * opens a side panel with repo, file:line, kind, via and this node's incoming/outgoing
 * edges; a legend explains the shape-by-kind convention; repo lanes are translucent
 * background bands sized to each repo's own nodes. Dark/light follows
 * \`prefers-color-scheme\` — there is no other theme switch. Works from \`file://\`: every
 * asset is inline, and the graph JSON is escaped (\`<\` to \\u003c) so a \`</script>\` inside
 * a label can never close the tag early.
 */
export function renderHtml(graph, { title = 'flowtrace graph' } = {}) {
  const originalTotal = (graph.nodes || []).length;
  const resolved = resolveGraph(graph);
  const foldedCount = originalTotal - resolved.nodes.length;
  const repoCount = new Set(resolved.nodes.map((node) => node.repo)).size;
  const payload = { nodes: resolved.nodes, edges: resolved.edges };
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  const headline =
    `${resolved.nodes.length} node${resolved.nodes.length === 1 ? '' : 's'}, ` +
    `${resolved.edges.length} edge${resolved.edges.length === 1 ? '' : 's'}, ` +
    `${foldedCount} folded stub${foldedCount === 1 ? '' : 's'} collapsed, ` +
    `${repoCount} repo${repoCount === 1 ? '' : 's'}`;

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>' + CSS_TEXT + '</style>',
    '</head>',
    '<body>',
    '<header id="summary">' + escapeHtml(title) + ' — ' + escapeHtml(headline) + '</header>',
    '<div id="stage-wrap">',
    '<svg id="stage"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--edge)"></path></marker></defs><g id="viewport"></g></svg>',
    '</div>',
    '<div id="legend"></div>',
    '<div id="hint">wheel to zoom &middot; drag to pan &middot; click a node for details</div>',
    '<div id="panel"><button id="panel-close" aria-label="close">&times;</button><div id="panel-body">Click a node to see its details.</div></div>',
    '<script>',
    'var GRAPH = ' + json + ';',
    computeLayout.toString(),
    BOOTSTRAP_JS,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}
