/**
 * The case-level projection a replay is judged by: for every ledger case, which expected sites
 * the tool's `trace --json` answer found, which assertions held, and the raw counts behind
 * them. It reads only the fields `match/1` names, so a field added to `--json` for another
 * reason cannot move a committed projection, and it never carries a path, a sha, a digest, a
 * timestamp or a version.
 */

export const OBSERVED_FORMAT = 'flowtrace-journey-observed';
export const OBSERVED_SCHEMA_VERSION = 1;
export const MATCH_RULE = 'match/1';

// A route joined by anything other than exact equality says how on the edge that reaches it.
const JOIN_VIA = new Set(['alias', 'prefix', 'suffix']);

function codePointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** How a start resolved, read from the exit code and, for exit 2, the refusal's own wording. */
export function entryOf(exit, stderr) {
  if (exit === 0) return 'resolved';
  if (exit === 2) return /matches \d+ starts:/.test(stderr) ? 'ambiguous' : 'unresolved';
  return 'error';
}

/**
 * The walk as occurrences: every entry of `nodes` in its reported order, a folded stub standing
 * for the node it refers to but keeping the edge that reached it, since that edge is what says
 * where this occurrence was called from.
 */
export function readWalk(document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
  const edges = Array.isArray(document?.edges) ? document.edges : [];
  const full = new Map();
  for (const node of nodes) if (node && typeof node.kind === 'string') full.set(node.id, node);
  const incoming = new Map();
  const children = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, edge);
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from).push(edge.to);
  }
  const occurrences = [];
  nodes.forEach((node, order) => {
    const canonicalId = full.has(node.id) ? node.id : typeof node.ref === 'string' && full.has(node.ref) ? node.ref : null;
    if (canonicalId === null) return;
    occurrences.push({
      id: node.id,
      canonical: canonicalId,
      order,
      fields: full.get(canonicalId),
      edge: incoming.get(node.id) ?? null,
    });
  });
  // `sinks` and `branches` list every walked sink and branch in full, including those beneath a
  // folded node whose own subtree `nodes` leaves out; they are part of the answer, but with no
  // edge reaching them they can be found and ordered only after everything the tree shows.
  let order = nodes.length;
  for (const list of [document?.sinks, document?.branches]) {
    for (const node of Array.isArray(list) ? list : []) {
      if (!node || typeof node.kind !== 'string' || full.has(node.id)) continue;
      full.set(node.id, node);
      occurrences.push({ id: node.id, canonical: node.id, order, fields: node, edge: null });
      order += 1;
    }
  }
  const byId = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  return { occurrences, byId, children, full, stats: document?.stats ?? null };
}

function namesOf(fields) {
  const names = new Set();
  if (typeof fields.ref === 'string') names.add(fields.ref);
  if (typeof fields.class === 'string' && typeof fields.method === 'string') names.add(`${fields.class}.${fields.method}`);
  if (typeof fields.class === 'string' && Array.isArray(fields.methods)) {
    for (const method of fields.methods) names.add(`${fields.class}.${method}`);
  }
  return names;
}

/**
 * `match/1`. By site: the occurrence's own node sits at the site's file and line, or the edge
 * that reached it carries evidence at that file and line — a node stands on a declaration and
 * the call that reached it is recorded on its edge. By symbol: the node, in the site's
 * repository, answers to the site's symbol as its ref, its `Class.method`, or one of the methods
 * a sink records.
 */
export function matchSite(site, occurrence) {
  const fields = occurrence.fields;
  const atNode = fields.repo === site.repo && fields.file === site.file && fields.line === site.line;
  const evidence = Array.isArray(occurrence.edge?.evidence) ? occurrence.edge.evidence : [];
  const atEdge = evidence.some((entry) => entry.repo === site.repo && entry.file === site.file && entry.line === site.line);
  const bySite = atNode || atEdge;
  const bySymbol = typeof site.symbol === 'string' && fields.repo === site.repo && namesOf(fields).has(site.symbol);
  return { bySite, bySymbol };
}

function joinValue(occurrence) {
  if (typeof occurrence.fields.match === 'string') return occurrence.fields.match;
  if (typeof occurrence.edge?.match === 'string') return occurrence.edge.match;
  if (JOIN_VIA.has(occurrence.edge?.via)) return occurrence.edge.via;
  return null;
}

function matching(walk, site, { siteOnly = false } = {}) {
  const out = [];
  for (const occurrence of walk.occurrences) {
    const { bySite, bySymbol } = matchSite(site, occurrence);
    if (bySite || (!siteOnly && bySymbol)) out.push({ occurrence, bySite, bySymbol });
  }
  return out;
}

