/**
 * One walk's result status: how complete the traversal is within the scope it states,
 * whether its facts still match the code, and how strong its evidence is. The walk
 * computes the facts; this module turns them into the one shape every printer reads, so
 * the terminal, `--json`, `--graph`, `--mermaid`, `--html` and both span pages cannot
 * disagree about what one walk reached.
 *
 * A limit reason makes the traversal `partial`. A discovery reason, with no limit beside
 * it, makes it `unknown`: the walk followed every edge the budget allowed and still cannot
 * name what it did not see. Only a walk with neither reads `complete`. Freshness and
 * evidence are separate axes on purpose — fresh facts do not make a stopped walk complete,
 * and a complete walk over an inferred edge is still weak evidence.
 */

export const STATUS_SCHEMA_VERSION = 1;

/** The one phrase a read-only seed may carry when its walk is not complete. */
export const OBSERVED_READS = 'observed reads; other effects unknown';

export const LIMIT_REASONS = Object.freeze(['depth', 'node-budget', 'seed-cap', 'fan-out-cap']);
export const DISCOVERY_REASONS = Object.freeze([
  'unresolved-target',
  'unresolved-pipeline',
  'provider-unavailable',
  'unknown-edge-kind',
]);
/**
 * A stop where the walk left the configured repositories on purpose: the callee lives in a
 * package the facts never declare. It is listed so a reader sees where the answer ends,
 * but it is outside the traversal verdict, the notice and every gate, because nothing the
 * configured repositories hold was left unread.
 */
export const BOUNDARY_REASONS = Object.freeze(['external-boundary']);
const REASON_ORDER = new Map(
  [...LIMIT_REASONS, ...DISCOVERY_REASONS, ...BOUNDARY_REASONS].map((reason, index) => [reason, index]),
);

/** Whether a stop reason leaves part of the configured repositories unread. */
export function gatingReason(reason) {
  return !BOUNDARY_REASONS.includes(reason);
}

/** The traversal verdict over a set of stop reasons: limits first, then discovery. */
export function traversalOf(reasons) {
  const gating = reasons.filter(gatingReason);
  if (gating.some((reason) => LIMIT_REASONS.includes(reason))) return 'partial';
  return gating.length > 0 ? 'unknown' : 'complete';
}
const RAISED_BY = Object.freeze({ depth: '--depth', 'node-budget': '--max-nodes' });

/** The flag that raises one limit, or `null` when no flag raises it. */
export function raisedByOf(reason) {
  return Object.prototype.hasOwnProperty.call(RAISED_BY, reason) ? RAISED_BY[reason] : null;
}

/** Limit reasons in the order the status lists them; anything else sorts after, by name. */
export function compareReasons(a, b) {
  const left = REASON_ORDER.has(a) ? REASON_ORDER.get(a) : REASON_ORDER.size;
  const right = REASON_ORDER.has(b) ? REASON_ORDER.get(b) : REASON_ORDER.size;
  if (left !== right) return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The status object, from the raw material the walk gathered. `frontier` entries arrive
 * in the order the walk made them; this function only orders and counts, so two runs over
 * one fact set and one limit set build the same bytes.
 */
export function buildStatus(input) {
  // Walk order, then reason order: the caller gathers node entries in the order the walk
  // made them, and appends the cap entries in reason order.
  const frontier = input.frontier.slice();
  const frontierNodes = input.frontierNodes ? input.frontierNodes.slice() : [];
  const stops = {};
  for (const reason of Object.keys(input.stops).sort(compareReasons)) {
    if (input.stops[reason] > 0) stops[reason] = input.stops[reason];
  }
  const traversal = traversalOf(Object.keys(stops));
  const status = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    traversal,
    freshness: input.freshness.value,
    factSets: input.freshness.sets.map((entry) => ({ repo: entry.repo, freshness: entry.freshness })),
    evidence: {
      'source-supported': input.evidence['source-supported'],
      inferred: input.evidence.inferred,
      runtime: 'not supplied',
    },
    scope: input.scope,
    limits: input.limits,
    schedule: input.schedule,
    stops,
    frontier,
    identity: input.identity,
  };
  // The lookup a renderer that needs the per-node reason reads. Non-enumerable: it is a
  // convenience for one caller, never part of the contract a reader parses.
  Object.defineProperty(status, 'stopsByNode', { value: input.stopsByNode, enumerable: false });
  Object.defineProperty(status, 'frontierNodes', { value: frontierNodes, enumerable: false });
  return status;
}

/**
 * The same status over a narrower frontier: a component page that shows one entry only
 * shows the stops that entry can meet. Traversal is derived again from the kept reasons,
 * so a narrowed frontier never keeps the wider walk's verdict.
 */
