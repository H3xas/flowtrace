/**
 * Skeleton generation — one derived assertion surface into a starting spec in the target
 * suite's own conventions.
 *
 * `surface` answers where the state an entry route changes can be read back. This module
 * writes the next step and only that step: one `test()` per written state, calling the
 * route and then reading the state back through the endpoint the surface itself named.
 * Nothing here re-derives a surface, and nothing here consults an index — the model and
 * the fact sets behind it are the whole input, so two runs over the same surface agree
 * byte for byte.
 *
 * Five rules keep a skeleton honest, and each one is the same posture `surface` already
 * takes on a broken chain:
 *
 * - **It never invents an observation point.** Every read-back targets an endpoint the
 *   surface derived, and the block prints the chain that reached it, so an assertion is
 *   re-walked rather than trusted. A state whose surface is a gap is emitted as a parked
 *   block naming the gap and its evidence, never as an assertion against a plausible
 *   endpoint.
 * - **It never invents a helper.** The suite owns its setup: a client the caller's helper
 *   map names is imported and called, and one it does not name is a `TODO` carrying the
 *   `pw_request` evidence of a spec that already sends that request — the place a reader
 *   finds the real helper — beside a request-context call the reader replaces.
 * - **It never invents a correlation.** Which response field reflects a particular write
 *   is a judgment, not a walk. A `surface_verdict` fact an agent or a human cached, with
 *   the `file:line` of the projection path it was read from, turns the read-back into a
 *   field assertion; without one the block asserts that the endpoint answers and marks the
 *   field-level claim as unfilled.
 * - **It never invents a case id.** Every block carries the harness's own case-id
 *   placeholder until a human supplies the real one.
 * - **It never invents an acceptance criterion.** A block's title is a drafted one only when
 *   a `cases --gherkin-draft` scenario's own `Then` clause names this write — the same sink
 *   line the same walk recorded. A write no draft names keeps the surface-derived title and
 *   says so rather than borrowing the nearest scenario.
 *
 * One written state read back through one endpoint is one contract, however many legs reach
 * it, so two surface rows agreeing on both emit one test rather than the same assertion
 * twice — the dedup a reviewer otherwise makes by hand. Nothing is dropped: a merged block
 * names every leg and every chain it covers.
 *
 * A route on which nothing resolved produces no assertion at all: the plan is refused, and
 * the stub it can write instead names every gap that refused it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_CONVENTIONS, caseIdImportLine, mergeConventions, splitRouteKey } from './scaffold.js';

/** The identifiers a reader greps for, in the same spirit as `scaffold`'s own. */
export const UNRESOLVED = Object.freeze({
  pathParam: 'UNRESOLVED_PATH_PARAM',
  expected: 'UNRESOLVED_EXPECTED_VALUE',
});

const SEPARATOR = ' · ';

const VERB_METHODS = Object.freeze({ GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' });
const TITLE_CAP = 120;

/** Why a block is parked: the state is written, and no derived endpoint can observe it. */
const GAP_FIXME = 'assertion surface gap';

/** The suffix `cases --gherkin-draft` writes its Gherkin sibling under, one file per route. */
const DRAFT_SUFFIX = '.gherkin-draft.md';

/** How many drafted scenarios a block prints in full before it counts the rest. */
const AC_CAP = 5;

/** The shortest a borrowed acceptance criterion may be clipped to before it is dropped. */
const AC_MIN = 16;

/** How long a drafted `When` trigger prints before it points back at the draft for the rest. */
const AC_WHEN_CAP = 200;

/** The two client instances a block can hold: the one that writes, the one that reads back. */
const ACT_VARIABLE = 'client';
const OBSERVER_VARIABLE = 'observer';

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A value for a `'…'` literal: escaped, but faithful — a route template keeps its braces. */
function literal(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, ' ');
}

/**
 * A `test()` title: one line, escaped for a `'…'` literal, and faithful — a title naming an
 * endpoint keeps the braces of its template, which is what a reader matches a case against.
 */
function specTitle(text, cap = TITLE_CAP) {
  const flat = String(text ?? '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
  return literal(clipped);
}

/** A `// …` line: one line, no comment terminator smuggled through it. */
function commentText(text) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\*\//g, '* /')
    .trim();
}

/** `orders/v1/cart/items/{id}` and `.../${id}` both key as `.../\*`. */
export function normaliseTemplate(template) {
  return String(template ?? '')
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/\{[^}]*\}/g, '*')
    .replace(/:[^/]+/g, '*');
}

