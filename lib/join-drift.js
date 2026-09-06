/**
 * Snapshot and comparison half of the join step.
 *
 * `join --snapshot <file>` writes the current fact sets, the configuration the join and the
 * walk read, and every repository identity the facts carry into one portable, versioned
 * file with no timestamp in it, so two runs over unchanged inputs write the same bytes.
 * `join --against <file>` derives the joined model twice — once from that file, once from
 * the current facts — with one implementation and the current configuration, and reports
 * where the two differ. Four families of finding, each with a semantic identity that
 * lines, files, enumeration order and spec names never enter:
 *
 * - `path`: a caller joined to a route (`calls`), a consumer or processor joined to a
 *   publisher (`consumes`, `enqueues`), a route present on one side only, a route whose
 *   template changed while its action survived, and a gateway call newly without a route.
 * - `seed`: one way through a route, identified by its non-nominal branch dispositions.
 * - `effect`: what a seed leaves behind — a database write, a publish, a push, an outbound
 *   call — keyed the way the walk keys outcomes; a read leaves nothing behind.
 * - `evidence`: the mechanical coverage level `cover` assigns a seed, compared as a level,
 *   so a renamed or moved spec that proves the same thing is not drift.
 *
 * Nothing here reads a repository, runs git, or takes the code-index hop: both sides are
 * facts, and the comparison is exactly as reproducible as the facts are. Both sides are
 * derived with the current configuration — a changed alias or sink pattern is reported as
 * a note, never manufactured into findings.
 */

import { createHash } from 'node:crypto';

import { cover } from './cover.js';
import { validateFacts } from './facts.js';
import { join, normalizeAliases } from './join.js';
import { routeKey } from './normalize.js';
import { NOMINAL_DISPOSITIONS, trace } from './trace.js';

export const SNAPSHOT_FORMAT = 'flowtrace-snapshot';
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DRIFT_FORMAT = 'flowtrace-drift';
export const DRIFT_SCHEMA_VERSION = 1;

/** Every finding kind, by family, in the order the report lists them. */
export const FINDING_FAMILIES = Object.freeze({
  path: Object.freeze(['route-added', 'route-removed', 'path-added', 'path-removed', 'path-reshaped', 'call-unserved']),
  seed: Object.freeze(['seed-added', 'seed-removed', 'seed-changed']),
  effect: Object.freeze(['effect-added', 'effect-removed']),
  evidence: Object.freeze(['evidence-gained', 'evidence-lost']),
});
export const FINDING_KINDS = Object.freeze(Object.values(FINDING_FAMILIES).flat());
const FAMILY_ORDER = Object.freeze(Object.keys(FINDING_FAMILIES));
const FAMILY_OF = new Map(
  Object.entries(FINDING_FAMILIES).flatMap(([family, kinds]) => kinds.map((kind) => [kind, family])),
);
const KIND_ORDER = new Map(FINDING_KINDS.map((kind, index) => [kind, index]));

/** A snapshot that cannot be read, is of another version, or fails its own digest. */
export class SnapshotError extends Error {}

function compare(a, b) {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedSets(factSets) {
  return [...(factSets || [])].sort((a, b) => compare(a.repo, b.repo));
}

// ---------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------

/**
 * The header fields that identify a fact set: which repository, which extractor, which
 * git state, what the title collector did. Never the extraction timestamp — two snapshots
 * of one unchanged state must be the same bytes.
 */
const IDENTITY_FIELDS = Object.freeze([
  'repo',
  'kind',
  'generatedFrom',
  'headSha',
  'dirty',
  'dirtyDigest',
  'fileCount',
  'titles',
]);

/** sha1 over the facts exactly as serialised; the snapshot's own integrity check. */
export function factsDigest(facts) {
  return createHash('sha1')
    .update(JSON.stringify(Array.isArray(facts) ? facts : []))
    .digest('hex');
}

/** The identity block of one fact set, plus the digest of its facts. */
export function factSetIdentity(set) {
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    if (set[field] !== undefined && set[field] !== null) identity[field] = set[field];
  }
  identity.digest = factsDigest(set.facts);
  return identity;
}

/**
 * The part of the configuration the join and the walk read: aliases in the normalised form
 * the join applies (so the documented trailing-slash spelling and the bare one compare
 * equal) and the sink patterns.
 */
