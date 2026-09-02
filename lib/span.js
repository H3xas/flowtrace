/**
 * Span step — one entry route's observable behaviour, assembled outcome-first for a QA
 * reader instead of code-first for an engineer.
 *
 * `trace` prints the walk, `cover` counts the seeds, `cases` writes the sheet. This module
 * assembles nothing new: it joins what those three already hold into one model per route —
 * what the endpoint answers, what it refuses and with which status, what it publishes, who
 * answers that, and which of those outcomes a test already pins. Every number on it comes
 * from a source that can be re-derived independently, which is what makes the reconciliation
 * gate a test rather than a claim:
 *
 * - **The ledger's unit is a `cover` seed, never a row this module invents.** Rows are built
 *   by walking `cover`'s own route record, so every seed `cover --json` lists is accounted for
 *   exactly once — as a row, or as a named arm of the one row it merged into. The only merge
 *   is `dedupeOutcomeRows`' throw/catch pair, it drops nothing, and it is reported
 *   as `reconcile.deduped` so `outcomes + deduped === ledgerRows === coverSeeds` stays a test
 *   rather than a claim. The tier counts sum to the row count, and the row count plus the
 *   deduped count to the seed count.
 * - **The tiers are the tree renderer's join, not a new one.** `tested` is the same branch-outcome /
 *   asserted-status match `render-tree-html` draws as `direct`, including a fault re-pointed
 *   by an `exception_map` fact; `inherited-only` is the route tier the cover overlay already
 *   carries; `untested` is the absence of both.
 * - **Nothing here invents a case id.** A tested row's case ids come from `case_id` facts
 *   joined by the same `(spec, declLine)` key a resolved title joins on — a case-id
 *   annotation, a literal configured call or a same-file table row. Nothing looser is
 *   read: the refusing `case_id` join is the only case-id source this module trusts.
 * - **The untested rows quote `cases`.** The Gherkin block on an untested row is
 *   `renderScenarioBlock`'s own output, byte for byte, so the page can never drift from the
 *   generator a tester would otherwise run separately.
 * - **The assertion surface is `lib/assertion-surface.js`'s own, not a second derivation.**
 *   Where the state this route changes can be read back arrives from the same
 *   `assertionSurface()` the `surface` verb prints, run over the walk this module already
 *   paid for; nothing here re-reads a write, re-walks a reader or decides what a safe verb
 *   is. This module only folds that flat list into one group per state and leg, so a group
 *   on the page and a row in `surface --json` are one claim about one walk.
 * - **A verdict is read, never derived, and its absence is a signal, not a blank.** `options.verdicts`
 *   (the `surface_verdict` index `lib/skeleton.js` builds) is matched onto the observation
 *   points named outright, by the same identity `skeleton` binds a verdict to; passed, every
 *   such point gains the cached fact or `null`, and `null` prints as "judgment pending" rather
 *   than as an open question a reader mistakes for unconsidered. Omitted, no point gains the
 *   property at all, so a span built without verdict input remains the plain model.
 */

import { assertionSurface } from './assertion-surface.js';
import { cover } from './cover.js';
import {
  evidenceIndex as seedEvidenceLevels,
  expectedFor,
  pathSummary,
  phraseFor,
  preconditionBullets,
  renderScenarioBlock,
  routeSlugFor,
} from './cases.js';
import { buildRouteIndex, matchRoute, normalizeAliases } from './join.js';
import { buildCoverOverlay, tierOf } from './render-graph.js';
import { joins } from './render-tree-html.js';
import { splitRouteKey, statusFor } from './scaffold.js';
import { verdictKey } from './skeleton.js';
import { trace } from './trace.js';

const { indexFacts, lookupException, resolveTitle, statusOf, thrownType } = joins;

/** The three tags a ledger row can carry. Exactly one, always. */
export const TIERS = Object.freeze(['tested', 'inherited-only', 'untested']);

/**
 * What a tester should do first, and the only ordering this page ever prints. Untested
 * fault contracts outrank everything because an unpinned refusal is the outcome a caller
 * meets first and nothing observes today; unguarded branches follow; inherited-only rows
 * are work only once those are done; a tested row is already answered and sorts last.
 * Inside a rank the route's own seed order decides, never the order the join happened to
 * produce.
 */
export const RANKS = Object.freeze({
  'untested-fault': 0,
  'untested-branch': 1,
  'inherited-only': 2,
  tested: 3,
});