/** The named parameters of a route template, in the order the template writes them. */
export function templateParams(template) {
  return [...String(template ?? '').matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/**
 * One `cases --gherkin-draft` file, read back into the scenarios it states. The draft is the
 * markdown a human reviews and pastes; this parses that same file rather than a second
 * machine format, so the acceptance criterion a spec is titled after is the one a reviewer
 * read. A file that carries no `# <route> — Gherkin draft` heading is not a draft and is `null`.
 */
export function parseGherkinDraft(text) {
  const body = String(text ?? '');
  const heading = body.match(/^# (.+?) — Gherkin draft$/m);
  if (!heading) return null;
  const route = heading[1].trim();
  const scenarios = [];
  for (const chunk of body.split(/\n(?=## Scenario: )/).slice(1)) {
    const lines = chunk.split('\n');
    const heard = lines[0].slice('## Scenario: '.length).trim();
    const title = heard === route ? '' : heard.startsWith(`${route} · `) ? heard.slice(route.length + 3) : heard;
    const marker = chunk.match(/^<!-- (\S+) #(\S+) -->$/m);
    const given = [];
    const then = [];
    let when = '';
    let clause = 'given';
    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('**Case id:**')) break;
      if (trimmed.startsWith('When ')) {
        when = trimmed.slice('When '.length);
        clause = 'then';
      } else if (trimmed.startsWith('Given ')) {
        given.push(trimmed.slice('Given '.length));
      } else if (trimmed.startsWith('Then ')) {
        then.push(trimmed.slice('Then '.length));
        clause = 'then';
      } else if (trimmed.startsWith('And ')) {
        (clause === 'given' ? given : then).push(trimmed.slice('And '.length));
      }
    }
    scenarios.push({
      id: marker ? marker[1] : null,
      key: marker ? marker[2] : null,
      title,
      given,
      when,
      then,
    });
  }
  return { route, scenarios };
}

/**
 * Every draft in one `cases --gherkin-draft --out <dir>` directory, keyed by the route its own
 * heading names — never by guessing the slug back into a route key. An absent or unreadable
 * directory is empty, the same way an absent helper map is: a draft nobody wrote is absent,
 * never assumed.
 */
export function readDrafts(dir) {
  const index = new Map();
  if (!dir || !existsSync(dir)) return index;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return index;
  }
  for (const name of entries.filter((entry) => entry.endsWith(DRAFT_SUFFIX)).sort(compare)) {
    let parsed = null;
    try {
      parsed = parseGherkinDraft(readFileSync(join(dir, name), 'utf8'));
    } catch {
      parsed = null;
    }
    if (!parsed || index.has(parsed.route)) continue;
    index.set(parsed.route, { file: name, route: parsed.route, scenarios: parsed.scenarios });
  }
  return index;
}

/**
 * The preconditions a drafted `Given` states that a spec author has to arrange — the route's
 * own identity is not one, and neither is the coverage evidence `cases` lists beside it, which
 * records that a test already exercises the endpoint rather than anything to set up. What is
 * left is what actually distinguishes two scenarios that share a trigger, a feature toggle
 * above all, so the block prints it rather than two identical lines.
 */
function preconditions(scenario, route) {
  return (scenario.given || []).filter(
    (line) => line !== `the ${route} endpoint` && !/ already exercises this endpoint$/.test(line),
  );
}

/** A drafted `Then` line without the `(always)` qualifier `cases` appends to an undecided sink. */
function outcomeText(line) {
  return String(line ?? '')
    .replace(/\s+\(always\)$/, '')
    .trim();
}

/**
 * The drafted scenarios whose own `Then` clause names this write, and the line that named it.
 * The join is between two readings of the same walk, not a name match: a synchronous leg is
 * named by the `db <store>.<method>` sink line for a method the surface itself recorded on
 * that state, an asynchronous one by the `⇝ <message>` publish whose processor performs the
 * write. A write no drafted `Then` names matches nothing, and its block keeps the
 * surface-derived title rather than borrowing the nearest scenario.
 */
export function draftedFor(scenarios, state, route = '') {
  if (!state || !state.state) return [];
  const methods = (state.methods || []).filter(Boolean);
  const message = state.through ? state.through.message : null;
  const matches = [];
  for (const scenario of scenarios || []) {
    for (const line of scenario.then || []) {
      const outcome = outcomeText(line);
      const hit =
        state.leg === 'async'
          ? Boolean(message) && (outcome === `⇝ ${message}` || outcome.startsWith(`⇝ ${message} `))
          : methods.length > 0
            ? methods.some((method) => outcome === `db ${state.state}.${method}`)
            : outcome.startsWith(`db ${state.state}.`);
      if (!hit) continue;
      matches.push({
        key: scenario.key,
        id: scenario.id,
        title: scenario.title,
        given: preconditions(scenario, route),
        when: scenario.when,
        outcome,
      });
      break;
    }
  }
  return matches;
}

/** The stable identity of one cached verdict: the write, the state and the endpoint. */
export function verdictKey(row) {
  return [
    row.route ?? '',
    row.state ?? '',
    row.leg ?? '',
    row.through ?? '',
    row.observe ?? '',
  ].join('|');
}

/**
 * Every cached `surface_verdict`, keyed by the surface it answers. A verdict is read, never
 * derived: a state with no verdict is a state whose field-level correlation this tool does
 * not know, and the block says so instead of picking a field.
 */
export function verdictIndex(factSets) {
  const index = new Map();
  for (const set of factSets || []) {
    for (const item of set.facts || []) {
      if (item.type !== 'surface_verdict') continue;
      index.set(verdictKey(item), item);
    }
  }
  return index;
}

/**
 * Requests the target suite already sends, keyed `VERB <normalised template>`. This is the
 * evidence a missing-helper `TODO` carries: the spec and line where a helper that already
 * sends this request is called, rather than a guess at that helper's name.
 */
export function requestIndex(factSets) {
  const index = new Map();
  for (const set of factSets || []) {
    for (const item of set.facts || []) {
      if (item.type !== 'pw_request') continue;
      const key = `${item.verb} ${normaliseTemplate(item.template)}`;
      const rows = index.get(key) || [];
      rows.push({ spec: item.spec || item.file, line: item.line, via: item.via || null });
      index.set(key, rows);
    }
  }
  for (const [key, rows] of index) {
    rows.sort((a, b) => (a.via === b.via ? 0 : a.via === 'helper' ? -1 : 1) || compare(a.spec, b.spec) || a.line - b.line);
    index.set(key, rows);
  }
  return index;
}

/** The helper the map names for one request, by exact route key or by normalised template. */
export function helperFor(helpers, verb, template) {
  const map = helpers || {};
  const exact = map[`${verb} ${template}`];
  if (exact) return exact;
  const normalised = map[`${verb} ${normaliseTemplate(template)}`];
  return normalised || null;
}

/** `{ module, className, method, … }` read from a JSON file; an unreadable file is empty. */
export function readHelpers(file) {
  if (!file || !existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** A cached-verdict fact file, read as one more fact set; an unreadable file is empty. */
export function readVerdictFacts(file) {
  if (!file || !existsSync(file)) return { repo: 'verdicts', kind: 'surface-verdict', facts: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      repo: raw.repo ?? 'verdicts',
      kind: raw.kind ?? 'surface-verdict',
      facts: Array.isArray(raw.facts) ? raw.facts : [],
    };
  } catch {
    return { repo: 'verdicts', kind: 'surface-verdict', facts: [] };
  }
}

function stateIdentity(row) {
  return [row.state ?? '', row.leg ?? '', row.through ? row.through.ref : ''].join('|');
}

/**
 * The observation point one state's block reads back through: the endpoint the caller
 * pinned with `observe`, or — with nothing pinned — the shortest chain the surface derived,
 * which is the order `assertionSurface` already sorted its rows into.
 */
export function observationFor(model, state, observe) {
  const wanted = observe ? normaliseTemplate(observe) : null;
  const identity = stateIdentity(state);
  for (const row of model.surfaces || []) {
    if (stateIdentity(row) !== identity) continue;
    if (wanted && normaliseTemplate(row.template) !== wanted && normaliseTemplate(row.observe) !== wanted) continue;
    return row;
  }
  return null;
}

function legPhrase(state) {
  if (state.leg === 'async') {
    return state.through ? `async via ${state.through.ref}` : 'async';
  }
  return 'sync';
}

/** `Store async via Processor`, plus the count of further legs a merged block also covers. */
function stateLabel(block) {
  const name = block.state ? block.state : 'no state reached';
  const leg = block.state
    ? legPhrase({ leg: block.leg, through: block.through ? { ref: block.through } : null })
    : '';
  const extra = (block.mergedLegs || []).length;
  const tail = extra > 0 ? ` (+${extra} leg${extra === 1 ? '' : 's'})` : '';
  return `${leg ? `${name} ${leg}` : name}${tail}`;
}

/** How many further drafted scenarios a block covers beyond the one it is titled after. */
function acMore(rows) {
  return rows.length > 1 ? ` (+${rows.length - 1} drafted)` : '';
}

/**
 * A block's title. With a drafted acceptance criterion it leads with the criterion and keeps
 * the surface identity behind it, so a reader sees both what is claimed and where it is
 * observed; the identity half is never clipped away to make room for the borrowed half, and a
 * criterion with no room left to state is dropped from the title rather than shortened to
 * nonsense — the block still prints it in full below.
 */
function blockTitle(block) {
  const tail = block.observe ? `observe ${block.observe}` : `gap ${block.reason || 'unresolved'}`;
  const surfaceTitle = () => specTitle([stateLabel(block), tail].join(SEPARATOR));
  const rows = block.ac || [];
  if (rows.length === 0) return surfaceTitle();
  // A criterion naming `db <store>.<method>` or `⇝ <message>` already states the write the
  // surface label would repeat, so only the identity it leaves unsaid rides behind it — the
  // store when the criterion does not name it, and the merged-leg count, which nothing else
  // states. The leg itself is not dropped: every block prints it as a `// surface:` line.
  const outcome = rows[0].outcome;
  const extra = (block.mergedLegs || []).length;
  const legs = extra > 0 ? ` (+${extra} leg${extra === 1 ? '' : 's'})` : '';
  const named = Boolean(block.state) && outcome.includes(block.state);
  const identity = block.state && (!named || legs) ? `${block.state}${legs}` : null;
  const fixed = [identity, tail].filter(Boolean).join(SEPARATOR);
  const more = acMore(rows);
  const room = TITLE_CAP - fixed.length - SEPARATOR.length - more.length;
  if (room < AC_MIN) return surfaceTitle();
  return `${specTitle(outcome, room)}${more}${SEPARATOR}${specTitle(fixed)}`;
}

/** The identity two surface rows must share to be one contract: the store and the endpoint. */
function contractKey(block) {
  return `${block.state ?? ''}|${block.observe ?? ''}`;
}

/** The distinct claim one cached verdict makes, so two verdicts can be compared for agreement. */
function verdictClaim(row) {
  return `${row.field ?? ''}|${row.reflects === true}|${row.expect ?? ''}`;
}

/**
 * One written state read back through one endpoint is one contract, however many legs reach
 * it — the dedup a reviewer otherwise makes by hand. Rows agreeing on store and endpoint
 * collapse into the one with the shortest chain; every other leg is carried on the merged
 * block with its own write site and chain, so nothing is dropped and the merge is re-walkable.
 * Legs that reach different endpoints stay apart, and a gap keeps its own leg, because its
 * reason and its evidence are per-leg.
 *
 * A merged block polls when any of its legs is asynchronous. Its cached verdict is the one its
 * legs agree on; legs whose verdicts disagree leave the field claim unfilled and say so, which
 * is the same refusal to invent a correlation a state with no verdict at all already gets.
 */
export function dedupeObserved(blocks) {
  const groups = new Map();
  for (const block of blocks) {
    if (block.kind !== 'observed') continue;
    const key = contractKey(block);
    groups.set(key, [...(groups.get(key) || []), block]);
  }
  const absorbed = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => a.hops - b.hops || compare(a.leg, b.leg) || compare(a.through, b.through));
    const [primary, ...rest] = ordered;
    for (const block of rest) absorbed.add(block);
    primary.mergedLegs = rest.map((block) => ({
      leg: block.leg,
      through: block.through,
      message: block.message,
      writeFile: block.writeFile,
      writeLine: block.writeLine,
      hops: block.hops,
      chain: block.chain,
    }));
    primary.poll = ordered.some((block) => block.poll);
    const seen = new Set();
    for (const row of ordered) {
      for (const entry of row.ac || []) {
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        if (row !== primary) primary.ac = [...(primary.ac || []), entry];
      }
    }
    const found = ordered.map((block) => block.verdict).filter(Boolean);
    const claims = new Set(found.map(verdictClaim));
    primary.verdict = claims.size > 1 ? null : found[0] || null;
    primary.verdictConflict = claims.size > 1 ? found : null;
  }
  return { blocks: blocks.filter((block) => !absorbed.has(block)), deduped: absorbed.size };
}

function gapFor(model, state) {
  const identity = stateIdentity(state);
  return (model.gaps || []).find((row) => stateIdentity(row) === identity) || null;
}

function chainText(chain) {
  return (chain || []).map((hop) => hop.ref).join(' <- ');
}

function nestedMatch(field, value) {
  const parts = String(field || '')
    .split('.')
    .filter(Boolean);
  if (parts.length === 0) return value;
  let rendered = value;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    rendered = `{ ${parts[index]}: ${rendered} }`;
  }
  return rendered;
}

/**
 * One route's skeleton, as a plan a renderer walks. Every state the surface carries becomes
 * one block — an observed block when the surface derived an endpoint for it, a parked gap
 * block when it did not — and a plan with no observed block at all is refused rather than
 * filled in.
 */
export function skeletonPlan(model, options = {}) {
  const conventions = options.conventions || DEFAULT_CONVENTIONS;
  const helpers = options.helpers || {};
  const verdicts = options.verdicts || new Map();
  const requests = options.requests || new Map();
  const observe = options.observe || null;
  const routeKey = model.route.key;
  const { verb, path } = splitRouteKey(routeKey);
  const drafted = options.drafts instanceof Map ? options.drafts.get(routeKey) || null : options.drafts || null;
  const scenarios = drafted ? drafted.scenarios || [] : [];
  const blocks = [];
  const misses = [];

  const noWrite = (model.gaps || []).filter((row) => row.reason === 'no-write');
  for (const gap of noWrite) {
    blocks.push({
      kind: 'gap',
      state: null,
      leg: null,
      through: null,
      ac: [],
      acFile: null,
      reason: gap.reason,
      detail: gap.detail,
      file: gap.file,
      line: gap.line,
      evidence: gap.evidence || [],
      evidenceMore: gap.evidenceMore || 0,
    });
  }

  for (const state of model.states || []) {
    const ac = draftedFor(scenarios, state, routeKey);
    const observation = observationFor(model, state, observe);
    if (!observation) {
      const gap = gapFor(model, state);
      if (observe && !gap) continue;
      blocks.push({
        kind: 'gap',
        state: state.state,
        leg: state.leg,
        through: state.through ? state.through.ref : null,
        ac,
        acFile: ac.length > 0 ? drafted.file || null : null,
        reason: gap ? gap.reason : 'no-endpoint',
        detail: gap ? gap.detail : null,
        file: gap ? gap.file : state.file,
        line: gap ? gap.line : state.line,
        evidence: gap ? gap.evidence || [] : [],
        evidenceMore: gap ? gap.evidenceMore || 0 : 0,
      });
      continue;
    }
    const key = verdictKey({
      route: routeKey,
      state: state.state,
      leg: state.leg,
      through: state.through ? state.through.ref : '',
      observe: observation.observe,
    });
    blocks.push({
      kind: 'observed',
      state: state.state,
      leg: state.leg,
      through: state.through ? state.through.ref : null,
      message: state.through ? state.through.message || null : null,
      ac,
      acFile: ac.length > 0 ? drafted.file || null : null,
      writeFile: state.file,
      writeLine: state.line,
      observe: observation.observe,
      observeVerb: observation.verb,
      observeTemplate: observation.template,
      observeFile: observation.file,
      observeLine: observation.line,
      hops: observation.hops,
      chain: observation.chain || [],
      poll: state.leg === 'async',
      verdict: verdicts.get(key) || null,
    });
  }

  const { blocks: kept, deduped } = dedupeObserved(blocks);
  for (const block of kept) block.title = blockTitle(block);

  const templates = [...new Set(kept.filter((block) => block.observeTemplate).map((block) => block.observeTemplate))].sort(
    compare,
  );
  const constNames = new Map();
  templates.forEach((template, index) => {
    constNames.set(template, templates.length === 1 ? 'OBSERVE_PATH' : `OBSERVE_PATH_${index + 1}`);
  });
  for (const block of kept) {
    if (block.observeTemplate) block.observeConst = constNames.get(block.observeTemplate);
  }

  const actHelper = helperFor(helpers, verb, path);
  if (!actHelper) {
    misses.push({
      route: routeKey,
      verb,
      template: path,
      evidence: (requests.get(`${verb} ${normaliseTemplate(path)}`) || [])[0] || null,
    });
  }
  const observers = new Map();
  for (const block of kept) {
    if (block.kind !== 'observed') continue;
    const helper = helperFor(helpers, block.observeVerb, block.observeTemplate);
    block.helper = helper || null;
    if (helper) {
      observers.set(`${block.observeVerb} ${block.observeTemplate}`, helper);
      continue;
    }
    const missKey = `${block.observeVerb} ${normaliseTemplate(block.observeTemplate)}`;
    if (misses.some((row) => `${row.verb} ${normaliseTemplate(row.template)}` === missKey)) continue;
    misses.push({
      route: block.observe,
      verb: block.observeVerb,
      template: block.observeTemplate,
      evidence: (requests.get(missKey) || [])[0] || null,
    });
  }

  const observed = kept.filter((block) => block.kind === 'observed');
  const plan = {
    route: routeKey,
    title: specTitle(routeKey),
    verb,
    path,
    wildcards: path.split('/').filter((segment) => segment === '*').length,
    verbMethod: (conventions.verbMethods || VERB_METHODS)[verb] || 'post',
    actHelper: actHelper || null,
    observers: [...observers.values()],
    blocks: kept,
    misses,
    drafts: drafted ? { file: drafted.file, route: drafted.route, scenarios: scenarios.length } : null,
    draftMiss: !drafted && options.draftsFrom ? options.draftsFrom : null,
    needsPoll: observed.some((block) => block.poll),
    needsExpected: observed.some((block) => block.verdict && block.verdict.reflects === true && !block.verdict.expect),
    observeConsts: templates.map((template) => ({ template, name: constNames.get(template) })),
    counts: {
      states: (model.states || []).length,
      blocks: kept.length,
      observed: observed.length,
      gaps: kept.length - observed.length,
      verdicts: observed.filter((block) => block.verdict).length,
      misses: misses.length,
      deduped,
      drafted: kept.filter((block) => (block.ac || []).length > 0).length,
    },
    refused: observed.length === 0,
    refusal:
      observed.length === 0
        ? `no derived observation point for ${routeKey}: ${
            kept.length === 0 ? 'the surface named no state' : kept.map((block) => block.reason).sort(compare).join(', ')
          }`
        : null,
    limits: model.limits || null,
  };
  return plan;
}

function storeReference(conventions) {
  const factory = conventions.contextFactory;
  return factory.instance ? factory.instanceVariable : factory.store;
}

function contextLine(conventions, role) {
  const factory = conventions.contextFactory;
  const args = [factory.api, `${factory.as}.${role}()`, ...(factory.fixtures || [])];
  return `const ${factory.variable} = await ${storeReference(conventions)}.${factory.method}(${args.join(', ')});`;
}

function pathExpression(template, param) {
  const params = templateParams(template);
  if (params.length === 0) return `'${literal(template)}'`;
  const filled = String(template).replace(/\{[^}]+\}/g, `\${${param}}`);
  return `\`${filled}\``;
}