export function comparisonConfig(config) {
  return {
    aliases: normalizeAliases(config?.aliases || []),
    sinks: config?.sinks ?? null,
  };
}

/**
 * Build the snapshot: fact sets in repository order, each with its identity and its
 * facts exactly as extracted, under a versioned envelope naming the tool that wrote it
 * and the configuration it was taken with.
 */
export function snapshotOf(factSets, { tool, config } = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    format: SNAPSHOT_FORMAT,
    tool: { name: tool?.name ?? 'flowtrace-cli', version: tool?.version ?? '0.0.0' },
    config: comparisonConfig(config),
    factSets: sortedSets(factSets).map((set) => ({
      ...factSetIdentity(set),
      facts: Array.isArray(set.facts) ? set.facts : [],
    })),
  };
}

/**
 * Read a parsed snapshot back, refusing anything that cannot be compared honestly: another
 * format or schema version, a fact set with no repository id or no facts array, a fact the
 * validator rejects, a duplicate repository, or facts that no longer match the digest they
 * were written with. A refusal throws `SnapshotError`; nothing partial is returned.
 */
export function readSnapshot(parsed, name = 'snapshot') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SnapshotError(`${name}: not a snapshot object`);
  }
  if (parsed.format !== SNAPSHOT_FORMAT) {
    throw new SnapshotError(
      `${name}: format ${JSON.stringify(parsed.format ?? null)} is not "${SNAPSHOT_FORMAT}"`,
    );
  }
  if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotError(
      `${name}: schemaVersion ${JSON.stringify(parsed.schemaVersion ?? null)} is not supported (this version reads ${SNAPSHOT_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(parsed.factSets) || parsed.factSets.length === 0) {
    throw new SnapshotError(`${name}: carries no fact sets`);
  }
  const seen = new Set();
  const factSets = parsed.factSets.map((set, index) => {
    if (!set || typeof set !== 'object' || typeof set.repo !== 'string' || set.repo === '') {
      throw new SnapshotError(`${name}: factSets[${index}] has no repository id`);
    }
    if (!Array.isArray(set.facts)) {
      throw new SnapshotError(`${name}: ${set.repo}: has no facts array`);
    }
    if (seen.has(set.repo)) throw new SnapshotError(`${name}: repository "${set.repo}" appears twice`);
    seen.add(set.repo);
    try {
      validateFacts(set.facts);
    } catch (error) {
      throw new SnapshotError(`${name}: ${set.repo}: ${error.message}`);
    }
    if (typeof set.digest !== 'string' || factsDigest(set.facts) !== set.digest) {
      throw new SnapshotError(`${name}: ${set.repo}: facts do not match their recorded digest`);
    }
    return { ...set };
  });
  return {
    tool: parsed.tool && typeof parsed.tool === 'object' ? parsed.tool : null,
    config: comparisonConfig(parsed.config),
    factSets,
  };
}

// ---------------------------------------------------------------------------------------
// Semantic identities
// ---------------------------------------------------------------------------------------

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The tokens that tell one way through a route apart from the nominal one: every decision
 * forced off its nominal side, named by the toggle it reads or by the condition text —
 * never by the line it sits on, so moving code leaves the identity alone.
 */
export function seedIdentity(seed) {
  const tokens = [];
  for (const entry of seed.dispositions || []) {
    if (NOMINAL_DISPOSITIONS[entry.kind] === entry.disposition) continue;
    const where = entry.toggle ? entry.toggle : normalizeText(entry.text);
    tokens.push(`${entry.kind}:${where}=${entry.disposition}`);
  }
  return tokens.sort().join(' · ') || 'happy path';
}

function isRead(outcome) {
  return outcome.kind === 'db' && outcome.access === 'read';
}

/** The walk's own outcome key: kind, repository, target, member. */
export function effectIdentity(outcome) {
  return `${outcome.kind}|${outcome.repo || ''}|${outcome.ref}|${outcome.method || ''}`;
}

/** The label `cover` prints for the same outcome. */
export function effectLabel(outcome) {
  if (outcome.kind === 'message') return `⇝ ${outcome.ref}`;
  if (outcome.kind === 'db') return `db ${outcome.ref}${outcome.method ? `.${outcome.method}` : ''}`;
  return `${outcome.kind} ${outcome.ref}`;
}

function at(item) {
  if (!item) return null;
  return { repo: item.repo ?? null, file: item.file ?? null, line: item.line ?? null };
}

// ---------------------------------------------------------------------------------------
// One side of the comparison: the joined boundary
// ---------------------------------------------------------------------------------------

function routeTable(factSets) {
  const routes = new Map();
  for (const set of sortedSets(factSets)) {
    for (const fact of set.facts || []) {
      if (fact.type !== 'route') continue;
      const key = routeKey(fact.verb, fact.template);
      // The first declaration of a key is the one the join's route index matches, too.
      if (routes.has(key)) continue;
      routes.set(key, {
        key,
        repo: set.repo,
        ref: `${fact.controller}.${fact.action}`,
        file: fact.file,
        line: fact.line,
      });
    }
  }
  return routes;
}

function callerTable(factSets, flow) {
  const served = new Map();
  for (const edge of flow.edges) {
    if (edge.kind === 'calls') served.set(`${edge.from.repo}|${edge.from.ref}|${edge.callerKey}`, edge.key);
  }
  const callers = [];
  for (const set of sortedSets(factSets)) {
    for (const fact of set.facts || []) {
      if (fact.type !== 'gateway_call') continue;
      const ref = `${fact.service}.${fact.method}`;
      const callerKey = routeKey(fact.verb, fact.template);
      const triple = `${set.repo}|${ref}|${callerKey}`;
      callers.push({
        id: `${set.repo}|${ref}`,
        triple,
        callerKey,
        from: { repo: set.repo, ref, file: fact.file, line: fact.line },
        route: served.get(triple) ?? null,
      });
    }
  }
  return callers;
}

function pathId(edge) {
  if (edge.kind === 'calls') return `calls|${edge.from.repo}|${edge.from.ref}|${edge.key}`;
  if ((edge.kind === 'consumes' || edge.kind === 'enqueues') && edge.match) {
    return `${edge.kind}|${edge.to.repo}|${edge.to.ref}|${edge.key}`;
  }
  return null;
}

function pathTable(flow) {
  const paths = new Map();
  for (const edge of flow.edges) {
    const id = pathId(edge);
    if (id && !paths.has(id)) paths.set(id, edge);
  }
  return paths;
}

function consumerTable(factSets) {
  const consumers = new Set();
  for (const set of factSets || []) {
    for (const fact of set.facts || []) {
      if (fact.type === 'consume') consumers.add(`${set.repo}|${fact.consumer}`);
      else if (fact.type === 'worker_processor') consumers.add(`${set.repo}|${fact.processor}`);
    }
  }
  return consumers;
}

function boundaryModel(factSets, aliases) {
  const flow = join(factSets, { aliases });
  const callers = callerTable(factSets, flow);
  const callersById = new Map();
  for (const caller of callers) {
    const list = callersById.get(caller.id) || [];
    list.push(caller);
    callersById.set(caller.id, list);
  }
  return {
    routes: routeTable(factSets),
    paths: pathTable(flow),
    callers,
    callersById,
    consumers: consumerTable(factSets),
  };
}

/** What became of a caller the snapshot joined to a route, given the current side. */
function callerStatusAfter(side, from, followedKey) {
  const now = side.callersById.get(`${from.repo}|${from.ref}`) || [];
  if (now.length === 0) return 'removed';
  if (followedKey && now.some((caller) => caller.route === followedKey)) return 'followed';
  if (now.some((caller) => caller.route)) return 'retargeted';
  return 'unserved';
}

/** Where a caller the current side joins to a route stood in the snapshot. */
function callerStatusBefore(side, from) {
  const then = side.callersById.get(`${from.repo}|${from.ref}`) || [];
  if (then.length === 0) return 'added';
  if (then.some((caller) => caller.route)) return 'retargeted';
  return 'previously-unserved';
}

function consumerStatusAfter(side, to) {
  return side.consumers.has(`${to.repo}|${to.ref}`) ? 'no-publisher' : 'removed';
}

function consumerStatusBefore(side, to) {
  return side.consumers.has(`${to.repo}|${to.ref}`) ? 'previously-no-publisher' : 'added';
}

function callsTo(side, key) {
  return [...side.paths.values()].filter((edge) => edge.kind === 'calls' && edge.key === key);
}

function groupByAction(side, keys) {
  const groups = new Map();
  for (const key of keys) {
    const route = side.routes.get(key);
    const id = `${route.repo}|${route.ref}`;
    const list = groups.get(id) || [];
    list.push(key);
    groups.set(id, list);
  }
  return groups;
}

/**
 * Path findings. A route on one side only is one finding carrying its callers; a route
 * whose key changed while its action survived — and that pairing is unique on both
 * sides — is one reshape carrying its callers; everything a route-level finding names is
 * never repeated as a path or unserved-call finding of its own.
 */
function comparePaths(before, after, findings, pairs) {
  const beforeOnly = [...before.routes.keys()].filter((key) => !after.routes.has(key)).sort(compare);
  const afterOnly = [...after.routes.keys()].filter((key) => !before.routes.has(key)).sort(compare);
  const beforeGroups = groupByAction(before, beforeOnly);
  const afterGroups = groupByAction(after, afterOnly);
  const reshaped = new Map();
  for (const [action, oldKeys] of beforeGroups) {
    const newKeys = afterGroups.get(action);
    if (oldKeys.length === 1 && newKeys && newKeys.length === 1) reshaped.set(oldKeys[0], newKeys[0]);
  }
  const reshapedAfter = new Set(reshaped.values());
  const explainedPaths = new Set();
  const explainedCallers = new Set();

  for (const key of beforeOnly) {
    const route = before.routes.get(key);
    const oldPaths = callsTo(before, key);
    if (reshaped.has(key)) {
      const newKey = reshaped.get(key);
      const callers = oldPaths.map((edge) => ({
        from: edge.from,
        status: callerStatusAfter(after, edge.from, newKey),
      }));
      findings.push({
        kind: 'path-reshaped',
        route: newKey,
        routeBefore: key,
        routeAt: at(after.routes.get(newKey)),
        routeAtBefore: at(route),
        callers,
      });
      pairs.push({ before: key, after: newKey });
      for (const [index, edge] of oldPaths.entries()) {
        explainedPaths.add(pathId(edge));
        explainedCallers.add(`${edge.from.repo}|${edge.from.ref}`);
        if (callers[index].status === 'followed') {
          explainedPaths.add(`calls|${edge.from.repo}|${edge.from.ref}|${newKey}`);
        }
      }
      continue;
    }
    const callers = oldPaths.map((edge) => ({ from: edge.from, status: callerStatusAfter(after, edge.from, null) }));
    findings.push({ kind: 'route-removed', route: key, routeAt: at(route), callers });
    for (const edge of oldPaths) {
      explainedPaths.add(pathId(edge));
      explainedCallers.add(`${edge.from.repo}|${edge.from.ref}`);
    }
  }

  for (const key of afterOnly) {
    if (reshapedAfter.has(key)) continue;
    const route = after.routes.get(key);
    const newPaths = callsTo(after, key);
    const callers = newPaths.map((edge) => ({ from: edge.from, status: callerStatusBefore(before, edge.from) }));
    findings.push({ kind: 'route-added', route: key, routeAt: at(route), callers });
    for (const edge of newPaths) explainedPaths.add(pathId(edge));
  }

  for (const [id, edge] of before.paths) {
    if (after.paths.has(id) || explainedPaths.has(id)) continue;
    const finding = { kind: 'path-removed', route: edge.key, edge: edge.kind, from: edge.from, to: edge.to };
    if (edge.kind === 'calls') {
      finding.routeAt = at(before.routes.get(edge.key));
      finding.caller = callerStatusAfter(after, edge.from, null);
      explainedCallers.add(`${edge.from.repo}|${edge.from.ref}`);
    } else {
      finding.consumer = consumerStatusAfter(after, edge.to);
    }
    findings.push(finding);
  }

  for (const [id, edge] of after.paths) {
    if (before.paths.has(id) || explainedPaths.has(id)) continue;
    const finding = { kind: 'path-added', route: edge.key, edge: edge.kind, from: edge.from, to: edge.to };
    if (edge.kind === 'calls') {
      finding.routeAt = at(after.routes.get(edge.key));
      finding.caller = callerStatusBefore(before, edge.from);
    } else {
      finding.consumer = consumerStatusBefore(before, edge.to);
    }
    findings.push(finding);
  }

  const unservedBefore = new Set(before.callers.filter((caller) => !caller.route).map((caller) => caller.triple));
  for (const caller of after.callers) {
    if (caller.route) continue;
    if (unservedBefore.has(caller.triple)) continue;
    if (explainedCallers.has(caller.id)) continue;
    findings.push({ kind: 'call-unserved', route: null, callerKey: caller.callerKey, from: caller.from });
  }

  return reshaped.size;
}

// ---------------------------------------------------------------------------------------
// One side of the comparison: seeds, effects and evidence per route
// ---------------------------------------------------------------------------------------

function decidingLocation(seed, root) {
  const forced = (seed.dispositions || []).find(
    (entry) => NOMINAL_DISPOSITIONS[entry.kind] !== entry.disposition,
  );
  const source = forced || root;
  return source ? { repo: root?.repo ?? null, file: source.file ?? null, line: source.line ?? null } : null;
}

function effectTable(outcomes) {
  const effects = new Map();
  for (const outcome of outcomes || []) {
    if (isRead(outcome)) continue;
    const id = effectIdentity(outcome);
    if (!effects.has(id)) effects.set(id, { label: effectLabel(outcome), at: at(outcome) });
  }
  return effects;
}

/**
 * Walk every route key once, through `cover` so the evidence level is exactly the one
 * `cover` reports, while keeping the raw walk so each seed's semantic identity can be
 * built from its dispositions rather than from `cover`'s line-free summary label.
 */
function behaviourModel(factSets, keys, options) {
  const walked = new Map();
  const walker = typeof options.trace === 'function' ? options.trace : trace;
  const caching = (sets, start, walkOptions) => {
    const result = walker(sets, start, walkOptions);
    if (walkOptions && walkOptions.seeds === true) walked.set(start, result);
    return result;
  };
  const report = cover(factSets, {
    keys,
    aliases: options.aliases,
    traceOptions: { sinks: options.sinks },
    trace: caching,
    area: 'against',
  });
  const routes = new Map();
  for (const record of report.routes) {
    const raw = walked.get(record.key) || {};
    const seeds = new Map();
    const seen = new Map();
    const always = new Map();
    for (const [index, seed] of (raw.seeds || []).entries()) {
      const base = seedIdentity(seed);
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      const identity = count > 1 ? `${base} #${count}` : base;
      const summary = record.seeds[index] || {};
      seeds.set(identity, {
        identity,
        label: summary.dispositions || 'happy path',
        id: seed.id,
        key: seed.key ?? null,
        response: seed.response || null,
        level: summary.level || record.state,
        effects: effectTable(seed.outcomes),
        at: decidingLocation(seed, raw.root),
      });
      for (const [id, effect] of effectTable(seed.always)) {
        if (!always.has(id)) always.set(id, effect);
      }
    }
    routes.set(record.key, {
      seeds,
      always,
      truncated: (raw.seedsTruncated || 0) > 0,
      error: raw.error || (raw.candidates ? 'the route key resolves to more than one start' : null),
    });
  }
  return routes;
}

