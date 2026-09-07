/**
 * Scope step — an area's whole route universe, before any edit.
 *
 * `affected` answers "which specs must run for this diff" after a change exists; nothing
 * in the pipeline answered the question a change starts from — "what is this area's whole
 * route universe, and which of it already has automated evidence and a server-side
 * authorization point". `scope` is that ledger seed: one row per area key, in the area
 * file's own order, each carrying the route's own declaration site, `cover`'s own
 * executing-evidence verdict collapsed to yes/no, and the first node on the route's own
 * walk that looks like an authorization check.
 *
 * The walk is exactly the one `cover` already takes — same depth, same options — so the
 * automation flag is the same number `cover --area` would report and the gate search
 * never looks deeper than the evidence it sits beside. `options.trace` is wrapped rather
 * than read twice: a caller's own walker replacement (tests) is still honoured, and the
 * walked tree it returns is captured once per key instead of being asked for a second time.
 */

import { cover } from './cover.js';
import { staleFactsWarnings } from './facts.js';
import { trace as defaultTrace } from './trace.js';

export const SCOPE_SCHEMA_VERSION = 1;

/** A caller's own `options.stale`, or `staleFactsWarnings`, normalised to `{message, kind}` — a bare string (an older override, or a hand-built one) reads as the strict `head` kind. */
function normalizeStale(raw) {
  return (raw || []).map((entry) => (typeof entry === 'string' ? { message: entry, kind: 'head' } : entry));
}

/** Every configured `gatePatterns` source compiled once, so a large area walks each pattern's regex only once per node rather than once per key. */
function compileGatePatterns(sources) {
  return (sources || []).map((source) => new RegExp(source));
}

/**
 * The repository a node's location is reported under: a `bus` node names the message
 * bus, never a checkout, so its `homeRepo` — the repository the walk was in when it
 * crossed onto the bus — stands in for it, the same reading `routes-of` gives a hop.
 */
function locationRepo(node) {
  return node.repo === 'bus' ? node.homeRepo || node.repo : node.repo;
}

/**
 * The first node on a route's own walk whose `ref` matches one of the compiled gate
 * patterns — root included, since a route whose own declaration carries the pattern
 * (an `[Authorize]`-shaped controller-level check the extractor folded into the route
 * itself) is still a server-side gate. `null` when no pattern is configured or none
 * matches; a walk that errored or stayed ambiguous carries no nodes and matches nothing.
 */
function firstGateNode(walked, patterns) {
  if (patterns.length === 0 || !walked || !Array.isArray(walked.nodes)) return null;
  for (const node of walked.nodes) {
    if (typeof node.ref !== 'string') continue;
    if (!node.file || !Number.isInteger(node.line)) continue;
    if (patterns.some((pattern) => pattern.test(node.ref))) return node;
  }
  return null;
}

function location(repo, file, line) {
  return repo && file && Number.isInteger(line) ? `${repo}:${file}:${line}` : null;
}

/**
 * The area's whole route universe. `keys` is exactly what `readAreaKeys` returns for the
 * area file — already deduplicated, already in the file's own line order — and that order
 * is preserved on the way out: nothing here re-sorts or re-groups it, so the ledger a
 * caller seeds from reads in the order the area file was reviewed in.
 *
 * Refuses on `head`-stale facts exactly as `affected` does, and for the same reason: a
 * ledger built from facts behind a commit nobody has looked at yet would name gates and
 * automation states that may no longer be true. A `worktree`-stale fact set — HEAD
 * unchanged, only the working tree's dirty digest has moved on — gates nothing: `scope`
 * reads no diff of its own, so an uncommitted edit changes nothing this walk would see
 * differently than the last commit did.
 */
export function scope(factSets, options = {}) {
  const {
    area = null,
    keys = [],
    aliases = [],
    traceOptions = {},
    trace: walker = defaultTrace,
    repos = [],
    gatePatterns = [],
  } = options;

  const stale = normalizeStale(options.stale || staleFactsWarnings(factSets, repos));
  const headStale = stale.filter((entry) => entry.kind !== 'worktree');
  if (headStale.length > 0) {
    return { area, verdict: 'stale', stale: headStale };
  }

  const patterns = compileGatePatterns(gatePatterns);
  const walkedByKey = new Map();
  const capture = (facts, key, opts) => {
    const walked = walker(facts, key, opts);
    walkedByKey.set(key, walked);
    return walked;
  };

  const report = cover(factSets, { area: area || 'area', keys, aliases, traceOptions, trace: capture });

  const routes = keys.map((key, index) => {
    const record = report.routes[index] || null;
    const walked = walkedByKey.get(key) || null;
    const root = walked && walked.root ? walked.root : null;
    const gateNode = firstGateNode(walked, patterns);
    const repo = root ? locationRepo(root) : null;
    const file = record && record.file !== null && record.file !== undefined ? record.file : root ? root.file : null;
    const line = record && record.line !== null && record.line !== undefined ? record.line : root ? root.line : null;
    return {
      key,
      repo,
      file,
      line,
      automation: record && record.evidence.executing > 0 ? 'yes' : 'no',
      serverGate: gateNode ? location(locationRepo(gateNode), gateNode.file, gateNode.line) : null,
    };
  });

  return { schemaVersion: SCOPE_SCHEMA_VERSION, area, routes };
}

/** Human rendering of the same model emitted by `--json`. */
export function renderScope(report) {
  if (report.verdict === 'stale') {
    const lines = [`scope ${report.area || 'area'} — stale, refusing to list`];
    for (const entry of report.stale) lines.push(`  ${entry.message}`);
    return lines.join('\n');
  }
  const lines = [`scope ${report.area}: ${report.routes.length} route${report.routes.length === 1 ? '' : 's'}`];
  for (const route of report.routes) {
    const where = location(route.repo, route.file, route.line) || 'unresolved';
    lines.push(
      `${route.key} — ${where} — automation: ${route.automation} — server-gate: ${route.serverGate || 'none'}`,
    );
  }
  return lines.join('\n');
}