function callExpression(helper, instance) {
  const args = (helper.args || []).join(', ');
  return `${instance}.${helper.method}(${args})`;
}

function renderImports(plan, conventions) {
  const aliases = conventions.importAliases;
  const factory = conventions.contextFactory;
  const observing = plan.counts.observed > 0;
  const lines = [];
  const caseIdImport = caseIdImportLine(conventions);
  if (caseIdImport) lines.push(caseIdImport);
  lines.push(`import { ${observing ? 'expect, test' : 'test'} } from '${aliases.fixtures}';`);
  if (!observing) return lines;
  lines.push(
    `import { ${[factory.api.split('.')[0], factory.store, factory.as].join(', ')} } from '${aliases.utils}';`,
  );
  const byModule = new Map();
  for (const helper of [plan.actHelper, ...plan.observers].filter(Boolean)) {
    const names = byModule.get(helper.module) || new Set();
    if (helper.className) names.add(helper.className);
    for (const name of helper.imports || []) names.add(name);
    byModule.set(helper.module, names);
  }
  for (const module of [...byModule.keys()].sort(compare)) {
    const names = [...byModule.get(module)].sort(compare);
    if (names.length === 0) continue;
    lines.push(`import { ${names.join(', ')} } from '${module}';`);
  }
  return lines;
}

