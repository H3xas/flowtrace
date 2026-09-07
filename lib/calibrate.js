/**
 * Reader calibration — the fixed packets a reader is measured against before its
 * verdicts are allowed to move a coverage number.
 *
 * A reader — a person, a script, an agent — is handed one packet at a time and writes a
 * verdict from the packet's own evidence. Nothing pins that behaviour: a prompt wording
 * change or a model swap can move a packet from `route` to `path` with no test failing,
 * and the first sign is a coverage report that looks wrong. A golden set is the pin. Each
 * entry is one packet, one reference verdict, and the outcome the merge must produce for
 * it — the levels after the merge, the rejection reasons it raises, and the toggle folds
 * it performs.
 *
 * `calibrate` runs a reader's own verdicts through exactly the merge real verdicts go
 * through (`mergeVerdicts`), and reports disagreement by packet id rather than as one
 * pass/fail count: a reader that reads three shapes right and one wrong should be told
 * which one.
 *
 * The report a golden packet is merged into is built by `reportFromPacket`. Its
 * mechanical floor — `route`, `skipped` or `none` — comes from the packet's candidates,
 * or from the entry's own `expect.state` where the shape under test is a verdict written
 * against evidence this run no longer has.
 *
 * The golden directory is always the caller's: nothing here knows where any particular
 * reader keeps its set. The package ships one built from its worked example.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LEVEL_RULES, READER_LEVELS, dispositionSummary, headlineOf, stateOf } from './cover.js';
import { mergeVerdicts } from './packets.js';


const PACKET_SUFFIX = '.packet.json';
const VERDICT_SUFFIX = '.verdict.json';
const NO_TEST = '(no enclosing test)';

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error.message})`);
  }
}

/**
 * Every `<id>.packet.json` in the golden directory, paired with its `<id>.verdict.json`.
 * A packet with no verdict beside it is an error, not a skip: an entry nothing expects
 * an answer for calibrates nothing.
 */
export function loadGolden(dir) {
  if (!dir) throw new Error('a golden directory is required');
  if (!existsSync(dir)) throw new Error(`${dir}: golden set not found`);
  const ids = readdirSync(dir)
    .filter((name) => name.endsWith(PACKET_SUFFIX))
    .map((name) => name.slice(0, -PACKET_SUFFIX.length))
    .sort();
  return ids.map((id) => {
    const verdictFile = join(dir, `${id}${VERDICT_SUFFIX}`);
    if (!existsSync(verdictFile)) throw new Error(`${verdictFile}: golden packet "${id}" has no expected verdict`);
    const doc = readJson(verdictFile);
    return {
      id,
      shape: doc.shape || id,
      rule: doc.rule || '',
      packet: readJson(join(dir, `${id}${PACKET_SUFFIX}`)),
      expect: doc.expect || {},
      verdict: doc.verdict || null,
    };
  });
}

