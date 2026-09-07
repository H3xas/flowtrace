/**
 * Edge export — the joined cross-repo edges in a versioned file a code index can import.
 *
 * `join --export-edges <file>` writes one record per joined edge in exactly the join
 * contract's shape — `kind`, `from` and `to` as `{ repo, ref, file, line }`, the join
 * `key` — plus a `provenance` field naming the export it came from, so an importer can
 * render imported rows distinguishably and drop or replace them wholesale on the next
 * import. The envelope carries the full provenance once: the producer, the format
 * version, the configuration the join read, and every fact set's identity block, the same
 * block the snapshot writes. Its `id` is a digest over all of that, so a facts change, a
 * re-extraction at another HEAD or a tool upgrade produces a new id while an unchanged
 * state keeps it.
 *
 * Only joined edges export: a caller or a spec matched to a route action (`calls`,
 * `tests`), and — for a message that has both a publisher and a matched consumer or
 * processor — its `publishes`, `consumes` and `enqueues` edges verbatim. The message end of
 * those carries `repo: "message"` with no file or line, exactly as the join states it; an
 * importer that wants a code-to-code hop composes across that node. Nothing unjoined and
 * nothing intra-repository (`injects`, `renders`, `pushes`, `calls_out`) is exported.
 * Records are sorted and deduplicated, and no timestamp is written, so two exports over
 * unchanged facts are the same bytes.
 *
 * A code end always carries `repo`, `file` and `line`: the export refuses the whole run
 * rather than write a record whose code end is missing one, since a consumer that can
 * follow every edge is the guarantee this format makes. The message end above is the one
 * exemption, and it is an exemption from this check by name (`repo: "message"`), not from
 * completeness — it never carries a file or line by design.
 */

import { createHash } from 'node:crypto';

import { comparisonConfig, factSetIdentity } from './join-drift.js';

export const EDGES_FORMAT = 'flowtrace-edges';
export const EDGES_SCHEMA_VERSION = 1;

/** The edge kinds an export may contain, in the order records are written. */
export const EXPORTED_KINDS = Object.freeze(['calls', 'consumes', 'enqueues', 'publishes', 'tests']);

function compare(a, b) {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareLine(a, b) {
  return (a ?? -1) - (b ?? -1);
}

function end(item) {
  return {
    repo: item?.repo ?? null,
    ref: item?.ref ?? null,
    file: item?.file ?? null,
    line: item?.line ?? null,
  };
}

/** Raised when a joined edge's code end lacks `repo`, `file` or `line`; the whole export
 * is refused rather than write a record that breaks the format's own guarantee. */
export class IncompleteEdgeError extends Error {}

/** A code end is complete when it carries `repo`, `file` and `line`; the message end
 * (`repo: "message"`) is exempt — it carries no file or line by design. */
function assertCompleteEnd(side, edge, label) {
  if (side.repo === 'message') return;
  if (side.repo != null && side.file != null && side.line != null) return;
  throw new IncompleteEdgeError(
    `join --export-edges: refusing ${edge.kind} ${edge.key ?? '(no key)'}: its ${label} end is missing repo, file or line`,
  );
}

/**
 * The provenance block: who produced the export, in which format version, from which
 * configuration and which fact sets — and the id an importer keys on.
 */
export function provenanceOf(factSets, { tool, config } = {}) {
  const producer = `${tool?.name ?? 'flowtrace-cli'} ${tool?.version ?? '0.0.0'}`;
  const identities = [...(factSets || [])]
    .sort((a, b) => compare(a.repo, b.repo))
    .map(factSetIdentity);
  const id = createHash('sha1')
    .update(JSON.stringify([producer, EDGES_SCHEMA_VERSION, identities]))
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    producer,
    formatVersion: EDGES_SCHEMA_VERSION,
    config: comparisonConfig(config),
    factSets: identities,
  };
}

/** The joined edges of a flow: both ends matched, nothing from an unjoined bucket. */
export function joinedEdges(flow) {
  const joinedMessages = new Set();
  for (const edge of flow.edges || []) {
    if ((edge.kind === 'consumes' || edge.kind === 'enqueues') && edge.match) joinedMessages.add(edge.key);
  }
  return (flow.edges || []).filter((edge) => {
    if (edge.kind === 'calls' || edge.kind === 'tests') return true;
    if (edge.kind === 'consumes' || edge.kind === 'enqueues') return Boolean(edge.match);
    if (edge.kind === 'publishes') return joinedMessages.has(edge.key);
    return false;
  });
}

function recordOrder(a, b) {
  return (
    compare(a.kind, b.kind) ||
    compare(a.key, b.key) ||
    compare(a.from.repo, b.from.repo) ||
    compare(a.from.ref, b.from.ref) ||
    compare(a.from.file, b.from.file) ||
    compareLine(a.from.line, b.from.line) ||
    compare(a.to.repo, b.to.repo) ||
    compare(a.to.ref, b.to.ref) ||
    compare(a.to.file, b.to.file) ||
    compareLine(a.to.line, b.to.line)
  );
}

/**
 * Build the export from a flow the join already produced and the fact sets it was built
 * from. `tool` names the producer; `config` is the configuration the join read.
 */
export function exportEdges(flow, factSets, { tool, config } = {}) {
  const provenance = provenanceOf(factSets, { tool, config });
  const seen = new Set();
  const edges = [];
  for (const edge of joinedEdges(flow)) {
    const record = { kind: edge.kind, from: end(edge.from), to: end(edge.to), key: edge.key ?? null, provenance: provenance.id };
    assertCompleteEnd(record.from, record, 'from');
    assertCompleteEnd(record.to, record, 'to');
    const identity = JSON.stringify(record);
    if (seen.has(identity)) continue;
    seen.add(identity);
    edges.push(record);
  }
  edges.sort(recordOrder);
  return {
    schemaVersion: EDGES_SCHEMA_VERSION,
    format: EDGES_FORMAT,
    tool: { name: tool?.name ?? 'flowtrace-cli', version: tool?.version ?? '0.0.0' },
    provenance,
    edges,
  };
}
