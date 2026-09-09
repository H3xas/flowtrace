/**
 * The terminal trace tree as a standalone HTML page, with per-line test evidence.
 *
 * The tree is not re-implemented here. `lib/render-tree.js` exposes the helpers its own
 * `renderSubtree` prints through (`internals`), and the walk below is a structural mirror
 * of that recursion — same connectors, same fold and infra-collapse decisions, every
 * character of line text produced by `renderNodeLine`. The only thing this module adds is
 * the bookkeeping `renderTree` throws away: which node produced which line, so evidence
 * can bind to a line without either side re-deriving the other's text.
 *
 * That fidelity is a test rather than a claim. Every run of tree text on the page carries
 * `class="tt"`, nothing this module adds ever does, so the two are separable mechanically:
 * strip the markup off the `tt` runs and the result is byte-identical to
 * `renderTree(result, { color: false })` (`test/render-tree-html.test.js`).
 *
 * Evidence arrives the ordinary way — facts through `factSets`, a cover overlay the caller
 * built — so `--cover-overlay` and `--specs` mean here exactly what they mean everywhere
 * else, and an unoverlaid page states that nothing was evaluated instead of drawing a tier.
 */

import { internals, renderTrailer } from './render-tree.js';
import { tierOf } from './render-graph.js';

const { renderNodeLine, nodeLabel, orderChildren, identityKey, countOccurrences, subtreeSize, plural } = internals;

/**
 * Structural mirror of the private `renderSubtree`. Emits one record per printed line
 * instead of a bare string, carrying the node and the nearest enclosing route node —
 * evidence binds to routes, so a line's tier is its route's tier.
 */
