/**
 * Tree rendering for the trace step.
 *
 * One node per line, `<ref>  <repo>  <file>:<line>  [<via>]`, with branch points drawn
 * as `◇` children of the method they sit in and sinks prefixed `■`. Colour is applied
 * only when stdout is a terminal and `NO_COLOR` is unset, so piped or redirected output
 * stays plain text.
 *
 * A dependency the walk reaches down more than one path is one node in the system, not
 * one per caller: shared-subtree folding is on by default, while `--no-fold` prints every
 * occurrence in full. With folding on, the first appearance is full and every later one —
 * same repo, file, line, kind and ref — as one line pointing back at it, with no
 * children of its own. It composes with the shared-dependency infra-collapse above: that
 * decides what is shown at all, folding only ever runs over what survives it. `--json`
 * and `--graph` (`foldedGraph`) fold the same way, so the walk's own flat node/edge list
 * never needs to duplicate a subtree just to be printed twice.
 */

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  red: '\u001b[31m',
};

/** True when the current process may write ANSI colour to stdout. */
export function colorEnabled(stream = process.stdout, env = process.env) {
  return Boolean(stream && stream.isTTY) && !env.NO_COLOR;
}

function painter(enabled) {
  if (!enabled) return (text) => text;
  return (text, color) => `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function repoTag(crossing) {
  const roles = crossing.role && crossing.role.length > 0 ? ` (${crossing.role.join(', ')})` : '';
  return `⇢ repo:${crossing.to}${roles}`;
}

function location(node) {
  if (!node.file) return '-';
  return `${node.file}:${node.line ?? 0}`;
}

function flags(node) {
  const marks = [];
  if (node.contract === 'none') marks.push('⚠ no contract declared');
  if (node.match === 'name-ambiguous') marks.push(`⚠ ambiguous contract (${node.fqns} fqns)`);
  if (node.derivedName) marks.push('name derived from work type');
  if (node.queue) marks.push(`queue ${node.queue}`);
  if (node.unresolved) marks.push(typeof node.unresolved === 'string' ? `unresolved: ${node.unresolved}` : 'unresolved');
  if (node.inferred) marks.push(node.mountPrefix ? `inferred mount ${node.mountPrefix}` : 'inferred mount');
  if (node.cycle) marks.push('cycle');
  if (node.leaf) marks.push('leaf');
  if (node.graph === 'unavailable') marks.push('graph: unavailable');
  if (node.dropped) marks.push(`+${node.dropped} dropped`);
  if (node.attach === 'file') marks.push('attach: file');
  if (node.kind === 'db' && node.via === 'graph') marks.push('via graph');
  if (node.accessUnknown) marks.push('access unknown');
  if (node.accessGuess) marks.push('access guessed');
  if (node.bindings && node.bindings.length > 1) marks.push(`${node.bindings.length} bindings`);
  return marks;
}

/**
 * What the hop did, when the reference alone would not say it: the event that fired a
 * handler, the action a method dispatched, the effect that answers that action.
 */
function nodeLabel(node) {
  if (node.via === 'handler' && node.event) return `(${node.event}) ${node.method}()`;
  if (node.via === 'dispatch') return `dispatch ${node.ref}`;
  if (node.via === 'props') return `prop ${node.prop || node.ref}${node.prop && node.prop !== node.ref ? ` → ${node.ref}` : ''}`;
  if (node.via === 'effect') return `effect ${node.ref}`;
  return node.ref;
}

function renderNodeLine(node, paint) {
  if (node.kind === 'branch') {
    const head = paint(`◇ ${node.line}${node.endLine && node.endLine !== node.line ? `-${node.endLine}` : ''}`, 'yellow');
    const outcome = node.response ? `  → ${paint(node.response, 'magenta')}` : '';
    const aside =
      node.primary === false
        ? `  ${paint(`(${node.demoted})`, 'dim')}`
        : node.collapsed
          ? `  ${paint(`(collapsed: ${node.collapsed})`, 'dim')}`
          : '';
    return `${head}  ${node.text || ''}${outcome}  ${paint(`[branch:${node.branchKind}]`, 'dim')}${aside}`;
  }
  const marker = node.sink ? '■ ' : '';
  const label = nodeLabel(node);
  const ref = node.sink ? paint(`${marker}${node.ref}`, 'magenta') : paint(label, 'bold');
  const where = paint(location(node), 'dim');
  const tag = node.kind === 'db' && node.access ? `db·${node.access}` : node.match ? `${node.via}·${node.match}` : node.via;
  const via = paint(`[${tag}]`, 'cyan');
  const marks = flags(node);
  const suffix = marks.length > 0 ? `  ${paint(marks.join(' · '), 'red')}` : '';
  const crossing = node.crossRepo ? `${paint(repoTag(node.crossRepo), 'yellow')}  ` : '';
  const summary = node.summary
    ? `  ${paint(
        `→ ${plural(node.summary.sinks, 'sink')} · ${plural(node.summary.primaryBranches, 'primary branch point')} · ${plural(node.summary.seeds, 'seed')}`,
        'magenta',
      )}`
    : '';
  return `${crossing}${ref}  ${node.repo}  ${where}  ${via}${suffix}${summary}`;
}

/**
 * An effect a seed of this flow owns: a data write the walk saw called by name, a
 * message, a push, an outbound call, or anything a consumer of that message reaches. A
 * data class the code index attached to another class is not one, and neither is an
 * effect behind a shared dependency, which is the same for every seed and reported once.
 */
function ownsEffect(node) {
  if (node.kind === 'message') return node.effectInfra !== true;
  const owned = node.effectInfra !== true || node.asyncLeg === true;
  if (node.kind !== 'db') return node.sink === true && owned;
  return owned && node.via !== 'graph' && Array.isArray(node.methods) && node.methods.length > 0;
}

const seedWork = new WeakMap();

/** Whether anything under this node reaches a seed: a deciding branch, or an owned effect. */
function carriesSeedWork(node) {
  if (seedWork.has(node)) return seedWork.get(node);
  const carries =
    node.kind === 'branch'
      ? node.primary === true
      : ownsEffect(node) || (node.children || []).some(carriesSeedWork);
  seedWork.set(node, carries);
  return carries;
}

/** A dependency shared by the whole system, or a hop the code index guessed. */
function isShared(node) {
  return node.infra === true || node.via === 'graph';
}

/**
 * A node's identity for shared-subtree folding: two nodes at the same spot, naming the
 * same thing, are one node seen twice. `ref` is part of the key alongside repo, file,
 * line and kind because a generic `kind` (`class`, chiefly) is shared by nodes that are
 * not the same thing at all — an unresolved interface pivot and the concrete class DI
 * resolves it to can legitimately anchor at the same file and line without being the
 * same node.
 */
function identityKey(node) {
  return `${node.repo}|${node.file ?? ''}|${node.line ?? ''}|${node.kind}|${node.ref ?? ''}`;
}

/**
 * How many times each identity appears among the nodes a rendering with this
 * `expandInfra` setting would show — the infra-collapse rule decides what counts as
 * "shown" first, and folding only ever counts within that. Used for the `×N` on a
 * folded line, so it reads as "this many times in the tree you are looking at".
 */
function countOccurrences(node, expandInfra, counts) {
  const key = identityKey(node);
  counts.set(key, (counts.get(key) || 0) + 1);
  const { shown } = orderChildren(node, expandInfra);
  for (const child of shown) countOccurrences(child, expandInfra, counts);
  return counts;
}

/** Total shown nodes with folding off — the "before" half of the trailer's fold count. */
function countShown(node, expandInfra) {
  let total = 1;
  const { shown } = orderChildren(node, expandInfra);
  for (const child of shown) total += countShown(child, expandInfra);
  return total;
}

/** Total shown nodes with folding on: a repeat identity counts as one and is not descended into. */
function countFolded(node, expandInfra, seen) {
  const key = identityKey(node);
  if (seen.has(key)) return 1;
  seen.set(key, node.id);
  let total = 1;
  const { shown } = orderChildren(node, expandInfra);
  for (const child of shown) total += countFolded(child, expandInfra, seen);
  return total;
}

function subtreeSize(node) {
  let nodes = 1;
  let graph = node.via === 'graph' ? 1 : 0;
  for (const child of node.children || []) {
    const inner = subtreeSize(child);
    nodes += inner.nodes;
    graph += inner.graph;
  }
  return { nodes, graph };
}

/**
 * Children in reading order: the chain this flow is about first, then what every request
 * through the system also touches. A shared subtree that reaches nothing a seed lists is
 * folded into one line; one that holds a write, a message or a deciding branch is drawn,
 * because the shared-dependency rule demotes plumbing, never the point of the request.
 */
function orderChildren(node, expandInfra) {
  const children = node.children || [];
  if (expandInfra) return { shown: children, hidden: [] };
  const shown = children.filter((child) => !isShared(child));
  const shared = children.filter(isShared);
  return {
    shown: [...shown, ...shared.filter(carriesSeedWork)],
    hidden: shared.filter((child) => !carriesSeedWork(child)),
  };
}

/**
 * `fold` (default on everywhere it is threaded through) collapses every occurrence of a
 * node after its first — same repo, file, line, kind and ref — into one `↑ <label> (see
 * above, ×N)` line with no children of its own. `seen` and `counts` are shared across the
 * whole render: `seen` decides, in the order nodes are actually shown, which occurrence
 * is the one printed in full; `counts` (from `countOccurrences`) supplies `N`. Folding
 * composes with the infra-collapse above it rather than competing: `orderChildren` decides
 * what is shown at all, and only shown nodes ever reach the fold check, so a node hidden
 * behind "infrastructure (...)" never needs a fold line of its own.
 */
function renderSubtree(node, prefix, isLast, lines, paint, expandInfra, fold, seen, counts) {
  const connector = prefix === null ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`;
  const key = identityKey(node);
  const canonicalId = fold ? seen.get(key) : undefined;
  if (fold && canonicalId !== undefined && canonicalId !== node.id) {
    const count = counts.get(key) || 1;
    lines.push(`${connector}${paint(`↑ ${nodeLabel(node)} (see above, ×${count})`, 'dim')}`);
    return;
  }
  if (fold && canonicalId === undefined) seen.set(key, node.id);
  lines.push(`${connector}${renderNodeLine(node, paint)}`);
  const childPrefix = prefix === null ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
  const { shown, hidden } = orderChildren(node, expandInfra);
  const total = shown.length + (hidden.length > 0 ? 1 : 0);
  shown.forEach((child, position) => {
    renderSubtree(child, childPrefix, position === total - 1, lines, paint, expandInfra, fold, seen, counts);
  });
  if (hidden.length === 0) return;
  const size = hidden.reduce(
    (sum, child) => {
      const inner = subtreeSize(child);
      return { nodes: sum.nodes + inner.nodes, graph: sum.graph + inner.graph };
    },
    { nodes: 0, graph: 0 },
  );
  lines.push(
    `${childPrefix}└─ ${paint(
      `infrastructure (${plural(size.nodes, 'node')}, ${plural(size.graph, 'graph hop')}) — use --expand-infra`,
      'dim',
    )}`,
  );
}

