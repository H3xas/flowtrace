/**
 * Join step — turns per-repo fact sets into a single cross-repo flow graph.
 *
 * Input is `factSets: [{repo, kind, facts}]`, one entry per `out/facts/<repo>.json`
 * file, plus `options.aliases: [{from, to}]` — caller-side route-prefix rewrites
 * (e.g. the gateway rewriting `catalog/...` to `inventory/...` for part of the
 * surface). Output is `{ edges, unjoined }` per the flowtrace contract: every edge
 * carries `{kind, from, to, key}` (from/to are `{repo, ref, file, line}`), and every
 * fact that could not be matched to its counterpart lands in the matching `unjoined`
 * bucket. Aliases are tried only after exact and prefix matching fail, and only on
 * the caller side — routes are never rewritten.
 */

import { normalizeRoute, normalizeVerb, routeKey } from './normalize.js';

const UNJOINED_BUCKETS = [
  'mobile_calls_without_route',
  'routes_without_caller',
  'publish_without_consumer',
  'consume_without_publisher',
  'intercepts_without_route',
  'messages_without_contract',
  'publish_unresolved',
];

function emptyUnjoined() {
  const unjoined = {};
  for (const bucket of UNJOINED_BUCKETS) unjoined[bucket] = [];
  return unjoined;
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

export function buildRouteIndex(routeEntries) {
  return routeEntries.map(({ repo, fact }) => ({
    repo,
    fact,
    verb: normalizeVerb(fact.verb),
    templatePart: normalizeRoute(fact.template),
    key: routeKey(fact.verb, fact.template),
  }));
}

function verbCompatible(routeVerb, callVerb) {
  return routeVerb === callVerb || routeVerb === 'ANY' || callVerb === 'ANY';
}

function findExact(routeIndex, callVerb, templatePart) {
  return routeIndex.find(
    (entry) => verbCompatible(entry.verb, callVerb) && entry.templatePart === templatePart
  );
}

function findPrefix(routeIndex, callVerb, templatePart) {
  if (!templatePart.endsWith('*')) return null;
  const prefix = templatePart.slice(0, -1);
  const candidates = routeIndex
    .filter(
      (entry) =>
        verbCompatible(entry.verb, callVerb) &&
        entry.templatePart !== templatePart &&
        entry.templatePart.startsWith(prefix)
    )
    .sort((a, b) => a.templatePart.localeCompare(b.templatePart));
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * A caller pattern that carries no leading path — `**\/cart/items/${id}` from a Cypress
 * intercept — still names the tail of exactly one route. Match it when a route's
 * template part ends with the whole pattern on a segment boundary; the leading `/`
 * requirement stops `items/*` from attaching itself to an unrelated route.
 */
function findSuffix(routeIndex, callVerb, templatePart) {
  if (!templatePart) return null;
  const candidates = routeIndex
    .filter(
      (entry) =>
        verbCompatible(entry.verb, callVerb) &&
        entry.templatePart !== templatePart &&
        entry.templatePart.endsWith(`/${templatePart}`)
    )
    .sort((a, b) => a.templatePart.localeCompare(b.templatePart));
  return candidates.length > 0 ? candidates[0] : null;
}

function normalizeAliasSegment(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function normalizeAliases(aliases) {
  return aliases.map((alias) => ({
    from: normalizeAliasSegment(alias.from),
    to: normalizeAliasSegment(alias.to),
  }));
}

function rewriteWithAlias(templatePart, alias) {
  if (templatePart === alias.from) return alias.to;
  if (templatePart.startsWith(`${alias.from}/`)) return alias.to + templatePart.slice(alias.from.length);
  return null;
}

/**
 * Try every alias's caller-side rewrite against the route index. Exact hits across
 * all aliases are preferred over prefix hits across all aliases, in alias order.
 * Aliases are never applied to the route side.
 */
function tryAliases(routeIndex, callVerb, templatePart, aliases) {
  for (const alias of aliases) {
    const rewritten = rewriteWithAlias(templatePart, alias);
    if (rewritten === null) continue;
    const exact = findExact(routeIndex, callVerb, rewritten);
    if (exact) return { route: exact, match: 'alias', alias: { from: alias.from, to: alias.to } };
  }
  for (const alias of aliases) {
    const rewritten = rewriteWithAlias(templatePart, alias);
    if (rewritten === null) continue;
    const prefixed = findPrefix(routeIndex, callVerb, rewritten);
    if (prefixed) return { route: prefixed, match: 'alias', alias: { from: alias.from, to: alias.to } };
  }
  return null;
}

/**
 * A caller split into path segments for the segment-aware tiers. A glob pattern keeps a
 * trailing `**` apart from `*`, because `normalizeRoute` collapses the two and only the
 * first may cross a `/`. Every other segment is normalized as the route side is.
 */
function callerSegments(template, glob) {
  let raw = String(template ?? '').trim().split('#')[0].split('?')[0].replace(/\/+$/, '');
  let anySegments = false;
  if (glob && (raw === '**' || raw.endsWith('/**'))) {
    anySegments = true;
    raw = raw === '**' ? '' : raw.slice(0, -3);
  }
  const part = normalizeRoute(raw);
  return { segments: part ? part.split('/') : [], anySegments };
}

const PARAMETER_SEGMENT = '*';

function globSegment(segment) {
  const body = segment
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * How one caller segment meets one route segment: `equal` (the same text, or a whole `*`
 * against a route parameter), `glob` (a glob caller's `*` inside the segment matches a
 * literal route segment), `parameter` (a route parameter takes a caller segment that is not
 * a whole `*`), or `null`. A whole `*` of a template that is not a glob stands for an
 * unread value, so it never matches a literal route segment.
 */
function compareSegment(callerSegment, routeSegment, glob) {
  if (callerSegment === routeSegment) return 'equal';
  if (routeSegment === PARAMETER_SEGMENT) return 'parameter';
  if (glob && callerSegment.includes('*') && globSegment(callerSegment).test(routeSegment)) return 'glob';
  return null;
}

/**
 * Align the caller with one route and return the route segment each caller segment met,
 * or `null`. `tail` aligns the caller with the end of a strictly longer route, as the base
 * suffix rule does. A trailing `**` takes one or more route segments after the others.
 * `allowParameter` admits a route parameter for a caller segment; a match that names one
 * must use it at least once, so a parameter result never stands for a plainer one.
 */
function alignRoute(caller, routeSegments, { tail, allowParameter, glob }) {
  const { segments, anySegments } = caller;
  const fits = (offset) => {
    let usedParameter = false;
    const met = [];
    for (let i = 0; i < segments.length; i += 1) {
      const kind = compareSegment(segments[i], routeSegments[offset + i], glob);
      if (kind === null) return null;
      if (kind === 'parameter') {
        if (!allowParameter) return null;
        usedParameter = true;
      }
      met.push(routeSegments[offset + i]);
    }
    if (allowParameter && !usedParameter) return null;
    return met;
  };
  if (anySegments) {
    const first = tail ? 1 : 0;
    const last = tail ? routeSegments.length - segments.length - 1 : Math.min(0, routeSegments.length - segments.length - 1);
    for (let offset = first; offset <= last; offset += 1) {
      const met = fits(offset);
      if (met) return met;
    }
    return null;
  }
  if (tail) {
    if (routeSegments.length <= segments.length) return null;
    return fits(routeSegments.length - segments.length);
  }
  if (routeSegments.length !== segments.length) return null;
  return fits(0);
}

/**
 * Order two candidates of one segment-aware tier: at the first caller segment where their
 * route segments differ, the one equal to the caller segment ranks first, and a route
 * parameter equals a whole `*`. Neither or both equal, or no difference at all, is a tie.
 */
function compareCandidates(caller, left, right) {
  for (let i = 0; i < caller.segments.length; i += 1) {
    if (left.met[i] === right.met[i]) continue;
    const segment = caller.segments[i];
    const leftEqual = left.met[i] === segment;
    const rightEqual = right.met[i] === segment;
    if (leftEqual === rightEqual) return 0;
    return leftEqual ? -1 : 1;
  }
  return 0;
}

/**
 * One segment-aware tier: every compatible route the caller aligns with, ranked by
 * `compareCandidates`. Two candidates of equal first rank are ambiguous, never a choice; two
 * entries of one route key are one candidate.
 */
function findAligned(routeIndex, callVerb, caller, mode) {
  const candidates = [];
  for (const entry of routeIndex) {
    if (!verbCompatible(entry.verb, callVerb)) continue;
    const met = alignRoute(caller, entry.templatePart ? entry.templatePart.split('/') : [], mode);
    if (met) candidates.push({ entry, met });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareCandidates(caller, a, b) || a.entry.templatePart.localeCompare(b.entry.templatePart));
  const best = candidates[0];
  const tied = candidates.filter((candidate) => compareCandidates(caller, best, candidate) === 0);
  const keys = [...new Set(tied.map((candidate) => candidate.entry.key))];
  if (keys.length > 1) return { ambiguous: true, candidates: keys.sort() };
  return { route: best.entry };
}

function rewriteCaller(caller, alias) {
  const joined = caller.segments.join('/');
  const rewritten = rewriteWithAlias(joined, alias);
  if (rewritten === null) return null;
  return { segments: rewritten ? rewritten.split('/') : [], anySegments: caller.anySegments };
}

function aligned(found, match, alias) {
  if (!found) return null;
  if (found.ambiguous) return { route: null, ambiguous: true, candidates: found.candidates };
  return { route: found.route, match, ...(alias ? { alias: { from: alias.from, to: alias.to } } : {}) };
}

/**
 * `matchRoute` with the reason it found no route. The result is `{ route, match, alias? }`,
 * `{ route: null, ambiguous: true, candidates }` when a segment-aware tier holds two
 * candidates of equal rank, or `null` when no route fits.
 *
 * The base tiers run first and unchanged for a caller read without `{ glob: true }`: exact,
 * prefix, alias, suffix. Only when they find nothing do the parameter tiers follow: a route
 * parameter takes a literal caller segment directly (`parameter`), after a caller-side
 * alias rewrite (`alias`), and in a tail match (`suffix`).
 *
 * `{ glob: true }` reads the caller as a glob pattern of a test stub, never as a template
 * with an unresolved builder suffix: a trailing `*` stays inside its segment, a trailing
 * `**` takes one or more segments, and the prefix and tail tiers align segment by segment.
 */
export function matchRouteDetailed(routeIndex, verb, template, aliases = [], options = {}) {
  const callVerb = normalizeVerb(verb);
  const callTemplatePart = normalizeRoute(template);
  const glob = options.glob === true;

  // A template that normalizes to bare `*` names no path, so every route is an equally
  // baseless guess; the prefix fallback would otherwise hand it the first route that sorts
  // first and state an edge the source never wrote.
  if (callTemplatePart === '*') return null;

  const caller = callerSegments(template, glob);
  const strict = { tail: false, allowParameter: false, glob };
  const lastSegment = caller.segments[caller.segments.length - 1] || '';
  const globbed = glob && (caller.anySegments || lastSegment.includes('*'));

  if (!caller.anySegments) {
    const exact = findExact(routeIndex, callVerb, callTemplatePart);
    if (exact) return { route: exact, match: 'exact' };
  }

  if (globbed) {
    const prefixed = findAligned(routeIndex, callVerb, caller, strict);
    if (prefixed) return aligned(prefixed, 'prefix');
  } else {
    const prefixed = findPrefix(routeIndex, callVerb, callTemplatePart);
    if (prefixed) return { route: prefixed, match: 'prefix' };
  }

  if (aliases.length > 0) {
    if (globbed) {
      for (const alias of aliases) {
        const rewritten = rewriteCaller(caller, alias);
        if (!rewritten || rewritten.anySegments) continue;
        const exact = findExact(routeIndex, callVerb, rewritten.segments.join('/'));
        if (exact) return { route: exact, match: 'alias', alias: { from: alias.from, to: alias.to } };
      }
      for (const alias of aliases) {
        const rewritten = rewriteCaller(caller, alias);
        if (!rewritten) continue;
        const found = findAligned(routeIndex, callVerb, rewritten, strict);
        if (found) return aligned(found, 'alias', alias);
      }
    } else {
      const aliased = tryAliases(routeIndex, callVerb, callTemplatePart, aliases);
      if (aliased) return aliased;
    }
  }

  if (globbed) {
    const suffixed = findAligned(routeIndex, callVerb, caller, { ...strict, tail: true });
    if (suffixed) return aligned(suffixed, 'suffix');
  } else {
    const suffixed = findSuffix(routeIndex, callVerb, callTemplatePart);
    if (suffixed) return { route: suffixed, match: 'suffix' };
  }

  const parameter = { tail: false, allowParameter: true, glob };
  const direct = findAligned(routeIndex, callVerb, caller, parameter);
  if (direct) return aligned(direct, 'parameter');

  for (const alias of aliases) {
    const rewritten = rewriteCaller(caller, alias);
    if (!rewritten) continue;
    const found = findAligned(routeIndex, callVerb, rewritten, parameter);
    if (found) return aligned(found, 'alias', alias);
  }

  const tailed = findAligned(routeIndex, callVerb, caller, { ...parameter, tail: true });
  if (tailed) return aligned(tailed, 'suffix');

  return null;
}

/**
 * Match a gateway_call/cypress_intercept caller against the route index. Exact
 * template equality wins first; a caller key ending in `*` (an unresolved builder
 * suffix, or simply a trailing dynamic segment) falls back to prefix matching against
 * route template parts; then caller-side gateway aliases are tried; then a caller
 * that names only the tail of a route matches by suffix; last, a route parameter takes a
 * literal caller segment. Each result carries its own match kind, so a suffixed or
 * parameter join is never counted as a direct one. An ambiguous result is `null` here;
 * `matchRouteDetailed` names its candidates.
 */
export function matchRoute(routeIndex, verb, template, aliases = [], options = {}) {
  const result = matchRouteDetailed(routeIndex, verb, template, aliases, options);
  if (!result || result.ambiguous) return null;
  return result;
}

/**
 * Message contract index — everything the leveled message join needs, built once over
 * every fact set so a hop can be matched no matter which repository declares the class.
 */
export function buildMessageIndex(factSets) {
  const fqnsByName = new Map();
  const declarations = new Map();
  const queuesByMessage = new Map();
  for (const set of factSets) {
    for (const fact of set.facts || []) {
      if (fact.type === 'message_class') {
        const fqns = fqnsByName.get(fact.name) || new Set();
        if (fact.fqn) fqns.add(fact.fqn);
        fqnsByName.set(fact.name, fqns);
        const sites = declarations.get(fact.name) || [];
        sites.push({ repo: set.repo, fact });
        declarations.set(fact.name, sites);
      } else if (fact.type === 'queue_name') {
        const queues = queuesByMessage.get(fact.message) || new Set();
        queues.add(fact.name);
        queuesByMessage.set(fact.message, queues);
      }
    }
  }
  return { fqnsByName, declarations, queuesByMessage };
}

/** Every simple message name a consumer or processor fact can stand for. */
export function messageNames(fact) {
  const names = new Set();
  if (fact.message) names.add(fact.message);
  if (names.size === 0 && fact.workType) names.add(`${fact.workType}Message`);
  if (names.size === 0 && fact.processor) names.add(fact.processor.replace(/Processor$/, 'Message'));
  return names;
}

/** True when no configured repository declares a class for this message name. */
export function hasContract(messageIndex, name) {
  return messageIndex.declarations.has(name);
}

/**
 * Match one publish against one consume/processor fact, in the contract's order:
 * `fqn`, `name`, `name-ambiguous`, `queue`. Returns null when nothing lines up.
 */
export function matchMessage(messageIndex, publishFact, otherFact) {
  const publishName = publishFact.message;
  const otherNames = messageNames(otherFact);
  if (otherNames.has(publishName)) {
    if (publishFact.fqn && otherFact.fqn && publishFact.fqn === otherFact.fqn) {
      return { match: 'fqn', derived: !otherFact.message };
    }
    const fqns = messageIndex.fqnsByName.get(publishName);
    const distinct = fqns ? fqns.size : 0;
    if (distinct > 1) return { match: 'name-ambiguous', fqns: distinct, derived: !otherFact.message };
    return { match: 'name', derived: !otherFact.message };
  }
  const publishQueues = messageIndex.queuesByMessage.get(publishName);
  if (publishQueues) {
    for (const name of otherNames) {
      const queues = messageIndex.queuesByMessage.get(name);
      if (!queues) continue;
      for (const queue of queues) {
        if (publishQueues.has(queue)) return { match: 'queue', queue, derived: !otherFact.message };
      }
    }
  }
  return null;
}

function stripGlobPrefix(pattern) {
  const text = String(pattern || '');
  if (text.startsWith('**/')) return text.slice(3);
  if (text.startsWith('**')) return text.slice(2);
  return text;
}

/** The fact types that name a route a test reaches, in reading order, with their source. */
const EVIDENCE_SOURCES = Object.freeze([
  { type: 'cypress_intercept', source: 'cypress', field: 'pattern' },
  { type: 'pw_request', source: 'playwright-api', field: 'template' },
  { type: 'pw_stub', source: 'playwright-stub', field: 'pattern' },
]);

/**
 * Read every test evidence fact onto the route it names, once, for `join` and `cover` alike.
 * Each entry keeps its `source` (`cypress`, `playwright-api` or `playwright-stub`) so a
 * reader never conflates the strength of two kinds of evidence. A `pw_stub` of
 * `kind: "opaque"` names no URL and is never matched. A pattern with no `/` after its glob
 * prefix strip names no path. A `pw_request` has no `skipped` of its own, so it takes the
 * flag of the `pw_test` that shares its spec and title.
 *
 * Each entry has `status`: `matched` (with `result` and `evidence`), `opaque`, `no-path` or
 * `unmatched`.
 */
export function readTestEvidence(factSets, options = {}) {
  const aliases = options.aliases || [];
  const routeIndex = options.routeIndex || buildRouteIndex(collect(factSets, 'route'));
  const pwTestSkipped = new Map();
  for (const { fact } of collect(factSets, 'pw_test')) {
    pwTestSkipped.set(`${fact.spec}::${fact.test}`, fact.skipped === true);
  }
  const entries = [];
  for (const { type, source, field } of EVIDENCE_SOURCES) {
    for (const { repo, fact } of collect(factSets, type)) {
      const pattern = fact[field];
      const stripped = stripGlobPrefix(pattern);
      const skipped =
        type === 'pw_request' ? pwTestSkipped.get(`${fact.spec}::${fact.test}`) === true : fact.skipped === true;
      const entry = { repo, fact, type, source, pattern, stripped, skipped };
      if (type === 'pw_stub' && fact.kind === 'opaque') {
        entries.push({ ...entry, status: 'opaque' });
        continue;
      }
      if (!stripped.includes('/')) {
        entries.push({ ...entry, status: 'no-path' });
        continue;
      }
      const result = matchRoute(routeIndex, fact.verb, stripped, aliases);
      if (!result) {
        entries.push({ ...entry, status: 'unmatched' });
        continue;
      }
      entries.push({
        ...entry,
        status: 'matched',
        result,
        evidence: {
          repo,
          spec: fact.spec,
          test: fact.test,
          line: fact.line,
          verb: fact.verb,
          pattern,
          skipped,
          match: result.match,
          source,
          ...(type === 'pw_request' && fact.via ? { via: fact.via } : {}),
        },
      });
    }
  }
  return { routeIndex, entries };
}

function isNoPathPattern(stripped) {
  if (stripped.startsWith('?')) return true;
  if (stripped.startsWith('filter.')) return true;
  if (!stripped.includes('/')) return true;
  return false;
}

function routeRef(entry) {
  return {
    repo: entry.repo,
    ref: `${entry.fact.controller}.${entry.fact.action}`,
    file: entry.fact.file,
    line: entry.fact.line,
  };
}

function buildComponentIndex(componentEntries) {
  const bySelector = new Map();
  const roleByName = new Map();
  for (const { fact } of componentEntries) {
    if (fact.selector) bySelector.set(fact.selector, fact);
    roleByName.set(fact.name, fact.role);
  }
  return { bySelector, roleByName };
}

function classRef(repo, name, file, line, roleByName) {
  const ref = { repo, ref: name, file, line };
  if (roleByName && roleByName.has(name)) ref.role = roleByName.get(name);
  return ref;
}



function compareStrings(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function join(factSets, options = {}) {
  const aliases = normalizeAliases(options.aliases || []);
  const edges = [];
  const unjoined = emptyUnjoined();

  const routeEntries = collect(factSets, 'route');
  const routeIndex = buildRouteIndex(routeEntries);
  const gatewayCallEntries = collect(factSets, 'gateway_call');
  const interceptEntries = collect(factSets, 'cypress_intercept');
  const publishEntries = collect(factSets, 'publish');
  const consumeEntries = collect(factSets, 'consume');
  const processorEntries = collect(factSets, 'worker_processor');
  const injectsEntries = collect(factSets, 'injects');
  const rendersEntries = collect(factSets, 'renders');
  const componentEntries = collect(factSets, 'component');
  const signalrEntries = collect(factSets, 'signalr_push');
  const httpOutEntries = collect(factSets, 'http_out');

  const messageIndex = buildMessageIndex(factSets);
  const { bySelector, roleByName } = buildComponentIndex(componentEntries);
  const matchedRouteKeys = new Set();

  for (const { repo, fact } of gatewayCallEntries) {
    const callerKey = routeKey(fact.verb, fact.template);
    const result = matchRoute(routeIndex, fact.verb, fact.template, aliases);
    if (!result) {
      unjoined.mobile_calls_without_route.push({ key: callerKey, fact });
      continue;
    }
    matchedRouteKeys.add(result.route.key);
    edges.push({
      kind: 'calls',
      from: {
        ...classRef(repo, `${fact.service}.${fact.method}`, fact.file, fact.line, roleByName),
        class: fact.service,
      },
      to: routeRef(result.route),
      key: result.route.key,
      callerKey,
      match: result.match,
      ...(result.alias ? { alias: result.alias } : {}),
    });
  }

  for (const { repo, fact } of interceptEntries) {
    const stripped = stripGlobPrefix(fact.pattern);
    if (isNoPathPattern(stripped)) {
      unjoined.intercepts_without_route.push({
        key: routeKey(fact.verb, stripped),
        fact,
        reason: 'no-path',
      });
      continue;
    }
    const callerKey = routeKey(fact.verb, stripped);
    const result = matchRoute(routeIndex, fact.verb, stripped, aliases);
    if (!result) {
      unjoined.intercepts_without_route.push({ key: callerKey, fact });
      continue;
    }
    edges.push({
      kind: 'tests',
      from: { repo, ref: fact.test || '', file: fact.spec, line: fact.line },
      to: routeRef(result.route),
      key: result.route.key,
      callerKey,
      match: result.match,
      ...(result.alias ? { alias: result.alias } : {}),
    });
  }

  for (const entry of routeIndex) {
    if (!matchedRouteKeys.has(entry.key)) {
      unjoined.routes_without_caller.push({ key: entry.key, fact: entry.fact });
    }
  }

  for (const { repo, fact } of publishEntries) {
    // A publish whose argument type the extractor could not read names no message to join
    // on: it is listed with its reason, never counted as a publish without a consumer.
    if (fact.message == null) {
      unjoined.publish_unresolved.push({ key: fact.unresolved || 'unknown', repo, fact });
      continue;
    }
    // A publish is "without consumer" only when neither a consume fact nor a
    // worker_processor fact matches it — a Worker processor is a real
    // consumer of the message, not a second, separately-tracked drift bucket.
    const hasConsumer = consumeEntries.some(({ fact: consume }) => matchMessage(messageIndex, fact, consume));
    const hasProcessor = processorEntries.some(({ fact: processor }) => matchMessage(messageIndex, fact, processor));
    if (!hasConsumer && !hasProcessor) {
      unjoined.publish_without_consumer.push({ key: fact.message, fact });
    }
    if (!hasContract(messageIndex, fact.message)) {
      unjoined.messages_without_contract.push({ key: fact.message, fact });
    }
    edges.push({
      kind: 'publishes',
      from: { repo, ref: fact.file, file: fact.file, line: fact.line },
      to: { repo: 'message', ref: fact.message, file: null, line: null },
      key: fact.message,
    });
  }

  for (const { repo, fact } of consumeEntries) {
    let level = null;
    for (const { fact: publish } of publishEntries) {
      const result = matchMessage(messageIndex, publish, fact);
      if (result) {
        level = result;
        break;
      }
    }
    if (!level) {
      unjoined.consume_without_publisher.push({ key: fact.message, fact });
    }
    if (!hasContract(messageIndex, fact.message)) {
      unjoined.messages_without_contract.push({ key: fact.message, fact });
    }
    edges.push({
      kind: 'consumes',
      from: { repo: 'message', ref: fact.message, file: null, line: null },
      to: classRef(repo, fact.consumer, fact.file, fact.line, roleByName),
      key: fact.message,
      ...(level ? { match: level.match } : {}),
    });
  }

  for (const { repo, fact } of processorEntries) {
    let level = null;
    let publisher = null;
    for (const { fact: publish } of publishEntries) {
      const result = matchMessage(messageIndex, publish, fact);
      if (result) {
        level = result;
        publisher = publish;
        break;
      }
    }
    const key = publisher ? publisher.message : fact.message;
    if (!key) continue;
    edges.push({
      kind: 'enqueues',
      from: { repo: 'message', ref: key, file: null, line: null },
      to: classRef(repo, fact.processor, fact.file, fact.line, roleByName),
      key,
      ...(level ? { match: level.match } : {}),
    });
  }

  for (const { repo, fact } of injectsEntries) {
    edges.push({
      kind: 'injects',
      from: classRef(repo, fact.from, fact.file, fact.line, roleByName),
      to: classRef(repo, fact.to, fact.file, fact.line, roleByName),
      key: `${fact.from}->${fact.to}`,
    });
  }

  for (const { repo, fact } of rendersEntries) {
    const component = bySelector.get(fact.to);
    const to = component
      ? classRef(repo, component.name, component.file, component.line, roleByName)
      : { repo, ref: fact.to, file: fact.file, line: fact.line };
    edges.push({
      kind: 'renders',
      from: classRef(repo, fact.from, fact.file, fact.line, roleByName),
      to,
      key: `${fact.from}->${fact.to}`,
    });
  }

  for (const { repo, fact } of signalrEntries) {
    edges.push({
      kind: 'pushes',
      from: { repo, ref: fact.file, file: fact.file, line: fact.line },
      to: { repo: 'signalr', ref: fact.method, file: null, line: null },
      key: fact.method,
    });
  }

  for (const { repo, fact } of httpOutEntries) {
    edges.push({
      kind: 'calls_out',
      from: { repo, ref: fact.file, file: fact.file, line: fact.line },
      to: { repo: fact.configKey, ref: normalizeRoute(fact.template), file: null, line: null },
      key: fact.configKey,
    });
  }

  edges.sort((a, b) => {
    const byKind = compareStrings(a.kind, b.kind);
    if (byKind !== 0) return byKind;
    const byKey = compareStrings(a.key, b.key);
    if (byKey !== 0) return byKey;
    return compareStrings(a.from && a.from.ref, b.from && b.from.ref);
  });

  for (const bucket of UNJOINED_BUCKETS) {
    unjoined[bucket].sort((a, b) => compareStrings(a.key, b.key));
  }

  return { edges, unjoined };
}

export function summarize(flow) {
  const edges = {};
  let aliasMatches = 0;
  for (const edge of flow.edges) {
    edges[edge.kind] = (edges[edge.kind] || 0) + 1;
    if (edge.match === 'alias') aliasMatches += 1;
  }
  const unjoined = {};
  for (const bucket of Object.keys(flow.unjoined)) {
    unjoined[bucket] = flow.unjoined[bucket].length;
  }
  return { edges, unjoined, aliasMatches };
}
