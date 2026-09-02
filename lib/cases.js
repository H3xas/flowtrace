/**
 * Cases step — a named coverage gap into a plain-English case a person reads, judges,
 * and pastes into whatever case-management tool the team already uses.
 *
 * `cover` names which seeds no test reaches; `scaffold` turns them into a Playwright
 * skeleton a developer edits. This module writes the step in between: no code, no
 * import, no fixture — one markdown file per **route**, one case block per seed, in
 * words a tester can judge without reading the branch that produced it. Nothing here
 * calls a case-management API; the sheet is meant to be read, then pasted in by hand.
 *
 * The same three rules `scaffold` keeps apply here, because the source is the same
 * seed list:
 *
 * - **It never invents a seed.** Every block comes from a seed the walker produced and
 *   carries that seed's stable `#key`.
 * - **It never writes into a repository.** The output directory is checked against
 *   every configured repository root, exactly as `scaffold`'s is.
 * - **It never invents a case id.** `Case id:` is always the literal `TODO: pending` —
 *   a human fills it in once the case exists in the tool of record.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { BRANCH_DISPOSITIONS, trace } from './trace.js';
import { HAPPY_DISPOSITIONS, STATE_ORDER } from './cover.js';
import {
  MAX_LEVELS,
  keepsSeed,
  mappedFaultStatus,
  splitRouteKey,
  statusFor,
  testTitle,
  unreachableEntry,
  unreachableFooter,
} from './scaffold.js';

const CASE_ID_PLACEHOLDER = 'TODO: pending';

/**
 * `--gherkin-draft`'s own case id line. It is never the bare `TODO: pending` placeholder —
 * pointing back at the plain-English sheet keeps a reader from mistaking this second,
 * Gherkin-shaped rendering of the same evidence for the one place a human judges it.
 */
const GHERKIN_CASE_ID_NOTE = 'TODO: pending — see `cases` sheet for the human-readable version';

/** A case block's `### <id>  <summary>  \`#<key>\`` line never runs past this many characters. */
const MAX_HEADING_CHARS = 120;

/** How many sinks a heading names outright before folding the rest into `+N more`. */
const HEADING_SINK_CAP = 2;

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRead(outcome) {
  return outcome.kind === 'db' && outcome.access === 'read';
}

/** `<kind> <ref>[.method]` — the same shorthand `scaffold` and `cover` already use. */
function outcomeLabel(outcome) {
  if (outcome.kind === 'message') return `⇝ ${outcome.ref}`;
  if (outcome.kind === 'db') return `db ${outcome.ref}${outcome.method ? `.${outcome.method}` : ''}`;
  return `${outcome.kind} ${outcome.ref}`;
}

/**
 * The first two sinks, joined, plus ` +N more` for the rest — never the raw list, which
 * for a seed with a handful of sinks would otherwise run the heading off the page. When
 * even the capped form doesn't fit `maxLen`, the second sink itself gives way, its tail
 * cut and marked with an ellipsis, so the heading — id and `#hash` included — stays
 * within `MAX_HEADING_CHARS`.
 */
function cappedSinkList(sinks, reads, maxLen) {
  const shown = sinks.slice(0, HEADING_SINK_CAP);
  const moreCount = sinks.length - shown.length;
  const moreSuffix = moreCount > 0 ? ` +${moreCount} more` : '';
  const readsSuffix = reads > 0 ? ` · reads ${reads}` : '';
  const text = `${shown.join(', ')}${moreSuffix}${readsSuffix}`;
  if (maxLen === undefined || text.length <= maxLen || shown.length < 2) return text;

  const fixedLen = shown[0].length + ', '.length + '…'.length + moreSuffix.length + readsSuffix.length;
  const budget = maxLen - fixedLen;
  const truncatedSecond = budget > 0 ? `${shown[1].slice(0, budget)}…` : '…';
  return `${shown[0]}, ${truncatedSecond}${moreSuffix}${readsSuffix}`;
}

/**
 * The header line's status/sink summary — a response (`400 BadRequest`, `throw … (500)`)
 * passes through untouched, since it is already short; a seed with observable effects gets
 * its sink list capped to fit `maxLen`, the budget `renderCaseBlock` leaves after the id
 * and `#hash`.
 */
function headerSummary(seed, maxLen) {
  if (seed.response) return seed.response;
  const outcomes = seed.outcomes || [];
  if (outcomes.length === 0) return 'no observable effect';
  const sinks = outcomes.filter((outcome) => !isRead(outcome)).map(outcomeLabel);
  const reads = outcomes.filter(isRead).length;
  if (sinks.length === 0) return reads > 0 ? `reads ${reads}` : 'no observable effect';
  return cappedSinkList(sinks, reads, maxLen);
}

/**
 * Sanitise a route key into a flat file-safe slug, the same rule `bin/flowtrace.js`
 * already uses for `out/flows/<slug>.md`, so the two verbs never disagree on naming.
 */
function sanitiseKey(key) {
  return (
    String(key)
      .toLowerCase()
      .replace(/\*/g, 'star')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'route'
  );
}