function renderConsts(plan, conventions) {
  const lines = [];
  if (plan.counts.observed === 0) return lines;
  if (conventions.contextFactory.instance) {
    lines.push(`const ${conventions.contextFactory.instanceVariable} = new ${conventions.contextFactory.store}();`);
  }
  const usesParam =
    (!plan.actHelper && plan.wildcards > 0) ||
    plan.observeConsts.some((entry) => templateParams(entry.template).length > 0) ||
    [plan.actHelper, ...plan.observers]
      .filter(Boolean)
      .some((helper) => (helper.args || []).includes(UNRESOLVED.pathParam));
  if (usesParam) lines.push(`const ${UNRESOLVED.pathParam} = '';`);
  if (!plan.actHelper) {
    if (plan.wildcards > 0) {
      const filled = plan.path.split('/').map((segment) => (segment === '*' ? `\${${UNRESOLVED.pathParam}}` : segment)).join('/');
      lines.push(`const ROUTE_PATH = \`${filled}\`;`);
    } else {
      lines.push(`const ROUTE_PATH = '${literal(plan.path)}';`);
    }
  }
  for (const entry of plan.observeConsts) {
    lines.push(`const ${entry.name} = ${pathExpression(entry.template, UNRESOLVED.pathParam)};`);
  }
  if (plan.needsExpected) lines.push(`const ${UNRESOLVED.expected}: unknown = undefined;`);
  if (plan.needsPoll) {
    lines.push(`const POLL_TIMEOUT_MS = ${conventions.poll.timeoutMs};`);
    lines.push(`const POLL_INTERVALS_MS = [${(conventions.poll.intervalsMs || []).join(', ')}];`);
  }
  const seen = new Set();
  for (const helper of [plan.actHelper, ...plan.observers].filter(Boolean)) {
    for (const [name, expression] of helper.consts || []) {
      if (seen.has(name)) continue;
      seen.add(name);
      lines.push(`const ${name} = ${expression};`);
    }
  }
  return lines;
}