function renderTracked(node, prefix, isLast, out, paint, expandInfra, fold, seen, counts, routeNode) {
  const connector = prefix === null ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`;
  const key = identityKey(node);
  const canonicalId = fold ? seen.get(key) : undefined;
  if (fold && canonicalId !== undefined && canonicalId !== node.id) {
    const count = counts.get(key) || 1;
    out.push({
      kind: 'fold',
      connector,
      body: paint(`↑ ${nodeLabel(node)} (see above, ×${count})`, 'dim'),
      node,
      route: routeNode,
    });
    return;
  }
  if (fold && canonicalId === undefined) seen.set(key, node.id);
  const route = node.kind === 'route' ? node : routeNode;
  out.push({ kind: 'node', connector, body: renderNodeLine(node, paint), node, route });
  const childPrefix = prefix === null ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
  const { shown, hidden } = orderChildren(node, expandInfra);
  const total = shown.length + (hidden.length > 0 ? 1 : 0);
  shown.forEach((child, position) => {
    renderTracked(child, childPrefix, position === total - 1, out, paint, expandInfra, fold, seen, counts, route);
  });
  if (hidden.length === 0) return;
  const size = hidden.reduce(
    (sum, child) => {
      const inner = subtreeSize(child);
      return { nodes: sum.nodes + inner.nodes, graph: sum.graph + inner.graph };
    },
    { nodes: 0, graph: 0 },
  );
  out.push({
    kind: 'infra',
    connector: `${childPrefix}└─ `,
    body: paint(
      `infrastructure (${plural(size.nodes, 'node')}, ${plural(size.graph, 'graph hop')}) — use --expand-infra`,
      'dim',
    ),
    node: null,
    route,
  });
}

/** One record per line the terminal renderer would print, in the order it prints them. */
export function trackedLines(result, paint, { expandInfra = false, fold = true } = {}) {
  const counts = fold ? countOccurrences(result.root, expandInfra, new Map()) : new Map();
  const out = [];
  renderTracked(result.root, null, true, out, paint, expandInfra, fold, new Map(), counts, null);
  return out;
}

const OPEN = '\u0001';
const SEP = '\u0002';
const CLOSE = '\u0003';
const KNOWN_COLORS = new Set(['dim', 'bold', 'cyan', 'yellow', 'magenta', 'red']);

/**
 * Colour leaves the renderer as sentinels rather than ANSI, so the HTML pass splits on
 * characters that cannot occur in a source line instead of parsing escape sequences back
 * out of one.
 */
const markPaint = (text, color) => `${OPEN}${KNOWN_COLORS.has(color) ? color : ''}${SEP}${text}${CLOSE}`;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One run of text the repository's own renderer produced. `tt` marks it as such, and
 * nothing this module adds carries that class, so the page's tree text is separable from
 * the page's annotations by class alone — which is what the fidelity test does.
 */
function treeSpan(text, color) {
  if (text === '') return '';
  return `<span class="tt${color ? ` c-${color}` : ''}">${escapeHtml(text)}</span>`;
}

function markedToHtml(text) {
  let html = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf(OPEN, index);
    if (open === -1) {
      html += treeSpan(text.slice(index), null);
      break;
    }
    html += treeSpan(text.slice(index, open), null);
    const sep = text.indexOf(SEP, open);
    const close = text.indexOf(CLOSE, sep);
    html += treeSpan(text.slice(sep + 1, close), text.slice(open + 1, sep));
    index = close + 1;
  }
  return html;
}

/**
 * Everything the join reads out of the fact sets, in one pass: assertion facts by test,
 * `pw_test` declaration lines, `pw_title` resolutions by source declaration line, and the
 * `exception_map` facts kept apart by scope — a global filter applies to every action, a
 * per-action catch only to its own, and the same exception type legitimately maps to
 * different statuses under each.
 */
function indexFacts(factSets) {
  const assertions = new Map();
  const declarations = new Map();
  const titlesByLine = new Map();
  const globalByType = new Map();
  const byAction = new Map();
  let filters = 0;
  for (const set of factSets || []) {
    for (const fact of set.facts || []) {
      if (fact.type === 'pw_assert') {
        const id = `${fact.spec}::${fact.test}`;
        assertions.set(id, [...(assertions.get(id) || []), fact]);
      } else if (fact.type === 'pw_test') {
        if (typeof fact.line !== 'number') continue;
        const id = `${fact.spec}::${fact.test}`;
        const seen = declarations.get(id);
        if (seen === undefined) declarations.set(id, fact.line);
        else if (seen !== fact.line) declarations.set(id, null);
      } else if (fact.type === 'pw_title') {
        titlesByLine.set(`${fact.spec}::${fact.line}`, fact.titles);
      } else if (fact.type === 'exception_map') {
        const entry = {
          scope: fact.scope,
          exception: fact.exception,
          status: String(fact.status),
          via: fact.scope === 'action' ? `${fact.class}.${fact.method}` : fact.class,
          file: fact.file,
          line: fact.line,
        };
        if (fact.scope === 'action') {
          const key = `${fact.class}.${fact.method}`;
          byAction.set(key, [...(byAction.get(key) || []), entry]);
        } else {
          if (!globalByType.has(fact.exception)) filters += 1;
          globalByType.set(fact.exception, entry);
        }
      }
    }
  }
  return { assertions, declarations, titlesByLine, globalByType, byAction, filters };
}

/**
 * The status one exception type surfaces as under one controller action. An action's own
 * `catch (T)` wins over a global filter because it runs first; a bare `catch` is tried
 * last, since a typed global mapping is the more specific claim about that type.
 */
function lookupException(index, type, controller, action) {
  const scoped = index.byAction.get(`${controller}.${action}`) || [];
  const exact = scoped.find((entry) => entry.exception === type);
  if (exact) return exact;
  if (index.globalByType.has(type)) return index.globalByType.get(type);
  return scoped.find((entry) => entry.exception === '*') || null;
}

/**
 * The title a test actually ran under. `pw_test.test` records the title *expression*, so a
 * parameterised test reads as its own source; `pw_title` carries what Playwright's own
 * collector resolved for that declaration. The collector's own join runs on
 * `(spec file, declaration ordinal)` and stamps each fact with the declaration's source
 * line, so here the two sides meet at `(spec, line)` and no template is evaluated. With no
 * `pw_title` fact the expression is kept as written and labelled `raw`, never guessed at.
 */
function resolveTitle(index, spec, rawTitle) {
  const line = index.declarations.get(`${spec}::${rawTitle}`);
  const listed = line === null || line === undefined ? null : index.titlesByLine.get(`${spec}::${line}`);
  if (listed && listed.length > 0) return { mechanism: 'listed', titles: listed, raw: rawTitle };
  return { mechanism: 'raw', titles: [rawTitle], raw: rawTitle };
}

/** The HTTP code a branch's `response` states, or null when it states none. */
function statusOf(response) {
  const text = String(response || '');
  const leading = /^(\d{3})\b/.exec(text);
  if (leading) return leading[1];
  const thrown = /\((\d{3})\)/.exec(text);
  return thrown ? thrown[1] : null;
}

/** The exception type a fault branch throws, or null when the branch throws nothing. */
function thrownType(response) {
  const match = /^throw\s+([\w.]+)/.exec(String(response || ''));
  return match ? match[1].split('.').pop() : null;
}

const TIER_LABEL = Object.freeze({ asserted: 'asserted', 'stubbed-only': 'stubbed', none: 'no evidence' });

/**
 * Everything one page needs, derived once. Nothing here is module state: two renders in
 * one process share no cache, so a page never carries a number another page produced.
 */
function buildContext(result, { factSets, coverOverlay, expandInfra, fold }) {
  const index = indexFacts(factSets);
  const overlay = coverOverlay || null;
  const records = trackedLines(result, markPaint, { expandInfra, fold });
  const rootRef = result.root.ref;
  const titles = new Map();
  const mechanisms = { listed: 0, raw: 0 };

  const refOf = (record) => (record.route ? record.route.ref : rootRef);

  const resolvedFor = (entry) => {
    const key = `${entry.spec}::${entry.test}`;
    if (titles.has(key)) return titles.get(key);
    const resolution = resolveTitle(index, entry.spec, entry.test);
    mechanisms[resolution.mechanism] += 1;
    titles.set(key, resolution);
    return resolution;
  };

  const evidenceRows = (routeKey) => (overlay && overlay.evidence.get(routeKey)) || [];

  const verifyingTests = (routeKey) => {
    const byTest = new Map();
    for (const row of evidenceRows(routeKey)) {
      const id = `${row.spec}::${row.test}`;
      if (!index.assertions.has(id)) continue;
      if (byTest.has(id)) continue;
      byTest.set(id, {
        repo: row.repo,
        spec: row.spec,
        test: row.test,
        asserts: index.assertions.get(id).length,
      });
    }
    return [...byTest.values()].sort((a, b) => b.asserts - a.asserts || a.spec.localeCompare(b.spec));
  };

  const stubOnlyTests = (routeKey) => {
    const seen = new Map();
    for (const row of evidenceRows(routeKey)) {
      const id = `${row.spec}::${row.test}`;
      if (index.assertions.has(id)) continue;
      if (!seen.has(id)) seen.set(id, { repo: row.repo, spec: row.spec, test: row.test });
    }
    return [...seen.values()];
  };

  const assertedCache = new Map();
  const assertedStatuses = (routeKey) => {
    if (assertedCache.has(routeKey)) return assertedCache.get(routeKey);
    const byStatus = new Map();
    for (const entry of verifyingTests(routeKey)) {
      for (const fact of index.assertions.get(`${entry.spec}::${entry.test}`) || []) {
        if (fact.kind !== 'status' || fact.value === null || fact.value === undefined) continue;
        const code = String(fact.value);
        const list = byStatus.get(code) || [];
        if (!list.some((test) => test.spec === entry.spec && test.test === entry.test)) list.push(entry);
        byStatus.set(code, list);
      }
    }
    assertedCache.set(routeKey, byStatus);
    return byStatus;
  };

  /**
   * What a fault branch really answers the caller. `renderNodeLine` prints `throw X (500)`
   * because an escaping exception is a 500 — true only while nothing catches it. The
   * remapped status never touches the tree text: it re-points the join and adds an
   * annotation beside the line.
   */
  const faultMapping = (record) => {
    const node = record.node;
    if (!node || node.responseKind !== 'fault') return null;
    const type = thrownType(node.response);
    if (!type) return null;
    const route = record.route && record.route.route;
    const found = lookupException(index, type, route ? route.controller : null, route ? route.action : null);
    const stated = statusOf(node.response);
    if (!found || found.status === stated) return null;
    return { ...found, type, from: stated };
  };

  const mappings = new Map();
  for (const record of records) {
    const mapping = faultMapping(record);
    if (mapping) mappings.set(record, mapping);
  }

  /**
   * Records whose branch outcome a verifying test of the same route provably observed.
   * Where several branches end in one status the join cannot separate them, so every one
   * of them is attributed and flagged `shared` rather than one being guessed at.
   */
  const direct = new Map();
  if (overlay) {
    const candidates = [];
    const refsByStatus = new Map();
    for (const record of records) {
      const node = record.node;
      if (!node || node.kind !== 'branch') continue;
      const ref = refOf(record);
      const mapping = mappings.get(record) || null;
      const code = mapping ? mapping.status : statusOf(node.response);
      if (!code || !assertedStatuses(ref).has(code)) continue;
      const bucket = `${ref}|${code}`;
      const refs = refsByStatus.get(bucket) || new Set();
      refs.add(node.ref);
      refsByStatus.set(bucket, refs);
      candidates.push({ record, ref, code, bucket, mapping });
    }
    for (const { record, ref, code, bucket, mapping } of candidates) {
      direct.set(record, {
        status: code,
        tests: assertedStatuses(ref).get(code),
        shared: refsByStatus.get(bucket).size > 1,
        mapping,
      });
    }
  }

  const tierFor = (record) => (overlay ? tierOf(overlay, refOf(record)) : 'neutral');

  return {
    result,
    records,
    rootRef,
    overlay,
    index,
    mappings,
    direct,
    mechanisms,
    refOf,
    resolvedFor,
    verifyingTests,
    stubOnlyTests,
    tierFor,
    expandInfra,
    fold,
  };
}

/** One naming for a test everywhere on the page: suite › spec › title. */
function testName(ctx, entry, { instances = false } = {}) {
  const resolution = ctx.resolvedFor(entry);
  const [first] = resolution.titles;
  const head = `${entry.repo} › ${entry.spec} › ${first}`;
  if (!instances || resolution.titles.length < 2) return head;
  return `${entry.repo} › ${entry.spec} › ${resolution.raw} — ${plural(resolution.titles.length, 'instance')}: ${resolution.titles.join(' · ')}`;
}

function testLine(ctx, entry, options) {
  const asserts = entry.asserts ? ` · ${plural(entry.asserts, 'assertion')}` : '';
  return `${testName(ctx, entry, options)}${asserts}`;
}

function evidenceBlock(ctx, routeKey, tier) {
  if (tier === 'neutral') {
    return '<div class="ev ev-none">no coverage overlay requested — pass <code>--cover-overlay</code> to join test evidence onto this tree</div>';
  }
  if (tier === 'none') {
    return '<div class="ev ev-none">no executing test names this route — nothing on this tree carries test evidence today</div>';
  }
  const list = tier === 'asserted' ? ctx.verifyingTests(routeKey) : ctx.stubOnlyTests(routeKey);
  const shown = list.slice(0, 3);
  const rest = list.length - shown.length;
  const heading =
    tier === 'asserted'
      ? `verified by ${plural(list.length, 'test')}`
      : `named by ${plural(list.length, 'test')}, no assertion recorded`;
  const rows = shown
    .map((entry) => {
      const resolution = ctx.resolvedFor(entry);
      const mech = `<span class="mech mech-${resolution.mechanism}">${resolution.mechanism}</span>`;
      if (resolution.titles.length < 2) {
        return `<div class="ev-row">${escapeHtml(testLine(ctx, entry))}${mech}</div>`;
      }
      const instances = resolution.titles.map((title) => `<span class="inst">${escapeHtml(title)}</span>`).join('');
      return `<div class="ev-row">${escapeHtml(testLine(ctx, entry))}${mech}<div class="insts"><span class="insts-k">${escapeHtml(plural(resolution.titles.length, 'instance'))}</span>${instances}</div></div>`;
    })
    .join('');
  const more = rest > 0 ? `<div class="ev-row ev-more">+${rest} more</div>` : '';
  return `<div class="ev ev-${tier === 'asserted' ? 'asserted' : 'stubbed'}"><div class="ev-head">${escapeHtml(heading)}</div>${rows}${more}</div>`;
}

/**
 * The route line carries the full test list; an inherited badge carries a one-line summary
 * instead. Repeating the full list on every inherited line bloats the page for no reading
 * value, and the long form is one line away anyway.
 */
function badgeTitle(ctx, routeKey, tier, { anchor = false } = {}) {
  if (tier === 'neutral') return 'no coverage overlay requested — nothing on this page was evaluated';
  if (tier === 'none') return 'no executing test names this route';
  const list = tier === 'asserted' ? ctx.verifyingTests(routeKey) : ctx.stubOnlyTests(routeKey);
  const verb = tier === 'asserted' ? 'asserted' : 'stubbed';
  if (!anchor) {
    return `inherited from the route — on a path ${verb} by ${plural(list.length, 'test')}, listed under the route line above. No test outcome pins this line itself.`;
  }
  return [
    `on a path ${verb} by:`,
    ...list.slice(0, 6).map((entry) => testLine(ctx, entry, { instances: true })),
    list.length > 6 ? `+${list.length - 6} more` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The `← e2e › spec › title (asserts 403)` tail a directly attributed branch earns. A
 * parameterised test ran under several titles and every one of them drove the branch, so
 * the tail names the first and counts the rest rather than implying one instance did it.
 */
function attributionHtml(ctx, hit) {
  const shown = hit.tests.slice(0, 2).map((entry) => {
    const resolution = ctx.resolvedFor(entry);
    const extra = resolution.titles.length - 1;
    return `${testName(ctx, entry)}${extra > 0 ? ` +${plural(extra, 'more instance')}` : ''}`;
  });
  const rest = hit.tests.length - shown.length;
  const more = rest > 0 ? ` +${rest} more` : '';
  const marker = hit.shared ? ' · shared outcome' : '';
  return `<span class="attr">  ← ${escapeHtml(`${shown.join('; ')}${more} (asserts ${hit.status})${marker}`)}</span>`;
}

function mappingTitle(mapping) {
  const how =
    mapping.scope === 'global'
      ? `${mapping.via} is registered globally, so it converts this exception for every action.`
      : `${mapping.via} catches this exception itself, so the mapping holds for this action only — the same exception can map elsewhere in another action.`;
  return [
    `the tree prints ${mapping.from} because an escaping exception is a ${mapping.from}; this one does not escape.`,
    `${mapping.type} → ${mapping.status}`,
    how,
    `from an exception_map fact at ${mapping.file}:${mapping.line}.`,
  ].join('\n');
}

/** `→ 409 via LockController.Save` — the status the tree text cannot state. */
function mappingHtml(mapping) {
  return `<span class="map" title="${escapeHtml(mappingTitle(mapping))}">  → ${escapeHtml(`${mapping.status} via ${mapping.via}`)}</span>`;
}

function directTitle(ctx, hit) {
  const head = hit.mapping
    ? `direct: this branch throws ${hit.mapping.type}, which ${hit.mapping.via} answers as ${hit.status}, and these tests assert ${hit.status} on this route — the branch was exercised:`
    : `direct: this branch answers ${hit.status}, and these tests assert ${hit.status} on this route — the branch was exercised:`;
  const tail = hit.shared
    ? ['', `shared outcome: more than one branch on this route ends in ${hit.status}, so the join attributes all of them.`]
    : [];
  return [head, ...hit.tests.map((entry) => testLine(ctx, entry, { instances: true })), ...tail].join('\n');
}

/**
 * A tier is spelled out where the flow does something a test could observe — the route
 * itself, an effect, a deciding branch — and reads as a dot everywhere else, because two
 * hundred identical words down the gutter drown the tree the page exists to show. A
 * directly attributed branch is always spelled: it is the one line that claims more.
 */
function isSpelled(node, isRoute, hit) {
  if (hit || isRoute) return true;
  return Boolean(node) && (node.sink === true || (node.kind === 'branch' && node.primary === true));
}

function buildTreeHtml(ctx) {
  const parts = [];
  for (const record of ctx.records) {
    const tier = ctx.tierFor(record);
    const indent = [...record.connector].length;
    const style = indent > 0 ? ` style="padding-left:${indent}ch;text-indent:-${indent}ch"` : '';
    const node = record.node;
    const isRoute = Boolean(node) && node.kind === 'route';
    const hit = ctx.direct.get(record);
    const spelled = isSpelled(node, isRoute, hit);
    const badgeClass = hit
      ? 'badge b-direct'
      : `badge b-${tier === 'stubbed-only' ? 'stubbed' : tier}${isRoute ? ' b-anchor' : ''}${spelled ? '' : ' b-dot'}`;
    const title = escapeHtml(hit ? directTitle(ctx, hit) : badgeTitle(ctx, ctx.refOf(record), tier, { anchor: isRoute }));
    const silent = (tier === 'none' || tier === 'neutral') && !isRoute && !hit;
    const badge = silent
      ? ''
      : `<span class="${badgeClass}" title="${title}">${hit ? 'direct' : spelled ? escapeHtml(TIER_LABEL[tier] || tier) : '&#9675;'}</span>`;
    const attribution = hit ? attributionHtml(ctx, hit) : '';
    const mapping = ctx.mappings.get(record);
    const mapped = mapping ? mappingHtml(mapping) : '';
    parts.push(
      `<div class="ln${hit ? ' ln-direct' : ''}${mapping ? ' ln-mapped' : ''}"><span class="txt"${style}>${treeSpan(record.connector, null)}${markedToHtml(record.body)}${mapped}${attribution}</span>${badge}</div>`,
    );
    if (isRoute) parts.push(evidenceBlock(ctx, record.route.ref, tier));
  }
  return parts.join('\n');
}

const STYLE = `
:root {
  --bg: #0d1117;
  --panel: #12181f;
  --edge: #232c37;
  --fg: #c9d1d9;
  --muted: #7d8794;
  --bold: #f0f6fc;
  --cyan: #56b6c2;
  --yellow: #d5a336;
  --magenta: #c678dd;
  --red: #e06c6c;
  --ok: #56c07a;
  --warn: #d8a13a;
  --off: #6b7581;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1500px; margin: 0 auto; padding: 28px 22px 64px; }
h1 { font-size: 15px; margin: 0 0 4px; color: var(--bold); font-weight: 600; letter-spacing: .01em; }
.sub { color: var(--muted); margin: 0 0 18px; font-size: 12px; }
.route { color: var(--bold); }
.strip {
  display: flex; flex-wrap: wrap; gap: 0;
  border: 1px solid var(--edge); border-radius: 6px;
  background: var(--panel); margin-bottom: 14px; overflow: hidden;
}
.cell { padding: 9px 16px; border-right: 1px solid var(--edge); min-width: 0; }
.cell:last-child { border-right: 0; }
.cell .k { display: block; color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; }
.cell .v { display: block; color: var(--bold); font-size: 13px; margin-top: 2px; word-break: break-word; }
.v.ok { color: var(--ok); } .v.warn { color: var(--warn); } .v.off { color: var(--off); }
.v .of { color: var(--muted); font-size: 11px; font-weight: 400; }
.note {
  border: 1px solid var(--edge); border-left: 3px solid var(--warn); border-radius: 6px;
  background: var(--panel); padding: 11px 15px; margin-bottom: 14px; color: var(--fg); font-size: 12px;
}
.note b { color: var(--warn); font-weight: 600; }
.note code { color: var(--cyan); font-size: 11.5px; }
.legend {
  display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center;
  border: 1px solid var(--edge); border-radius: 6px; background: var(--panel);
  padding: 10px 15px; margin-bottom: 14px; font-size: 12px; color: var(--muted);
}
.legend .item { display: flex; align-items: center; gap: 7px; }
.term {
  border: 1px solid var(--edge); border-radius: 6px; background: #0a0e14;
  padding: 14px 16px; overflow-x: auto;
}
pre.tree { margin: 0; font: inherit; white-space: normal; }
.ln { display: flex; align-items: baseline; gap: 12px; min-height: 1.55em; }
.ln:hover { background: rgba(110, 140, 190, .07); }
.txt { flex: 1 1 auto; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.c-dim { color: var(--muted); }
.c-bold { color: var(--bold); font-weight: 600; }
.c-cyan { color: var(--cyan); }
.c-yellow { color: var(--yellow); }
.c-magenta { color: var(--magenta); }
.c-red { color: var(--red); }
.badge {
  flex: 0 0 auto; align-self: flex-start; font-size: 10px; letter-spacing: .05em;
  text-transform: uppercase; padding: 1px 7px; border-radius: 9px; border: 1px solid transparent;
  white-space: nowrap; cursor: help; opacity: .62;
}
.badge.b-anchor { opacity: 1; font-weight: 700; }
.badge.b-dot { padding: 1px 5px; font-size: 9px; line-height: 1.75; border-color: transparent; background: none; opacity: .5; }
.ln:hover .badge.b-dot { opacity: 1; }
.b-direct {
  opacity: 1; font-weight: 700; color: #06210f;
  background: var(--ok); border-color: var(--ok);
}
.ln-direct { background: rgba(86, 192, 122, .07); }
.ln-direct:hover { background: rgba(86, 192, 122, .13); }
.attr { color: var(--ok); opacity: .85; }
.map { color: var(--magenta); opacity: .95; cursor: help; }
.ln-mapped { background: rgba(198, 120, 221, .07); }
.ln-mapped:hover { background: rgba(198, 120, 221, .13); }
.mech {
  margin-left: 8px; font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase;
  padding: 0 5px; border-radius: 7px; border: 1px solid transparent; opacity: .75; white-space: nowrap;
}
.mech-listed { color: var(--cyan); border-color: rgba(86, 182, 194, .40); background: rgba(86, 182, 194, .10); }
.mech-raw { color: var(--off); border-color: rgba(107, 117, 129, .40); background: rgba(107, 117, 129, .08); }
.insts { margin: 2px 0 4px 2ch; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.insts-k { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; }
.inst {
  color: var(--cyan); font-size: 11.5px; padding: 0 6px; border-radius: 4px;
  background: rgba(86, 182, 194, .09); border: 1px solid rgba(86, 182, 194, .22);
}
.b-asserted { color: var(--ok); border-color: rgba(86, 192, 122, .45); background: rgba(86, 192, 122, .10); }
.b-stubbed { color: var(--warn); border-color: rgba(216, 161, 58, .45); background: rgba(216, 161, 58, .10); }
.b-none { color: var(--off); border-color: rgba(107, 117, 129, .40); background: rgba(107, 117, 129, .08); }
.b-neutral { color: var(--off); border-color: rgba(107, 117, 129, .40); background: rgba(107, 117, 129, .08); }
.ev { margin: 3px 0 8px 3ch; padding: 7px 12px; border-left: 2px solid var(--edge); background: rgba(255,255,255,.02); border-radius: 0 4px 4px 0; }
.ev-head { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 3px; }
.ev-asserted .ev-head { color: var(--ok); }
.ev-stubbed .ev-head { color: var(--warn); }
.ev-none { color: var(--off); font-size: 12px; }
.ev-row { color: var(--fg); font-size: 12px; overflow-wrap: anywhere; }
.ev-more { color: var(--muted); }
.trailer { margin-top: 10px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.foot { margin-top: 16px; color: var(--off); font-size: 11px; }
@media (max-width: 720px) {
  .badge { font-size: 9px; }
  .wrap { padding: 18px 12px 48px; }
}
`;

const LEGEND = [
  ['b-direct', 'direct', 'outcome-proven — a verifying test asserts the status this branch answers, so the test drove this line'],
  ['b-asserted', 'asserted', 'route level: an executing test hits this route and asserts in the same test'],
  ['b-stubbed', 'stubbed', 'route level: an executing test hits this route, no assertion recorded'],
  ['b-asserted b-dot', '&#9675;', 'on an asserted path — inherited from the route line, nothing pins this line itself'],
  ['b-none', 'no evidence', 'no executing test names this route — inherited lines stay unbadged'],
];

const ANNOTATIONS = [
  ['map', '→ 409 via …', 'an exception_map fact converts this exception; the join runs against the converted status'],
  ['mech mech-listed', 'listed', 'title resolved from a pw_title fact — the collector joined the listing to the source by declaration ordinal'],
  ['mech mech-raw', 'raw', 'title expression kept as written — no pw_title fact covers it'],
];

function legendHtml() {
  return LEGEND.map(
    ([cls, label, text]) => `<span class="item"><span class="badge ${cls} b-anchor">${label}</span>${escapeHtml(text)}</span>`,
  ).join('');
}

function annotationsHtml() {
  return ANNOTATIONS.map(
    ([cls, label, text]) => `<span class="item"><span class="${cls}">${escapeHtml(label)}</span>${escapeHtml(text)}</span>`,
  ).join('');
}

function levelsOf(ctx) {
  const levels = { direct: ctx.direct.size, inherited: 0, none: 0, neutral: 0 };
  for (const record of ctx.records) {
    if (ctx.direct.has(record)) continue;
    const tier = ctx.tierFor(record);
    if (tier === 'neutral') levels.neutral += 1;
    else if (tier === 'none') levels.none += 1;
    else levels.inherited += 1;
  }
  return levels;
}

function stripHtml(ctx) {
  const cells = [
    `<div class="cell"><span class="k">start</span><span class="v">${escapeHtml(ctx.rootRef)}</span></div>`,
    `<div class="cell"><span class="k">tree lines</span><span class="v">${ctx.records.length}</span></div>`,
  ];
  const unmappedFaults = ctx.records.filter(
    (record) => record.node && record.node.responseKind === 'fault' && !ctx.mappings.has(record),
  ).length;
  if (!ctx.overlay) {
    cells.push('<div class="cell"><span class="k">coverage overlay</span><span class="v off">not requested</span></div>');
  } else {
    const levels = levelsOf(ctx);
    const routeTier = tierOf(ctx.overlay, ctx.rootRef);
    const verifying = ctx.verifyingTests(ctx.rootRef);
    const stubs = ctx.stubOnlyTests(ctx.rootRef);
    const specs = new Set([...verifying, ...stubs].map((entry) => entry.spec));
    const assertSpecs = new Set(verifying.map((entry) => entry.spec));
    cells.push(
      `<div class="cell"><span class="k">direct</span><span class="v ok">${levels.direct}</span></div>`,
      `<div class="cell"><span class="k">inherited</span><span class="v ${routeTier === 'asserted' ? 'ok' : 'warn'}">${levels.inherited}</span></div>`,
      `<div class="cell"><span class="k">no evidence</span><span class="v off">${levels.none}</span></div>`,
      `<div class="cell"><span class="k">route tier</span><span class="v ${routeTier === 'asserted' ? 'ok' : routeTier === 'none' ? 'off' : 'warn'}">${escapeHtml(TIER_LABEL[routeTier])}</span></div>`,
      `<div class="cell"><span class="k">verifying specs</span><span class="v">${assertSpecs.size}</span></div>`,
      `<div class="cell"><span class="k">specs touching start</span><span class="v">${specs.size}</span></div>`,
    );
  }
  cells.push(
    `<div class="cell"><span class="k">faults remapped</span><span class="v ${ctx.mappings.size ? '' : 'off'}">${ctx.mappings.size}${unmappedFaults ? ` <span class="of">of ${ctx.mappings.size + unmappedFaults}</span>` : ''}</span></div>`,
  );
  return `<div class="strip">${cells.join('')}</div>`;
}

/**
 * The three limits the badges do not close, stated on the page rather than left to a
 * footnote: symmetric branches carry no distinguishing status, a skipped test is not
 * evidence, and Cypress evidence can never reach `asserted` because the fact schema
 * records no Cypress assertion fact.
 */
function claimNote() {
  return `<div class="note"><b>What a badge claims.</b> There are two strengths of claim on this page, and they are not the same claim.
<br><b>Inherited</b> is the weaker one: evidence binds a <em>route</em> to a <em>spec</em>, so a badge on a guard, a branch or a
repository call reads &ldquo;this line is on a path an asserted test drives&rdquo;, never &ldquo;this line is individually asserted&rdquo;.
<br><b>Direct</b> is the stronger one, and it is still narrow: the branch states an observable outcome
(<code>response</code> / <code>responseKind</code>, written for <code>error_return</code> and <code>guard</code> facts) and a verifying
test asserts that same HTTP status on this route (<code>pw_assert</code> with <code>kind: "status"</code>). Matching codes mean the test
provably <em>exercised</em> the branch — the outcome was observed. It does <em>not</em> mean the test asserts the branch's internal
effects, and it does not upgrade the rest of the path. Where several branches end in one status the join cannot separate them, so
all of them are attributed and marked <em>shared outcome</em>.
<br><b>Still out of reach.</b> Symmetric branches — the ones where both sides end in the same success outcome — carry no
distinguishing status, so nothing here can pin which side ran; per-branch certainty for those needs the per-test runtime
line hits <code>cover --runtime</code> joins. Two limits are inherited from the evidence index unchanged: a skipped test is not evidence, and
Cypress evidence can never reach <em>asserted</em> because the fact schema records no Cypress assertion fact — only Playwright's.</div>`;
}

function enrichmentNote(ctx) {
  const listed = ctx.mechanisms.listed;
  const raw = ctx.mechanisms.raw;
  const specs =
    ctx.overlay && ctx.overlay.specs.length > 0
      ? `<br><b>Evidence was filtered.</b> <code>--specs</code> narrowed it to ${escapeHtml(plural(ctx.overlay.specs.length, 'selector'))}: <code>${escapeHtml(ctx.overlay.specs.join(', '))}</code>, so every tier on this page answers &ldquo;what does that selection alone prove&rdquo;.`
      : '';
  return `<div class="note"><b>Two annotations, both read from facts.</b>
<br><b>Statuses for thrown exceptions.</b> The tree prints <code>throw X (500)</code> because an escaping exception is a 500 — true
only while nothing catches it. <code>exception_map</code> facts state what actually catches it: ${escapeHtml(plural(ctx.index.filters, 'globally registered filter'))}
apply everywhere, and ${escapeHtml(plural(ctx.index.byAction.size, 'controller action'))} catch exceptions themselves. Action-scoped
mappings genuinely disagree — the same exception type answers one status in one action and another elsewhere — so the lookup is keyed
by this route's own controller and action, never by exception type alone. A remapped fault joins against the <em>mapped</em> status; an
unmapped one keeps 500, which assumes no filter reaches it.
<br><b>Resolved test titles.</b> A <code>pw_test</code> fact stores the title <em>expression</em>, so a parameterised test reads as its
own source; a <code>pw_title</code> fact carries what Playwright's own collector resolved for that declaration, joined to it by its
ordinal among the spec file's declarations rather than by any line the runner reported. On this page
${listed} title${listed === 1 ? '' : 's'} resolved that way and ${raw} kept the expression, marked <em>raw</em>. Nothing here evaluates
a template: the fact carries the declaration's source line, so both sides key on <code>(spec, line)</code>.
<br>Both fact types are extracted alongside every other fact, so neither is read from a working tree the rest of this page was not
indexed from.${specs}</div>`;
}

function footHtml(ctx) {
  if (!ctx.overlay) {
    return '<p class="foot">no coverage overlay — tree text produced by the repository\'s own renderer, no evidence joined</p>';
  }
  const levels = levelsOf(ctx);
  const routeTier = tierOf(ctx.overlay, ctx.rootRef);
  const verifying = ctx.verifyingTests(ctx.rootRef);
  const stubs = ctx.stubOnlyTests(ctx.rootRef);
  return `<p class="foot">route tier: ${escapeHtml(routeTier)} · ${escapeHtml(plural(verifying.length, 'verifying test'))} · ${escapeHtml(plural(stubs.length, 'stub-only test'))} · ${escapeHtml(plural(levels.direct, 'directly attributed line'))} · titles: ${ctx.mechanisms.listed} listed / ${ctx.mechanisms.raw} raw · tree text produced by the repository's own renderer, route badges by the cover overlay, direct badges by the branch-outcome / asserted-status join</p>`;
}

function buildContent(ctx) {
  const tree = buildTreeHtml(ctx);
  const trailer = renderTrailer(ctx.result, { color: false, expandInfra: ctx.expandInfra, fold: ctx.fold });
  const legends = ctx.overlay
    ? `<div class="legend">${legendHtml()}</div>\n<div class="legend">${annotationsHtml()}</div>`
    : `<div class="legend">${annotationsHtml()}</div>`;
  return `<div class="wrap">
<h1>flowtrace · <span class="route">${escapeHtml(ctx.rootRef)}</span></h1>
<p class="sub">terminal trace tree, line for line, with the test evidence that covers it — hover a badge for the full test list</p>

${stripHtml(ctx)}

${claimNote()}

${enrichmentNote(ctx)}

${legends}

<div class="term"><pre class="tree">${tree}</pre>
<div class="trailer">${escapeHtml(trailer)}</div></div>

${footHtml(ctx)}
</div>`;
}

/**
 * One self-contained page: the trace tree exactly as the terminal prints it, each line
 * carrying the strongest evidence claim that line has earned. Inline CSS only, nothing
 * fetched, so it opens straight off disk.
 */
export function renderTreeHtml(
  result,
  { title = 'flowtrace trace', factSets = [], coverOverlay = null, expandInfra = false, fold = true } = {},
) {
  const ctx = buildContext(result, { factSets, coverOverlay, expandInfra, fold });
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    buildContent(ctx),
    '</body></html>',
    '',
  ].join('\n');
}

/**
 * The joins this page derives, exposed for the readers that must make the same claim about
 * the same fact. `span` tags a ledger row `tested` on exactly the branch-outcome /
 * asserted-status match drawn here as `direct`, and reads a fault's real status through the
 * same `exception_map` lookup — mirroring the discipline this module already keeps against
 * `render-tree.js`'s own `internals`, so the two surfaces cannot drift into disagreeing.
 */
export const joins = { indexFacts, lookupException, resolveTitle, statusOf, thrownType, escapeHtml };