function dispositionText(seed) {
  if (seed.dispositions.length === 0) return 'no deciding branch';
  return seed.dispositions
    .map((entry) => `${entry.kind}@${entry.line}=${entry.disposition}${entry.count > 1 ? ` ×${entry.count}` : ''}`)
    .join(', ');
}

function outcomeText(item) {
  if (item.kind === 'db') return `■ db ${item.ref}${item.method ? `.${item.method}` : ''}`;
  if (item.kind === 'push') return `■ push ${item.ref}`;
  if (item.kind === 'http_out') return `■ http_out ${item.ref}`;
  const consumers = item.consumers || [];
  if (consumers.length === 0) return `⇝ ${item.ref} → (no consumer)`;
  return consumers
    .map((consumer) => {
      const nested = consumer.sinks.map((sink) => ` → ■ db ${sink}`).join('');
      return `⇝ ${item.ref} → ${consumer.ref} [${consumer.repo}]${nested}`;
    })
    .join(', ');
}

/** Writes and message hops read one by one; reads collapse to a single count. */
function outcomeLine(items) {
  const isRead = (item) => item.kind === 'db' && item.access === 'read';
  const written = items.filter((item) => !isRead(item)).map(outcomeText).join(', ');
  const reads = items.filter(isRead).length;
  if (reads === 0) return written;
  return written ? `${written} · reads ${reads}` : `reads ${reads}`;
}