/** Every canonical node below `id`, a folded stub continuing into the node it refers to. */
function descendants(walk, id) {
  const seen = new Set();
  const stack = [...(walk.children.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    const occurrence = walk.byId.get(next);
    if (!occurrence) continue;
    if (seen.has(occurrence.id)) continue;
    seen.add(occurrence.id);
    seen.add(occurrence.canonical);
    for (const child of walk.children.get(occurrence.canonical) ?? []) stack.push(child);
    if (occurrence.id !== occurrence.canonical) for (const child of walk.children.get(occurrence.id) ?? []) stack.push(child);
  }
  return seen;
}

function projectSite(walk, site) {
  const hits = matching(walk, site);
  if (hits.length === 0) return { id: site.id, found: false, by: null, match: null };
  const anySite = hits.some((hit) => hit.bySite);
  const anySymbol = hits.some((hit) => hit.bySymbol);
  const by = anySite && anySymbol ? 'both' : anySite ? 'site' : 'symbol';
  const value = hits.map((hit) => joinValue(hit.occurrence)).find((entry) => entry !== null) ?? null;
  return { id: site.id, found: true, by, match: value };
}

function projectUnknown(walk, unknown) {
  const hits = matching(walk, unknown, { siteOnly: true });
  let marked = false;
  let asserted = false;
  for (const { occurrence } of hits) {
    const below = [...descendants(walk, occurrence.canonical)].map((id) => walk.full.get(id)).filter(Boolean);
    const fields = occurrence.fields;
    if (fields.unresolved === true || (walk.children.get(occurrence.canonical) ?? []).some((id) => walk.full.get(id)?.unresolved === true)) {
      marked = true;
    }
    if ((fields.kind === 'route' && fields.unresolved !== true) || below.some((node) => node.kind === 'route' && node.unresolved !== true)) {
      asserted = true;
    }
  }
  return { id: unknown.id, seen: hits.length > 0, marked, asserted };
}

function projectAssertion(walk, assertion, sitesById) {
  const result = (held, reason = null) => ({ id: assertion.id, held, reason });
  if (assertion.kind === 'before') {
    const first = matching(walk, sitesById.get(assertion.first))[0];
    const then = matching(walk, sitesById.get(assertion.then))[0];
    if (!first) return result(false, `missing:${assertion.first}`);
    if (!then) return result(false, `missing:${assertion.then}`);
    if (first.occurrence.canonical === then.occurrence.canonical) return result(false, 'same-node');
    return first.occurrence.order < then.occurrence.order ? result(true) : result(false, 'reversed');
  }
  if (assertion.kind === 'reached-from') {
    const target = sitesById.get(assertion.site);
    const from = sitesById.get(assertion.from);
    const targets = matching(walk, target);
    if (targets.length === 0) return result(false, `missing:${assertion.site}`);
    const sources = matching(walk, from);
    const reached = [];
    for (const hit of targets) {
      const evidence = Array.isArray(hit.occurrence.edge?.evidence) ? hit.occurrence.edge.evidence : [];
      const byEdge = evidence.some((entry) => entry.repo === from.repo && entry.file === from.file && entry.line === from.line);
      const byDescent = sources.some(
        (source) =>
          source.occurrence.canonical !== hit.occurrence.canonical &&
          descendants(walk, source.occurrence.canonical).has(hit.occurrence.id),
      );
      if (byEdge || byDescent) reached.push(hit.occurrence);
    }
    if (reached.length === 0) return result(false, sources.length === 0 ? `missing:${assertion.from}` : 'not-reached');
    if (assertion.match === undefined) return result(true);
    if (reached.some((occurrence) => joinValue(occurrence) === assertion.match)) return result(true);
    return result(false, `match:${joinValue(reached[0]) ?? 'none'}`);
  }
  for (const id of assertion.sites) {
    if (!matching(walk, sitesById.get(id)).some((hit) => hit.bySite)) return result(false, `not-at-site:${id}`);
  }
  return result(true);
}

/** Assertions a run makes, for the outside-the-expected-set count. */
function runAssertions(walk, run) {
  const seen = new Map();
  for (const node of walk.full.values()) {
    if (run.asserts === 'routes') {
      if (node.kind !== 'route' || node.unresolved === true) continue;
      const item = { repo: node.repo, kind: 'route', ref: node.ref, node };
      seen.set(JSON.stringify([item.repo, item.kind, item.ref]), item);
    } else {
      if (node.sink !== true) continue;
      const owner = typeof node.class === 'string' ? node.class : node.ref;
      const methods = Array.isArray(node.methods) && node.methods.length > 0 ? node.methods : [null];
      for (const method of methods) {
        const ref = method === null ? owner : `${owner}.${method}`;
        const item = { repo: node.repo, kind: node.kind, ref, node };
        seen.set(JSON.stringify([item.repo, item.kind, item.ref]), item);
      }
    }
  }
  return [...seen.values()];
}

function outsideOf(walk, run, sitesById) {
  const reach = run.reach.map((id) => sitesById.get(id));
  const outside = [];
  for (const item of runAssertions(walk, run)) {
    const covered = reach.some((site) => {
      if (site.repo !== item.repo) return false;
      if (run.asserts === 'sinks') return site.symbol === item.ref;
      return walk.occurrences.some((occurrence) => occurrence.fields === item.node && (matchSite(site, occurrence).bySite || matchSite(site, occurrence).bySymbol));
    });
    if (!covered) outside.push({ repo: item.repo, kind: item.kind, ref: item.ref });
  }
  return outside.sort((a, b) => codePointCompare(JSON.stringify([a.repo, a.kind, a.ref]), JSON.stringify([b.repo, b.kind, b.ref])));
}

/** One run's projection plus the walk the cases are read against. */
export function projectRun(run, output, sitesById) {
  const entry = entryOf(output.exit, output.stderr);
  let document = null;
  if (output.exit === 0) {
    try {
      document = JSON.parse(output.stdout);
    } catch {
      document = null;
    }
  }
  const walk = readWalk(document);
  const budgetHit = document && document.stats && typeof document.stats.budgetHit === 'boolean' ? document.stats.budgetHit : null;
  const unresolvedMarkers = [...walk.full.values()].filter((node) => node.unresolved === true).length;
  const outside = document ? outsideOf(walk, run, sitesById) : [];
  return {
    record: { id: run.id, exit: output.exit, entry: document || entry !== 'resolved' ? entry : 'error', budgetHit, unresolvedMarkers, outside },
    walk,
  };
}

/** The projection of one ledger over one set of run outputs, keyed by run id. */
export function project(ledger, outputs) {
  const sitesById = new Map([...ledger.sites, ...ledger.unknowns].map((site) => [site.id, site]));
  const runs = new Map();
  for (const run of ledger.runs) runs.set(run.id, projectRun(run, outputs.get(run.id), sitesById));
  const cases = ledger.cases.map((entry) => {
    const { record, walk } = runs.get(entry.run);
    const sites = entry.expect.map((id) => projectSite(walk, sitesById.get(id)));
    const unknowns = entry.unknowns.map((id) => projectUnknown(walk, sitesById.get(id)));
    const assertions = entry.assertions.map((assertion) => projectAssertion(walk, assertion, sitesById));
    const counts = {
      sitesResolved: sites.filter((site) => site.found).length,
      sitesExpected: sites.length,
      outside: record.outside.length,
      entryUnresolved: record.entry === 'resolved' ? 0 : 1,
      assertionsHeld: assertions.filter((assertion) => assertion.held).length,
      assertionsAsserted: assertions.length,
      unknownsMarked: unknowns.filter((unknown) => unknown.marked).length,
      unknownsExpected: unknowns.length,
    };
    const falselyComplete =
      record.exit === 0 && record.budgetHit === false && record.unresolvedMarkers === 0 && counts.sitesResolved < counts.sitesExpected;
    return { id: entry.id, run: entry.run, sites, unknowns, assertions, counts, falselyComplete, classification: null, evidence: '' };
  });
  return {
    format: OBSERVED_FORMAT,
    schemaVersion: OBSERVED_SCHEMA_VERSION,
    pack: ledger.pack,
    rules: { match: MATCH_RULE },
    runs: ledger.runs.map((run) => runs.get(run.id).record),
    cases,
  };
}

export function serialise(projection) {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

function observedPart(entry) {
  const { classification, evidence, ...rest } = entry;
  return JSON.stringify(rest);
}

/**
 * Carry each human classification over from `previous` for a case whose observed fields did
 * not change; a changed or new case gets `classification: null`, so the gate stays red until a
 * person reads it again.
 */
export function carryClassifications(projection, previous) {
  const before = new Map((previous?.cases ?? []).map((entry) => [entry.id, entry]));
  const runsBefore = new Map((previous?.runs ?? []).map((run) => [run.id, JSON.stringify(run)]));
  const runsNow = new Map(projection.runs.map((run) => [run.id, JSON.stringify(run)]));
  for (const entry of projection.cases) {
    const old = before.get(entry.id);
    const runSame = runsBefore.get(entry.run) === runsNow.get(entry.run);
    if (old && runSame && observedPart(old) === observedPart(entry)) {
      entry.classification = old.classification ?? null;
      entry.evidence = typeof old.evidence === 'string' ? old.evidence : '';
    }
  }
  return projection;
}

/** Case ids whose observed fields, or whose run's fields, differ between two projections. */
export function driftedCases(projection, committed) {
  const drifted = new Set();
  const committedCases = new Map((committed?.cases ?? []).map((entry) => [entry.id, entry]));
  const committedRuns = new Map((committed?.runs ?? []).map((run) => [run.id, JSON.stringify(run)]));
  const header = (value) => JSON.stringify([value?.format, value?.schemaVersion, value?.pack, value?.rules]);
  const headerMoved = header(projection) !== header(committed);
  for (const entry of projection.cases) {
    const old = committedCases.get(entry.id);
    const runMoved = committedRuns.get(entry.run) !== JSON.stringify(projection.runs.find((run) => run.id === entry.run));
    if (headerMoved || !old || runMoved || observedPart(old) !== observedPart(entry)) drifted.add(entry.id);
  }
  for (const id of committedCases.keys()) if (!projection.cases.some((entry) => entry.id === id)) drifted.add(id);
  return [...drifted];
}

/** Whether a case's observations meet the one condition under which it may read `resolved`. */
export function meetsResolved(entry, runRecord) {
  return (
    runRecord.entry === 'resolved' &&
    entry.sites.every((site) => site.found) &&
    entry.assertions.every((assertion) => assertion.held) &&
    entry.unknowns.every((unknown) => unknown.marked && !unknown.asserted) &&
    !entry.falselyComplete
  );
}

/** Every case whose human classification contradicts its observations or the vocabulary. */
export function classificationProblems(projection, vocabulary) {
  const problems = [];
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  for (const entry of projection.cases) {
    if (!vocabulary.includes(entry.classification)) {
      problems.push(`${entry.id}: classification ${JSON.stringify(entry.classification)} is not in the vocabulary`);
      continue;
    }
    const meets = meetsResolved(entry, runs.get(entry.run));
    if (entry.classification === 'resolved' && !meets) problems.push(`${entry.id}: classified resolved but its observations show a gap`);
    if (entry.classification !== 'resolved' && meets) problems.push(`${entry.id}: observations meet resolved but it is classified ${entry.classification}`);
    if (entry.classification === 'unresolved-cause' && (typeof entry.evidence !== 'string' || entry.evidence.trim() === '')) {
      problems.push(`${entry.id}: unresolved-cause must name the evidence that would decide it`);
    }
    if (entry.classification !== 'unresolved-cause' && entry.evidence !== '') {
      problems.push(`${entry.id}: evidence is only written for unresolved-cause`);
    }
  }
  return problems;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? `${numerator}/${denominator} (n/a)` : `${numerator}/${denominator} (${(numerator / denominator).toFixed(2)})`;
}

/**
 * The human report: every case on its own line with its raw counts, then totals with every
 * ratio beside its numerator and denominator. It makes no accuracy claim; a total is only ever
 * read beside the cases it adds up.
 */
export function report(projection, { generation = 'unknown', tool = 'unknown' } = {}) {
  const lines = [];
  lines.push(`journey pack ${projection.pack}: ${projection.cases.length} cases, bundle ${generation}, ${tool}`);
  lines.push('');
  const width = Math.max(...projection.cases.map((entry) => entry.id.length));
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  for (const entry of projection.cases) {
    const c = entry.counts;
    lines.push(
      `${entry.id.padEnd(width)}  sites ${c.sitesResolved}/${c.sitesExpected}  outside ${c.outside}  entry ${runs.get(entry.run).entry}` +
        `  assertions ${c.assertionsHeld}/${c.assertionsAsserted}  unknowns ${c.unknownsMarked}/${c.unknownsExpected}` +
        `  falsely complete ${entry.falselyComplete ? 'yes' : 'no'}  ${entry.classification ?? '(unclassified)'}`,
    );
  }
  const sum = (field) => projection.cases.reduce((total, entry) => total + entry.counts[field], 0);
  lines.push('');
  lines.push(
    `totals over ${projection.cases.length} cases: sites ${ratio(sum('sitesResolved'), sum('sitesExpected'))}, ` +
      `assertions ${ratio(sum('assertionsHeld'), sum('assertionsAsserted'))}, ` +
      `unknowns marked ${ratio(sum('unknownsMarked'), sum('unknownsExpected'))}, ` +
      `entry unresolved ${ratio(sum('entryUnresolved'), projection.cases.length)}, ` +
      `falsely complete ${ratio(projection.cases.filter((entry) => entry.falselyComplete).length, projection.cases.length)}`,
  );
  for (const run of projection.runs) {
    lines.push(
      `run ${run.id}: exit ${run.exit}, entry ${run.entry}, budgetHit ${run.budgetHit}, ` +
        `unresolved markers ${run.unresolvedMarkers}, outside the expected set ${run.outside.length}`,
    );
  }
  lines.push('');
  lines.push('Results of different packs are reported separately and never pooled.');
  return `${lines.join('\n')}\n`;
}