/** How many observable effects one consumer or processor names before folding the rest. */
const EFFECT_CAP = 8;

/** How many callers the entry row names outright. */
const CALLER_CAP = 6;

/** How many observation points one assertion-surface group names outright before folding. */
const OBSERVE_CAP = 3;

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function collect(factSets, type) {
  const out = [];
  for (const set of factSets || []) {
    for (const fact of set.facts || []) {
      if (fact.type === type) out.push({ repo: set.repo, fact });
    }
  }
  return out;
}

/**
 * The callers that reach this route from a client repository, from `gateway_call` facts
 * matched through the same route index every other join uses. A route nothing in the
 * facts calls resolves to its own identity rather than to a guess.
 */
export function callersOf(factSets, routeKey, aliases = []) {
  const routeIndex = buildRouteIndex(collect(factSets, 'route'));
  const normalized = normalizeAliases(aliases);
  const found = [];
  for (const { repo, fact } of collect(factSets, 'gateway_call')) {
    const match = matchRoute(routeIndex, fact.verb, fact.template, normalized);
    if (!match || match.route.key !== routeKey) continue;
    found.push({
      repo,
      service: fact.service || null,
      method: fact.method || null,
      file: fact.file,
      line: fact.line,
      template: fact.template,
      resolved: fact.resolved === true,
    });
  }
  found.sort(
    (a, b) => compare(a.repo, b.repo) || compare(a.file, b.file) || (a.line || 0) - (b.line || 0),
  );
  return found;
}

/**
 * Every node in the walk, parents before children, in the order the tree prints them.
 * `stopAt` prunes a subtree without hiding its root, which is how the synchronous half of
 * the route is read without the consumer subtrees the asynchronous section owns.
 */
function walkNodes(root, visit, stopAt = null) {
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    visit(node);
    if (stopAt && node !== root && stopAt(node)) continue;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
}

/** The boundary between the request the caller waits on and everything the bus answers. */
const isMessage = (node) => node.kind === 'message';

const SIDE_EFFECT_KINDS = new Set(['db', 'push', 'message', 'http_out']);

/** `store write`, `push`, `publish` — a sink named as something a tester could observe. */
function effectWords(node) {
  if (node.kind === 'db') return node.access === 'write' ? 'writes to' : 'reads from';
  if (node.kind === 'push') return 'pushes';
  if (node.kind === 'message') return 'publishes';
  return 'calls out to';
}