function sinkText(seed) {
  if (seed.response) return seed.response;
  if (seed.outcomes.length === 0) return 'no observable effect';
  return outcomeLine(seed.outcomes);
}

/**
 * `[unreachable: tenantId ← jwt]` — why a black-box caller cannot force this seed, or
 * can only force it with a degenerate path segment. Silent on a seed the request itself
 * decides, which is the ordinary case and needs no note.
 */
function reachabilityNote(seed, paint) {
  if (!seed.reachability || seed.reachability === 'reachable') return '';
  const reason = seed.reachabilityReason ? `: ${seed.reachabilityReason}` : '';
  return `  ${paint(`[${seed.reachability}${reason}]`, 'yellow')}`;
}

function branchList(entries) {
  return entries.map((entry) => `${entry.kind}@${entry.class}.${entry.method}:${entry.line}`).join(', ');
}

/** Render the seed block: one line per use case, plus the branches that do not multiply. */
export function renderSeeds(result, { color = false } = {}) {
  const paint = painter(color);
  const seeds = result.seeds || [];
  if (seeds.length === 0) return 'use-case seeds: none (no sink reached)';
  const total = seeds.length + (result.seedsTruncated || 0);
  const lines = [`use-case seeds (${total}):`];
  for (const seed of seeds) {
    const stable = seed.key ? `  ${paint(`#${seed.key}`, 'dim')}` : '';
    lines.push(
      `${paint(seed.id, 'bold')}  ${dispositionText(seed)}  → ${paint(sinkText(seed), 'magenta')}${stable}` +
        `${reachabilityNote(seed, paint)}`,
    );
    if (seed.alsoOnPath.length > 0) {
      lines.push(paint(`    also on path: ${branchList(seed.alsoOnPath)}`, 'dim'));
    }
    if (seed.always && seed.always.length > 0) {
      lines.push(paint(`    always (infrastructure): ${outcomeLine(seed.always)}`, 'dim'));
    }
    if (seed.infrastructure && seed.infrastructure.length > 0) {
      lines.push(paint(`    also on path (infrastructure): ${branchList(seed.infrastructure)}`, 'dim'));
    }
  }
  if (result.seedsTruncated > 0) lines.push(`+${result.seedsTruncated} more`);
  return lines.join('\n');
}