function renderMissTodos(plan) {
  return plan.misses.map((miss) => {
    const evidence = miss.evidence
      ? `an existing request is sent at ${miss.evidence.spec}:${miss.evidence.line}${
          miss.evidence.via === 'helper' ? ' through a helper' : ''
        }`
      : 'no spec in the facts sends this request yet';
    return `// TODO(flowtrace): no helper named for ${miss.verb} ${miss.template} — ${evidence}`;
  });
}

/**
 * The drafted acceptance criteria this block is titled after, each with the trigger its own
 * `When` clause states — the branch a spec author has to reach before the assertion below
 * means anything. They are printed, never acted on: the generator states the criterion and
 * still invents no setup of its own to satisfy it.
 */
function renderAcLines(block, pad) {
  const rows = block.ac || [];
  if (rows.length === 0) return [];
  const lines = [
    `${pad}// ac: ${commentText(
      `${rows[0].outcome} — ${rows.length} drafted scenario${rows.length === 1 ? '' : 's'}${
        block.acFile ? ` in ${block.acFile}` : ''
      }`,
    )}`,
  ];
  for (const row of rows.slice(0, AC_CAP)) {
    const given = (row.given || []).length > 0 ? `given ${row.given.join('; ')}, ` : '';
    const when = commentText(`${given}when ${row.when || 'a request is made'}`);
    const trigger = when.length > AC_WHEN_CAP ? `${when.slice(0, AC_WHEN_CAP - 1)}…` : when;
    lines.push(`${pad}// ac #${commentText(`${row.key ?? 'unkeyed'}: ${trigger}`)}`);
  }
  if (rows.length > AC_CAP) lines.push(`${pad}// ac: +${rows.length - AC_CAP} more`);
  return lines;
}

