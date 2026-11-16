/**
 * Cover step — seed-level coverage of one feature area, from committed evidence only.
 *
 * The denominator is the seed list `trace --seeds` already produces for every route key
 * in an area file: one root-to-sink path with one disposition per branch point on it.
 * The numerator is `cypress_intercept` facts matched to those route keys by the same
 * rules the join step uses (`exact` · `prefix` · `alias` · `suffix`).
 *
 * Only the mechanical half of the coverage design is computed here. Level `route` is
 * decided from a request literal in a spec, and splits into `route` (at least one
 * executing test) and `skipped` (evidence exists, every test carrying it is skipped).
 * Levels `path` and `disposition` need a reader to say whether an assertion is
 * diagnostic of a sink or of one branch outcome, so they are reported as
 * `needs-reader` with their candidate tests attached and are never guessed.
 *
 * Evidence is per route, not per seed: an intercept proves a request reached the route
 * and says nothing about which way through it the request went. Every seed of a route
 * therefore carries that route's evidence, and every renderer states this.
 *
 * An area key naming a `worker_processor` fact instead of an HTTP route produces a
 * seed the same way: walked, ranked and gap-listed alongside the routes, tagged
 * `owner: "worker_processor"` so a reader — and `scaffold` — knows this one
 * publishes a message rather than sends a request. It has no path a `cypress_intercept`
 * could ever match, so its state stays `none` by construction rather than being guessed.
 */

import { emailReport, testKey } from './emails.js';
import { matchPagePath, normalizeAliases, pwTestNotRunning, pwTestStates, readTestEvidence } from './join.js';
import {
  RUNTIME_VERDICT_SOURCE,
  buildRuntimeIndex,
  runtimeEvidenceLabel,
  runtimeProofSpans,
  runtimeSummary,
  seedRuntimeVerdict,
} from './runtime-cover.js';
import { seedConditions, trace } from './trace.js';

/** Rank of the heaviest effect a seed reaches. A tier of the sort key, never a summand. */
export const SINK_WEIGHTS = Object.freeze({ db: 3, message: 2, push: 1, http_out: 1 });

/**
 * A database read leaves nothing behind, so it ranks below a publish rather than above
 * it — otherwise a read-only `GET` outranks a route that puts a message on the bus. A
 * `db` outcome with no `access` is ranked as a write: over-ranking costs a test case,
 * under-ranking hides a data write.
 */
export const READ_WEIGHT = 0;

function outcomeWeight(outcome) {
  if (outcome.kind === 'db' && outcome.access === 'read') return READ_WEIGHT;
  return SINK_WEIGHTS[outcome.kind];
}

function isRead(outcome) {
  return outcome.kind === 'db' && outcome.access === 'read';
}

/** Rank of the heaviest branch outcome a seed forces away from the happy path. */
export const BRANCH_WEIGHTS = Object.freeze({ error_return: 3, validation: 3, toggle: 2, guard: 1 });

/** The disposition a request meets when nothing goes wrong and nothing is switched on. */
export const HAPPY_DISPOSITIONS = Object.freeze({
  error_return: 'not-taken',
  guard: 'clear',
  validation: 'valid',
  toggle: 'off',
  reject: 'not-taken',
});

/**
 * A reject decision ranks with an error return: both end the request with a status a caller
 * can ask for. Kept out of `BRANCH_WEIGHTS`, which `cover --json` prints, so a report with no
 * reject decision prints the table it always has.
 */
function weightOf(kind) {
  return kind === 'reject' ? BRANCH_WEIGHTS.error_return : BRANCH_WEIGHTS[kind];
}

/**
 * Coverage levels, ordered least to most covered. `route` and below are decided
 * mechanically; `path` and `disposition` are reached only through a reader verdict
 * (see `lib/packets.js`) that upgrades one seed at a time — never downgraded, never
 * guessed.
 */
export const STATE_ORDER = Object.freeze({ none: 0, skipped: 1, route: 2, path: 3, disposition: 4 });

export const STATE_GLYPHS = Object.freeze({
  disposition: '◈',
  path: '◆',
  route: '■',
  skipped: '◪',
  none: '□',
});

/** Levels the design defines but no mechanical rule can decide. */
export const READER_LEVELS = Object.freeze(['path', 'disposition']);

/**
 * The one-sentence evidence rule per reader level. Shared between the route record's
 * `levels.*.promotedBy` and the packet's `rules` field so the two never drift apart.
 */
export const LEVEL_RULES = Object.freeze({
  path: 'an assertion on a response field only produced on that path, a follow-up read that observes the effect, or an assertion on a push effect',
  disposition: 'an asserted status or body that maps to exactly one error_return, validation or guard, or a toggle set and read with the toggled assertion',
});

const EVIDENCE_CAP = 5;
const READ_ONLY_WEIGHT = 0;

/**
 * Response codes a `pw_assert` of kind `status` can mechanically promote a seed against.
 * These are terminal dispositions — a route stops here and does nothing else — so a
 * status assertion pinned to one of them is diagnostic of exactly the branch that
 * produced it, the same judgement a reader would otherwise have to make.
 */
export const PLAYWRIGHT_TERMINAL_CODES = Object.freeze([400, 401, 403, 404, 410]);
const TERMINAL_CODE_SET = new Set(PLAYWRIGHT_TERMINAL_CODES);

/** Above this many seeds on one route the design stops trusting the enumeration. */
const CROWDED_SEEDS = 24;