/**
 * Trailer: sinks reached, branch points, repositories crossed, edges by `via`. When
 * folding (default on) actually removed nodes from the printed tree, a final segment
 * names the reduction — `folded 312 → 185 nodes` — counting each folded reference as
 * one node, per the same rule `renderSubtree` prints by. Nothing is added when there was
 * nothing to fold, so a trace with no repeated node gains no fold-reduction segment.
 */
export function renderTrailer(result, { color = false, expandInfra = false, fold = true } = {}) {
  const paint = painter(color);
  const stats = result.stats;
  const via = Object.keys(stats.via)
    .sort()
    .map((key) => `${key} ${stats.via[key]}`)
    .join(', ');
  const parts = stats.inventory
    ? [
        plural(stats.routes, 'route'),
        `${stats.repos.length} repo${stats.repos.length === 1 ? '' : 's'} (${stats.repos.join(', ')})`,
        `via: ${via || 'none'}`,
      ]
    : [
        plural(stats.sinks, 'sink'),
        `${plural(stats.branches, 'branch point')} (${stats.primaryBranches} primary)`,
        `${stats.repos.length} repo${stats.repos.length === 1 ? '' : 's'} (${stats.repos.join(', ')})`,
        `via: ${via || 'none'}`,
      ];
  if (stats.crossings > 0) parts.push(`${stats.crossings} repo crossing${stats.crossings === 1 ? '' : 's'}`);
  if (stats.graphUnavailable > 0) parts.push(`${stats.graphUnavailable} graph hop unavailable`);
  if (stats.budgetHit) parts.push('node budget reached');
  if (fold) {
    const before = countShown(result.root, expandInfra);
    const after = countFolded(result.root, expandInfra, new Map());
    if (before !== after) parts.push(`folded ${before} → ${after} nodes`);
  }
  return paint(parts.join(' · '), 'dim');
}