export function narrowStatus(status, frontier) {
  if (!status) return status;
  const stops = {};
  for (const entry of frontier) stops[entry.reason] = (stops[entry.reason] || 0) + 1;
  const traversal = traversalOf(Object.keys(stops));
  const narrowed = { ...status, traversal, stops: Object.fromEntries(Object.keys(stops).sort(compareReasons).map((r) => [r, stops[r]])), frontier };
  Object.defineProperty(narrowed, 'stopsByNode', { value: status.stopsByNode, enumerable: false });
  Object.defineProperty(narrowed, 'frontierNodes', { value: status.frontierNodes, enumerable: false });
  return narrowed;
}

function location(ref) {
  return ref && ref.file ? `${ref.file}${ref.line ? `:${ref.line}` : ''}` : '-';
}

function countText(value) {
  return Number.isInteger(value) ? String(value) : 'unknown';
}

/** Whether `--require-complete` fails a run over this status. Evidence never fails it. */
export function walkFails(status) {
  return Boolean(
    status && (status.traversal !== 'complete' || status.freshness !== 'matching'),
  );
}

/**
 * The `file:line` of the walk's start, or `null` when the start has no file. A page that
 * keeps source locations behind an expander reads it here, so the status line and its
 * location come from one module.
 */
export function startLocationOf(status) {
  const start = status && status.scope && status.scope.start;
  return start && start.file ? location(start) : null;
}

/**
 * The header lines every output prints before anything else, in one fixed order. With
 * `withStartLocation: false` the start line names no `file:line`, and `startLocationOf`
 * gives it. Without the option the lines are the ones every terminal printer prints.
 */
export function statusLines(status, { withStartLocation = true } = {}) {
  if (!status) return [];
  const start = status.scope.start;
  const scopeParts = [status.scope.mode];
  if (status.scope.fromHandler) scopeParts.push(`from handler ${status.scope.fromHandler}`);
  if (status.scope.unscoped) scopeParts.push('unscoped');
  if (status.scope.graph) scopeParts.push('graph hop');
  if (status.scope.entry) scopeParts.push(`entry ${status.scope.entry}`);
  const startAt = withStartLocation ? ` ${location(start)}` : '';
  const lines = [
    `start: ${start.ref} (${start.kind}, ${start.repo}${startAt})`,
    `scope: ${scopeParts.join(', ')}`,
    `limits: depth ${status.limits.depth}, node budget ${status.limits.maxNodes}, ` +
      `seed cap ${status.limits.seedCap}, interface fan-out ${status.limits.interfaceFanOut}, ` +
      `graph fan-out ${status.limits.graphFanOut}`,
    `status: traversal ${status.traversal}, freshness ${status.freshness}`,
    `evidence: ${status.evidence['source-supported']} source-supported, ${status.evidence.inferred} inferred, ` +
      `runtime ${status.evidence.runtime}`,
    `stops: ${stopsText(status)}; frontier ${status.frontier.length}`,
  ];
  if (status.schedule && status.schedule.order === 'level') {
    const level = status.schedule.level;
    lines.push(
      `schedule: levels below ${level} walked in full, level ${level} in call-site order to the node budget`,
    );
  }
  return lines;
}

function stopsText(status) {
  const reasons = Object.keys(status.stops);
  if (reasons.length === 0) return 'none';
  return reasons.map((reason) => `${reason} ${status.stops[reason]}`).join('; ');
}

/** One line per frontier entry: where the walk stopped, why, and what it left unread. */
export function frontierLines(status) {
  return (status.frontier || []).map((entry) => {
    const parts = [entry.reason, entry.repo || '-', entry.target || '-', location(entry.callSite)];
    if (entry.via) parts.push(`via ${entry.via}`);
    if (entry.caller) parts.push(`caller ${entry.caller.ref} ${location(entry.caller)}`);
    if (entry.detail) parts.push(`detail ${entry.detail}`);
    if (entry.gate) parts.push(`gate ${entry.gate}`);
    parts.push(`remaining ${countText(entry.remaining)}`);
    if (LIMIT_REASONS.includes(entry.reason)) {
      parts.push(entry.raisedBy ? `raise ${entry.raisedBy}` : 'no flag raises it');
    }
    return parts.join('  ');
  });
}

/** The stderr reasons `--require-complete` prints for one failed walk. */
export function requireCompleteLines(status, label = null) {
  if (!walkFails(status)) return [];
  const prefix = label ? `flowtrace: not complete: ${label}: ` : 'flowtrace: not complete: ';
  const lines = [];
  for (const reason of Object.keys(status.stops).sort(compareReasons)) {
    if (!gatingReason(reason)) continue;
    const raised = LIMIT_REASONS.includes(reason)
      ? ` (${raisedByOf(reason) ? `raise ${raisedByOf(reason)}` : 'no flag raises it'})`
      : '';
    lines.push(`${prefix}${reason} ${status.stops[reason]}${raised}`);
  }
  if (status.freshness !== 'matching') {
    const sets = status.factSets.map((entry) => `${entry.repo} ${entry.freshness}`).join(', ');
    lines.push(`${prefix}freshness ${status.freshness} (${sets})`);
  }
  return lines;
}