function candidateLabels(candidates) {
  const seen = new Set();
  const labels = [];
  for (const candidate of candidates || []) {
    const label = `${candidate.spec} :: ${candidate.test || NO_TEST}`;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * A one-route `cover` report holding this packet's seeds at their mechanical floor —
 * the shape `mergeVerdicts` expects, built from the packet a reader was handed rather
 * than from a fresh walk.
 */
export function reportFromPacket(packet, options = {}) {
  const state = options.state || stateOf(packet.candidates || []);
  const labels = candidateLabels(packet.candidates);
  const matches = [...new Set((packet.candidates || []).map((candidate) => candidate.match))].sort();
  const levels = {
    route: { state, observed: state === 'route', skippedOnly: state === 'skipped', match: matches },
  };
  for (const level of READER_LEVELS) {
    levels[level] = { state: 'needs-reader', promotedBy: LEVEL_RULES[level], candidates: labels };
  }
  const seeds = (packet.seeds || []).map((seed) => ({
    id: seed.id,
    key: seed.key || null,
    state,
    level: state,
    verdictSource: null,
    dispositions: dispositionSummary(seed),
    sinks: seed.outcomes || [],
    reads: seed.reads || 0,
    response: seed.response || null,
    evidence: labels,
    evidenceMore: 0,
  }));
  const route = {
    key: packet.route,
    state,
    ref: packet.routeRef || packet.route,
    file: packet.file ?? null,
    line: packet.line ?? null,
    levels,
    seeds,
    always: [],
    seedsTruncated: 0,
  };
  const totals = {
    routes: 1,
    observed: state === 'route' ? 1 : 0,
    skippedOnly: state === 'skipped' ? 1 : 0,
    none: state === 'none' ? 1 : 0,
    seeds: seeds.length,
    seedsObserved: state === 'route' ? seeds.length : 0,
    seedsSkipped: state === 'skipped' ? seeds.length : 0,
    seedsNone: state === 'none' ? seeds.length : 0,
    seedsPath: 0,
    seedsDisposition: 0,
  };
  return { area: 'golden', headline: headlineOf(totals), totals, routes: [route], gaps: [], gapGroups: [], specs: [] };
}

/**
 * One golden packet plus one reader verdict, through the merge real verdicts go through.
 * Returns the merged route, the merge summary, and the level each seed ended at, keyed
 * by the stable seed key the merge itself matches on.
 */
export function applyGolden(entry, verdict) {
  const report = reportFromPacket(entry.packet, { state: entry.expect ? entry.expect.state : undefined });
  const summary = mergeVerdicts(report, [{ file: `${entry.id}${VERDICT_SUFFIX}`, doc: verdict }]);
  const route = report.routes[0];
  const levels = {};
  for (const seed of route.seeds) levels[seed.key || seed.id] = seed.level;
  return { report, route, summary, levels };
}

function normaliseVerdicts(verdicts) {
  const given = new Map();
  if (!verdicts) return given;
  if (verdicts instanceof Map) {
    for (const [id, doc] of verdicts) given.set(id, doc);
    return given;
  }
  if (Array.isArray(verdicts)) {
    for (const item of verdicts) {
      if (!item) continue;
      const id = item.id || (item.doc && item.doc.id);
      given.set(id, item.verdict || item.doc || item);
    }
    return given;
  }
  for (const [id, doc] of Object.entries(verdicts)) given.set(id, doc);
  return given;
}

function countOf(map, reason) {
  return (map && map[reason]) || 0;
}

function rejectionMismatches(entry, summary) {
  const expected = (entry.expect && entry.expect.rejections) || {};
  const got = summary.rejections || {};
  const reasons = [...new Set([...Object.keys(expected), ...Object.keys(got)])].sort();
  const out = [];
  for (const reason of reasons) {
    const want = countOf(expected, reason);
    const have = countOf(got, reason);
    if (want === have) continue;
    out.push({
      id: entry.id,
      seed: null,
      expected: `${want} × ${reason}`,
      got: `${have} × ${reason}`,
      rule: entry.rule,
    });
  }
  return out;
}

function countMismatch(entry, field, want, have) {
  if (want === undefined || want === have) return null;
  return { id: entry.id, seed: null, expected: `${want} ${field}`, got: `${have} ${field}`, rule: entry.rule };
}

/** Every way one reader verdict can disagree with a golden entry, by seed then by count. */
export function disagreements(entry, verdict) {
  if (!verdict) {
    return [{ id: entry.id, seed: null, expected: 'a verdict for this golden packet', got: 'nothing', rule: entry.rule }];
  }
  const applied = applyGolden(entry, verdict);
  const out = [];
  for (const [key, level] of Object.entries((entry.expect && entry.expect.seeds) || {})) {
    const got = applied.levels[key];
    if (got === level) continue;
    out.push({ id: entry.id, seed: key, expected: level, got: got === undefined ? 'no such seed' : got, rule: entry.rule });
  }
  out.push(...rejectionMismatches(entry, applied.summary));
  const counts = [
    countMismatch(entry, 'upgrades', entry.expect && entry.expect.upgrades, applied.summary.upgrades),
    countMismatch(entry, 'confirmations', entry.expect && entry.expect.confirmed, applied.summary.confirmed),
  ];
  for (const mismatch of counts) if (mismatch) out.push(mismatch);
  return out;
}

/**
 * Run a reader's verdicts for the golden packets through the merge and say whether the
 * reader is calibrated. `verdicts` is `{<golden id>: <verdict doc>}`, a `Map` of the
 * same, or an array of `{id, verdict}` — one entry per golden packet.
 *
 * A missing verdict, a level the merge did not land on, a rejection reason that did not
 * fire (or fired when it should not have), and a verdict naming no golden packet are all
 * disagreements. `agreed` lists the golden ids that matched in full.
 */
export function calibrate(verdicts, options = {}) {
  const golden = options.golden || loadGolden(options.dir);
  const given = normaliseVerdicts(verdicts);
  const known = new Set(golden.map((entry) => entry.id));
  const agreed = [];
  const disagreed = [];

  for (const entry of golden) {
    const found = disagreements(entry, given.get(entry.id));
    if (found.length === 0) {
      agreed.push(entry.id);
      continue;
    }
    disagreed.push(...found);
  }
  for (const id of given.keys()) {
    if (known.has(id)) continue;
    disagreed.push({
      id: id === undefined ? '(unnamed)' : id,
      seed: null,
      expected: 'a golden packet id',
      got: 'a verdict naming no golden packet',
      rule: 'calibration runs over the golden set and nothing else',
    });
  }
  return { agreed, disagreed };
}