function seedSummary(seed) {
  return { identity: seed.identity, label: seed.label };
}

function seedSide(seed) {
  return {
    id: seed.id,
    key: seed.key,
    response: seed.response,
    effects: [...seed.effects.values()].map((effect) => effect.label),
    at: seed.at,
  };
}

function compareBehaviour(before, after, pairs, findings, skipped) {
  for (const pair of pairs) {
    const left = before.get(pair.before);
    const right = after.get(pair.after);
    if (!left || !right) continue;
    const base = { route: pair.after, ...(pair.before !== pair.after ? { routeBefore: pair.before } : {}) };
    if (left.error || right.error) {
      skipped.push({ ...base, reason: left.error || right.error });
      continue;
    }
    if (left.truncated || right.truncated) {
      skipped.push({ ...base, reason: 'the seed list is truncated on at least one side' });
      continue;
    }
    for (const [identity, seed] of left.seeds) {
      if (right.seeds.has(identity)) continue;
      findings.push({ kind: 'seed-removed', ...base, seed: seedSummary(seed), before: seedSide(seed) });
    }
    for (const [identity, seed] of right.seeds) {
      if (left.seeds.has(identity)) continue;
      findings.push({ kind: 'seed-added', ...base, seed: seedSummary(seed), after: seedSide(seed) });
    }
    for (const [identity, was] of left.seeds) {
      const now = right.seeds.get(identity);
      if (!now) continue;
      const seed = seedSummary(now);
      if (was.response !== now.response) {
        findings.push({
          kind: 'seed-changed',
          ...base,
          seed,
          before: { response: was.response, at: was.at },
          after: { response: now.response, at: now.at },
        });
      }
      for (const [id, effect] of was.effects) {
        if (now.effects.has(id)) continue;
        findings.push({ kind: 'effect-removed', ...base, seed, effect: effect.label, at: effect.at });
      }
      for (const [id, effect] of now.effects) {
        if (was.effects.has(id)) continue;
        findings.push({ kind: 'effect-added', ...base, seed, effect: effect.label, at: effect.at });
      }
      if (was.level !== now.level) {
        const gained = LEVEL_RANK[now.level] > LEVEL_RANK[was.level];
        findings.push({
          kind: gained ? 'evidence-gained' : 'evidence-lost',
          ...base,
          seed,
          before: { level: was.level },
          after: { level: now.level },
        });
      }
    }
    for (const [id, effect] of left.always) {
      if (right.always.has(id)) continue;
      findings.push({ kind: 'effect-removed', ...base, seed: null, effect: effect.label, at: effect.at });
    }
    for (const [id, effect] of right.always) {
      if (left.always.has(id)) continue;
      findings.push({ kind: 'effect-added', ...base, seed: null, effect: effect.label, at: effect.at });
    }
  }
}