/** The further legs a merged block covers, each still naming its own write site and chain. */
function renderMergedLegLines(block, pad) {
  return (block.mergedLegs || []).map(
    (leg) =>
      `${pad}// also written: ${commentText(
        `${block.state} ${legPhrase({ leg: leg.leg, through: leg.through ? { ref: leg.through } : null })} at ${
          leg.writeFile
        }:${leg.writeLine} — chain: ${chainText(leg.chain)}`,
      )}`,
  );
}

function readBackLines(block, conventions, pad) {
  const variable = conventions.contextFactory.variable;
  const target = block.helper
    ? callExpression(block.helper, OBSERVER_VARIABLE)
    : `${variable}.get(${block.observeConst})`;
  const verdict = block.verdict;
  const asserts = verdict && verdict.reflects === true;
  const value = asserts ? verdict.expect ?? UNRESOLVED.expected : null;
  if (block.poll) {
    if (asserts) {
      return [
        `${pad}await expect`,
        `${pad}  .poll(async () => (await ${target}).json(), { timeout: POLL_TIMEOUT_MS, intervals: POLL_INTERVALS_MS })`,
        `${pad}  .toMatchObject(${nestedMatch(verdict.field, value)});`,
      ];
    }
    return [
      `${pad}await expect`,
      `${pad}  .poll(async () => (await ${target}).status(), { timeout: POLL_TIMEOUT_MS, intervals: POLL_INTERVALS_MS })`,
      `${pad}  .toBe(${conventions.okStatus});`,
    ];
  }
  const lines = [`${pad}const readBack = await ${target};`, `${pad}expect(readBack.status()).toBe(${conventions.okStatus});`];
  if (asserts) lines.push(`${pad}expect(await readBack.json()).toMatchObject(${nestedMatch(verdict.field, value)});`);
  return lines;
}