function effectsUnder(node) {
  const effects = [];
  const seen = new Set();
  walkNodes(node, (candidate) => {
    if (candidate === node) return;
    if (!SIDE_EFFECT_KINDS.has(candidate.kind)) return;
    if (candidate.kind === 'db' && candidate.access !== 'write') return;
    const key = `${candidate.kind}|${candidate.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    effects.push({
      kind: candidate.kind,
      words: effectWords(candidate),
      ref: candidate.ref,
      repo: candidate.repo,
      file: candidate.file ?? null,
      line: candidate.line ?? null,
    });
  });
  return effects;
}

/**
 * The asynchronous half of the route: every message the walk publishes, the consumers and
 * processors that answer it, and the observable effects past those. A message with no
 * consumer at all is still listed — "nothing answers this today" is the finding, not a
 * reason to hide the row.
 */
export function messagesOf(result) {
  const messages = new Map();
  walkNodes(result.root, (node) => {
    if (node.kind !== 'message') return;
    const key = node.ref;
    if (messages.has(key)) return;
    const answered = (node.children || []).filter(
      (child) => child.kind === 'consumer' || child.kind === 'processor',
    );
    messages.set(key, {
      message: node.ref,
      fqn: node.fqn ?? null,
      file: node.file ?? null,
      line: node.line ?? null,
      contract: node.contract === 'none' ? 'none' : 'declared',
      answeredBy: answered.map((child) => {
        const effects = effectsUnder(child);
        return {
          kind: child.kind,
          repo: child.repo,
          ref: child.ref,
          workType: child.workType ?? null,
          file: child.file ?? null,
          line: child.line ?? null,
          effects: effects.slice(0, EFFECT_CAP),
          effectsMore: Math.max(0, effects.length - EFFECT_CAP),
        };
      }),
    });
  });
  return [...messages.values()].sort((a, b) => compare(a.message, b.message));
}

/**
 * The services and stores that own the route, named in words rather than as a tree. The
 * walk stops at every published message: what a consumer touches belongs to the
 * asynchronous section, and listing it here would read as the endpoint's own work.
 */
export function ownersOf(result) {
  const services = [];
  const repositories = new Map();
  const seenService = new Set();
  walkNodes(result.root, (node) => {
    if (node.kind === 'db') {
      const existing = repositories.get(node.ref) || {
        ref: node.ref,
        repo: node.repo,
        access: node.access || 'read',
        infra: node.infra === true,
        methods: new Set(),
        file: node.file ?? null,
        line: node.line ?? null,
      };
      if (node.access === 'write') existing.access = 'write';
      if (node.infra !== true) existing.infra = false;
      for (const method of node.methods || []) existing.methods.add(method);
      repositories.set(node.ref, existing);
      return;
    }
    if (node.kind !== 'method' && node.kind !== 'action') return;
    if (node.infra === true) return;
    if (!node.class || seenService.has(node.class)) return;
    seenService.add(node.class);
    services.push({ ref: node.class, repo: node.repo, file: node.file ?? null, line: node.line ?? null });
  }, isMessage);
  return {
    services,
    repositories: [...repositories.values()]
      .map((entry) => ({ ...entry, methods: [...entry.methods].sort() }))
      .sort((a, b) => Number(a.infra) - Number(b.infra) || compare(a.ref, b.ref)),
  };
}

/**
 * The status this outcome really answers the caller. A fault is read through
 * `exception_map` with an action-scoped catch taking precedence over a global filter —
 * the same lookup the tree renderer annotates with — so a caught fault reads as the status
 * it surfaces as rather than as the 500 an escaping exception would be. Everything else
 * takes `cases`' own `statusFor`, so the page never states a status the sheet would not.
 */
export function outcomeStatus(seed, route, index) {
  if (seed.kind === 'fault') {
    const stated = statusOf(seed.response);
    const type = thrownType(seed.response);
    const found = type ? lookupException(index, type, route.controller, route.action) : null;
    if (!found) return { status: stated, stated, mapping: null, remapped: false };
    return {
      status: String(found.status),
      stated,
      mapping: { ...found, type },
      remapped: String(found.status) !== stated,
    };
  }
  const numeric = statusFor(seed);
  const stated = numeric === null ? null : String(numeric);
  return { status: stated, stated, mapping: null, remapped: false };
}

/** The deciding branch a row is named after — the last one on the seed's own path. */
function decidingPhrase(seed) {
  const decisions = seed.dispositions || [];
  if (decisions.length === 0) return null;
  return phraseFor(decisions[decisions.length - 1]);
}

/** One sentence a tester can read without opening the code. */
function headlineOf(seed, outcome) {
  const when = decidingPhrase(seed);
  const clause = when ? ` when ${when}` : ' on the happy path';
  if (seed.kind === 'fault' || seed.kind === 'reject') {
    const answer = outcome.status ? `answers ${outcome.status}` : 'refuses the request';
    const because = outcome.remapped ? `, because ${outcome.mapping.via} catches ${outcome.mapping.type}` : '';
    return `${answer}${because}${clause}`;
  }
  return `succeeds${clause}`;
}

/** Where the row's behaviour is written — the expander's contents, never the reading path. */
function whereOf(seed) {
  const decisions = seed.dispositions || [];
  return decisions.map((entry) => ({
    kind: entry.kind,
    disposition: entry.disposition,
    text: entry.text,
    class: entry.class ?? null,
    method: entry.method ?? null,
    file: entry.file ?? null,
    line: entry.line ?? null,
    phrase: phraseFor(entry),
  }));
}

/**
 * Everything the join needs about the tests that name this route, derived once: which of
 * them assert at all, and which statuses those assertions pin. Both are read exactly the
 * way `render-tree-html` reads them, so a `tested` row here and a `direct` badge there are
 * the same claim about the same fact.
 */
function testContext(factSets, routeKey, overlay, index) {
  const rows = (overlay && overlay.evidence.get(routeKey)) || [];
  const verifying = new Map();
  const stubOnly = new Map();
  for (const row of rows) {
    const id = `${row.spec}::${row.test}`;
    if (index.assertions.has(id)) {
      if (!verifying.has(id)) {
        verifying.set(id, { repo: row.repo, spec: row.spec, test: row.test, asserts: index.assertions.get(id).length });
      }
    } else if (!stubOnly.has(id)) {
      stubOnly.set(id, { repo: row.repo, spec: row.spec, test: row.test });
    }
  }
  const byStatus = new Map();
  for (const entry of verifying.values()) {
    for (const fact of index.assertions.get(`${entry.spec}::${entry.test}`) || []) {
      if (fact.kind !== 'status' || fact.value === null || fact.value === undefined) continue;
      const code = String(fact.value);
      const list = byStatus.get(code) || [];
      if (!list.some((test) => test.spec === entry.spec && test.test === entry.test)) list.push(entry);
      byStatus.set(code, list);
    }
  }
  return {
    verifying: [...verifying.values()].sort((a, b) => b.asserts - a.asserts || compare(a.spec, b.spec)),
    stubOnly: [...stubOnly.values()].sort((a, b) => compare(a.spec, b.spec) || compare(a.test, b.test)),
    byStatus,
    tier: tierOf(overlay, routeKey),
  };
}

/**
 * `case_id` facts, keyed the same way a resolved title is: `spec::declLine`. An
 * annotation, a literal call and a same-file table all land here — the table's rows
 * arrive as separate facts at the same line, so they are flattened into one `ids` list in
 * the table's own declaration order, the same order a collector's per-instance titles
 * carry at that line.
 */
function caseIdsByLine(factSets) {
  const byLine = new Map();
  for (const set of factSets || []) {
    for (const candidate of set.facts || []) {
      if (candidate.type !== 'case_id') continue;
      const key = `${candidate.spec}::${candidate.line}`;
      const entry = byLine.get(key) || { ids: [], source: candidate.source };
      for (const id of candidate.ids || []) entry.ids.push(id);
      if (candidate.source === 'table') entry.source = 'table';
      byLine.set(key, entry);
    }
  }
  return byLine;
}

/**
 * The case ids resolved for one test, joined the same way a title is: through the test's
 * own declaration line, never through its title text. No `case_id` fact at that line — no
 * annotation, no resolvable configured call, a cross-file table, or anything the reader
 * refuses — leaves `ids` empty rather than guessed.
 */
function resolveCaseIds(index, caseIdIndex, spec, rawTitle) {
  const line = index.declarations.get(`${spec}::${rawTitle}`);
  if (line === null || line === undefined) return { ids: [], source: null };
  return caseIdIndex.get(`${spec}::${line}`) || { ids: [], source: null };
}

/**
 * A test named the way this tool names one everywhere: repository, spec, resolved title, and
 * the case ids a `case_id` fact resolved at the same declaration line — empty
 * when no such fact exists, never a guess.
 */
function titleOf(index, caseIdIndex, entry) {
  const resolution = resolveTitle(index, entry.spec, entry.test);
  const cases = resolveCaseIds(index, caseIdIndex, entry.spec, entry.test);
  return {
    repo: entry.repo,
    spec: entry.spec,
    titles: resolution.titles,
    mechanism: resolution.mechanism,
    raw: resolution.raw,
    asserts: entry.asserts ?? null,
    caseIds: cases.ids,
  };
}

/**
 * The rank a row sorts in. A tier alone does not decide it: an untested refusal and an
 * untested happy path are different work, and the refusal is the one a caller meets first.
 */
export function rankOf(row) {
  if (row.tier === 'untested') {
    return row.outcomeKind === 'fault' ? RANKS['untested-fault'] : RANKS['untested-branch'];
  }
  return RANKS[row.tier];
}

/**
 * The ledger's only ordering, applied in one place so the page, the sections and any test
 * of the order all read the same function. `order` is the row's position in the route's own
 * seed list, so a tie never falls back to whatever order the join happened to produce.
 */
export function orderRows(rows) {
  return [...rows].sort((a, b) => rankOf(a) - rankOf(b) || a.order - b.order);
}

/**
 * Where each action-scoped `catch` clause begins and ends, read from facts only. An
 * `exception_map` fact carries the line its `catch (T)` is written on and no end line, so a
 * clause runs from its own line to the next clause in the same action, and the last clause
 * in an action runs to that action's own `method_span.endLine`. An action with no
 * `method_span` fact gets no upper bound for its last clause and is therefore never used to
 * attribute a return — an absent bound refuses the join rather than widening it.
 */
function catchClauseRanges(factSets, index) {
  const ends = new Map();
  for (const { fact } of collect(factSets, 'method_span')) {
    if (typeof fact.endLine !== 'number') continue;
    ends.set(`${fact.class}.${fact.method}@${fact.file}`, fact.endLine);
  }
  const ranges = new Map();
  for (const [via, entries] of index.byAction) {
    const byFile = new Map();
    for (const entry of entries) {
      if (typeof entry.line !== 'number') continue;
      byFile.set(entry.file, [...(byFile.get(entry.file) || []), entry]);
    }
    for (const [file, list] of byFile) {
      const sorted = [...list].sort((a, b) => a.line - b.line);
      sorted.forEach((entry, position) => {
        const next = sorted[position + 1];
        const end = next ? next.line - 1 : (ends.has(`${via}@${file}`) ? ends.get(`${via}@${file}`) : null);
        if (end === null || end <= entry.line) return;
        ranges.set(`${file}:${entry.line}`, { ...entry, via, endLine: end });
      });
    }
  }
  return ranges;
}

/** The disposition a row is named after — the last branch its own path actually took. */
function decidingEntry(row) {
  const taken = (row.where || []).filter((entry) => entry.disposition === 'taken');
  return taken.length > 0 ? taken[taken.length - 1] : null;
}

/**
 * The `catch` clause that surfaces this row's outcome, or `null`. A **throw** arm names its
 * clause outright: `outcomeStatus` already resolved the row through an action-scoped
 * `exception_map`, so the clause is the fact that mapping was read from. A **catch** arm
 * names it structurally: the row's deciding branch is an `error_return` written inside the
 * clause's own line range, in the clause's own action. Nothing here matches on a name, and a
 * row whose deciding branch is a guard or an `if` is not a catch arm however its status reads.
 */
function catchArmOf(row, ranges) {
  if (row.kind === 'fault') {
    if (!row.mapping || row.mapping.scope !== 'action' || typeof row.mapping.line !== 'number') return null;
    const clause = ranges.get(`${row.mapping.file}:${row.mapping.line}`);
    return clause ? { source: 'throw', clause } : null;
  }
  const entry = decidingEntry(row);
  if (!entry || entry.kind !== 'error_return' || !entry.file || typeof entry.line !== 'number') return null;
  const via = `${entry.class || ''}.${entry.method || ''}`;
  for (const clause of ranges.values()) {
    if (clause.file !== entry.file || clause.via !== via) continue;
    if (entry.line > clause.line && entry.line <= clause.endLine) return { source: 'catch', clause };
  }
  return null;
}

/** One arm of a merged outcome, carrying everything the arm said on its own row. */
function armOf(row, source) {
  return {
    source,
    id: row.id,
    key: row.key ?? null,
    kind: row.kind,
    status: row.status,
    stated: row.stated,
    headline: row.headline,
    reachability: row.reachability,
    coverLevel: row.coverLevel,
    coverState: row.coverState,
    preconditions: row.preconditions,
    expected: row.expected,
    where: row.where,
    gherkin: row.gherkin,
  };
}

function mergeLists(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const line of list || []) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/**
 * The throw/catch dedup: `span` carries
 * a deleted-item refusal as two rows — one seeded at the `throw`, one seeded at the `return`
 * inside the `catch` that answers it — and they are one observable contract seen from two
 * fact sources rather than two behaviours.
 *
 * The join is evidence, never a name match. Two rows merge only when all of it holds: they
 * are surfaced by the **same** `catch` clause (the throw arm through the `exception_map`
 * fact `outcomeStatus` already resolved it by, the catch arm through an `error_return`
 * written inside that clause's own line range in that clause's own action), the group holds
 * **both** kinds of arm — a group of throw arms alone or catch arms alone is not a
 * duplication and is left as it stands — and every arm agrees on the status it answers and
 * on the tier it carries. One disagreement refuses the merge outright.
 *
 * Nothing is dropped. The merged row keeps the throw arm's identity, headline and branch
 * chain, because that arm names the condition a test has to arrange; every arm — its own
 * seed id, key, headline, `Given`, `Then`, branch chain and drafted scenario — is carried on
 * `row.dedup.arms`, ordered by the route's own seed order, and the merged `Given`/`Then` is
 * the union of the arms' own lines in that order. So the page states one outcome and can
 * still be reconciled seed by seed against `cover`.
 */
export function dedupeOutcomeRows(rows, ranges) {
  const groups = new Map();
  for (const row of rows) {
    const arm = catchArmOf(row, ranges);
    if (!arm) continue;
    const key = `${arm.clause.file}:${arm.clause.line}`;
    const group = groups.get(key) || { clause: arm.clause, throws: [], catches: [] };
    (arm.source === 'throw' ? group.throws : group.catches).push(row);
    groups.set(key, group);
  }

  const merged = new Map();
  const folded = new Set();
  for (const [key, group] of groups) {
    if (group.throws.length === 0 || group.catches.length === 0) continue;
    const members = [...group.throws, ...group.catches];
    const status = members[0].status;
    const tier = members[0].tier;
    if (status === null || status === undefined) continue;
    if (members.some((row) => row.status !== status || row.tier !== tier)) continue;
    merged.set(key, group);
    for (const row of group.catches) folded.add(row.id);
    for (const row of group.throws.slice(1)) folded.add(row.id);
  }

  if (merged.size === 0) return { rows, deduped: 0 };

  const primaries = new Map();
  for (const [key, group] of merged) primaries.set(group.throws[0].id, { key, group });

  const out = [];
  for (const row of rows) {
    if (folded.has(row.id)) continue;
    const hit = primaries.get(row.id);
    if (!hit) {
      out.push(row);
      continue;
    }
    const { group } = hit;
    const arms = [
      ...group.throws.map((entry) => ({ row: entry, source: 'throw' })),
      ...group.catches.map((entry) => ({ row: entry, source: 'catch' })),
    ]
      .sort((a, b) => a.row.order - b.row.order)
      .map((entry) => armOf(entry.row, entry.source));
    const clause = group.clause;
    const next = {
      ...row,
      order: Math.min(...[...group.throws, ...group.catches].map((entry) => entry.order)),
      preconditions: mergeLists(arms.map((arm) => arm.preconditions)),
      expected: mergeLists(arms.map((arm) => arm.expected)),
      dedup: {
        clause: {
          exception: clause.exception,
          status: clause.status,
          via: clause.via,
          file: clause.file,
          line: clause.line,
          endLine: clause.endLine,
        },
        arms,
      },
    };
    next.rank = rankOf(next);
    out.push(next);
  }
  return { rows: out, deduped: folded.size };
}

/**
 * The cached verdict for one observation point, or `null` when nothing was read for it —
 * `undefined` never a substitute for `null` here, so a caller can tell "no cached fact"
 * (absent, `null`) from "verdicts were never consulted" (the key is missing outright). The
 * identity is `verdictKey`'s own, `lib/skeleton.js`'s: a verdict whose `leg` or
 * `through` does not match this exact row binds to nothing.
 */
function verdictFor(verdicts, routeKey, entry) {
  const key = verdictKey({
    route: routeKey,
    state: entry.state,
    leg: entry.leg,
    through: entry.through ? entry.through.ref : '',
    observe: entry.observe,
  });
  return verdicts.get(key) || null;
}

/**
 * A point nobody has read yet sorts after one somebody has, stably — a verdict already read
 * is exactly what a tester most needs named outright, ahead of an unread point the nearest-hop
 * sort would otherwise have shown instead. `verdicts` falsy is the identity ordering, so a
 * caller that never asks for verdicts keeps the plain nearest-hop-first order.
 */
function prioritiseVerdicted(points, verdicts) {
  if (!verdicts) return points;
  const read = points.filter((point) => point.verdict !== null);
  const unread = points.filter((point) => point.verdict === null);
  return [...read, ...unread];
}

/**
 * The assertion surface folded the way a reader asks for it: one group per state the route
 * changes on one leg, carrying the safe-verb endpoints that read that state back. Every row
 * inside a group is `lib/assertion-surface.js`'s own — this function derives nothing, it
 * groups. The flat list arrives sorted by state, leg, carrier, hops and endpoint, so the
 * groups come out in that order too and the page never depends on a map's insertion luck.
 *
 * `verdicts` is optional and additive: passed, every point gains a `verdict` property — the
 * cached `surface_verdict` fact or `null` — and the points a group names outright are chosen
 * verdicted-first (`prioritiseVerdicted`) rather than nearest-hop-first, so a correlation
 * already read is never the one folding into "+N more" while an unread one is shown instead.
 * Omitted, no point gains the property at all and the cap keeps its plain nearest-hop order.
 */
export function surfaceGroups(surface, routeKey, verdicts) {
  const groups = new Map();
  for (const entry of (surface && surface.surfaces) || []) {
    const key = `${entry.state}|${entry.leg}|${entry.through ? entry.through.ref : ''}`;
    const group = groups.get(key) || {
      key,
      state: entry.state,
      leg: entry.leg,
      through: entry.through,
      writes: entry.writes || [],
      file: entry.writeFile ?? null,
      line: entry.writeLine ?? null,
      points: [],
      total: 0,
    };
    group.total += 1;
    const point = {
      observe: entry.observe,
      verb: entry.verb,
      template: entry.template,
      hops: entry.hops,
      repo: entry.repo,
      file: entry.file ?? null,
      line: entry.line ?? null,
    };
    if (verdicts) point.verdict = verdictFor(verdicts, routeKey, entry);
    group.points.push(point);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const { points, ...rest } = group;
    const ordered = prioritiseVerdicted(points, verdicts);
    const observe = ordered.slice(0, OBSERVE_CAP);
    return { ...rest, observe, observeMore: Math.max(0, group.total - observe.length) };
  });
}

/**
 * Confirmed / refused / pending, counted over the observation points the section actually
 * names outright — never the ones a group folds into "+N more", which the page never prints
 * individually and so has nothing to annotate. `undefined` (verdicts never consulted) yields
 * `null`, the same "not evaluated" signal `surfaceGroups` itself carries.
 */
export function verdictCountsOf(groups) {
  if (!groups.some((group) => group.observe.some((point) => point.verdict !== undefined))) return null;
  const counts = { confirmed: 0, refused: 0, pending: 0 };
  for (const group of groups) {
    for (const point of group.observe) {
      if (point.verdict === undefined) continue;
      if (point.verdict === null) counts.pending += 1;
      else if (point.verdict.reflects === true) counts.confirmed += 1;
      else counts.refused += 1;
    }
  }
  counts.total = counts.confirmed + counts.refused + counts.pending;
  return counts;
}

/**
 * One route's whole span: the map, the ledger, the assertion surface and the limits, from
 * facts already on disk. `options.trace` replaces the walker in tests; `options.specs`
 * narrows the evidence the same way it narrows every other renderer.
 */
export function span(factSets, routeKey, options = {}) {
  const sets = factSets || [];
  const aliases = options.aliases || [];
  const walked = new Map();
  const walker = (facts, key, walkOptions) => {
    if (!walked.has(key)) walked.set(key, (options.trace || trace)(facts, key, walkOptions));
    return walked.get(key);
  };

  const report = cover(sets, {
    area: routeKey,
    keys: [routeKey],
    aliases,
    traceOptions: options.traceOptions,
    trace: walker,
  });
  const record = report.routes[0];
  const result = walked.get(routeKey) || {};
  if (record.error || record.candidates) {
    return { error: record.error || 'ambiguous start', candidates: record.candidates || null, route: { key: routeKey } };
  }

  const index = indexFacts(sets);
  const caseIdIndex = caseIdsByLine(sets);
  const overlay = buildCoverOverlay(sets, { specs: options.specs || '', aliases });
  const tests = testContext(sets, routeKey, overlay, index);
  const levels = seedEvidenceLevels(report);
  const { verb, path } = splitRouteKey(routeKey);
  const routeFact = (result.root && result.root.route) || {};
  const route = {
    key: routeKey,
    verb: verb || null,
    path: path || routeKey,
    controller: routeFact.controller ?? null,
    action: routeFact.action ?? null,
    repo: result.root ? result.root.repo : null,
    file: result.root ? result.root.file ?? null : null,
    line: result.root ? result.root.line ?? null : null,
    chain: pathSummary(routeKey, result.root),
  };

  const callers = callersOf(sets, routeKey, aliases);
  const seedsById = new Map((result.seeds || []).map((seed) => [seed.id, seed]));
  const rows = record.seeds.map((seedRecord, position) => {
    const seed = seedsById.get(seedRecord.id);
    if (!seed) throw new Error(`span: cover seed ${seedRecord.id} has no walked seed behind it`);
    const outcome = outcomeStatus(seed, route, index);
    const tier =
      outcome.status && tests.byStatus.has(outcome.status)
        ? 'tested'
        : tests.tier === 'asserted' || tests.tier === 'stubbed-only'
          ? 'inherited-only'
          : 'untested';
    const row = {
      order: position,
      id: seed.id,
      key: seed.key ?? null,
      kind: seed.kind,
      outcomeKind: seed.kind === 'effect' ? 'success' : 'fault',
      status: outcome.status,
      stated: outcome.stated,
      mapping: outcome.mapping,
      remapped: outcome.remapped,
      headline: headlineOf(seed, outcome),
      preconditions: preconditionBullets(seed),
      expected: expectedFor(seed),
      reachability: seed.reachability || 'unknown',
      reachabilityReason: seed.reachabilityReason || null,
      where: whereOf(seed),
      tier,
      coverLevel: seedRecord.level,
      coverState: seedRecord.state,
      tests:
        tier === 'tested'
          ? (tests.byStatus.get(outcome.status) || []).map((entry) => titleOf(index, caseIdIndex, entry))
          : tier === 'inherited-only'
            ? (tests.tier === 'asserted' ? tests.verifying : tests.stubOnly).map((entry) => titleOf(index, caseIdIndex, entry))
            : [],
      gherkin: tier === 'untested' ? renderScenarioBlock(seed, routeKey, levels) : null,
    };
    row.rank = rankOf(row);
    return row;
  });

  const { rows: outcomes, deduped } = dedupeOutcomeRows(rows, catchClauseRanges(sets, index));
  const ordered = orderRows(outcomes);
  const surface = assertionSurface(sets, routeKey, result, {
    sinks: (options.traceOptions || {}).sinks,
  });
  const surfaceGroupList = surfaceGroups(surface, routeKey, options.verdicts);
  const counts = {
    tested: outcomes.filter((row) => row.tier === 'tested').length,
    'inherited-only': outcomes.filter((row) => row.tier === 'inherited-only').length,
    untested: outcomes.filter((row) => row.tier === 'untested').length,
    total: outcomes.length,
  };

  return {
    route,
    slug: routeSlugFor(routeKey),
    entry: {
      resolved: callers.length > 0,
      callers: callers.slice(0, CALLER_CAP),
      callersMore: Math.max(0, callers.length - CALLER_CAP),
      identity: routeKey,
    },
    owners: ownersOf(result),
    outcomes: {
      success: ordered.filter((row) => row.outcomeKind === 'success'),
      fault: ordered.filter((row) => row.outcomeKind === 'fault'),
    },
    messages: messagesOf(result),
    ledger: { rows: ordered, counts, order: Object.keys(RANKS) },
    surface: {
      groups: surfaceGroupList,
      states: surface.states,
      gaps: surface.gaps,
      counts: surface.counts,
      limits: surface.limits,
      verdictCounts: verdictCountsOf(surfaceGroupList),
    },
    evidence: {
      tier: tests.tier,
      verifying: tests.verifying.map((entry) => titleOf(index, caseIdIndex, entry)),
      stubOnly: tests.stubOnly.map((entry) => titleOf(index, caseIdIndex, entry)),
      assertedStatuses: [...tests.byStatus.keys()].sort(),
      specs: record.evidence.specs,
    },
    reconcile: {
      coverSeeds: record.seeds.length,
      // The seeds the ledger accounts for, which is what "reconciles with cover" means:
      // one row per seed until a throw/catch pair merges, and then the merged row's
      // own seed plus every arm it carries. `outcomes` is the row count the page prints.
      ledgerRows: ordered.length + deduped,
      outcomes: ordered.length,
      deduped,
      seedsTruncated: record.seedsTruncated || 0,
      keys: record.seeds.map((seed) => seed.id),
    },
    limits: {
      seedsTruncated: record.seedsTruncated || 0,
      specs: overlay.specs,
      unmatchedSpecs: overlay.unmatchedSpecs,
      globalFilters: index.filters,
      scopedActions: index.byAction.size,
      caseIds:
        'case_id facts join a tested row by (spec, declLine); a case-id annotation, a literal configured call or a same-file table row resolves, anything else — a subscript, a computed value, a cross-file table — stays absent rather than guessed',
      runtime: 'every edge on this page is source-inferred; none is runtime-confirmed',
      symmetric: 'outcome-symmetric branches stay unattributable without per-test runtime line hits (cover --runtime)',
      dedup:
        'a throw row and the row seeded inside the catch that answers it merge into one outcome only when the same exception_map clause surfaces both and they agree on status and tier; an exception_map fact carries no end line, so a clause runs to the next clause in its action or to that action\'s own method_span end, and an action with no method_span never attributes a return at all',
    },
  };
}