/**
 * Wrap a walker and count what it returned, so a command that reads many walks can print
 * one notice for the run. The counter rides on the wrapper; the walker's own results are
 * untouched. With `labelOf`, the wrapper also keeps each walk's status under the label
 * `--require-complete` prints for it.
 */
export function countWalks(walk, labelOf = null) {
  const counts = { walks: 0, incomplete: 0, stops: new Map() };
  const kept = [];
  const wrapped = (...args) => {
    const result = walk(...args);
    counts.walks += 1;
    const status = result && result.status;
    if (status && status.traversal !== 'complete') {
      counts.incomplete += 1;
      for (const [reason, count] of Object.entries(status.stops)) {
        if (!gatingReason(reason)) continue;
        counts.stops.set(reason, (counts.stops.get(reason) || 0) + count);
      }
    }
    if (labelOf && status) kept.push({ label: labelOf(status, ...args), status });
    return result;
  };
  wrapped.counts = counts;
  wrapped.walks = kept;
  return wrapped;
}

/**
 * The `--require-complete` stderr lines for every kept walk. A route a run walks twice
 * over the same identity prints once. `traversalOnly` judges the traversal alone, for a
 * side whose facts trail the code by design.
 */
export function requireCompleteFailures(walks, { traversalOnly = false } = {}) {
  const seen = new Set();
  const lines = [];
  for (const { label, status } of walks) {
    const key = `${label}\u0000${status.identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const judged = traversalOnly ? { ...status, freshness: 'matching' } : status;
    lines.push(...requireCompleteLines(judged, label));
  }
  return lines;
}

/**
 * The mark an item of a reading verb carries when the walk behind it stopped: its
 * traversal and stop counts, the shape `cover` records keep. A complete walk gives `null`,
 * so a reader that adds nothing over a complete walk keeps its bytes.
 */
export function walkMark(status) {
  if (!status || status.traversal === 'complete') return null;
  return { traversal: status.traversal, stops: { ...status.stops } };
}

/** The one text form of a walk mark: `walk <traversal> (<reason> <n>, …)`. */
export function walkMarkText(mark) {
  if (!mark) return '';
  const reasons = Object.keys(mark.stops)
    .sort(compareReasons)
    .map((reason) => `${reason} ${mark.stops[reason]}`)
    .join(', ');
  return `walk ${mark.traversal} (${reasons})`;
}

/**
 * Where a walk stopped, without file or line: one record per frontier entry that leaves
 * the configured repositories partly unread. A stop that moves inside one caller keeps the
 * same boundary; a renamed caller or target does not. The records sort by their JSON, so
 * two walks over the same boundary give the same list.
 */
export function walkBoundary(status) {
  const records = new Map();
  for (const entry of (status && status.frontier) || []) {
    if (!gatingReason(entry.reason)) continue;
    const record = {
      reason: entry.reason,
      target: entry.target || null,
      caller: (entry.caller && entry.caller.ref) || null,
      gate: entry.gate || null,
    };
    records.set(JSON.stringify(record), record);
  }
  return [...records.keys()].sort().map((key) => records.get(key));
}

/** The boundary records one side added and removed against the other. */
export function boundaryChange(before, after) {
  const keyOf = (record) => JSON.stringify({ reason: record.reason, target: record.target, caller: record.caller, gate: record.gate });
  const left = new Set(before.map(keyOf));
  const right = new Set(after.map(keyOf));
  return {
    added: after.filter((record) => !left.has(keyOf(record))),
    removed: before.filter((record) => !right.has(keyOf(record))),
  };
}

/** One text form of a boundary record. */
export function boundaryRecordText(record) {
  const parts = [record.reason, record.target || '-'];
  if (record.caller) parts.push(`caller ${record.caller}`);
  if (record.gate) parts.push(`gate ${record.gate}`);
  return parts.join(' ');
}

/** The one stderr notice the eight reading commands print after a run over a stopped walk. */
export function noticeLine(command, counts) {
  if (!counts || counts.incomplete === 0) return null;
  const reasons = [...counts.stops.entries()]
    .sort((a, b) => compareReasons(a[0], b[0]))
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  return (
    `flowtrace: ${command}: ${counts.incomplete} of ${counts.walks} walks did not complete ` +
    `(${reasons}); its answer can miss what they did not reach`
  );
}