function renderObservedBlock(block, plan, conventions, depth) {
  const pad = '  '.repeat(depth);
  const factory = conventions.contextFactory;
  const lines = [`${pad}test('${block.title}', async ({ ${(factory.fixtures || []).join(', ')} }) => {`];
  lines.push(`${pad}  ${conventions.caseIdPlaceholder};`);
  lines.push(
    `${pad}  // surface: ${commentText(
      `${block.state} ${legPhrase({ leg: block.leg, through: block.through ? { ref: block.through } : null })} at ${
        block.writeFile
      }:${block.writeLine}`,
    )}`,
  );
  lines.push(
    `${pad}  // observed at ${commentText(`${block.observe} [${block.hops} hop${block.hops === 1 ? '' : 's'}]`)}`,
  );
  lines.push(`${pad}  // chain: ${commentText(chainText(block.chain))}`);
  lines.push(...renderMergedLegLines(block, `${pad}  `));
  lines.push(...renderAcLines(block, `${pad}  `));
  lines.push(`${pad}  ${contextLine(conventions, conventions.roles.default)}`);
  if (plan.actHelper) {
    lines.push(`${pad}  const ${ACT_VARIABLE} = new ${plan.actHelper.className}(${factory.variable});`);
    lines.push(`${pad}  const response = await ${callExpression(plan.actHelper, ACT_VARIABLE)};`);
  } else {
    lines.push(`${pad}  const response = await ${factory.variable}.${plan.verbMethod}(ROUTE_PATH);`);
  }
  lines.push(`${pad}  expect(response.status()).toBe(${conventions.okStatus});`);
  if (block.helper) {
    lines.push(`${pad}  const ${OBSERVER_VARIABLE} = new ${block.helper.className}(${factory.variable});`);
  }
  if (block.verdict) {
    lines.push(
      `${pad}  // verdict: ${commentText(
        `${block.verdict.field} ${block.verdict.reflects === true ? 'reflects' : 'does not reflect'} this write — ${
          block.verdict.file
        }:${block.verdict.line}`,
      )}`,
    );
  } else if (block.verdictConflict) {
    for (const row of block.verdictConflict) {
      lines.push(
        `${pad}  // verdict: ${commentText(
          `${row.field} ${row.reflects === true ? 'reflects' : 'does not reflect'} this write — ${row.file}:${row.line}`,
        )}`,
      );
    }
    lines.push(
      `${pad}  // TODO(flowtrace): the cached verdicts for the legs this test merges disagree — read them again and record one, or split the legs with --observe`,
    );
  } else {
    lines.push(
      `${pad}  // TODO(flowtrace): no surface_verdict fact for ${commentText(
        `${block.state} at ${block.observe}`,
      )} — which response field reflects this write is a judgment, not a walk`,
    );
  }
  if (block.verdict && block.verdict.reflects === false) {
    lines.push(
      `${pad}  // TODO(flowtrace): the cached verdict refuses this field — pick another observation point or record a new verdict`,
    );
  }
  lines.push(...readBackLines(block, conventions, `${pad}  `));
  lines.push(`${pad}});`);
  return lines;
}