const LEVEL_RANK = Object.freeze({ none: 0, skipped: 1, route: 2, path: 3, disposition: 4 });

// ---------------------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------------------

function sortKeyOf(finding) {
  return JSON.stringify([
    finding.from?.repo,
    finding.from?.ref,
    finding.to?.repo,
    finding.to?.ref,
    finding.seed?.identity,
    finding.effect,
    finding.callerKey,
  ]);
}

function findingOrder(a, b) {
  return (
    compare(a.route ?? '￿', b.route ?? '￿') ||
    compare(a.routeBefore, b.routeBefore) ||
    FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
    KIND_ORDER.get(a.kind) - KIND_ORDER.get(b.kind) ||
    compare(sortKeyOf(a), sortKeyOf(b))
  );
}

function withFamily(finding) {
  const { kind, ...rest } = finding;
  return { kind, family: FAMILY_OF.get(kind), ...rest };
}

/**
 * Compare a read snapshot with the current fact sets. `current` is `{ tool, factSets }`;
 * `options` carries the current configuration's `aliases` and `sinks` (both sides are
 * derived with them) and, in tests, a replacement `trace`.
 */
export function driftOf(snapshot, current, options = {}) {
  const aliases = options.aliases || [];
  const sinks = options.sinks;
  const before = boundaryModel(snapshot.factSets, aliases);
  const after = boundaryModel(current.factSets, aliases);
  const findings = [];
  const pairs = [];
  const skipped = [];
  const reshaped = comparePaths(before, after, findings, pairs);
  for (const key of before.routes.keys()) {
    if (after.routes.has(key)) pairs.push({ before: key, after: key });
  }
  pairs.sort((a, b) => compare(a.after, b.after) || compare(a.before, b.before));
  const walkOptions = { aliases, sinks, trace: options.trace };
  const beforeBehaviour = behaviourModel(snapshot.factSets, pairs.map((pair) => pair.before), walkOptions);
  const afterBehaviour = behaviourModel(current.factSets, pairs.map((pair) => pair.after), walkOptions);
  compareBehaviour(beforeBehaviour, afterBehaviour, pairs, findings, skipped);

  const ordered = findings.map(withFamily).sort(findingOrder);
  const counts = { total: ordered.length };
  for (const family of FAMILY_ORDER) counts[family] = 0;
  for (const finding of ordered) counts[finding.family] += 1;

  const snapshotConfig = comparisonConfig(snapshot.config);
  const currentConfig = comparisonConfig({ aliases, sinks });
  const configurationDiffers = JSON.stringify(snapshotConfig) !== JSON.stringify(currentConfig);
  const notes = [
    'both sides are derived with the current configuration; a changed alias or sink pattern is reported here, never as a finding',
    'identities are semantic: a moved line, a renamed spec or a reordered declaration is not drift',
  ];
  if (configurationDiffers) {
    const differing = ['aliases', 'sinks'].filter(
      (field) => JSON.stringify(snapshotConfig[field]) !== JSON.stringify(currentConfig[field]),
    );
    notes.push(`the configuration differs from the snapshot's (${differing.join(', ')})`);
  }

  return {
    schemaVersion: DRIFT_SCHEMA_VERSION,
    format: DRIFT_FORMAT,
    snapshot: {
      tool: snapshot.tool ?? null,
      config: snapshotConfig,
      factSets: sortedSets(snapshot.factSets).map(factSetIdentity),
    },
    current: {
      tool: current.tool ?? null,
      config: currentConfig,
      factSets: sortedSets(current.factSets).map(factSetIdentity),
    },
    configurationDiffers,
    routes: {
      snapshot: before.routes.size,
      current: after.routes.size,
      compared: pairs.length,
      reshaped,
    },
    skipped: skipped.sort((a, b) => compare(a.route, b.route)),
    findings: ordered,
    counts,
    notes,
  };
}