/** Route keys from an area file: one per line, blank lines and `#` comments dropped. */
export function readAreaKeys(text) {
  const keys = [];
  const seen = new Set();
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    keys.push(line);
  }
  return keys;
}

function collect(factSets, type) {
  const out = [];
  for (const set of factSets) {
    for (const fact of set.facts || []) {
      if (fact.type === type) out.push({ repo: set.repo, fact });
    }
  }
  return out;
}

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Every name a `worker_processor` fact answers to — its own class name and its work
 * type, the same two names `scaffold`'s own processor index resolves a start against.
 * An area key matching one of these is a message-driven seed, not an HTTP route: it
 * carries no path a `cypress_intercept`/`pw_request` could ever match, so its own state
 * stays `none`; this tool does not yet read the other harness's evidence.
 * That is the honest denominator entry the scaffold half already writes into — this is
 * what lets it appear in an area's gap list instead of only being named as a start.
 */
export function processorOwners(factSets) {
  const names = new Set();
  for (const set of factSets || []) {
    for (const item of set.facts || []) {
      if (item.type !== 'worker_processor') continue;
      if (item.processor) names.add(item.processor);
      if (item.workType) names.add(item.workType);
    }
  }
  return names;
}

function seedOrdinal(id) {
  const digits = /^U(\d+)$/.exec(String(id || ''));
  return digits ? Number(digits[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Group the entries of `readTestEvidence` by the route they name, with the per-spec counts
 * the spec table prints. A pattern with no path proves nothing about which route ran, so it
 * is counted as `noPath` and never used as evidence; a `pw_stub` of `kind: "opaque"` is
 * counted and never joined to any route. A `pw_request` whose first path segment is an
 * interpolation the extractor could not fold is counted as `unresolvedBase` and gives no
 * evidence. A glob pattern with two candidate routes of equal rank is counted as `ambiguous`,
 * beside `unmatched`, and names neither. Every evidence entry carries its `source`
 * (`cypress` · `playwright-api` · `playwright-stub`) so the parity summary can tell Cypress
 * evidence from Playwright UI-stub evidence, without conflating either with the unrelated
 * backend-API Playwright harness.
 */
export function buildEvidenceIndex(factSets, options = {}) {
  const aliases = normalizeAliases(options.aliases || []);
  const { routeIndex, entries } = readTestEvidence(factSets, { aliases });
  const byRoute = new Map();
  const specs = new Map();
  let noPath = 0;
  let unmatched = 0;
  let unresolvedBase = 0;
  let ambiguous = 0;
  let opaqueStubs = 0;
  const pwRequestMatches = [];

  const spec = (name) => {
    if (!specs.has(name)) {
      specs.set(name, { spec: name, tests: 0, skipped: 0, intercepts: 0, routes: new Set() });
    }
    return specs.get(name);
  };

  for (const type of ['cypress_test', 'pw_test']) {
    for (const { fact } of collect(factSets, type)) {
      const record = spec(fact.spec);
      record.tests += 1;
      if (type === 'pw_test' ? pwTestNotRunning(fact) : fact.skipped === true) record.skipped += 1;
    }
  }

  for (const entry of entries) {
    const record = spec(entry.fact.spec);
    if (entry.status === 'opaque') {
      opaqueStubs += 1;
      continue;
    }
    record.intercepts += 1;
    if (entry.status === 'no-path') {
      noPath += 1;
      continue;
    }
    if (entry.status === 'unmatched') {
      unmatched += 1;
      continue;
    }
    if (entry.status === 'unresolved-base') {
      unresolvedBase += 1;
      continue;
    }
    if (entry.status === 'ambiguous') {
      ambiguous += 1;
      continue;
    }
    const key = entry.result.route.key;
    record.routes.add(key);
    const list = byRoute.get(key) || [];
    list.push(entry.evidence);
    byRoute.set(key, list);
    if (entry.type === 'pw_request') {
      pwRequestMatches.push({ routeKey: key, spec: entry.fact.spec, test: entry.fact.test, skipped: entry.skipped });
    }
  }

  const routesByTest = annotateRealism(factSets, entries);

  for (const list of byRoute.values()) {
    list.sort(
      (a, b) =>
        Number(a.skipped) - Number(b.skipped) ||
        compare(a.spec, b.spec) ||
        compare(a.test, b.test) ||
        a.line - b.line,
    );
  }
  return { byRoute, specs, noPath, unmatched, unresolvedBase, ambiguous, routeIndex, pwRequestMatches, opaqueStubs, routesByTest };
}

const REACHES = ['stubbed', 'backend', 'blocked', 'unknown'];
const PAGE_REACH_CLASSES = ['real', 'patched', 'mocked', 'unknown', 'none'];


/** The backend class of each test that has a class fact, by `testKey`. */
function testClasses(factSets) {
  const classes = new Map();
  for (const type of ['pw_backend', 'cypress_backend']) {
    for (const { repo, fact } of collect(factSets, type)) classes.set(testKey(repo, fact.spec, fact.line), fact.backend);
  }
  return classes;
}
const HANDLER_REACH = { fulfill: 'stubbed', 'fetch-fulfill': 'backend', abort: 'blocked', unresolved: 'unknown' };
// A spy beside a stub of the same route in the same test sees what that stub answers.
const ANSWER_STRENGTH = { 'fetch-fulfill': 2, fulfill: 1 };

function classReach(backend) {
  if (backend === 'real' || backend === 'patched') return 'backend';
  if (backend === 'mocked') return 'stubbed';
  return 'unknown';
}

/**
 * Gives each matched evidence entry the class of its test (`backend`, or `none` without a
 * class fact), the `handler` of its source, and the `reach` those give. A class fact and an
 * entry name the same test by repository, spec and the declaration line of the test, so two
 * tests with one title keep their own classes. Returns the route keys each test holds named
 * evidence on, by `testKey`.
 */
function annotateRealism(factSets, entries) {
  const classes = testClasses(factSets);
  const matched = entries.filter((entry) => entry.status === 'matched');
  const routesByTest = new Map();
  const answers = new Map();
  for (const entry of matched) {
    const { testLine, handler } = entry.fact;
    entry.owner = typeof testLine === 'number' ? testKey(entry.repo, entry.fact.spec, testLine) : null;
    if (entry.owner) {
      if (!routesByTest.has(entry.owner)) routesByTest.set(entry.owner, new Set());
      routesByTest.get(entry.owner).add(entry.result.route.key);
    }
    if (!entry.owner || !ANSWER_STRENGTH[handler]) continue;
    const at = `${entry.result.route.key}\u0000${entry.owner}`;
    const best = answers.get(at);
    if (!best || ANSWER_STRENGTH[handler] > ANSWER_STRENGTH[best]) answers.set(at, handler);
  }
  for (const entry of matched) {
    const { testLine, handler } = entry.fact;
    const backend = entry.owner ? classes.get(entry.owner) ?? 'none' : 'none';
    let reach;
    if (entry.type === 'pw_request') reach = classReach(backend);
    else if (HANDLER_REACH[handler]) reach = HANDLER_REACH[handler];
    else if (handler === 'spy') {
      const answer = entry.owner ? answers.get(`${entry.result.route.key}\u0000${entry.owner}`) : undefined;
      reach = answer ? HANDLER_REACH[answer] : classReach(backend);
    } else reach = 'unknown';
    Object.assign(entry.evidence, {
      testLine: typeof testLine === 'number' ? testLine : null,
      backend,
      ...(typeof handler === 'string' ? { handler } : {}),
      reach,
    });
  }
  return routesByTest;
}

function reachCounts(list) {
  const counts = Object.fromEntries(REACHES.map((reach) => [reach, 0]));
  for (const entry of list) if (entry.reach) counts[entry.reach] += 1;
  return counts;
}

function realismOf(evidence) {
  return {
    executing: reachCounts(evidence.filter((entry) => !entry.skipped)),
    skipped: reachCounts(evidence.filter((entry) => entry.skipped)),
    entries: evidence.map((entry) => ({
      spec: entry.spec,
      test: entry.test,
      testLine: entry.testLine ?? null,
      line: entry.line,
      source: entry.source,
      skipped: entry.skipped,
      backend: entry.backend ?? 'none',
      ...(entry.handler ? { handler: entry.handler } : {}),
      reach: entry.reach ?? 'unknown',
    })),
  };
}

function realismTotal(routes) {
  const total = { executing: reachCounts([]), skipped: reachCounts([]) };
  for (const route of routes) {
    for (const reach of REACHES) {
      total.executing[reach] += route.realism.executing[reach];
      total.skipped[reach] += route.realism.skipped[reach];
    }
  }
  return total;
}

/**
 * Candidate mechanical `disposition` promotions per route, from a `pw_assert` of kind
 * `status` whose value is a terminal code, in the same `(spec, test)` as a `pw_request`
 * that matched the route from an executing (non-skipped) test. A route reached only by
 * skipped tests contributes no candidates, matching the rule that a reader — mechanical
 * or human — can never promote a seed that never ran.
 */
export function buildDispositionCandidates(factSets, evidenceIndex) {
  const routesByTest = new Map();
  for (const match of evidenceIndex.pwRequestMatches) {
    if (match.skipped) continue;
    const key = `${match.spec}::${match.test}`;
    const set = routesByTest.get(key) || new Set();
    set.add(match.routeKey);
    routesByTest.set(key, set);
  }

  const byRoute = new Map();
  for (const { fact } of collect(factSets, 'pw_assert')) {
    if (fact.kind !== 'status') continue;
    if (typeof fact.value !== 'number' || !TERMINAL_CODE_SET.has(fact.value)) continue;
    const routes = routesByTest.get(`${fact.spec}::${fact.test}`);
    if (!routes) continue;
    for (const routeKey of routes) {
      const list = byRoute.get(routeKey) || [];
      list.push({ value: fact.value, spec: fact.spec, test: fact.test, line: fact.line });
      byRoute.set(routeKey, list);
    }
  }
  return byRoute;
}

function responseCode(response) {
  const match = /^(\d{3})/.exec(String(response || ''));
  return match ? Number(match[1]) : null;
}

/** `route` when an executing test names the route, `skipped` when only a skipped one does. */
export function stateOf(evidence) {
  if (evidence.some((entry) => !entry.skipped)) return 'route';
  if (evidence.length > 0) return 'skipped';
  return 'none';
}

function sinkWeight(seed) {
  let weight = READ_ONLY_WEIGHT;
  for (const outcome of seed.outcomes || []) {
    const value = outcomeWeight(outcome);
    if (value !== undefined && value > weight) weight = value;
  }
  return weight;
}

function branchWeight(seed) {
  let weight = 0;
  for (const branch of seed.dispositions || []) {
    if (HAPPY_DISPOSITIONS[branch.kind] === branch.disposition) continue;
    const value = weightOf(branch.kind);
    if (value !== undefined && value > weight) weight = value;
  }
  return weight;
}

/**
 * The seed's place in the priority order, as a lexicographic key rather than a sum:
 * how far the request is forced off the happy path first, what it then reaches second.
 * A sum lets a read-only happy path outrank an unexercised validation branch, which is
 * the ordering the coverage design exists to prevent.
 */
export function seedKey(seed) {
  return { branch: branchWeight(seed), sink: sinkWeight(seed) };
}

/**
 * The disposition vector that tells this seed apart: every outcome away from the happy
 * path, plus the toggles and named domain cases that select behaviour.
 */
export function dispositionSummary(seed) {
  const parts = [];
  for (const branch of seed.dispositions || []) {
    if (HAPPY_DISPOSITIONS[branch.kind] === branch.disposition) continue;
    parts.push(`${branch.kind}=${branch.disposition}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'happy path';
}

function outcomeLabel(outcome) {
  if (outcome.kind === 'message') return `⇝ ${outcome.ref}`;
  if (outcome.kind === 'db') return `db ${outcome.ref}${outcome.method ? `.${outcome.method}` : ''}`;
  return `${outcome.kind} ${outcome.ref}`;
}

/**
 * What the seed leaves behind, in the order the trace step lists effects. Writes,
 * publishes and pushes are named one by one; reads are counted, not named, the way the
 * tree renders them — a list of twenty `Get…` calls says nothing a count does not.
 */
export function sinkSummary(seed) {
  const parts = (seed.outcomes || []).filter((outcome) => !isRead(outcome)).map(outcomeLabel);
  if (parts.length === 0 && (seed.outcomes || []).length === 0 && seed.response) {
    return [`→ ${seed.response}`];
  }
  return parts;
}

/** How many of the seed's own effects are reads. */
export function readCount(seed) {
  return (seed.outcomes || []).filter(isRead).length;
}

/**
 * Effects reached only through a shared infrastructure dependency. They are identical
 * for every seed of the route, so they belong to the route and never to the ranking.
 */
function alwaysSummary(seeds) {
  const seen = new Set();
  const parts = [];
  for (const seed of seeds) {
    for (const outcome of seed.always || []) {
      const label = outcomeLabel(outcome);
      if (seen.has(label)) continue;
      seen.add(label);
      parts.push(label);
    }
  }
  return parts.sort();
}

/** An intercept registered outside any `it` — in a support command — names no test. */
const NO_TEST = '(no enclosing test)';

function evidenceLabels(evidence) {
  const seen = new Set();
  const labels = [];
  for (const entry of evidence) {
    const test = entry.test || NO_TEST;
    const label = `${entry.spec} :: ${test}`;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push({ label, spec: entry.spec, test, skipped: entry.skipped, match: entry.match });
  }
  return labels;
}

function routeRecord(key, walked, evidence, dispositionCandidates = [], owner = null, runtime = null, reach = null) {
  const state = stateOf(evidence);
  const labels = evidenceLabels(evidence);
  const executing = evidence.filter((entry) => !entry.skipped).length;
  const matches = [...new Set(evidence.map((entry) => entry.match))].sort();
  // Cypress-vs-Playwright parity uses the UI E2E harness (`pw_stub`) — the unrelated
  // backend-API Playwright harness (`pw_request`, `source: 'playwright-api'`) never
  // counts toward either side.
  const cypressEvidence = evidence.filter((entry) => entry.source === 'cypress');
  const playwrightEvidence = evidence.filter((entry) => entry.source === 'playwright-stub');
  const levels = {
    route: {
      state,
      observed: state === 'route',
      skippedOnly: state === 'skipped',
      match: matches,
    },
  };
  for (const level of READER_LEVELS) {
    levels[level] = {
      state: 'needs-reader',
      promotedBy: LEVEL_RULES[level],
      candidates: labels.map((entry) => entry.label),
    };
  }

  const record = {
    key,
    state,
    ref: walked.root ? walked.root.ref : key,
    file: walked.root ? walked.root.file ?? null : null,
    line: walked.root ? walked.root.line ?? null : null,
    evidence: {
      intercepts: evidence.length,
      executing,
      skipped: evidence.length - executing,
      specs: [...new Set(evidence.map((entry) => entry.spec))].sort(),
      cypressSpecs: [...new Set(cypressEvidence.map((entry) => entry.spec))].sort(),
      playwrightSpecs: [...new Set(playwrightEvidence.map((entry) => entry.spec))].sort(),
      match: matches,
      tests: labels,
    },
    parity: {
      cypress: stateOf(cypressEvidence),
      playwright: stateOf(playwrightEvidence),
    },
    realism: realismOf(evidence),
    pageReach: pageReachOf(reach),
    levels,
    seeds: [],
    always: alwaysSummary(walked.seeds || []),
    seedsTruncated: walked.seedsTruncated || 0,
  };
  const stats = walked.stats || {};
  if (stats.pipelines) record.pipelines = stats.pipelines;
  const sharedGateSeeds = (walked.seeds || []).filter((seed) => seed.gate && seed.gate.shared).length;
  if (sharedGateSeeds > 0) record.sharedGateSeeds = sharedGateSeeds;
  if (walked.error) record.error = walked.error;
  if (walked.candidates) record.candidates = walked.candidates;
  if (owner) record.owner = owner;
  // A route whose walk stopped early cannot state its seed count as the whole one: the
  // traversal and the stop counts travel with the record so a reader sees the boundary.
  if (walked.status) {
    record.walk = { traversal: walked.status.traversal, stops: { ...walked.status.stops } };
  }

  for (const seed of walked.seeds || []) {
    const conditions = seedConditions(walked, seed);
    const seedRecord = {
      id: seed.id,
      key: seed.key || null,
      state,
      // `level` starts equal to the mechanical `state` and is the only field a reader
      // verdict ever upgrades (route -> path -> disposition, never down). `state`
      // itself never changes after a merge — it stays the mechanical fact. A
      // `pw_assert` status match upgrades `level` the same way, mechanically, below.
      level: state,
      verdictSource: null,
      dispositions: dispositionSummary(seed),
      sinks: sinkSummary(seed),
      reads: readCount(seed),
      response: seed.response || null,
      branchWeight: branchWeight(seed),
      sinkWeight: sinkWeight(seed),
      evidence: labels.slice(0, EVIDENCE_CAP).map((entry) => entry.label),
      evidenceMore: Math.max(0, labels.length - EVIDENCE_CAP),
      ...(seed.statusReason ? { statusReason: seed.statusReason } : {}),
      ...(seed.gate ? { gate: { ...seed.gate } } : {}),
      ...(conditions.length > 0 ? { conditions } : {}),
    };
    const code = state === 'route' ? responseCode(seed.response) : null;
    const promotion = code !== null ? dispositionCandidates.find((candidate) => candidate.value === code) : undefined;
    if (promotion) {
      seedRecord.level = 'disposition';
      seedRecord.verdictSource = 'playwright-status';
      seedRecord.evidence = [`${promotion.spec} :: ${promotion.test} (${promotion.line}) — expect status ${promotion.value}`];
      seedRecord.evidenceMore = 0;
    }
    // The runtime tier is applied last because it outranks the static one: a
    // line hit inside the branch names the arm a matching status never could, so where
    // both speak the collector's answer is the one kept.
    if (runtime) {
      const verdict = seedRuntimeVerdict(seed.dispositions, runtime);
      seedRecord.runtime = verdict.status;
      if (verdict.status === 'proven') {
        seedRecord.level = 'disposition';
        seedRecord.verdictSource = RUNTIME_VERDICT_SOURCE;
        seedRecord.evidence = verdict.proofs
          .slice(0, EVIDENCE_CAP)
          .map((proof) => runtimeEvidenceLabel(proof, runtimeProofSpans(seed.dispositions, runtime)));
        seedRecord.evidenceMore = Math.max(0, verdict.proofs.length - EVIDENCE_CAP);
      }
    }
    record.seeds.push(seedRecord);
  }
  if (record.seeds.length + record.seedsTruncated > CROWDED_SEEDS) record.crowded = true;
  return record;
}

/**
 * Gap order: level ascending, then branch weight descending, then sink weight
 * descending, then route key — each tier decided only when the tier above it ties, so
 * an unexercised error return always outranks a read-only happy path.
 */
function compareGaps(a, b) {
  return (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    b.branchWeight - a.branchWeight ||
    b.sinkWeight - a.sinkWeight ||
    compare(a.route, b.route) ||
    seedOrdinal(a.seed ?? a.seeds[0]) - seedOrdinal(b.seed ?? b.seeds[0])
  );
}

function gapRows(routes) {
  const rows = [];
  for (const route of routes) {
    for (const seed of route.seeds) {
      // A seed at route level or above (path, disposition — reachable only through a
      // reader verdict) is not a gap; only none and skipped are.
      if (STATE_ORDER[seed.level] >= STATE_ORDER.route) continue;
      rows.push({
        route: route.key,
        seed: seed.id,
        state: seed.state,
        branchWeight: seed.branchWeight,
        sinkWeight: seed.sinkWeight,
        dispositions: seed.dispositions,
        sinks: seed.sinks,
        reads: seed.reads,
      });
    }
  }
  rows.sort(compareGaps);
  return rows;
}

/**
 * Merge the disposition vectors of seeds that share a route and an outcome set, so five
 * variants of one toggle read as `toggle=on · if=viewonly|not-viewonly` instead of five
 * near-identical rows. Branch points are matched by name *and* by their position among
 * the branches of that name, so two different `if` decisions never pool their values
 * into one misleading list; identical merged tokens then fold together.
 */
export function mergeDispositions(summaries) {
  const slots = new Map();
  let happy = false;
  for (const summary of summaries) {
    if (summary === 'happy path') {
      happy = true;
      continue;
    }
    const ordinals = new Map();
    for (const token of summary.split(' · ')) {
      const split = token.indexOf('=');
      const name = split === -1 ? token : token.slice(0, split);
      const value = split === -1 ? null : token.slice(split + 1);
      const ordinal = ordinals.get(name) || 0;
      ordinals.set(name, ordinal + 1);
      const slot = slots.get(`${name}#${ordinal}`) || { name, values: [] };
      if (value !== null && !slot.values.includes(value)) slot.values.push(value);
      slots.set(`${name}#${ordinal}`, slot);
    }
  }
  const parts = [];
  for (const slot of slots.values()) {
    const token = slot.values.length > 0 ? `${slot.name}=${slot.values.join('|')}` : slot.name;
    if (!parts.includes(token)) parts.push(token);
  }
  if (happy) parts.push('happy path');
  return parts.length > 0 ? parts.join(' · ') : 'happy path';
}

/**
 * One row per (route, level, branch weight, sink weight, outcome set); the seed ids it
 * stands for ride along. The weights are part of the key so a collapse never merges
 * seeds the priority order separates — only variants of one gap fold together.
 */
function gapGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.route}|${row.state}|${row.branchWeight}|${row.sinkWeight}|${row.reads}|${row.sinks.join('§')}`;
    const group = groups.get(key);
    if (group) {
      group.seeds.push(row.seed);
      group.summaries.push(row.dispositions);
      continue;
    }
    groups.set(key, {
      route: row.route,
      state: row.state,
      seeds: [row.seed],
      summaries: [row.dispositions],
      branchWeight: row.branchWeight,
      sinkWeight: row.sinkWeight,
      sinks: row.sinks,
      reads: row.reads,
    });
  }
  const collapsed = [...groups.values()].map((group) => ({
    route: group.route,
    seeds: group.seeds,
    count: group.seeds.length,
    state: group.state,
    branchWeight: group.branchWeight,
    sinkWeight: group.sinkWeight,
    dispositions: mergeDispositions(group.summaries),
    sinks: group.sinks,
    reads: group.reads,
  }));
  collapsed.sort(compareGaps);
  return collapsed;
}

function specRows(specs, routeKeys) {
  const area = new Set(routeKeys);
  const rows = [];
  for (const record of specs.values()) {
    const touched = [...record.routes].filter((key) => area.has(key)).sort();
    if (touched.length === 0) continue;
    rows.push({
      spec: record.spec,
      tests: record.tests,
      skipped: record.skipped,
      skippedShare: record.tests > 0 ? record.skipped / record.tests : 0,
      intercepts: record.intercepts,
      routes: touched.length,
    });
  }
  rows.sort((a, b) => b.routes - a.routes || b.intercepts - a.intercepts || compare(a.spec, b.spec));
  return rows;
}

/**
 * The browser path a `role: "page"` component answers to: its own `<Route path>` behind
 * the mount prefix the extractor inferred, when it found one.
 */
function pagePath(fact) {
  const declared = String(fact.path);
  const path = declared.startsWith('/') ? declared : `/${declared}`;
  const prefix = typeof fact.prefix === 'string' ? fact.prefix.replace(/\/+$/, '') : '';
  return prefix && !path.startsWith(`${prefix}/`) ? `${prefix}${path}` : path;
}

/**
 * Every web page with a declared path, with the browser paths it answers to and the area routes
 * its page walk reaches. A page whose walk fails keeps no routes, but a visit still matches it.
 */
function pageWalks(factSets, keys, options, walker) {
  const wanted = new Set(keys);
  const pages = [];
  for (const set of factSets) {
    if (set.kind !== 'web') continue;
    const handlerCounts = new Map();
    for (const fact of set.facts || []) {
      if (fact.type !== 'template_handler') continue;
      handlerCounts.set(fact.component, (handlerCounts.get(fact.component) || 0) + 1);
    }
    // The app-root mount is part of every browser path of the repository, so a visit may name it.
    const mounts = (set.facts || [])
      .filter((fact) => fact.type === 'page_mount' && fact.source === 'app-root' && typeof fact.path === 'string')
      .map((fact) => `/${fact.path.replace(/^\/+|\/+$/g, '')}`)
      .filter((mount) => mount !== '/');
    const seen = new Set();
    for (const fact of set.facts || []) {
      if (fact.type !== 'component' || fact.role !== 'page' || !fact.path) continue;
      if (seen.has(fact.name)) continue;
      seen.add(fact.name);
      const walked = walker(factSets, fact.name, {
        ...options.traceOptions,
        repo: set.repo,
        inventory: true,
        seeds: false,
      });
      const failed = !walked || walked.error || walked.candidates;
      const reached = failed
        ? []
        : [...new Set((walked.nodes || []).filter((node) => node.kind === 'route' && !node.unresolved).map((node) => node.ref))];
      const path = pagePath(fact);
      pages.push({
        key: `${set.repo}\u0000${fact.name}`,
        path,
        paths: [path, ...mounts.filter((mount) => !path.startsWith(`${mount}/`)).map((mount) => `${mount}${path}`)],
        fact,
        repo: set.repo,
        kind: set.kind,
        handlers: handlerCounts.get(fact.name) || 0,
        routes: reached.filter((key) => wanted.has(key)).sort(),
      });
    }
  }
  return pages;
}

/** A visit path without its origin, query and fragment. */
function visitPath(raw) {
  return String(raw)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .replace(/^\/\/[^/?#]*/, '')
    .replace(/[?#].*$/, '');
}

/**
 * The tests whose visits open a page that reaches each route, by route key, and the count of
 * visits by how they matched a page. A test counts once per route however many of its visits
 * reach it.
 */
function buildPageReach(factSets, pages) {
  const classes = testClasses(factSets);
  const skippedOf = pwTestStates(factSets);
  const visits = { matched: 0, unmatched: 0, ambiguous: 0, unread: 0 };
  const byRoute = new Map();
  for (const type of ['pw_visit', 'cypress_visit']) {
    for (const { repo, fact } of collect(factSets, type)) {
      if (typeof fact.path !== 'string') {
        visits.unread += 1;
        continue;
      }
      const found = matchPagePath(pages, visitPath(fact.path));
      if (!found) visits.unmatched += 1;
      else if (found.ambiguous) visits.ambiguous += 1;
      else {
        visits.matched += 1;
        const test = testKey(repo, fact.spec, fact.testLine);
        for (const route of found.page.routes) {
          const tests = byRoute.get(route) || new Map();
          const skipped = type === 'pw_visit' ? skippedOf(repo, fact) : fact.skipped === true;
          tests.set(test, { backend: classes.get(test) ?? 'none', skipped });
          byRoute.set(route, tests);
        }
      }
    }
  }
  return { byRoute, visits };
}

function pageReachOf(tests) {
  const counts = () => Object.fromEntries(PAGE_REACH_CLASSES.map((backend) => [backend, 0]));
  const reach = { executing: counts(), skipped: counts() };
  for (const test of tests ? tests.values() : []) reach[test.skipped ? 'skipped' : 'executing'][test.backend] += 1;
  return reach;
}

/** The email reads of the area, with the area routes of each read's test. */
function areaEmails(factSets, keys, index, walks) {
  const wanted = new Set(keys);
  const routesByTest = new Map();
  for (const [test, routes] of index.routesByTest) {
    const inArea = [...routes].filter((key) => wanted.has(key));
    if (inArea.length > 0) routesByTest.set(test, inArea);
  }
  const { emails, outsideArea } = emailReport(factSets, { routesByTest, walks, skippedOf: pwTestStates(factSets) });
  return { entries: emails, outsideArea };
}

/**
 * The web pages that reach this area's routes, one row each.
 *
 * A React page is **not** an HTTP route: nothing calls it, no seed runs through it, and no
 * evidence attaches to it. It never enters `report.routes`, so no total, glyph strip or gap
 * row can ever be computed from one. It rides alongside as its own list, so a reader asking
 * "which screen is this area?" gets an answer without the route index growing a row that is
 * not a route. `pw` counts the page's own area routes that executing Playwright evidence
 * reaches — a page's coverage is exactly the coverage of the routes it reaches, never more.
 */
function pageRows(pages, evidence) {
  const rows = [];
  for (const page of pages) {
    const { fact, routes } = page;
    if (routes.length === 0) continue;
    const playwright = routes.filter((key) =>
      (evidence.byRoute.get(key) || []).some((entry) => entry.source !== 'cypress' && entry.skipped !== true),
    ).length;
    rows.push({
      path: page.path,
      component: fact.name,
      repo: page.repo,
      kind: page.kind,
      file: fact.file,
      line: fact.line,
      handlers: page.handlers,
      routes,
      playwright,
      inferredMount: Boolean(fact.prefix),
    });
  }
  return rows.sort((a, b) => compare(a.path, b.path) || compare(a.component, b.component));
}

export function headlineOf(totals) {
  return [
    `${totals.observed}/${totals.routes} area routes with executing evidence`,
    `${totals.skippedOnly} skipped-only`,
    `${totals.none} none`,
    `${totals.seeds} seeds`,
    ...(totals.sharedGateSeeds ? [`${totals.sharedGateSeeds} shared-gate`] : []),
    `${totals.seedsPath || 0} path`,
    `${totals.seedsDisposition || 0} disposition`,
    ...(totals.unresolvedPipelines ? [`${totals.unresolvedPipelines} unresolved pipeline${totals.unresolvedPipelines === 1 ? '' : 's'}`] : []),
  ].join(' · ');
}

/** Count seeds by `level` across every route, for the two reader-level headline figures. */
function seedsAtLevel(routes, level) {
  return routes.reduce((sum, route) => sum + route.seeds.filter((seed) => seed.level === level).length, 0);
}

/**
 * How the runtime join landed across the area's seeds, one count per verdict, every key
 * present so a run that proved nothing still says so rather than emitting an empty object.
 */
function seedRuntimeCounts(routes) {
  const counts = {
    proven: 0,
    ambiguous: 0,
    contradicted: 0,
    unreached: 0,
    'no-span': 0,
    'no-branches': 0,
  };
  for (const route of routes) {
    for (const seed of route.seeds) {
      if (!seed.runtime) continue;
      counts[seed.runtime] = (counts[seed.runtime] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Cypress-vs-Playwright parity across the area's routes, from each route's `parity`
 * (mechanical `route`/`skipped`/`none` state, per side — see `routeRecord`). A route
 * counts for a side only at `route` (executing evidence); `skipped`-only evidence, like
 * `none`, does not count as executing evidence for that side. `opaqueStubs` rides along
 * unchanged from `buildEvidenceIndex` — it is a count, never a route bucket, because an
 * opaque stub is never joined to one.
 */
function parityTotals(routes, opaqueStubs) {
  const covers = (route, side) => route.parity[side] === 'route';
  return {
    cypressOnly: routes.filter((route) => covers(route, 'cypress') && !covers(route, 'playwright')).length,
    playwrightOnly: routes.filter((route) => covers(route, 'playwright') && !covers(route, 'cypress')).length,
    both: routes.filter((route) => covers(route, 'cypress') && covers(route, 'playwright')).length,
    neither: routes.filter((route) => !covers(route, 'cypress') && !covers(route, 'playwright')).length,
    opaqueStubs: opaqueStubs || 0,
  };
}

/**
 * Refresh `totals.seedsPath`/`totals.seedsDisposition` and the headline after a
 * verdict merge has upgraded seed levels in place. Gaps never need recomputing: only
 * a seed already at mechanical level `route` is ever eligible for an upgrade, and
 * that level was never a gap to begin with.
 */
export function recomputeLevels(report) {
  report.totals.seedsPath = seedsAtLevel(report.routes, 'path');
  report.totals.seedsDisposition = seedsAtLevel(report.routes, 'disposition');
  report.headline = headlineOf(report.totals);
  return report;
}

/**
 * Walk every route key in the area, attach the intercept evidence that names it, and
 * rank the seeds nothing executing reaches. `options.trace` replaces the walker in
 * tests; everything else in `options` is handed to it unchanged.
 */
export function cover(factSets, options = {}) {
  const keys = options.keys || [];
  const walker = options.trace || trace;
  const index = buildEvidenceIndex(factSets, { aliases: options.aliases });
  const dispositionIndex = buildDispositionCandidates(factSets, index);
  const processors = processorOwners(factSets);
  // Runtime line hits are opt-in: without `--runtime` no collector is read and the report
  // is the static form, with no runtime tier able to affect its values.
  const runtime = options.runtime ? buildRuntimeIndex(factSets, options.runtime) : null;
  const pages = pageWalks(factSets, keys, options, walker);
  const reach = buildPageReach(factSets, pages);
  const routes = [];
  const walks = new Map();

  for (const key of keys) {
    const walked = walker(factSets, key, { ...options.traceOptions, seeds: true });
    walks.set(key, walked);
    const owner = processors.has(key) ? 'worker_processor' : null;
    routes.push(
      routeRecord(key, walked || {}, index.byRoute.get(key) || [], dispositionIndex.get(key) || [], owner, runtime, reach.byRoute.get(key)),
    );
  }
  const runtimeCounts = runtime ? seedRuntimeCounts(routes) : null;

  const totals = {
    routes: routes.length,
    observed: routes.filter((route) => route.state === 'route').length,
    skippedOnly: routes.filter((route) => route.state === 'skipped').length,
    none: routes.filter((route) => route.state === 'none').length,
    seeds: routes.reduce((sum, route) => sum + route.seeds.length, 0),
    seedsObserved: routes.reduce(
      (sum, route) => sum + route.seeds.filter((seed) => seed.state === 'route').length,
      0,
    ),
    seedsSkipped: routes.reduce(
      (sum, route) => sum + route.seeds.filter((seed) => seed.state === 'skipped').length,
      0,
    ),
    seedsNone: routes.reduce(
      (sum, route) => sum + route.seeds.filter((seed) => seed.state === 'none').length,
      0,
    ),
    seedsPath: seedsAtLevel(routes, 'path'),
    seedsDisposition: seedsAtLevel(routes, 'disposition'),
    ...(runtimeCounts ? { seedsRuntime: runtimeCounts.proven } : {}),
    untraced: routes.filter((route) => route.error || route.candidates).length,
    crowded: routes.filter((route) => route.crowded).length,
    parity: parityTotals(routes, index.opaqueStubs),
  };
  const sharedGateSeeds = routes.reduce((sum, route) => sum + (route.sharedGateSeeds || 0), 0);
  if (sharedGateSeeds > 0) totals.sharedGateSeeds = sharedGateSeeds;
  const unresolvedPipelines = routes.reduce((sum, route) => sum + (route.pipelines ? route.pipelines.unresolved.length : 0), 0);
  if (unresolvedPipelines > 0) totals.unresolvedPipelines = unresolvedPipelines;

  const gaps = gapRows(routes);

  return {
    area: options.area || 'area',
    headline: headlineOf(totals),
    totals,
    realism: realismTotal(routes),
    routes,
    pages: pageRows(pages, index),
    emails: areaEmails(factSets, keys, index, walks),
    gaps,
    gapGroups: gapGroups(gaps),
    specs: specRows(index.specs, keys),
    ...(runtime ? { runtime: runtimeSummary(runtime, runtimeCounts) } : {}),
    notes: {
      evidence: 'per route, never per seed — an intercept proves the request, not the path through it',
      readerLevels: READER_LEVELS,
      priority: {
        key: ['level ascending', 'branch weight descending', 'sink weight descending', 'route key'],
        branch: BRANCH_WEIGHTS,
        sink: SINK_WEIGHTS,
        lexicographic: true,
      },
      intercepts: { noPath: index.noPath, unmatched: index.unmatched, unresolvedBase: index.unresolvedBase, ambiguous: index.ambiguous },
      realism:
        'per named evidence entry: stubbed (a fulfilled stub, or a test with a mocked backend), backend (the request reaches the backend), blocked (an aborted request) or unknown; executing and skipped entries are counted apart',
      pageReach:
        'inferred potential reach, not named evidence: per route, the tests by backend class that visit a page whose page walk reaches the route; executing and skipped tests are counted apart',
      visits: reach.visits,
      emails: 'a link from an email read to a template and a sender is a static match, not proof of delivery',
      evidenceCap: EVIDENCE_CAP,
      ...(runtime
        ? {
            runtime:
              'level disposition from a collector line hit inside the branch span, for one (spec, test) window: it proves the arm ran, never that the test asserted on it',
          }
        : {}),
      parity: {
        rule: 'per route: an executing cypress_intercept vs an executing pw_stub of kind "route" (not opaque); the backend-API playwright harness (pw_request) counts toward neither side',
        opaqueStubs: 'a pw_stub call with no URL literal at its call site — counted, never joined to a route',
      },
      pages: 'a web page is a screen, not an HTTP route — listed beside the routes it reaches, never inside the route index',
    },
  };
}