function renderGapBlock(block, conventions, depth) {
  const pad = '  '.repeat(depth);
  const lines = [`${pad}test('${block.title}', async () => {`];
  lines.push(`${pad}  ${conventions.caseIdPlaceholder};`);
  lines.push(`${pad}  test.fixme(true, '${literal(`${GAP_FIXME} ${block.reason}: ${block.detail || ''}`.trim())}');`);
  if (block.file) lines.push(`${pad}  // write: ${commentText(`${block.file}:${block.line}`)}`);
  for (const row of block.evidence || []) {
    lines.push(
      `${pad}  // evidence: ${commentText(`${row.via} ${row.ref}${row.file ? ` (${row.file}:${row.line})` : ''}`)}`,
    );
  }
  if (block.evidenceMore > 0) lines.push(`${pad}  // evidence: +${block.evidenceMore} more`);
  lines.push(...renderAcLines(block, `${pad}  `));
  lines.push(`${pad}});`);
  return lines;
}

/** One spec file: imports, the consts the body uses, then one block per written state. */
export function renderSkeleton(plan, conventions = DEFAULT_CONVENTIONS) {
  const lines = [...renderImports(plan, conventions), ''];
  const consts = renderConsts(plan, conventions);
  if (consts.length > 0) lines.push(...consts, '');
  const todos = renderMissTodos(plan);
  if (plan.draftMiss) {
    todos.unshift(
      `// TODO(flowtrace): no cases --gherkin-draft file for ${commentText(plan.route)} in ${commentText(
        plan.draftMiss,
      )} — titles below are surface-derived, not a drafted acceptance criterion`,
    );
  }
  if (todos.length > 0) lines.push(...todos, '');
  lines.push(`test.describe('${plan.title}', () => {`);
  let first = true;
  for (const block of plan.blocks) {
    if (!first) lines.push('');
    first = false;
    lines.push(
      ...(block.kind === 'observed'
        ? renderObservedBlock(block, plan, conventions, 1)
        : renderGapBlock(block, conventions, 1)),
    );
  }
  lines.push('});');
  return `${lines.join('\n')}\n`;
}

/** Every placeholder the emitted text still carries, counted rather than claimed away. */
export function placeholders(spec, conventions = DEFAULT_CONVENTIONS) {
  const text = String(spec || '');
  const count = (pattern) => (text.match(pattern) || []).length;
  return {
    caseId: count(new RegExp(escapeRegExp(conventions.caseIdPlaceholder), 'g')),
    todo: count(/^\s*\/\/ TODO\(/gm),
    unresolved: count(new RegExp(`\\b(${UNRESOLVED.pathParam}|${UNRESOLVED.expected})\\b`, 'g')),
    fixme: count(/test\.fixme\(/g),
  };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The whole step, model in and spec out. `refused` plans render only with `stub: true`, so
 * a route on which nothing resolved does not quietly become a spec that asserts nothing.
 */
export function skeleton(model, options = {}) {
  const conventions = mergeConventions(options.conventions);
  const plan = skeletonPlan(model, { ...options, conventions });
  if (plan.refused && options.stub !== true) return { plan, spec: null, conventions };
  const spec = renderSkeleton(plan, conventions);
  return { plan, spec, conventions, placeholders: placeholders(spec, conventions) };
}