/**
 * The private helpers a second renderer needs to reproduce this module's line text
 * exactly. `renderTree` returns one joined string and throws away which node produced
 * which line, so a renderer that has to bind evidence to a line cannot use it — it
 * re-runs the same recursion instead, over these same helpers, and every character it
 * prints still comes from here. One frozen object rather than seven loose exports keeps
 * the seam visible as a seam: it is an internal surface with one consumer
 * (`lib/render-tree-html.js`), not seven pieces of public API.
 */
export const internals = Object.freeze({
  renderNodeLine,
  nodeLabel,
  orderChildren,
  identityKey,
  countOccurrences,
  subtreeSize,
  plural,
});

/** Render the whole trace: tree, optional seed block, trailer. `fold` defaults on; `--no-fold` passes `false`. */
export function renderTree(result, { color = false, seeds = false, expandInfra = false, fold = true } = {}) {
  const paint = painter(color);
  const lines = [];
  const counts = fold ? countOccurrences(result.root, expandInfra, new Map()) : new Map();
  renderSubtree(result.root, null, true, lines, paint, expandInfra, fold, new Map(), counts);
  lines.push('');
  if (seeds) {
    lines.push(renderSeeds(result, { color }));
    lines.push('');
  }
  lines.push(renderTrailer(result, { color, expandInfra, fold }));
  return lines.join('\n');
}

/**
 * The node/edge graph beneath `result.root`, for `--json` and `--graph`: every node
 * carries its walk-assigned `id`; the first occurrence of a repo+file+line+kind+ref carries
 * every field `nodeFields` supplies, and every later occurrence is the two-field stub
 * `{ id, ref }` pointing back at the first — its own subtree is left out entirely rather
 * than duplicated, so a renderer downstream draws one shared node with two incoming
 * edges instead of walking the same subtree twice. `fold: false` returns every node in
 * full, matching the walk's own flat `nodes` list. Edges are `result.edges` filtered to
 * the pairs both of whose ends are still present.
 */
export function foldedGraph(result, { fold = true, nodeFields = () => ({}) } = {}) {
  const canonical = new Map();
  const included = new Set();
  const nodes = [];
  function visit(node) {
    const key = identityKey(node);
    if (fold && canonical.has(key)) {
      nodes.push({ id: node.id, ref: canonical.get(key) });
      included.add(node.id);
      return;
    }
    canonical.set(key, node.id);
    included.add(node.id);
    nodes.push({ id: node.id, ...nodeFields(node) });
    for (const child of node.children || []) visit(child);
  }
  visit(result.root);
  const edges = result.edges.filter((edge) => included.has(edge.from) && included.has(edge.to));
  return { nodes, edges };
}
