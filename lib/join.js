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
 * Match a gateway_call/cypress_intercept caller against the route index. Exact
 * template equality wins first; a caller key ending in `*` (an unresolved builder
 * suffix, or simply a trailing dynamic segment) falls back to prefix matching against
 * route template parts; then caller-side gateway aliases are tried; last, a caller
 * that names only the tail of a route matches by suffix. Each result carries its own
 * match kind, so a suffixed join is never counted as a direct one.
 */
export function matchRoute(routeIndex, verb, template, aliases = []) {
  const callVerb = normalizeVerb(verb);
  const callTemplatePart = normalizeRoute(template);

  const exact = findExact(routeIndex, callVerb, callTemplatePart);
  if (exact) return { route: exact, match: 'exact' };

  const prefixed = findPrefix(routeIndex, callVerb, callTemplatePart);
  if (prefixed) return { route: prefixed, match: 'prefix' };

  if (aliases.length > 0) {
    const aliased = tryAliases(routeIndex, callVerb, callTemplatePart, aliases);
    if (aliased) return aliased;
  }

  const suffixed = findSuffix(routeIndex, callVerb, callTemplatePart);
  if (suffixed) return { route: suffixed, match: 'suffix' };

  return null;
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
  if (pattern.startsWith('**/')) return pattern.slice(3);
  if (pattern.startsWith('**')) return pattern.slice(2);
  return pattern;
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
