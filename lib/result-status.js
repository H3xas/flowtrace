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
const REASON_ORDER = new Map([...LIMIT_REASONS, ...DISCOVERY_REASONS].map((reason, index) => [reason, index]));
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
  const reasons = Object.keys(stops);
  const traversal = reasons.some((reason) => LIMIT_REASONS.includes(reason))
    ? 'partial'
    : reasons.length > 0
      ? 'unknown'
      : 'complete';
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
  const reasons = Object.keys(stops);
  const traversal = reasons.some((reason) => LIMIT_REASONS.includes(reason))
    ? 'partial'
    : reasons.length > 0
      ? 'unknown'
      : 'complete';
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

/** The header lines every output prints before anything else, in one fixed order. */
export function statusLines(status) {
  if (!status) return [];
  const start = status.scope.start;
  const scopeParts = [status.scope.mode];
  if (status.scope.fromHandler) scopeParts.push(`from handler ${status.scope.fromHandler}`);
  if (status.scope.unscoped) scopeParts.push('unscoped');
  if (status.scope.graph) scopeParts.push('graph hop');
  const lines = [
    `start: ${start.ref} (${start.kind}, ${start.repo} ${location(start)})`,
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
 * untouched.
 */
export function countWalks(walk) {
  const counts = { walks: 0, incomplete: 0, stops: new Map() };
  const wrapped = (...args) => {
    const result = walk(...args);
    counts.walks += 1;
    const status = result && result.status;
    if (status && status.traversal !== 'complete') {
      counts.incomplete += 1;
      for (const [reason, count] of Object.entries(status.stops)) {
        counts.stops.set(reason, (counts.stops.get(reason) || 0) + count);
      }
    }
    return result;
  };
  wrapped.counts = counts;
  return wrapped;
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