/**
 * The finding kinds `--fail-on` selects: `any`, a family name, or a kind, comma-separated
 * and repeatable. Anything else is a usage error naming what is accepted.
 */
export function parseFailOn(values) {
  const kinds = new Set();
  for (const raw of values || []) {
    for (const token of String(raw).split(',')) {
      const value = token.trim();
      if (!value) continue;
      if (value === 'any') {
        for (const kind of FINDING_KINDS) kinds.add(kind);
      } else if (Object.hasOwn(FINDING_FAMILIES, value)) {
        for (const kind of FINDING_FAMILIES[value]) kinds.add(kind);
      } else if (KIND_ORDER.has(value)) {
        kinds.add(value);
      } else {
        throw new Error(
          `--fail-on: unknown finding "${value}" (accepted: any, ${FAMILY_ORDER.join(', ')}, ${FINDING_KINDS.join(', ')})`,
        );
      }
    }
  }
  return kinds;
}

export function failingFindings(report, kinds) {
  return (report.findings || []).filter((finding) => kinds.has(finding.kind));
}

// ---------------------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------------------

function place(item) {
  if (!item) return '';
  const head = [item.repo, item.file].filter(Boolean).join(':');
  return item.file && item.line !== null && item.line !== undefined ? `${head}:${item.line}` : head;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const CALLER_PHRASES = Object.freeze({
  removed: 'caller removed',
  unserved: 'caller survives, now unserved',
  followed: 'caller follows the new template',
  retargeted: 'caller now joins another route',
  added: 'caller added',
  'previously-unserved': 'caller previously unserved',
});
const CONSUMER_PHRASES = Object.freeze({
  removed: 'consumer removed',
  'no-publisher': 'consumer survives, no publisher',
  added: 'consumer added',
  'previously-no-publisher': 'consumer previously had no publisher',
});

function callerPhrase(status) {
  return CALLER_PHRASES[status] || status;
}

function outcomeText(side) {
  if (!side) return '';
  if (side.response) return ` → ${side.response}`;
  return side.effects && side.effects.length > 0 ? ` → ${side.effects.join(', ')}` : '';
}

function seedTag(side) {
  if (!side) return '';
  return ` [${side.id}${side.key ? ` #${side.key}` : ''}]`;
}

function findingLines(finding) {
  const lines = [];
  switch (finding.kind) {
    case 'route-removed':
    case 'route-added': {
      lines.push(`  route ${finding.kind === 'route-added' ? 'added' : 'removed'} — ${place(finding.routeAt)}`);
      for (const caller of finding.callers) {
        lines.push(`    caller ${caller.from.repo} ${caller.from.ref} — ${place(caller.from)} (${callerPhrase(caller.status)})`);
      }
      break;
    }
    case 'path-reshaped': {
      lines.push(`  path reshaped: ${finding.routeBefore} → ${finding.route} — ${place(finding.routeAt)}`);
      for (const caller of finding.callers) {
        lines.push(`    caller ${caller.from.repo} ${caller.from.ref} — ${place(caller.from)} (${callerPhrase(caller.status)})`);
      }
      break;
    }
    case 'path-added':
    case 'path-removed': {
      const verb = finding.kind === 'path-added' ? 'added' : 'removed';
      if (finding.edge === 'calls') {
        lines.push(`  path ${verb}: calls from ${finding.from.repo} ${finding.from.ref} — ${place(finding.from)} (${callerPhrase(finding.caller)})`);
      } else {
        lines.push(`  path ${verb}: ${finding.edge} ${finding.to.repo} ${finding.to.ref} — ${place(finding.to)} (${CONSUMER_PHRASES[finding.consumer] || finding.consumer})`);
      }
      break;
    }
    case 'seed-added':
      lines.push(`  seed added: ${finding.seed.label}${outcomeText(finding.after)}${seedTag(finding.after)} — ${place(finding.after.at)}`);
      break;
    case 'seed-removed':
      lines.push(`  seed removed: ${finding.seed.label}${outcomeText(finding.before)}${seedTag(finding.before)} — ${place(finding.before.at)}`);
      break;
    case 'seed-changed':
      lines.push(`  seed changed: ${finding.seed.label}: ${finding.before.response ?? 'effects only'} → ${finding.after.response ?? 'effects only'} — ${place(finding.after.at)}`);
      break;
    case 'effect-added':
    case 'effect-removed': {
      const on = finding.seed ? `on ${finding.seed.label}` : 'on every seed (shared infrastructure)';
      lines.push(`  effect ${finding.kind === 'effect-added' ? 'added' : 'removed'}: ${finding.effect} ${on} — ${place(finding.at)}`);
      break;
    }
    case 'evidence-gained':
    case 'evidence-lost':
      lines.push(`  evidence ${finding.kind === 'evidence-gained' ? 'gained' : 'lost'}: ${finding.seed.label}: ${finding.before.level} → ${finding.after.level}`);
      break;
    default:
      lines.push(`  ${finding.kind}`);
  }
  return lines;
}

/** Human rendering of the same model `--json` emits. */
export function renderDrift(report, { snapshotName = 'snapshot' } = {}) {
  const lines = [];
  const names = (side) => side.factSets.map((set) => set.repo).join(', ');
  const tool = report.snapshot.tool;
  lines.push(
    `against ${snapshotName}: snapshot ${plural(report.snapshot.factSets.length, 'fact set')} (${names(report.snapshot)})` +
      ` · current ${plural(report.current.factSets.length, 'fact set')} (${names(report.current)})` +
      (tool && tool.name ? ` · written by ${tool.name} ${tool.version ?? ''}`.trimEnd() : ''),
  );
  const routes = report.routes;
  lines.push(
    `routes: ${routes.compared} compared (${routes.snapshot} in the snapshot, ${routes.current} current${routes.reshaped ? `, ${routes.reshaped} reshaped` : ''})`,
  );
  if (report.configurationDiffers) {
    lines.push(`note: ${report.notes[report.notes.length - 1]}; both sides were derived with the current configuration`);
  }

  const groups = [];
  const unserved = [];
  for (const finding of report.findings) {
    if (finding.kind === 'call-unserved') {
      unserved.push(finding);
      continue;
    }
    const label = finding.routeBefore ? `${finding.routeBefore} → ${finding.route}` : finding.route;
    let group = groups.length > 0 ? groups[groups.length - 1] : null;
    if (!group || group.label !== label) {
      group = { label, at: finding.routeAt || null, findings: [] };
      groups.push(group);
    }
    if (!group.at && finding.routeAt) group.at = finding.routeAt;
    group.findings.push(finding);
  }
  for (const group of groups) {
    lines.push('', group.at ? `${group.label} — ${place(group.at)}` : group.label);
    for (const finding of group.findings) lines.push(...findingLines(finding));
  }
  if (unserved.length > 0) {
    lines.push('', 'calls without a serving route');
    for (const finding of unserved) {
      lines.push(`  ${finding.from.repo} ${finding.from.ref} ${finding.callerKey} — ${place(finding.from)}`);
    }
  }
  for (const entry of report.skipped) {
    lines.push('', `skipped ${entry.routeBefore ? `${entry.routeBefore} → ${entry.route}` : entry.route}: ${entry.reason}`);
  }
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('no drift: joined paths, seeds, effects and evidence levels match the snapshot');
  } else {
    const parts = FAMILY_ORDER.map((family) => `${family} ${report.counts[family]}`).join(' · ');
    lines.push(`drift: ${plural(report.findings.length, 'finding')} (${parts})`);
  }
  return lines.join('\n');
}