/** A route's file name; a second route with the same slug takes a numbered suffix. */
export function routeSlugFor(routeKey, taken = new Set()) {
  const base = sanitiseKey(routeKey);
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Never write into a repository the tool reads facts from — a case sheet is a document
 * a person files elsewhere, not an edit this tool makes to a checkout it does not own.
 */
function assertOutsideRepos(outDir, repoRoots) {
  const target = resolve(outDir);
  for (const root of repoRoots || []) {
    if (!root) continue;
    const base = resolve(root);
    if (target === base || target.startsWith(`${base}${sep}`)) {
      throw new Error(`cases: refusing to write inside a configured repository (${outDir})`);
    }
  }
}

function walkRoutes(options) {
  const walker = options.trace || trace;
  const keys = options.keys || [];
  return keys.map((key) => {
    const walked = walker(options.facts, key, { ...options.traceOptions, seeds: true }) || {};
    return { key, root: walked.root || null, seeds: walked.seeds || [], error: walked.error || null };
  });
}

function normaliseSeedInput(seeds) {
  if (!Array.isArray(seeds)) return [];
  return seeds.map((entry) => ({
    key: entry.key ?? entry.route,
    root: entry.root || null,
    seeds: entry.seeds || [],
    error: entry.error || null,
  }));
}

/** Every seed's level and evidence, keyed `<route>::<seed key>` and `<route>::#<id>`. */
export function evidenceIndex(report) {
  const index = new Map();
  for (const route of (report && report.routes) || []) {
    for (const seed of route.seeds || []) {
      const info = { level: seed.level || seed.state || 'none', evidence: seed.evidence || [], more: seed.evidenceMore || 0 };
      if (seed.key) index.set(`${route.key}::${seed.key}`, info);
      index.set(`${route.key}::#${seed.id}`, info);
    }
  }
  return index;
}

function lookupEvidence(routeKey, seed, index) {
  return index.get(`${routeKey}::${seed.key}`) || index.get(`${routeKey}::#${seed.id}`) || null;
}

/**
 * `{ text, covered, labels, more }` — evidence only counts once a mechanical `route`
 * level is reached. `text` is the plain sheet's own joined "a; b; c (+N more)" line;
 * `labels`/`more` are the same evidence unjoined, for a caller (the Gherkin `Given`
 * clause) that restates one stub per precondition line instead of one run-on sentence.
 */
function evidenceFor(seed, routeKey, index) {
  const info = lookupEvidence(routeKey, seed, index);
  const level = info ? info.level : 'none';
  const covered = STATE_ORDER[level] !== undefined && STATE_ORDER[level] >= STATE_ORDER.route;
  if (!covered) return { text: 'none', covered: false, labels: [], more: 0 };
  const labels = info.evidence || [];
  const more = info.more || 0;
  const suffix = more > 0 ? ` (+${more} more)` : '';
  return { text: `${labels.join('; ') || 'none'}${suffix}`, covered: true, labels, more };
}

/** Extract the boolean expression inside a leading `if ( … )`, honouring nested parens. */
function extractIfCondition(text) {
  const trimmed = String(text || '').trim();
  if (!/^if\s*\(/.test(trimmed)) return null;
  const start = trimmed.indexOf('(');
  let depth = 0;
  for (let index = start; index < trimmed.length; index += 1) {
    if (trimmed[index] === '(') depth += 1;
    else if (trimmed[index] === ')') {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start + 1, index).trim();
    }
  }
  return null;
}

function conditionOf(text) {
  const trimmed = String(text || '').trim();
  const extracted = extractIfCondition(trimmed);
  return extracted !== null ? extracted : trimmed;
}

function pair(whenTrue, whenFalse) {
  return { whenTrue, whenFalse };
}

function subject(text, fallback) {
  const value = String(text || '').trim();
  return value || fallback;
}

/** A condition's own term, spelled the way the caller wants it read. The plain sheet passes
 *  the expression through untouched; the Gherkin draft passes `humanTerm`. */
const asWritten = (text) => text;

/**
 * Common C# condition idioms, most specific first, each already accounting for its own
 * leading `!` — the plain-word reading of the condition exactly as written, both for it
 * holding and for it not. Anything unrecognised falls back to the quoted condition
 * itself: never wrong, just less readable.
 */
const IDIOMS = [
  [/^!\s*string\.IsNullOrWhiteSpace\(\s*([^()]+?)\s*\)$/i, (m, t) => pair(`${t(m[1])} is not blank`, `${t(m[1])} is blank`)],
  [/^string\.IsNullOrWhiteSpace\(\s*([^()]+?)\s*\)$/i, (m, t) => pair(`${t(m[1])} is blank`, `${t(m[1])} is not blank`)],
  [/^!\s*string\.IsNullOrEmpty\(\s*([^()]+?)\s*\)$/i, (m, t) => pair(`${t(m[1])} is not empty`, `${t(m[1])} is empty`)],
  [/^string\.IsNullOrEmpty\(\s*([^()]+?)\s*\)$/i, (m, t) => pair(`${t(m[1])} is empty`, `${t(m[1])} is not empty`)],
  [/^([\w.]+)\s*==\s*null$/, (m, t) => pair(`${t(m[1])} is missing`, `${t(m[1])} is present`)],
  [/^([\w.]+)\s*!=\s*null$/, (m, t) => pair(`${t(m[1])} is present`, `${t(m[1])} is missing`)],
  [
    /^!\s*[\w.]*\bIsValid\(\s*([^()]*)\s*\)$/,
    (m, t) => pair(`${subject(t(m[1]), 'the input')} is invalid`, `${subject(t(m[1]), 'the input')} is valid`),
  ],
  [
    /^[\w.]*\bIsValid\(\s*([^()]*)\s*\)$/,
    (m, t) => pair(`${subject(t(m[1]), 'the input')} is valid`, `${subject(t(m[1]), 'the input')} is invalid`),
  ],
  [
    /^!\s*[\w.]*\.Validate\(\s*([^()]*)\s*\)$/,
    (m, t) =>
      pair(`${subject(t(m[1]), 'the input')} fails validation`, `${subject(t(m[1]), 'the input')} passes validation`),
  ],
  [
    /^[\w.]*\.Validate\(\s*([^()]*)\s*\)$/,
    (m, t) =>
      pair(`${subject(t(m[1]), 'the input')} passes validation`, `${subject(t(m[1]), 'the input')} fails validation`),
  ],
  [
    /^!\s*[\w.]*IsToggleEnabled\(\s*Toggles\.(\w+)\s*\)$/,
    (m) => pair(`feature toggle ${m[1]} is disabled`, `feature toggle ${m[1]} is enabled`),
  ],
  [
    /^[\w.]*IsToggleEnabled\(\s*Toggles\.(\w+)\s*\)$/,
    (m) => pair(`feature toggle ${m[1]} is enabled`, `feature toggle ${m[1]} is disabled`),
  ],
  [/^!\s*(\S+)\.Equals\(\s*([^()]+?)\s*\)$/, (m, t) => pair(`${t(m[1])} is not ${t(m[2])}`, `${t(m[1])} is ${t(m[2])}`)],
  [/^(\S+)\.Equals\(\s*([^()]+?)\s*\)$/, (m, t) => pair(`${t(m[1])} is ${t(m[2])}`, `${t(m[1])} is not ${t(m[2])}`)],
  [/^([\w.]+)\s*!=\s*([\w."'.]+)$/, (m, t) => pair(`${t(m[1])} is not ${t(m[2])}`, `${t(m[1])} is ${t(m[2])}`)],
  [/^([\w.]+)\s*==\s*([\w."'.]+)$/, (m, t) => pair(`${t(m[1])} is ${t(m[2])}`, `${t(m[1])} is not ${t(m[2])}`)],
];

/** The two readings that fit any bare identifier — tried only once every specific idiom, and
 *  every draft-only idiom, has been given its turn, since they match almost anything. */
const GENERIC_IDIOMS = [
  [/^!\s*([\w.]+)$/, (m, t) => pair(`${t(m[1])} is false`, `${t(m[1])} is true`)],
  [/^([\w.]+)$/, (m, t) => pair(`${t(m[1])} is true`, `${t(m[1])} is false`)],
];

function fallbackPair(rawCondition) {
  const negated = /^!\s*/.test(rawCondition);
  const core = rawCondition.replace(/^!\s*/, '').trim();
  return negated ? pair(`\`${core}\` does not hold`, `\`${core}\` holds`) : pair(`\`${core}\` holds`, `\`${core}\` does not hold`);
}

function idiomPair(rawCondition, term = asWritten) {
  for (const [pattern, build] of [...IDIOMS, ...GENERIC_IDIOMS]) {
    const match = pattern.exec(rawCondition);
    if (match) return build(match, term);
  }
  return fallbackPair(rawCondition);
}

/**
 * Whether this seed's disposition is the side the condition takes when it literally
 * reads true. A canonical kind (`error_return`, `guard`, `validation`, `toggle`) answers
 * from `BRANCH_DISPOSITIONS`/`HAPPY_DISPOSITIONS`; a domain discriminator (`discriminatorOf`
 * in `lib/trace.js`) always names its positive match without a `not-` prefix, so the
 * disposition string itself answers instead.
 */
function isConditionTrueSide(entry) {
  const options = BRANCH_DISPOSITIONS[entry.kind];
  if (options) return entry.disposition !== HAPPY_DISPOSITIONS[entry.kind];
  return !String(entry.disposition || '').startsWith('not-');
}

/**
 * One branch decision in plain words, the disposition it took stated explicitly. A
 * toggle reads from its own name rather than the raw `IsToggleEnabled(...)` call, since
 * `entry.toggle` already carries it cleanly.
 */
export function phraseFor(entry) {
  if (entry.kind === 'toggle' && entry.toggle) {
    const name = String(entry.toggle).replace(/^Toggles\./, '');
    return `feature toggle ${name} is ${entry.disposition === 'on' ? 'enabled' : 'disabled'}`;
  }
  const { whenTrue, whenFalse } = idiomPair(conditionOf(entry.text));
  return isConditionTrueSide(entry) ? whenTrue : whenFalse;
}

export function preconditionBullets(seed) {
  const decisions = seed.dispositions || [];
  if (decisions.length === 0) return ['none (happy path — no deciding branch)'];
  return decisions.map((entry) => `${phraseFor(entry)} (${entry.kind} ${entry.disposition})`);
}

/** The role a case's first step authenticates as, when a status implies one. */
function roleFor(status) {
  if (status === 401) return 'an unauthenticated user';
  if (status === 403) return 'a user without the required permission';
  return 'an authorised user';
}

/** A precondition phrase trimmed to a clause that fits after "with": drop the "is". */
function impliedFragment(entry) {
  const phrase = phraseFor(entry);
  if (phrase.includes(' is not ')) return phrase.replace(' is not ', ' not ');
  return phrase.replace(' is ', ' ');
}

function hasBusSink(seed) {
  return (seed.outcomes || []).some((outcome) => outcome.kind === 'message') ||
    (seed.always || []).some((outcome) => outcome.kind === 'message');
}

/**
 * The non-toggle branch decisions restated as "with ..." fragments, plus a fragment for
 * a wildcard path segment — the same trigger `stepsFor`'s "Call ... with ..." step already
 * states, reused by the Gherkin `When` clause so the two shapes never disagree on what
 * triggers the seed. A toggle is a standing precondition, not a per-request trigger, so it
 * is left out here and stated instead wherever a caller renders preconditions.
 */
function dispositionFragments(seed, routeKey) {
  const { path } = splitRouteKey(routeKey);
  const fragments = (seed.dispositions || [])
    .filter((entry) => entry.kind !== 'toggle')
    .map(impliedFragment);
  const wildcards = path.split('/').filter((segment) => segment === '*').length;
  if (wildcards > 0) fragments.push('an existing id in the path');
  return fragments;
}

function stepsFor(seed, routeKey) {
  const { verb } = splitRouteKey(routeKey);
  const status = seed.kind === 'fault' ? mappedFaultStatus(seed) : statusFor(seed);
  const role = roleFor(status);
  const fragments = dispositionFragments(seed, routeKey);
  const withClause = fragments.length > 0 ? ` with ${fragments.join(', ')}` : '';
  const action = verb ? 'Call' : 'Trigger';
  const steps = [`Authenticate as ${role}.`, `${action} \`${routeKey}\`${withClause}.`];
  if (hasBusSink(seed)) steps.push('Wait for the consumer to process the message.');
  return steps;
}

function exceptionNameFrom(response) {
  const match = /throw\s+(\w+)/.exec(String(response || ''));
  return match ? match[1] : null;
}

function statusLabel(seed, status) {
  if (seed.response && /^\d{3}\b/.test(seed.response)) return seed.response;
  return `HTTP ${status}`;
}

export function expectedFor(seed) {
  if (seed.kind === 'fault') {
    const name = exceptionNameFrom(seed.response) || 'the thrown type';
    return [`decide: exception ${name} is unhandled today (500) — confirm the intended contract`];
  }
  if (seed.kind === 'reject') {
    const status = statusFor(seed);
    if (status === null) return ['decide: response status is not implied by the branch — confirm the intended contract'];
    return [statusLabel(seed, status)];
  }
  const lines = [];
  const status = statusFor(seed);
  if (status !== null) lines.push(statusLabel(seed, status));
  const own = (seed.outcomes || []).filter((outcome) => !isRead(outcome)).map(outcomeLabel);
  const always = (seed.always || []).map((outcome) => `${outcomeLabel(outcome)} (always)`);
  if (own.length === 0 && always.length === 0) lines.push('reads only (no observable write)');
  else lines.push(...own, ...always);
  return lines;
}

const CHAIN_KINDS = new Set(['action', 'method']);
const CHAIN_CAP = 6;

/**
 * The one-line path a route's request actually walks — the handler, then every service
 * method reached along the primary chain, in the order the walk meets them. Falls back
 * to the route key alone when the trace carries no tree (a seed-only test input, or a
 * route the walk could not resolve further than its own action).
 */
export function pathSummary(routeKey, root) {
  if (!root || !Array.isArray(root.children)) return routeKey;
  const labels = [];
  const seen = new Set();
  const visited = new Set();
  const queue = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    if (node.kind === 'branch') continue;
    if (CHAIN_KINDS.has(node.kind) && node.ref && !seen.has(node.ref)) {
      seen.add(node.ref);
      labels.push(node.ref);
    }
    if (node.sink === true) continue;
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  if (labels.length === 0) return routeKey;
  const capped = labels.slice(0, CHAIN_CAP);
  return capped.length < labels.length ? `${capped.join(' → ')} → …` : capped.join(' → ');
}

function renderCaseBlock(seed, routeKey, levels) {
  const idPart = `### ${seed.id}`;
  const keyPart = `\`#${seed.key}\``;
  const summaryMaxLen = MAX_HEADING_CHARS - idPart.length - keyPart.length - '  '.length - '  '.length;
  const header = `${idPart}  ${headerSummary(seed, summaryMaxLen)}  ${keyPart}`;
  const title = `**Title:** ${routeKey} · ${testTitle(seed)}`;
  const preconditions = ['**Preconditions:**', ...preconditionBullets(seed).map((line) => `- ${line}`)];
  const steps = ['**Steps:**', ...stepsFor(seed, routeKey).map((line, index) => `${index + 1}. ${line}`)];
  const expected = ['**Expected:**', ...expectedFor(seed).map((line) => `- ${line}`)];
  const evidence = evidenceFor(seed, routeKey, levels);
  return [
    header,
    '',
    title,
    '',
    ...preconditions,
    '',
    ...steps,
    '',
    ...expected,
    '',
    `**Evidence today:** ${evidence.text}`,
    '',
    `**Case id:** \`${CASE_ID_PLACEHOLDER}\``,
  ].join('\n');
}

// --- The Gherkin draft's own wording -------------------------------------------------
//
// A draft block is read by a tester who never opens the branch that produced it, so nothing
// below ever prints source: a condition the tool cannot read into words is stated by what
// the walk knows about the branch — its kind, its disposition, the status it returns —
// rather than quoted. The plain sheet keeps its own wording untouched; these helpers are
// the draft's alone.

/**
 * A `CamelCase` or `SCREAMING_CASE` name as words, when every word it splits into is a word
 * rather than a stray letter: `OrderItemType` reads "order item type" and `PENDING` reads
 * "pending", while `QAndA` is left exactly as written rather than spelled "q and a".
 */
function humanWords(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  if (/^[A-Z0-9_]+$/.test(text)) return text.replace(/_+/g, ' ').toLowerCase();
  const parts = text.replace(/_+/g, ' ').split(/(?<=[a-z0-9])(?=[A-Z])/);
  if (parts.some((part) => part.trim().length < 2)) return text;
  return parts.join(' ').toLowerCase();
}

/** Qualifier segments that carry no meaning of their own, so a term never reads as one. */
const ACCESSOR_SEGMENTS = new Set(['ToLower', 'ToUpper', 'Trim', 'ToString', 'Value', 'Current', 'GetValueOrDefault']);

/**
 * One term of a condition as a reader says it: a string literal stays its own words, a
 * number stays a number, and an expression is reduced to the name that carries its meaning
 * — `input.OrderItemType.ToLower()` reads "order item type", `Constants.OrderStatuses.PENDING`
 * reads "pending". An expression that reduces to nothing readable is returned as written,
 * which only ever happens inside a clause the draft has already decided not to print.
 */
function humanTerm(expression) {
  const raw = String(expression || '').trim();
  if (!raw) return raw;
  const literal = /^["']([^"']*)["']$/.exec(raw);
  if (literal) return `"${literal[1]}"`;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return raw;
  const segments = raw
    .replace(/\s+/g, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/[!?]/g, '')
    .split('.')
    .filter(Boolean);
  const meaningful = segments.filter((segment) => !ACCESSOR_SEGMENTS.has(segment));
  const chain = meaningful.length > 0 ? meaningful : segments;
  const last = chain[chain.length - 1];
  if (!last || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return raw;
  return humanWords(last.replace(/^_+/, ''));
}

/** How a comparison operator reads, for the side it holds and the side it does not. */
const COMPARISONS = {
  '<=': ['is at most', 'is more than'],
  '<': ['is less than', 'is at least'],
  '>=': ['is at least', 'is less than'],
  '>': ['is more than', 'is at most'],
};

/**
 * Idioms only the draft reads, tried after every shared idiom and before the two bare-identifier
 * ones — a predicate call and a size comparison both have a plain reading the plain sheet never
 * needed, because the plain sheet was content to quote them.
 */
const DRAFT_IDIOMS = [
  [
    /^(!?)\s*(?:await\s+)?[\w.?]*\b(?:[Ii]s|[Hh]as|[Cc]an|[Ss]hould)([A-Z]\w*)\(\s*[^()]*\s*\)$/,
    (m) => {
      const check = `the ${humanWords(m[2])} check`;
      return m[1] === '!' ? pair(`${check} fails`, `${check} passes`) : pair(`${check} passes`, `${check} fails`);
    },
  ],
  [
    /^(!?)\s*[\w.?]*\b(?:[Ii]s|[Hh]as|[Cc]an|[Ss]hould)([A-Z]\w*)$/,
    (m) => {
      const flag = `the ${humanWords(m[2])} flag`;
      return m[1] === '!' ? pair(`${flag} is not set`, `${flag} is set`) : pair(`${flag} is set`, `${flag} is not set`);
    },
  ],
  [
    /^(!?)\s*([\w.?]+)\.Any\(\s*\)$/,
    (m, t) => (m[1] === '!' ? pair(`${t(m[2])} is empty`, `${t(m[2])} has entries`) : pair(`${t(m[2])} has entries`, `${t(m[2])} is empty`)),
  ],
  [
    /^(!?)\s*([\w.?]+)\.Contains\(\s*([^()]+?)\s*\)$/,
    (m, t) =>
      m[1] === '!'
        ? pair(`${t(m[2])} does not contain ${t(m[3])}`, `${t(m[2])} contains ${t(m[3])}`)
        : pair(`${t(m[2])} contains ${t(m[3])}`, `${t(m[2])} does not contain ${t(m[3])}`),
  ],
  [
    /^([\w.?]+)\s*(<=|>=|<|>)\s*([\w.]+)$/,
    (m, t) => pair(`${t(m[1])} ${COMPARISONS[m[2]][0]} ${t(m[3])}`, `${t(m[1])} ${COMPARISONS[m[2]][1]} ${t(m[3])}`),
  ],
];

/** The idiom, and only an idiom — `null` where the plain sheet would quote the source. */
function strictIdiomPair(condition) {
  for (const [pattern, build] of [...IDIOMS, ...DRAFT_IDIOMS, ...GENERIC_IDIOMS]) {
    const match = pattern.exec(condition);
    if (match) return build(match, humanTerm);
  }
  return null;
}

/** Whether every bracket and quote in an expression closes — a condition the extractor cut
 *  short does not, and is read by what the branch does instead of by what it says. */
function isBalanced(expression) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quote === null;
}

function unwrapParens(expression) {
  let text = expression.trim();
  while (text.startsWith('(') && text.endsWith(')') && isBalanced(text.slice(1, -1))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** An expression split on its loosest top-level boolean operator, `||` before `&&`, so the
 *  parts recurse in the order C# itself groups them. */
function splitBoolean(expression) {
  for (const operator of ['||', '&&']) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let index = 0; index < expression.length; index += 1) {
      const character = expression[index];
      if (quote) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === '(' || character === '[') depth += 1;
      else if (character === ')' || character === ']') depth -= 1;
      else if (depth === 0 && expression.startsWith(operator, index)) {
        parts.push(expression.slice(start, index));
        index += 1;
        start = index + 1;
      }
    }
    if (parts.length > 0) {
      parts.push(expression.slice(start));
      return { operator, parts: parts.map((part) => part.trim()) };
    }
  }
  return null;
}

/**
 * Both readings of a whole condition, its `&&`/`||` structure carried through by De Morgan —
 * `a == null && b == null` not holding is "a is present or b is present", never the negation
 * of a sentence. `null` when any part of it has no plain reading, so a half-readable condition
 * is never printed half-read.
 */
function draftPair(expression) {
  const trimmed = String(expression || '').trim();
  if (!trimmed || !isBalanced(trimmed)) return null;
  const inner = unwrapParens(trimmed);
  const split = splitBoolean(inner);
  if (!split) return strictIdiomPair(inner);
  const parts = split.parts.map(draftPair);
  if (parts.some((part) => part === null)) return null;
  const conjunction = split.operator === '&&';
  return pair(
    parts.map((part) => part.whenTrue).join(conjunction ? ' and ' : ' or '),
    parts.map((part) => part.whenFalse).join(conjunction ? ' or ' : ' and '),
  );
}

/** The condition a branch decided on, or `null` when the walk recorded the statement it ran
 *  rather than the test it made — a `return`/`throw` line, or an `if (` the extractor cut. */
function draftCondition(text) {
  const trimmed = String(text || '').trim();
  const extracted = extractIfCondition(trimmed);
  if (extracted !== null) return extracted;
  if (/^(?:if|while)\s*\(/.test(trimmed)) return null;
  if (/^(?:return|throw)\b/.test(trimmed) || /[;{}]/.test(trimmed)) return null;
  return trimmed || null;
}

/** A status code as a tester names it. Anything unlisted stays the bare code. */
const STATUS_WORDS = Object.freeze({
  200: '200 OK',
  201: '201 Created',
  202: '202 Accepted',
  204: '204 No Content',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  409: '409 Conflict',
  410: '410 Gone',
  422: '422 Unprocessable Entity',
  500: '500 Internal Server Error',
});

function statusWords(status) {
  return STATUS_WORDS[status] || `HTTP ${status}`;
}

/** The status a branch returns, read from the statement it ran — the same evidence
 *  `scaffold`'s `statusFor` reads, narrowed to this one branch. */
const BRANCH_STATUSES = [
  [/StatusCodes?\.Status(\d{3})/, (m) => Number(m[1])],
  [/\bBadRequest\b|\bBadRequestException\b/, () => 400],
  [/\bUnauthorized\b|\bUnauthorizedException\b/, () => 401],
  [/\bForbid\b|\bForbidden\b|\bAccessDenied/, () => 403],
  [/\bNotFound/, () => 404],
  [/\bConflict/, () => 409],
  [/\bGone\b/, () => 410],
];

function branchStatus(entry) {
  const text = `${entry.text || ''} ${entry.returnText || ''}`;
  for (const [pattern, read] of BRANCH_STATUSES) {
    const match = pattern.exec(text);
    if (match) return read(match);
  }
  return null;
}

function branchExceptionWords(entry) {
  const match = /throw\s+new\s+(\w+?)(?:Exception)?\s*\(/.exec(`${entry.text || ''} ${entry.returnText || ''}`);
  return match ? humanWords(match[1]) : null;
}

/**
 * What a branch the tool cannot read into words did, rather than what it said: a canonical
 * kind is named by the rejection it makes (its status, or the exception it throws), and a
 * domain discriminator by the case its own disposition names. Never the source itself.
 */
function branchOutcomePhrase(entry) {
  const kind = entry.kind || '';
  if (kind === 'toggle') {
    return `the feature toggle on this path is ${entry.disposition === 'on' ? 'enabled' : 'disabled'}`;
  }
  if (BRANCH_DISPOSITIONS[kind]) {
    const rejected = isConditionTrueSide(entry);
    const status = branchStatus(entry);
    if (status !== null) {
      return rejected
        ? `the request is rejected with ${statusWords(status)}`
        : `the request passes the ${statusWords(status)} check`;
    }
    const named = branchExceptionWords(entry);
    if (named) return rejected ? `the ${named} guard is tripped` : `the ${named} guard is clear`;
    return rejected ? 'the request is rejected on this path' : 'the request passes the guard on this path';
  }
  const disposition = String(entry.disposition || '');
  const negated = disposition.startsWith('not-');
  const words = (negated ? disposition.slice(4) : disposition).replace(/[-_]+/g, ' ').trim() || 'branch';
  return negated ? `the ${words} case does not apply` : `the ${words} case applies`;
}

/** One branch decision as a draft states it — plain words, never the branch's own text. */
export function draftPhrase(entry) {
  if (entry.kind === 'toggle' && entry.toggle) return phraseFor(entry);
  const built = draftPair(draftCondition(entry.text));
  if (!built) return branchOutcomePhrase(entry);
  return isConditionTrueSide(entry) ? built.whenTrue : built.whenFalse;
}

/** `Given the <verb> <path> endpoint`, or the bare key when the route carries no verb
 *  (a mobile/web start `trace` still resolves, but `splitRouteKey` has no method to name). */
function routeIdentity(routeKey) {
  const { verb, path } = splitRouteKey(routeKey);
  return verb ? `the ${verb} ${path} endpoint` : `the \`${routeKey}\` entry point`;
}

/**
 * The `Given` clause: what has to be true before the request is sent, and nothing else. The
 * route's identity, the actor the seed's own status implies, every standing feature toggle,
 * every branch decision in plain words, and a wildcard segment's existing id. Coverage
 * evidence is not a precondition — a spec that already exercises the endpoint arranges
 * nothing for this case — so it is stated below the clauses instead of inside them.
 */
function givenLines(seed, routeKey, outcomes = []) {
  const status = seed.kind === 'fault' ? mappedFaultStatus(seed) : statusFor(seed);
  const { path } = splitRouteKey(routeKey);
  const preconditions = [`the caller is ${roleFor(status)}`];
  for (const entry of seed.dispositions || []) preconditions.push(draftPhrase(entry));
  if (path.split('/').filter((segment) => segment === '*').length > 0) {
    preconditions.push('the path names an existing id');
  }
  const lines = [`Given ${routeIdentity(routeKey)}`];
  const seen = new Set();
  for (const precondition of preconditions) {
    if (!precondition || seen.has(precondition)) continue;
    // A branch the tool can only read by the rejection it makes is that rejection, which the
    // `Then` clause already states: as a precondition it would only say the outcome twice, in
    // the clause a tester reads for what to arrange rather than for what to check.
    if (outcomes.some((outcome) => statesTheSameThing(precondition, outcome))) continue;
    seen.add(precondition);
    lines.push(`And ${precondition}`);
  }
  return lines;
}

/**
 * The `When` clause: the action, and only the action. What distinguishes this scenario from
 * the next one is a precondition, stated in `Given`; echoing the branch here would state it
 * twice and would put the branch's own text in a clause a tester pastes.
 */
function whenLine(routeKey) {
  const { verb, path } = splitRouteKey(routeKey);
  return verb ? `When a ${verb} request is made to ${path}` : `When the ${routeKey} entry point is triggered`;
}

/**
 * The outcomes a `Then` clause may assert: the writes, the emitted messages and the pushes
 * the walk recorded, whether they are this seed's own or reached on every request. A
 * read is not an outcome, and neither is an always-reached outbound call, whose access the
 * facts do not record — those are stated as a setup note rather than asserted.
 */
function observableOutcomes(seed) {
  const own = (seed.outcomes || []).filter((outcome) => !isRead(outcome)).map(outcomeLabel);
  const always = (seed.always || [])
    .filter((outcome) => !isRead(outcome) && outcome.kind !== 'http_out')
    .map((outcome) => `${outcomeLabel(outcome)} (always)`);
  return [...own, ...always];
}

/** The infrastructure this route reaches on every request whatever the branch decides —
 *  dropped from `Then`, kept as a note, so nothing the walk saw is lost by not asserting it. */
function infrastructureHops(seed) {
  return (seed.always || [])
    .filter((outcome) => isRead(outcome) || outcome.kind === 'http_out')
    .map(outcomeLabel);
}

/**
 * `{ lines, todos }` — the `Then` clause's own outcome lines, and the questions the evidence
 * cannot answer. A contract the walk does not know is a TODO under the block, never a
 * `decide:` clause: a Gherkin clause is pasted into a case tool as written, and "decide"
 * is an instruction to the reader, not something the endpoint does.
 */
function draftOutcome(seed) {
  const lines = [];
  const todos = [];
  if (seed.kind === 'fault') {
    const status = mappedFaultStatus(seed);
    const name = exceptionNameFrom(seed.response);
    if (status !== null) {
      lines.push(`the request is rejected with ${statusWords(status)}`);
      return { lines, todos };
    }
    const words = name ? humanWords(name.replace(/Exception$/, '')) : '';
    lines.push(words ? `the request fails with an unhandled ${words} error` : 'the request fails with an unhandled error');
    todos.push(
      `Confirm the intended contract: ${name || 'the thrown type'} is unhandled today, so the caller sees a 500.`,
    );
    return { lines, todos };
  }
  const status = statusFor(seed);
  if (status !== null) {
    lines.push(
      status >= 400 ? `the request is rejected with ${statusWords(status)}` : `the request responds with ${statusWords(status)}`,
    );
  }
  lines.push(...observableOutcomes(seed));
  if (lines.length === 0) {
    lines.push('the request returns with no observable write');
    if (seed.kind === 'reject') {
      todos.push('Confirm the response status for this branch — the branch itself does not imply one.');
    }
  }
  return { lines, todos };
}

/** How one sink reads in a title: what it is, not the shorthand the `Then` clause needs to
 *  keep verbatim for a second tool to join on. */
function sinkPhrase(outcome) {
  const ref = String(outcome.ref || '');
  if (outcome.kind === 'message') return `publishes the ${humanWords(ref.replace(/Message$/, ''))} message`;
  if (outcome.kind === 'push') return `sends the ${humanWords(ref)}`;
  if (outcome.kind === 'db') return `writes to the ${humanWords(ref.replace(/Repository(V\d+)?$/, '$1'))} store`;
  if (outcome.kind === 'http_out') return `calls ${humanWords(ref.split(/[ .]/)[0])}`;
  return `reaches ${humanWords(ref)}`;
}

/** The branches this seed is actually about — every decision it took that was not the happy
 *  side, in the order the walk met them, the same ones `scaffold`'s own title reads. */
function decidingEntries(seed) {
  return (seed.dispositions || []).filter((entry) => HAPPY_DISPOSITIONS[entry.kind] !== entry.disposition);
}

/**
 * Whether a condition says no more than the outcome beside it already does. A branch the tool
 * could only read by the rejection it makes states that rejection twice when the outcome is
 * that same rejection — "rejects the request with 400 Bad Request when the request is rejected
 * with 400 Bad Request" tells a reader nothing, so the title reaches further back instead.
 */
function statesTheSameThing(condition, outcome) {
  if (!condition || condition === outcome) return true;
  const match = /^the request (?:is rejected with|passes the) (.+?)(?: check)?$/.exec(condition);
  return Boolean(match) && outcome.includes(match[1]);
}

/** How long a scenario title runs before its tail is cut at a word boundary. */
const MAX_TITLE_CHARS = 120;

/**
 * The scenario title: what the endpoint does, and the condition it does it under, as one
 * sentence a reader judges without opening the branch. Never the branch's own text — the
 * traceability comment below the heading is where a reader goes back to the seed.
 */
export function draftTitle(seed) {
  const outcome = titleOutcome(seed);
  const branches = decidingEntries(seed);
  let condition = null;
  for (let index = branches.length - 1; index >= 0 && condition === null; index -= 1) {
    const phrase = draftPhrase(branches[index]);
    if (!statesTheSameThing(phrase, outcome)) condition = phrase;
  }
  // No deciding branch at all is the happy path and says so; a deciding branch that only
  // restates the outcome is left unsaid rather than turned into "… on the happy path",
  // which for a rejection would be a contradiction the evidence never claimed.
  const suffix = condition ? ` when ${condition}` : branches.length === 0 ? ' on the happy path' : '';
  const body = `${outcome}${suffix}`;
  const full = seed.reachability === 'edge' ? `${body} (edge: route arg)` : body;
  if (full.length <= MAX_TITLE_CHARS) return full;
  const cut = full.slice(0, MAX_TITLE_CHARS - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > MAX_TITLE_CHARS / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** A title's leading half: the outcome, in the same words the `Then` clause states it. */
function titleOutcome(seed) {
  if (seed.kind === 'fault') {
    const status = mappedFaultStatus(seed);
    if (status !== null) return `rejects the request with ${statusWords(status)}`;
    const name = exceptionNameFrom(seed.response);
    const words = name ? humanWords(name.replace(/Exception$/, '')) : '';
    return words ? `fails with an unhandled ${words} error` : 'fails with an unhandled error';
  }
  const status = statusFor(seed);
  if (seed.kind === 'reject') {
    return status !== null ? `rejects the request with ${statusWords(status)}` : 'returns with no observable write';
  }
  const own = (seed.outcomes || []).filter((outcome) => !isRead(outcome));
  const always = (seed.always || []).filter((outcome) => !isRead(outcome) && outcome.kind !== 'http_out');
  const primary = own[0] || always[0] || null;
  if (primary) return sinkPhrase(primary);
  return status !== null ? `responds with ${statusWords(status)}` : 'returns with no observable write';
}

/**
 * One `## Scenario:` block for one seed — the Gherkin-shaped sibling of `renderCaseBlock`,
 * from the same evidence, carrying the seed's stable `#key` as a traceability comment
 * (never a case-tool field) and a case id that is always pending. Everything the walk saw but
 * the case does not assert — the infrastructure it always reaches, the tests that already
 * exercise the route, the contract nobody has decided — rides below the clauses as a note,
 * so the three clauses themselves are pasteable exactly as they stand.
 */
export function renderScenarioBlock(seed, routeKey, levels) {
  const heading = `## Scenario: ${routeKey} · ${draftTitle(seed)}`;
  const traceability = `<!-- ${seed.id} #${seed.key} -->`;
  const { lines, todos } = draftOutcome(seed);
  const then = lines.map((line, index) => `${index === 0 ? 'Then' : 'And'} ${line}`);
  const hops = infrastructureHops(seed);
  const evidence = evidenceFor(seed, routeKey, levels);
  return [
    heading,
    '',
    traceability,
    '',
    ...givenLines(seed, routeKey, lines),
    whenLine(routeKey),
    ...then,
    ...(hops.length > 0 ? ['', `**Also reached on every request, not asserted:** ${hops.join(', ')}`] : []),
    ...(evidence.covered ? ['', `**Already exercised by:** ${evidence.text}`] : []),
    ...(todos.length > 0 ? ['', '**TODO before filing:**', ...todos.map((todo) => `- ${todo}`)] : []),
    '',
    `**Case id:** ${GHERKIN_CASE_ID_NOTE}`,
  ].join('\n');
}

/**
 * The fallback block for a route with no seed to draft from at all — reachability
 * filtered every seed away, the walk itself failed, or the route truly carries none.
 * `Given` reduces to the bare route identity; `When`/`Then` state the same absence of
 * data honestly rather than fabricate a trigger or an outcome.
 */
export function renderBareScenarioBlock(routeKey) {
  return [
    `## Scenario: ${routeKey}`,
    '',
    `Given ${routeIdentity(routeKey)}`,
    whenLine(routeKey),
    'Then the request reaches no traced outcome this tool can state',
    '',
    '**TODO before filing:**',
    '- Write the expected outcome by hand — the walk produced no seed for this route to state one from.',
    '',
    `**Case id:** ${GHERKIN_CASE_ID_NOTE}`,
  ].join('\n');
}

/** `route -> file -> cases -> fault -> uncovered`, the review page for a `cases` run. */
export function renderIndex(result) {
  const lines = [
    `# cases — ${result.area}`,
    '',
    `${result.counts.routes} routes · ${result.counts.cases} cases · ` +
      `${result.counts.faultCases} fault cases · ${result.counts.uncovered} uncovered · ` +
      `${result.counts.unreachable} unreachable`,
    '',
    '| route | file | cases | fault | uncovered |',
    '|---|---|---|---|---|',
  ];
  for (const file of result.files) {
    lines.push(`| \`${file.route}\` | \`${file.file}\` | ${file.cases} | ${file.faultCases} | ${file.uncovered} |`);
  }
  if (result.skipped.length > 0) {
    lines.push('', '## No seed at or below the level filter', '');
    for (const key of result.skipped) lines.push(`- \`${key}\``);
  }
  if (result.unreachable.length > 0) {
    lines.push('', `## Unreachable from a black-box caller (${result.counts.unreachable})`, '');
    for (const entry of result.unreachable) {
      lines.push(`- \`${entry.route}\` ${entry.id} \`#${entry.key}\`${entry.reason ? ` — ${entry.reason}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Walk every route, keep the seeds at or below `filter.maxLevel`, and write one case
 * sheet per route plus `INDEX.md`. `dryRun` returns the same result with nothing on
 * disk; `options.seeds` bypasses the walker entirely, the way `scaffold`'s does, for a
 * caller that already has the seed list (tests, a pre-built packet run).
 * `includeUnreachable` restores the seeds no black-box caller can force, which are
 * dropped by default and listed in a footer instead.
 */
export function cases(options = {}) {
  const filter = options.filter || {};
  const maxLevel = filter.maxLevel || 'skipped';
  if (!MAX_LEVELS.includes(maxLevel)) {
    throw new Error(`cases: unknown level "${maxLevel}" (expected ${MAX_LEVELS.join(', ')})`);
  }
  const outDir = options.outDir || null;
  if (outDir) assertOutsideRepos(outDir, options.repoRoots);

  const routes = options.seeds ? normaliseSeedInput(options.seeds) : walkRoutes(options);
  const levels = evidenceIndex(options.cover);
  const seedFilter = filter.seedKeys && filter.seedKeys.length > 0 ? new Set(filter.seedKeys) : null;

  const includeUnreachable = options.includeUnreachable === true;
  const gherkinDraft = options.gherkinDraft === true;
  const ordered = [...routes].sort((a, b) => compare(a.key, b.key));
  const taken = new Set();
  const gherkinTaken = new Set();
  const files = [];
  const gherkinFiles = [];
  const skipped = [];
  const unreachable = [];

  for (const route of ordered) {
    const dropped = [];
    const included = (route.seeds || []).filter((seed) => {
      const info = lookupEvidence(route.key, seed, levels);
      const level = info ? info.level : 'none';
      if (STATE_ORDER[level] > STATE_ORDER[maxLevel]) return false;
      if (seedFilter && !seedFilter.has(seed.key)) return false;
      if (!keepsSeed(seed, includeUnreachable)) {
        dropped.push(unreachableEntry(seed));
        return false;
      }
      return true;
    });
    for (const entry of dropped) unreachable.push({ route: route.key, ...entry });

    // `--gherkin-draft` writes one draft file per route regardless of `--max-level`: a
    // route already fully covered still gets a Given/When/Then draft for every seed, not
    // just its gaps — the plain sheet's coverage-gap framing does not apply here. Only
    // `--seed` and the reachability filter (both orthogonal to coverage level) narrow it.
    if (gherkinDraft) {
      const draftDropped = [];
      const draftSeeds = (route.seeds || []).filter((seed) => {
        if (seedFilter && !seedFilter.has(seed.key)) return false;
        if (!keepsSeed(seed, includeUnreachable)) {
          draftDropped.push(unreachableEntry(seed));
          return false;
        }
        return true;
      });
      const scenarioBlocks =
        draftSeeds.length > 0
          ? draftSeeds.map((seed) => renderScenarioBlock(seed, route.key, levels))
          : [renderBareScenarioBlock(route.key)];
      const draftBody = [
        `# ${route.key} — Gherkin draft`,
        '',
        `**Path:** ${pathSummary(route.key, route.root)}`,
        '',
        scenarioBlocks.join('\n\n'),
        '',
        ...(unreachableFooter(draftDropped) ? ['---', '', `**${unreachableFooter(draftDropped)}**`] : []),
      ].join('\n');
      gherkinFiles.push({
        route: route.key,
        file: `${routeSlugFor(route.key, gherkinTaken)}.gherkin-draft.md`,
        scenarios: scenarioBlocks.length,
        contents: `${draftBody}\n`,
      });
    }

    if (included.length === 0) {
      skipped.push(route.key);
      continue;
    }
    const faultCases = included.filter((seed) => seed.kind === 'fault').length;
    const uncovered = included.filter((seed) => !evidenceFor(seed, route.key, levels).covered).length;
    const blocks = included.map((seed) => renderCaseBlock(seed, route.key, levels));
    const body = [
      `# ${route.key}`,
      '',
      `**Path:** ${pathSummary(route.key, route.root)}`,
      '',
      blocks.join('\n\n'),
      '',
      '---',
      '',
      `${included.length} cases · ${faultCases} fault cases · ${uncovered} uncovered`,
      ...(unreachableFooter(dropped) ? ['', `**${unreachableFooter(dropped)}**`] : []),
    ].join('\n');
    files.push({
      route: route.key,
      file: `${routeSlugFor(route.key, taken)}.md`,
      cases: included.length,
      faultCases,
      uncovered,
      seeds: included.map((seed) => ({ id: seed.id, key: seed.key, kind: seed.kind })),
      contents: `${body}\n`,
    });
  }

  const result = {
    area: filter.area || options.area || 'area',
    outDir,
    dryRun: options.dryRun === true,
    files,
    skipped,
    unreachable,
    includeUnreachable,
    gherkinDraft,
    gherkinFiles,
    counts: {
      routes: files.length,
      cases: files.reduce((sum, file) => sum + file.cases, 0),
      faultCases: files.reduce((sum, file) => sum + file.faultCases, 0),
      uncovered: files.reduce((sum, file) => sum + file.uncovered, 0),
      skipped: skipped.length,
      unreachable: unreachable.length,
      gherkinFiles: gherkinFiles.length,
      gherkinScenarios: gherkinFiles.reduce((sum, file) => sum + file.scenarios, 0),
    },
    maxLevel,
  };
  result.index = renderIndex(result);

  if (outDir && options.dryRun !== true) {
    mkdirSync(outDir, { recursive: true });
    for (const file of files) writeFileSync(join(outDir, file.file), file.contents);
    writeFileSync(join(outDir, 'INDEX.md'), result.index);
    result.written = files.length;
    if (gherkinDraft) {
      for (const file of gherkinFiles) writeFileSync(join(outDir, file.file), file.contents);
      result.gherkinWritten = gherkinFiles.length;
    } else {
      result.gherkinWritten = 0;
    }
  } else {
    result.written = 0;
    result.gherkinWritten = 0;
  }
  return result;
}
