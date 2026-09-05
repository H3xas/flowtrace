/**
 * Trace step — one start, every hop to its sinks, across every fact set.
 *
 * The walk is deterministic and reads only facts. Each edge carries a `via` tag naming
 * the evidence that produced it, so a reader can tell a template reference from a
 * dependency-injection binding from a graph-index guess. The code index is consulted
 * only through the injected `outbound` function, and only where the facts fall silent.
 *
 * Hops are counted after the route: the interface and implementation nodes that resolve
 * one call share the hop of that call, so `--depth` measures call and message hops
 * rather than resolution steps.
 */

import { createHash } from 'node:crypto';

import { buildMessageIndex, buildRouteIndex, hasContract, matchMessage, matchRoute, normalizeAliases } from './join.js';
import { normalizeRoute, normalizeVerb, routeKey } from './normalize.js';

export const DEFAULT_DEPTH = 6;
/**
 * The node ceiling leaves headroom above what a deep route needs: a route's own
 * interface-collection fan-out can legitimately add nodes elsewhere in the same tree (a
 * message consumer reached on the async leg dispatching over its own interface-typed
 * collection, say), and a ceiling set close to a route's natural size can be pushed over
 * the edge mid-walk, silently pruning an already-redundant leg to a state whose assertion
 * surface had another, still-intact path (verifiable by comparing `assertionSurface`'s
 * `counts.observed` before and after). Generous headroom removes the crowding rather than
 * trimming what the walk is allowed to discover.
 */
export const DEFAULT_MAX_NODES = 1500;
export const DEFAULT_DB_PATTERNS = Object.freeze(['/DataAccess/', 'Repository', 'ResourceService']);
export const DEFAULT_WRITE_PREFIXES = Object.freeze([
  'Insert', 'Update', 'Upsert', 'Set', 'Delete', 'Remove', 'Save', 'Clear',
  'Add', 'Create', 'Archive', 'Mark', 'Increment', 'Decrement', 'Push', 'Replace', 'Write',
]);
export const DEFAULT_READ_PREFIXES = Object.freeze([
  'Get', 'Find', 'Fetch', 'Load', 'Read', 'Exists', 'Count',
  'List', 'Query', 'Search', 'Any', 'Has', 'Is',
]);
export const GRAPH_PRUNE = Object.freeze([
  '/Models/',
  '/Interfaces/',
  '/Constants',
  '/Enum',
  '/Dto',
  '/Exceptions/',
]);
export const GRAPH_FANOUT = 8;
/**
 * The most implementations a call on an interface-typed collection element fans out
 * to. A wide interface (many registered/declared implementations) stops growing the walk past
 * this many edges rather than multiplying the node budget by its full fan-in; the rest are
 * dropped and counted, same shape as `graphHop`'s own `GRAPH_FANOUT` cap.
 */
export const INTERFACE_FANOUT_CAP = 16;
export const EXHAUSTIVE_MAX_NODES = 100_000;

/** Stable identity for the source fact carried by a forward-walk edge. */
export function factProvenanceKey(repo, fact) {
  const identity = [repo, fact.type, fact.file, fact.line];
  if (fact.type === 'method_call') {
    identity.push(fact.class, fact.method, fact.field, fact.calledMethod);
  } else if (fact.type === 'gateway_call') {
    identity.push(fact.service, fact.method, fact.verb, fact.template);
  } else if (fact.type === 'publish' || fact.type === 'consume') {
    identity.push(fact.message, fact.consumer || '');
  } else if (fact.type === 'redis_publish') {
    identity.push(fact.channel);
  } else if (fact.type === 'signalr_push') {
    identity.push(fact.method);
  } else if (fact.type === 'http_out') {
    identity.push(fact.configKey, fact.template);
  }
  return JSON.stringify(identity);
}
/** The generic collection wrappers an interface-typed element field gets declared
 * with -- `List<IFoo> _field`, `IEnumerable<IFoo> _field`, and so on. */
const COLLECTION_ELEMENT_TYPE =
  /^(?:List|IList|ICollection|IEnumerable|IReadOnlyCollection|IReadOnlyList|HashSet|ISet)\s*<\s*([\w.]+)\s*>$/;

export const BRANCH_DISPOSITIONS = Object.freeze({
  toggle: Object.freeze(['off', 'on']),
  validation: Object.freeze(['valid', 'invalid']),
  error_return: Object.freeze(['taken', 'not-taken']),
  guard: Object.freeze(['tripped', 'clear']),
});

/** Dispositions that end the request there — no later branch point runs. */
export const TERMINAL_DISPOSITIONS = Object.freeze({ error_return: 'taken', guard: 'tripped' });

/**
 * How a seed ends, and the order a test plan should read it in: an `effect` seed runs the
 * flow to its writes, a `reject` seed is refused with a status a caller can ask for, a
 * `fault` seed is an unhandled exception — a 500 nobody targets from a black-box test.
 */
export const SEED_KINDS = Object.freeze(['effect', 'reject', 'fault']);
export const SEED_KIND_ORDER = Object.freeze({ effect: 0, reject: 1, fault: 2 });

/** At most this many distinct feature toggles multiply the seed list of one flow. */
export const MAX_MULTIPLYING_TOGGLES = 2;

export const DEFAULT_PRIMARY_DEPTH = 2;
export const DEFAULT_INFRA_FANIN = 25;
const MERGE_WINDOW = 4;

const MULTIPLYING = Object.keys(BRANCH_DISPOSITIONS);
/**
 * The verbs a consumer is entered through when none of its methods takes the message
 * it consumes: the MassTransit `Consume`, the worker-processor `Process`/`ProcessAsync`
 * and the job consumer's `Run`. `workerPatterns.consumerEntryMethods` adds a framework's own.
 */
export const DEFAULT_CONSUMER_ENTRY_METHODS = Object.freeze(['Consume', 'Process', 'ProcessAsync', 'Run']);

/**
 * The `via` a method hop carries when nothing but `--unscoped` put it there: no call
 * site named it, only the injection did. Scoped hops keep `body`, so the two trees are
 * told apart by a tag rather than by counting.
 */
export const UNSCOPED_VIA = 'di·unscoped';
const HOP_VIA = new Set([
  'literal', 'handler', 'body', 'dispatch', 'props', 'effect', 'publish', 'message', 'worker', 'graph', 'push', 'http_out',
  UNSCOPED_VIA,
]);
const SINK_KINDS = new Set(['push', 'http_out', 'db']);
const MAX_SEEDS = 64;
const SEED_BUDGET = 512;

const RESPONSE_RULES = [
  [/BadRequest/, '400 BadRequest'],
  [/NotFound/, '404 NotFound'],
  [/Forbid|Status403/, '403 Forbidden'],
  [/Unauthorized|Status401/, '401 Unauthorized'],
  [/Conflict|Status409/, '409 Conflict'],
  [/NoContent|Status204/, '204 NoContent'],
];

const THROWS = /\bthrow\b/;

/**
 * Whether the branch ends the request by throwing. A thrown exception is a 500 the
 * caller never asked for, so it never reads as a status a black-box test targets, even
 * when the exception type is named after one.
 */
export function isFault(text) {
  return THROWS.test(String(text || ''));
}

/** The observable outcome of a return or throw, for a seed that ends there. */
export function responseOf(text) {
  const line = String(text || '').trim();
  if (isFault(line)) {
    const thrown = /throw new (\w+)/.exec(line);
    return thrown ? `throw ${thrown[1]} (500)` : 'throw (500)';
  }
  for (const [pattern, label] of RESPONSE_RULES) {
    if (pattern.test(line)) return label;
  }
  const status = /Status(?:Code)?\(\s*(?:StatusCodes\.Status)?(\d{3})/.exec(line);
  if (status) return status[1];
  if (/\breturn\b/.test(line)) return 'return';
  return line.slice(0, 40);
}

const TOGGLE_NAME = /Toggles\.(\w+)/;

/** The toggle a `toggle` branch reads, when the condition names one. */
export function toggleNameOf(text) {
  const match = TOGGLE_NAME.exec(String(text || ''));
  return match ? `Toggles.${match[1]}` : null;
}

const COMPARISON = /(?:\.Equals\(\s*|[=!]=\s*|\bcase\s+)([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)/;
const NOT_A_DISCRIMINATOR = /^(null|true|false|string\.Empty)$/i;

/**
 * Dispositions for a plain `if`/`switch` that selects between domain cases rather than
 * checking a flag: the condition must compare against a named constant or enum member,
 * never a literal, a null, or a boolean.
 */
export function discriminatorOf(text) {
  const match = COMPARISON.exec(String(text || ''));
  if (!match) return null;
  const operand = match[1];
  const segment = operand.split('.').pop();
  if (NOT_A_DISCRIMINATOR.test(operand) || NOT_A_DISCRIMINATOR.test(segment)) return null;
  if (!/^[A-Z]/.test(segment) || /^(Length|Count|Value|Type|Id|Name)$/.test(segment)) return null;
  const label = segment.replace(/_/g, '-').toLowerCase();
  return [label, `not-${label}`];
}

/**
 * Fold a condition line and the error return that immediately follows it into one branch
 * point: two facts describing one decision should read as one decision.
 */
const TRUE_DISPOSITION = { toggle: 'on', validation: 'valid' };
const NEGATED = /^[^(]*\(\s*!/;

/** The disposition the controlled block belongs to, honouring a negated condition. */
export function blockDisposition(kind, text, dispositions) {
  if (kind === 'error_return') return 'taken';
  if (kind === 'guard') return 'tripped';
  if (!dispositions || dispositions.length === 0) return null;
  const positive = TRUE_DISPOSITION[kind] ?? dispositions[0];
  if (!NEGATED.test(String(text || ''))) return positive;
  return dispositions.find((option) => option !== positive) ?? positive;
}

/** Pair each `else` fact with the branch it belongs to and drop it from the list. */
export function pairElseFacts(entries) {
  const branches = entries.filter((entry) => entry.fact.kind !== 'else');
  for (const entry of entries) {
    if (entry.fact.kind !== 'else') continue;
    let owner = null;
    for (const candidate of branches) {
      const end = candidate.fact.endLine ?? candidate.fact.line;
      if (end < entry.fact.line && (!owner || end > (owner.fact.endLine ?? owner.fact.line))) owner = candidate;
    }
    if (owner) {
      owner.fact = { ...owner.fact, elseLine: entry.fact.line, elseEndLine: entry.fact.endLine ?? entry.fact.line };
    }
  }
  return branches;
}

export function mergeBranchFacts(entries) {
  const merged = [];
  for (let position = 0; position < entries.length; position += 1) {
    const current = entries[position];
    const next = entries[position + 1];
    const foldable =
      (current.fact.kind === 'if' || current.fact.kind === 'guard') &&
      next &&
      next.fact.kind === 'error_return' &&
      next.fact.class === current.fact.class &&
      next.fact.method === current.fact.method &&
      next.fact.line > current.fact.line &&
      next.fact.line - current.fact.line <= MERGE_WINDOW;
    if (foldable) {
      merged.push({
        repo: current.repo,
        fact: { ...current.fact, kind: 'error_return', returnText: next.fact.text, returnLine: next.fact.line },
      });
      position += 1;
      continue;
    }
    merged.push(current);
  }
  return merged;
}

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * `componentByName` keeps every declaration under a `repo|name` key so `resolveStart` can
 * see a same-repo duplicate as ambiguous. A walk continuing past a resolved
 * start — a DI field, a `renders`/`injects` edge target — still wants one component to
 * land on; it takes the last-processed declaration while name resolution reports the
 * complete candidate list.
 */
function lastComponent(index, key) {
  const entries = index.componentByName.get(key);
  return entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
}

function byLine(a, b) {
  return (a.fact ? a.fact.line : a.line) - (b.fact ? b.fact.line : b.line);
}

function prefixLength(name, prefixes) {
  let longest = 0;
  for (const prefix of prefixes) {
    if (prefix.length <= longest || !name.startsWith(prefix)) continue;
    const next = name.charAt(prefix.length);
    if (next !== '' && next.toUpperCase() !== next) continue;
    longest = prefix.length;
  }
  return longest;
}

/**
 * Read or write, decided by the verb a repository method opens with. A name matching
 * neither list is called a write: over-reporting a write costs a test case, missing one
 * costs a data bug.
 */
export function classifyAccess(methodName, { writePrefixes = DEFAULT_WRITE_PREFIXES, readPrefixes = DEFAULT_READ_PREFIXES } = {}) {
  const name = String(methodName || '');
  if (name === '') return { access: 'write', guess: true };
  const write = prefixLength(name, writePrefixes);
  const read = prefixLength(name, readPrefixes);
  if (write === 0 && read === 0) return { access: 'write', guess: true };
  return { access: write >= read ? 'write' : 'read', guess: false };
}

function isInterfaceName(name) {
  return /^I[A-Z]/.test(String(name || ''));
}

/**
 * The element type a field's declared generic-collection type names, or null when
 * `declaredType` is not one of the recognised collection wrappers -- a bare class or
 * interface type resolves through the normal single-receiver path rather than this one.
 */
function collectionElementType(declaredType) {
  const match = String(declaredType || '').trim().match(COLLECTION_ELEMENT_TYPE);
  return match ? match[1].trim() : null;
}

/**
 * Every known implementation of `iface` -- `di_binding` registrations and
 * `class X : IFoo` declarations alike, deduplicated by implementation name and ordered the
 * same way the single-target `bindings` list already was (alphabetically by impl), so a
 * fixture asserting fan-out order never depends on fact-extraction order.
 */
function interfaceImplementations(index, repo, iface) {
  const seen = new Map();
  for (const entry of index.diByIface.get(`${repo}|${iface}`) || []) {
    if (!seen.has(entry.fact.impl)) seen.set(entry.fact.impl, entry);
  }
  for (const entry of index.ifaceImpls.get(`${repo}|${iface}`) || []) {
    if (!seen.has(entry.fact.class)) seen.set(entry.fact.class, { repo, fact: { ...entry.fact, impl: entry.fact.class } });
  }
  return [...seen.values()].sort((a, b) => a.fact.impl.localeCompare(b.fact.impl));
}

function classNameFromPath(path) {
  const base = String(path || '').split('/').pop() || '';
  return base.replace(/\.[a-z]+$/i, '');
}

/** `Messages.OrderPlaced` -> `OrderPlaced`; an empty or missing name stays empty. */
function bareTypeName(name) {
  const text = String(name || '').trim();
  const dot = text.lastIndexOf('.');
  return dot === -1 ? text : text.slice(dot + 1);
}

/**
 * Whether a parameter type, as written, hands a method the message named: the message
 * itself (`T`, `Messages.T`, `T?`) or the message wrapped in the context and batch shapes a
 * consumer framework passes -- `ConsumeContext<T>`, `JobContext<T>`, `Batch<T>`,
 * `ConsumeContext<Batch<T>>`. Any other generic around the message (`IValidator<T>`,
 * `Func<T, bool>`) is a helper's parameter, not an entry, and does not count.
 */
function namesType(paramType, name) {
  let current = String(paramType || '').replace(/\s+/g, '').replace(/\?$/, '');
  for (;;) {
    if (bareTypeName(current) === name) return true;
    const wrapped = current.match(/^([\w.]+)<(.+)>$/);
    if (!wrapped || !/(?:Context|Batch)$/.test(bareTypeName(wrapped[1]))) return false;
    current = wrapped[2];
  }
}

/** Index every fact set once so the walk never rescans an array. */
export function buildTraceIndex(factSets) {
  const index = {
    repos: new Map(),
    componentByName: new Map(),
    componentBySelector: new Map(),
    rendersFrom: new Map(),
    handlersFrom: new Map(),
    dispatchesFrom: new Map(),
    effectsByAction: new Map(),
    actionDefs: new Map(),
    injectsFrom: new Map(),
    propTargets: new Map(),
    webPages: [],
    gatewayByService: new Map(),
    gatewayByMethod: new Map(),
    spansByName: new Map(),
    routeEntries: [],
    routesByKey: new Map(),
    ctorFields: new Map(),
    ctorFanIn: new Map(),
    callsByMethod: new Map(),
    callsByClass: new Map(),
    branchesByMethod: new Map(),
    methodsByClass: new Map(),
    diByIface: new Map(),
    ifaceImpls: new Map(),
    publishByFile: new Map(),
    fileSinks: new Map(),
    methodSpans: new Map(),
    spanByMethod: new Map(),
    spansByClass: new Map(),
    outcomeByMethod: new Map(),
    consumeAll: [],
    processorAll: [],
    classSite: new Map(),
    paramSources: new Map(),
  };

  function addMethod(repo, className, methodName) {
    if (!methodName) return;
    const key = `${repo}|${className}`;
    const names = index.methodsByClass.get(key);
    if (names) names.add(methodName);
    else index.methodsByClass.set(key, new Set([methodName]));
  }

  function site(repo, name, file, line, rank) {
    if (!name) return;
    const key = `${repo}|${name}`;
    const current = index.classSite.get(key);
    if (!current || rank < current.rank || (rank === current.rank && line < current.line)) {
      index.classSite.set(key, { repo, file, line, rank });
    }
  }

  const outcomes = [];
  const webGateways = [];
  for (const set of factSets) {
    const repo = set.repo;
    index.repos.set(repo, set.kind);
    for (const fact of set.facts || []) {
      const entry = { repo, fact };
      switch (fact.type) {
        case 'component':
          pushInto(index.componentByName, `${repo}|${fact.name}`, entry);
          if (fact.selector) index.componentBySelector.set(fact.selector, entry);
          if (set.kind === 'web' && fact.role === 'page' && fact.path) index.webPages.push(entry);
          site(repo, fact.name, fact.file, fact.line, 0);
          break;
        case 'renders':
          pushInto(index.rendersFrom, `${repo}|${fact.from}`, entry);
          break;
        case 'template_handler':
          pushInto(index.handlersFrom, `${repo}|${fact.component}`, entry);
          break;
        case 'action_dispatch':
          pushInto(index.dispatchesFrom, `${repo}|${fact.class}|${fact.method}`, entry);
          break;
        case 'effect_handler':
          for (const action of fact.actions || []) {
            pushInto(index.effectsByAction, `${repo}|${action}`, entry);
          }
          site(repo, fact.class, fact.file, fact.line, 1);
          break;
        case 'action_def':
          if (!index.actionDefs.has(`${repo}|${fact.action}`)) {
            index.actionDefs.set(`${repo}|${fact.action}`, entry);
          }
          break;
        case 'injects':
          pushInto(index.injectsFrom, `${repo}|${fact.from}`, entry);
          break;
        case 'props_bind':
          if (!index.propTargets.has(`${repo}|${fact.component}|${fact.prop}`)) {
            index.propTargets.set(`${repo}|${fact.component}|${fact.prop}`, entry);
          }
          break;
        case 'gateway_call':
          pushInto(index.gatewayByService, `${repo}|${fact.service}`, entry);
          if (set.kind === 'web') webGateways.push(entry);
          break;
        case 'route': {
          index.routeEntries.push(entry);
          pushInto(index.routesByKey, routeKey(fact.verb, fact.template), entry);
          site(repo, fact.controller, fact.file, fact.line, 1);
          break;
        }
        case 'ctor_field': {
          pushInto(index.ctorFields, `${repo}|${fact.class}`, entry);
          const users = index.ctorFanIn.get(fact.paramType) || new Set();
          users.add(`${repo}|${fact.class}`);
          index.ctorFanIn.set(fact.paramType, users);
          site(repo, fact.class, fact.file, fact.line, 0);
          break;
        }
        case 'method_call':
          pushInto(index.callsByMethod, `${repo}|${fact.class}|${fact.method}`, entry);
          pushInto(index.callsByClass, `${repo}|${fact.class}`, entry);
          addMethod(repo, fact.class, fact.method);
          site(repo, fact.class, fact.file, fact.line, 1);
          break;
        case 'branch_point':
          pushInto(index.branchesByMethod, `${repo}|${fact.class}|${fact.method}`, entry);
          addMethod(repo, fact.class, fact.method);
          site(repo, fact.class, fact.file, fact.line, 2);
          break;
        case 'di_binding':
          pushInto(index.diByIface, `${repo}|${fact.iface}`, entry);
          break;
        case 'iface_impl':
          pushInto(index.ifaceImpls, `${repo}|${fact.iface}`, entry);
          break;
        case 'param_source':
          index.paramSources.set(`${repo}|${fact.class}|${fact.method}|${fact.param}`, fact);
          break;
        case 'publish':
        case 'redis_publish':
        case 'signalr_push':
        case 'http_out':
          outcomes.push(entry);
          break;
        case 'method_span':
          pushInto(index.methodSpans, `${repo}|${fact.file}`, entry);
          pushInto(index.spansByClass, `${repo}|${fact.class}`, fact);
          if (set.kind === 'web') pushInto(index.spansByName, `${repo}|${fact.method}`, fact);
          if (!index.spanByMethod.has(`${repo}|${fact.class}|${fact.method}`)) {
            index.spanByMethod.set(`${repo}|${fact.class}|${fact.method}`, fact);
          }
          site(repo, fact.class, fact.file, fact.line, 1);
          break;
        case 'consume':
          index.consumeAll.push(entry);
          site(repo, fact.consumer, fact.file, fact.line, 1);
          break;
        case 'worker_processor':
          index.processorAll.push(entry);
          site(repo, fact.processor, fact.file, fact.line, 1);
          break;
        default:
          break;
      }
    }
  }
  for (const spans of index.methodSpans.values()) {
    spans.sort((a, b) => a.fact.line - b.fact.line || a.fact.endLine - b.fact.endLine);
  }
  for (const entry of webGateways) {
    const span = innermostSpan(index, entry.repo, entry.fact.file, entry.fact.line);
    if (!span) continue;
    pushInto(index.gatewayByMethod, `${entry.repo}|${span.class}|${span.method}`, entry);
  }
  for (const entry of outcomes) {
    const span = innermostSpan(index, entry.repo, entry.fact.file, entry.fact.line);
    if (span) {
      pushInto(index.outcomeByMethod, `${entry.repo}|${span.class}|${span.method}`, entry);
      continue;
    }
    const target = entry.fact.type === 'publish' ? index.publishByFile : index.fileSinks;
    pushInto(target, `${entry.repo}|${entry.fact.file}`, { ...entry, attach: 'file' });
  }
  index.routeIndex = buildRouteIndex(index.routeEntries);
  index.messages = buildMessageIndex(factSets);
  return index;
}

/** The narrowest method body that contains a line, or null when no span covers it. */
function innermostSpan(index, repo, file, line) {
  const spans = index.methodSpans.get(`${repo}|${file}`);
  if (!spans) return null;
  let best = null;
  for (const { fact } of spans) {
    if (fact.line > line || fact.endLine < line) continue;
    if (!best || fact.endLine - fact.line < best.endLine - best.line) best = fact;
  }
  return best;
}

function candidateList(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!seen.has(entry.key)) seen.set(entry.key, entry);
  }
  return [...seen.values()];
}

function parseRouteStart(start) {
  const trimmed = String(start).trim();
  const space = trimmed.indexOf(' ');
  if (space < 0) return null;
  const verb = normalizeVerb(trimmed.slice(0, space));
  const template = trimmed.slice(space + 1).trim();
  if (!template) return null;
  return { verb, template, key: `${verb} ${normalizeRoute(template)}` };
}

/**
 * A page path as it is compared: no trailing `/*` and no trailing slash, so a page
 * mounted as a wildcard and the same page named without one are one start, not two.
 */
function normalizePagePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const stripped = trimmed.replace(/\/\*+$/, '').replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Every string a `role: "page"` component answers to: its own `<Route path>` and, when
 * the extractor read a browser prefix off the library's own `navigate()` literals, that
 * prefix in front of it. A `<Route path>` declared relative to its parent route is read
 * from the mount root, because the parent chain is not modelled. Both readings are
 * inference, never a manifest — the mount lives in the host that federates the library —
 * so a start resolved this way is tagged.
 */
function pageStartPaths(fact) {
  const declared = String(fact.path || '').trim();
  if (declared === '') return [];
  const path = normalizePagePath(declared.startsWith('/') ? declared : `/${declared}`);
  if (!path) return [];
  const prefix = typeof fact.prefix === 'string' ? fact.prefix.replace(/\/+$/, '') : '';
  return prefix ? [normalizePagePath(`${prefix}${path}`), path] : [path];
}

function componentKind(role) {
  if (role === 'page') return 'page';
  if (role === 'service') return 'service';
  return 'component';
}

/**
 * Resolve a start string to one node, in the contract's order: mobile class, mobile
 * selector, route key, backend `Class.Method`, backend class, web component name, web
 * page path. The two web tiers are appended last on purpose — a name shared with a
 * mobile component resolves to the mobile one rather than becoming cross-tier ambiguous.
 * Returns `{node}` on a single match
 * and `{candidates}` when a tier matches more than one thing.
 *
 * `options.strictComponentNames` additionally treats two same-repo
 * `component`-type declarations of the same name as ambiguous, the same `{candidates}`
 * shape a cross-repo clash already returns. `trace()`'s own resolution (`trace <name>`,
 * `--from-handler`) always sets it. It defaults off because `resolveComponentStart`
 * (`lib/component-span.js`) calls this expecting a single, arbitrary node even
 * when duplicates exist — it runs its own richer raw-fact scan afterward to name and
 * disambiguate them, and must keep getting the chance to.
 */
export function resolveStart(factSets, start, options = {}) {
  const index = options.index || buildTraceIndex(factSets);
  const repoFilter = options.repo;
  const wanted = String(start || '').trim();
  if (!wanted) return { error: 'no start given' };

  const inRepo = (repo) => !repoFilter || repo === repoFilter;
  const strictComponentNames = Boolean(options.strictComponentNames);
  const componentKey = (entry) =>
    strictComponentNames
      ? `${entry.repo}|${entry.fact.name}|${entry.fact.file}:${entry.fact.line}`
      : `${entry.repo}|${entry.fact.name}`;

  const componentHits = [];
  for (const [key, entries] of index.componentByName) {
    if (!key.includes('|')) continue;
    for (const entry of entries) {
      if (entry.fact.name === wanted && inRepo(entry.repo) && index.repos.get(entry.repo) !== 'web') {
        componentHits.push({
          key: componentKey(entry),
          node: {
            repo: entry.repo,
            kind: componentKind(entry.fact.role),
            ref: entry.fact.name,
            file: entry.fact.file,
            line: entry.fact.line,
          },
          label: `${entry.fact.name} (${entry.fact.role}) ${entry.repo} ${entry.fact.file}:${entry.fact.line}`,
        });
      }
    }
  }
  if (componentHits.length > 0) return finish(componentHits);

  const selectorHits = [];
  for (const [selector, entry] of index.componentBySelector) {
    if (selector === wanted && inRepo(entry.repo) && index.repos.get(entry.repo) !== 'web') {
      selectorHits.push({
        key: `${entry.repo}|${entry.fact.name}`,
        node: {
          repo: entry.repo,
          kind: componentKind(entry.fact.role),
          ref: entry.fact.name,
          file: entry.fact.file,
          line: entry.fact.line,
        },
        label: `${entry.fact.name} <${selector}> ${entry.repo} ${entry.fact.file}:${entry.fact.line}`,
      });
    }
  }
  if (selectorHits.length > 0) return finish(selectorHits);

  const asRoute = parseRouteStart(wanted);
  if (asRoute) {
    const routeHits = [];
    for (const entry of index.routeEntries) {
      if (!inRepo(entry.repo)) continue;
      if (routeKey(entry.fact.verb, entry.fact.template) !== asRoute.key) continue;
      routeHits.push({
        key: `${entry.repo}|${entry.fact.controller}.${entry.fact.action}`,
        node: {
          repo: entry.repo,
          kind: 'route',
          ref: asRoute.key,
          file: entry.fact.file,
          line: entry.fact.line,
          route: entry.fact,
        },
        label: `${asRoute.key} -> ${entry.fact.controller}.${entry.fact.action} ${entry.repo} ${entry.fact.file}:${entry.fact.line}`,
      });
    }
    if (routeHits.length > 0) return finish(routeHits);
  }

  if (wanted.includes('.') && !wanted.includes(' ')) {
    const dot = wanted.lastIndexOf('.');
    const className = wanted.slice(0, dot);
    const methodName = wanted.slice(dot + 1);
    const methodHits = [];
    for (const entry of index.routeEntries) {
      if (!inRepo(entry.repo)) continue;
      if (entry.fact.controller !== className || entry.fact.action !== methodName) continue;
      methodHits.push({
        key: `${entry.repo}|${className}.${methodName}`,
        node: {
          repo: entry.repo,
          kind: 'action',
          ref: `${className}.${methodName}`,
          file: entry.fact.file,
          line: entry.fact.line,
          class: className,
          method: methodName,
        },
        label: `${className}.${methodName} (route ${routeKey(entry.fact.verb, entry.fact.template)}) ${entry.repo}`,
      });
    }
    if (methodHits.length === 0) {
      for (const [key, entries] of index.callsByMethod) {
        const [repo, cls, method] = key.split('|');
        if (cls !== className || method !== methodName || !inRepo(repo)) continue;
        const first = entries.slice().sort(byLine)[0];
        methodHits.push({
          key: `${repo}|${className}.${methodName}`,
          node: {
            repo,
            kind: 'method',
            ref: `${className}.${methodName}`,
            file: first.fact.file,
            line: first.fact.line,
            class: className,
            method: methodName,
          },
          label: `${className}.${methodName} ${repo} ${first.fact.file}:${first.fact.line}`,
        });
      }
    }
    if (methodHits.length > 0) return finish(methodHits);
  }

  const classHits = [];
  for (const [key, site] of index.classSite) {
    const separator = key.indexOf('|');
    const repo = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (name !== wanted || !inRepo(repo)) continue;
    if (index.repos.get(repo) === 'web' && index.componentByName.has(key)) continue;
    classHits.push({
      key,
      node: { repo, kind: 'class', ref: name, file: site.file, line: site.line },
      label: `${name} ${repo} ${site.file}:${site.line}`,
    });
  }
  if (classHits.length > 0) return finish(classHits);

  const webHits = [];
  for (const [, entries] of index.componentByName) {
    for (const entry of entries) {
      if (index.repos.get(entry.repo) !== 'web') continue;
      if (entry.fact.name !== wanted || !inRepo(entry.repo)) continue;
      webHits.push({
        key: componentKey(entry),
        node: {
          repo: entry.repo,
          kind: componentKind(entry.fact.role),
          ref: entry.fact.name,
          file: entry.fact.file,
          line: entry.fact.line,
        },
        label: `${entry.fact.name} (${entry.fact.role}) ${entry.repo} ${entry.fact.file}:${entry.fact.line}`,
      });
    }
  }
  if (webHits.length > 0) return finish(webHits);

  const wantedPath = normalizePagePath(wanted);
  if (wantedPath) {
    const pageHits = [];
    for (const entry of index.webPages) {
      if (!inRepo(entry.repo)) continue;
      if (!pageStartPaths(entry.fact).includes(wantedPath)) continue;
      pageHits.push({
        key: `${entry.repo}|${entry.fact.name}`,
        node: {
          repo: entry.repo,
          kind: 'page',
          ref: entry.fact.name,
          file: entry.fact.file,
          line: entry.fact.line,
          pagePath: entry.fact.path,
          inferred: true,
          ...(entry.fact.prefix ? { mountPrefix: entry.fact.prefix } : {}),
        },
        label: `${entry.fact.name} (page ${entry.fact.path}) ${entry.repo} ${entry.fact.file}:${entry.fact.line}`,
      });
    }
    if (pageHits.length > 0) return finish(pageHits);
  }

  return { error: `no page, component, service, route, method or class matches "${wanted}"` };

  function finish(hits) {
    const unique = candidateList(hits).sort((a, b) => a.key.localeCompare(b.key));
    if (unique.length > 1) return { candidates: unique.map((hit) => hit.label) };
    return { node: unique[0].node, index };
  }
}

function compilePatterns(patterns) {
  return (patterns && patterns.length > 0 ? patterns : DEFAULT_DB_PATTERNS).map(String);
}

function matchesAny(patterns, ...values) {
  for (const value of values) {
    if (!value) continue;
    for (const pattern of patterns) {
      if (String(value).includes(pattern)) return true;
    }
  }
  return false;
}

/**
 * Parse a `--from-handler` selector into an event/method pair. Accepts the display form
 * a handler hop renders as (`(click) onLike()`), the compact `click:onLike`, or a bare
 * method name — `null` event matches any binding that calls that method.
 */
function parseHandlerSelector(selector) {
  const trimmed = String(selector).trim();
  const display = trimmed.match(/^\(([^)]*)\)\s*([^\s()]+)\s*\(\s*\)$/);
  if (display) return { event: display[1].trim(), method: display[2].trim() };
  const compact = trimmed.match(/^([^:()]+):([^:()]+)$/);
  if (compact) return { event: compact[1].trim(), method: compact[2].trim() };
  return { event: null, method: trimmed };
}

// A web `ref`/`inline` handler node names itself `node.method`; a web `prop` handler
// (bound via `this.props.x`, or a bare identifier that turns out to be a connected
// action creator) never gets a method span, so it surfaces as a `props`-hop node named
// by the template-side identifier instead (`node.prop`). Either one is the name a
// `--from-handler` selector is written against.
function handlerMethod(node) {
  return node.method || node.prop;
}

function handlerLabel(node) {
  return `(${node.event}) ${handlerMethod(node)}() ${node.ref} ${node.repo} ${node.file}:${node.line}`;
}

/**
 * Resolve `--from-handler` against every `template_handler` node the walk produced —
 * a `via: 'handler'` node (ref/inline, resolved or not) or a `via: 'props'` node that
 * carries an `event` (a prop-kind handler binding, as opposed to an internal `props.`
 * call discovered mid-body, which carries none). One match narrows the walk to that
 * node (`node`); more than one is ambiguous (`candidates`); none lists what the walk
 * did find (`available`) so the caller can name a real one instead of guessing again.
 */
function resolveFromHandler(handlerNodes, selector) {
  const parsed = parseHandlerSelector(selector);
  const seen = new Map();
  for (const node of handlerNodes) {
    if (!seen.has(node.ref)) seen.set(node.ref, node);
  }
  const unique = [...seen.values()];
  const matches = unique.filter(
    (node) => handlerMethod(node) === parsed.method && (parsed.event === null || node.event === parsed.event),
  );
  if (matches.length === 1) return { node: matches[0] };
  if (matches.length > 1) return { candidates: matches.map(handlerLabel) };
  return { available: unique.map(handlerLabel) };
}

/**
 * Walk from `start` to every sink. `factSets` are the loaded `out/facts/*.json` bodies;
 * `options.outbound(repoRoot, className)` supplies graph hops and may be omitted.
 * `options.stopAtRoutes` (implied by `options.inventory`) treats a route reached from a
 * component as a leaf and folds a revisited subtree by the same memoisation `inventory`
 * already applies, without `inventory`'s own destructive prune of non-route-reaching
 * branches — the mode `lib/component-span.js` walks a component start in.
 */
export function trace(factSets, start, options = {}) {
  const index = options.index || buildTraceIndex(factSets);
  const resolved = options.startNode
    ? { node: options.startNode }
    : resolveStart(factSets, start, { index, repo: options.repo, strictComponentNames: true });
  if (resolved.candidates) return { candidates: resolved.candidates };
  if (resolved.error) return { error: resolved.error };

  const exhaustive = options.exhaustive === true;
  const depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : DEFAULT_DEPTH;
  const maxNodes =
    Number.isInteger(options.maxNodes) && options.maxNodes > 0
      ? options.maxNodes
      : exhaustive
        ? EXHAUSTIVE_MAX_NODES
        : DEFAULT_MAX_NODES;
  const aliases = normalizeAliases(options.aliases || []);
  const dbPatterns = compilePatterns(options.sinks && options.sinks.db);
  const accessPrefixes = {
    writePrefixes: (options.sinks && options.sinks.writePrefixes) || DEFAULT_WRITE_PREFIXES,
    readPrefixes: (options.sinks && options.sinks.readPrefixes) || DEFAULT_READ_PREFIXES,
  };
  const forceGraph = Boolean(options.graph);
  const unscoped = Boolean(options.unscoped);
  const inventory = Boolean(options.inventory);
  const stopAtRoutes = Boolean(options.stopAtRoutes) || inventory;
  const summaries = options.summaries instanceof Map ? options.summaries : new Map();
  const primaryDepth = Number.isInteger(options.primaryDepth) ? options.primaryDepth : DEFAULT_PRIMARY_DEPTH;
  const infraFanIn = Number.isInteger(options.infraFanIn) ? options.infraFanIn : DEFAULT_INFRA_FANIN;
  const outbound = typeof options.outbound === 'function' ? options.outbound : null;
  const repoRoots = new Map((options.repos || []).map((repo) => [repo.id, repo.root]));
  const repoRoles = new Map((options.repos || []).map((repo) => [repo.id, repo.role || []]));
  const consumerEntryMethods = [
    ...DEFAULT_CONSUMER_ENTRY_METHODS,
    ...(Array.isArray(options.consumerEntryMethods) ? options.consumerEntryMethods : []),
  ];

  const nodes = [];
  const edges = [];
  const visited = new Map();
  const onPath = new Set();
  const fileFactsUsed = new Set();
  const graphReached = new Set();
  let counter = 0;
  let crossings = 0;
  let budgetHit = false;
  const exhaustiveBudget = Symbol('exhaustive walk node budget');

  function makeNode(fields) {
    if (exhaustive && nodes.length >= maxNodes) {
      budgetHit = true;
      throw exhaustiveBudget;
    }
    counter += 1;
    const node = { id: `n${counter}`, children: [], ...fields };
    nodes.push(node);
    return node;
  }

  function attach(parent, node, via, evidence = []) {
    node.via = via;
    node.homeRepo = index.repos.has(node.repo) ? node.repo : parent.homeRepo;
    if (index.repos.has(node.repo) && parent.homeRepo && node.repo !== parent.homeRepo) {
      node.crossRepo = { from: parent.homeRepo, to: node.repo, role: repoRoles.get(node.repo) || [] };
      crossings += 1;
    }
    parent.children.push(node);
    edges.push({
      from: parent.id,
      to: node.id,
      via,
      fromRepo: parent.homeRepo ?? null,
      toRepo: node.homeRepo ?? null,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(node.match ? { match: node.match } : {}),
      ...(node.caller ? { caller: node.caller } : {}),
    });
    return node;
  }

  function classSite(repo, name) {
    return index.classSite.get(`${repo}|${name}`) || null;
  }

  function isDb(repo, name, file) {
    return matchesAny(dbPatterns, file, name);
  }

  function nextHops(parentHops, via) {
    return HOP_VIA.has(via) ? parentHops + 1 : parentHops;
  }

  function child(parent, fields, via, evidence = []) {
    const hops = fields.selfCall === true ? parent.hops : nextHops(parent.hops, via);
    const node = makeNode({ ...fields, hops });
    if (parent.infra === true) node.infra = true;
    if (parent.asyncLeg === true || parent.kind === 'message') node.asyncLeg = true;
    const inherited = parent.methodDepth ?? 0;
    const entered = parent.methodEntered === true;
    node.methodEntered = entered || node.kind === 'method' || node.kind === 'action';
    node.methodDepth =
      node.kind === 'action'
        ? 0
        : node.kind === 'method' && (via === 'body' || via === UNSCOPED_VIA) && fields.selfCall !== true
          ? (entered ? inherited + 1 : 0)
          : inherited;
    if (!node.gates) {
      node.gates = typeof fields.gateLine === 'number' ? gatesAt(parent, fields.gateLine) : parent.gates || [];
    }
    return attach(parent, node, via, evidence);
  }

  function factEvidence(repo, fact) {
    return { key: factProvenanceKey(repo, fact), repo, type: fact.type, file: fact.file, line: fact.line };
  }

  function factEvidenceList(repo, facts) {
    return facts
      .map((fact) => factEvidence(repo, fact))
      .sort(
        (left, right) =>
          left.file.localeCompare(right.file) || left.line - right.line || left.type.localeCompare(right.type),
      );
  }

  function addEvidenceToNodeEdge(node, evidence) {
    if (evidence.length === 0) return;
    const edge = edges.findLast((candidate) => candidate.to === node.id);
    if (edge) edge.evidence = evidence;
  }

  function guard(node) {
    if (SINK_KINDS.has(node.kind) || node.kind === 'branch') return true;
    const key = `${node.repo}|${node.ref}`;
    if (onPath.has(key) || (stopAtRoutes && visited.has(key))) {
      node.cycle = true;
      return false;
    }
    onPath.add(key);
    visited.set(key, node.id);
    node.guardKey = key;
    return true;
  }

  function release(node) {
    if (node.guardKey) onPath.delete(node.guardKey);
  }

  function releaseAll(guarded) {
    for (const node of guarded) release(node);
  }

  /**
   * A consumer runs in its own process, so a class already on the publishing path is not
   * a cycle for it. Message keys are kept so a republished message still terminates.
   */
  function asNewEntryPoint(run) {
    const saved = [...onPath];
    onPath.clear();
    for (const key of saved) {
      if (key.startsWith('bus|')) onPath.add(key);
    }
    try {
      run();
    } finally {
      onPath.clear();
      for (const key of saved) onPath.add(key);
    }
  }

  function gatesAt(methodNode, line) {
    const inherited = methodNode.gates || [];
    const spans = methodNode.branchSpans;
    if (!spans || spans.length === 0 || typeof line !== 'number') return inherited;
    const gates = [...inherited];
    for (const span of spans) {
      if (line >= span.start && line <= span.end) {
        gates.push({ branch: span.branch, kind: span.kind, line: span.line, disposition: span.disposition });
      } else if (span.elseStart !== undefined && line >= span.elseStart && line <= span.elseEnd) {
        gates.push({ branch: span.branch, kind: span.kind, line: span.line, disposition: span.elseDisposition });
      }
    }
    return gates;
  }

  function intersectGates(lists) {
    if (lists.length === 0) return [];
    const key = (gate) => `${gate.branch}=${gate.disposition}`;
    let kept = lists[0];
    for (const other of lists.slice(1)) {
      const present = new Set(other.map(key));
      kept = kept.filter((gate) => present.has(key(gate)));
    }
    return kept;
  }

  function methodAnchor(repo, className, methodName, fallback) {
    const span = index.spanByMethod.get(`${repo}|${className}|${methodName}`);
    if (span) return { file: span.file, line: span.line };
    const call = (index.callsByMethod.get(`${repo}|${className}|${methodName}`) || []).slice().sort(byLine)[0];
    const branch = (index.branchesByMethod.get(`${repo}|${className}|${methodName}`) || []).slice().sort(byLine)[0];
    const anchor = call || branch;
    return anchor ? { file: anchor.fact.file, line: anchor.fact.line } : fallback;
  }

  /**
   * Whether effects written by this method are the point of the request or plumbing.
   * The shared-dependency rule demotes branch points inside a shared service's own
   * methods; it never demotes what a primary method writes, publishes or pushes, no
   * matter how widely the repository it writes through is injected.
   */
  function markDbAccess(node, methodNames) {
    const names = methodNames && methodNames.length > 0 ? methodNames : [''];
    node.methodAccess = names.map((name) => {
      const { access, guess } = classifyAccess(name, accessPrefixes);
      return { name, access, ...(guess ? { accessGuess: true } : {}) };
    });
    node.access = node.methodAccess.some((entry) => entry.access === 'write') ? 'write' : 'read';
    if (node.methodAccess.some((entry) => entry.accessGuess)) node.accessGuess = true;
  }

  function isPrimaryOwner(node) {
    return (node.methodDepth ?? 0) <= primaryDepth;
  }

  function fanIn(typeName) {
    const users = index.ctorFanIn.get(typeName);
    return users ? users.size : 0;
  }

  function addBranch(parent, repo, fact, className, methodName) {
    const branch = child(
      parent,
      {
        repo,
        kind: 'branch',
        ref: `${className}.${methodName}@${fact.line}`,
        file: fact.file,
        line: fact.line,
        branchKind: fact.kind,
        text: fact.text,
        class: className,
        method: methodName,
        ...(fact.endLine !== undefined ? { endLine: fact.endLine } : {}),
        ...(fact.returnText ? { returnText: fact.returnText, returnLine: fact.returnLine } : {}),
      },
      'body',
    );
    if (fact.kind === 'error_return' || fact.kind === 'guard') {
      const ending = fact.returnText || fact.text;
      branch.response = responseOf(ending);
      branch.responseKind = isFault(ending) ? 'fault' : 'reject';
    }
    const onPrimaryChain =
      branch.infra !== true && branch.asyncLeg !== true && (branch.methodDepth ?? 0) <= primaryDepth;
    if (!onPrimaryChain) {
      branch.primary = false;
      branch.demoted = branch.infra === true ? 'infrastructure' : branch.asyncLeg === true ? 'async' : 'depth';
      return branch;
    }
    branch.primary = true;
    if (MULTIPLYING.includes(fact.kind)) {
      branch.dispositions = [...BRANCH_DISPOSITIONS[fact.kind]];
      return branch;
    }
    const discriminator = discriminatorOf(fact.text);
    if (discriminator) branch.dispositions = discriminator;
    return branch;
  }

  function fileFactKey(repo, fact) {
    return `${repo}|${fact.type}|${fact.file}|${fact.line}`;
  }

  function outcomeNode(parent, entry, hops, attach) {
    const { repo, fact } = entry;
    const marker = { ...(attach ? { attach } : {}), effectInfra: !isPrimaryOwner(parent) };
    if (fact.type === 'publish') {
      if (fact.message == null) {
        // A publish whose message type the extractor could not read: stated as a leaf that
        // carries the reason and expands nothing, so the site stays visible without a guessed hop.
        child(
          parent,
          {
            repo: 'bus',
            kind: 'message',
            ref: '(unresolved)',
            file: fact.file,
            line: fact.line,
            gateLine: fact.line,
            unresolved: fact.unresolved || 'unknown',
            messageFact: fact,
            ...marker,
          },
          'publish',
          [factEvidence(repo, fact)],
        );
        return;
      }
      const message = child(
        parent,
        {
          repo: 'bus',
          kind: 'message',
          ref: fact.message,
          file: fact.file,
          line: fact.line,
          gateLine: fact.line,
          fqn: fact.fqn,
          messageFact: fact,
          ...marker,
          ...(hasContract(index.messages, fact.message) ? {} : { contract: 'none' }),
        },
        'publish',
        [factEvidence(repo, fact)],
      );
      expand(message, hops + 1);
      return;
    }
    if (fact.type === 'redis_publish' || fact.type === 'signalr_push') {
      child(
        parent,
        {
          repo,
          kind: 'push',
          ref: fact.type === 'redis_publish' ? fact.channel : fact.method,
          file: fact.file,
          line: fact.line,
          gateLine: fact.line,
          sink: true,
          ...marker,
        },
        'push',
        [factEvidence(repo, fact)],
      );
      return;
    }
    child(
      parent,
      {
        repo,
        kind: 'http_out',
        ref: `${fact.configKey} ${normalizeRoute(fact.template)}`,
        file: fact.file,
        line: fact.line,
        gateLine: fact.line,
        sink: true,
        ...marker,
      },
      'http_out',
      [factEvidence(repo, fact)],
    );
  }

  /** Facts whose method span is this method — the only attachment that can be gated. */
  function addMethodOutcomes(node, hops) {
    const scoped = (index.outcomeByMethod.get(`${node.repo}|${node.class}|${node.method}`) || [])
      .slice()
      .sort(byLine);
    for (const entry of scoped) {
      const key = fileFactKey(entry.repo, entry.fact);
      if (fileFactsUsed.has(key)) continue;
      fileFactsUsed.add(key);
      outcomeNode(node, entry, hops, null);
    }
  }

  /** Facts no method span covered: attached by file, and marked as such. */
  function addFileOutcomes(node, hops) {
    const fallback = [
      ...(index.publishByFile.get(`${node.repo}|${node.file}`) || []),
      ...(index.fileSinks.get(`${node.repo}|${node.file}`) || []),
    ].sort(byLine);
    for (const entry of fallback) {
      const key = fileFactKey(entry.repo, entry.fact);
      if (fileFactsUsed.has(key)) continue;
      fileFactsUsed.add(key);
      outcomeNode(node, entry, hops, 'file');
    }
  }

  function expandMessage(node, hops) {
    if (!guard(node)) return;
    if (!exhaustive && hops >= depth) {
      node.leaf = true;
      release(node);
      return;
    }
    const publishFact = node.messageFact || { message: node.ref, fqn: node.fqn };
    const consumers = index.consumeAll
      .map((entry) => ({ entry, level: matchMessage(index.messages, publishFact, entry.fact) }))
      .filter((candidate) => candidate.level !== null)
      .sort((a, b) => a.entry.fact.consumer.localeCompare(b.entry.fact.consumer));
    for (const { entry, level } of consumers) {
      const { repo, fact } = entry;
      const site = classSite(repo, fact.consumer);
      const consumer = child(
        node,
        {
          repo,
          kind: 'consumer',
          ref: fact.consumer,
          file: site ? site.file : fact.file,
          line: site ? site.line : fact.line,
          class: fact.consumer,
          message: fact.message,
          match: level.match,
          ...(level.fqns ? { fqns: level.fqns } : {}),
          ...(level.queue ? { queue: level.queue } : {}),
          ...(level.derived ? { derivedName: true } : {}),
        },
        'message',
        [factEvidence(repo, fact)],
      );
      consumer.hops = 0;
      asNewEntryPoint(() => expandConsumer(consumer, 0));
    }
    const processors = index.processorAll
      .map((entry) => ({ entry, level: matchMessage(index.messages, publishFact, entry.fact) }))
      .filter((candidate) => candidate.level !== null)
      .sort((a, b) => a.entry.fact.processor.localeCompare(b.entry.fact.processor));
    for (const { entry, level } of processors) {
      const { repo, fact } = entry;
      const site = classSite(repo, fact.processor);
      const processor = child(
        node,
        {
          repo,
          kind: 'processor',
          ref: fact.processor,
          file: site ? site.file : fact.file,
          line: site ? site.line : fact.line,
          class: fact.processor,
          message: fact.message || publishFact.message,
          workType: fact.workType,
          match: level.match,
          ...(level.fqns ? { fqns: level.fqns } : {}),
          ...(level.queue ? { queue: level.queue } : {}),
          ...(level.derived ? { derivedName: true } : {}),
        },
        'worker',
        [factEvidence(repo, fact)],
      );
      processor.hops = 0;
      asNewEntryPoint(() => expandConsumer(processor, 0));
    }
    release(node);
  }

  function graphHop(node, className, hops) {
    if (!outbound) return;
    const root = repoRoots.get(node.repo);
    if (!root) {
      node.graph = 'unavailable';
      return;
    }
    const result = outbound(root, className);
    if (!result || result.unavailable) {
      node.graph = 'unavailable';
      return;
    }
    const seen = new Set();
    const kept = [];
    let dropped = 0;
    for (const edge of result) {
      if (edge.kind !== 'uses-type') continue;
      const target = edge.target;
      if (matchesAny(GRAPH_PRUNE, target)) continue;
      const name = classNameFromPath(target);
      if (!name || name === className) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      if (graphReached.has(`${node.repo}|${name}`) || visited.has(`${node.repo}|${name}`)) continue;
      if (kept.length >= GRAPH_FANOUT) {
        dropped += 1;
        continue;
      }
      kept.push({ name, target, line: edge.line });
    }
    if (dropped > 0) node.dropped = dropped;
    for (const entry of kept) {
      graphReached.add(`${node.repo}|${entry.name}`);
      const site = classSite(node.repo, entry.name);
      const file = site ? site.file : entry.target;
      const line = site ? site.line : 1;
      if (isDb(node.repo, entry.name, file)) {
        child(
          node,
          {
            repo: node.repo,
            kind: 'db',
            ref: entry.name,
            file,
            line,
            sink: true,
            access: 'unknown',
            accessUnknown: true,
            methodAccess: [],
            effectInfra: !isPrimaryOwner(node),
          },
          'graph',
        );
        continue;
      }
      const target = child(node, { repo: node.repo, kind: 'class', ref: entry.name, file, line, class: entry.name }, 'graph');
      expandClass(target, hops + 1, []);
    }
  }

  /**
   * One method body, receiver by receiver. A `[ctor]` edge opens only for a field this
   * method actually calls through, and the implementation behind `[di]` gets only the
   * members those call sites named -- constructor injection is a list of what the class
   * *can* reach, never of what this method does.
   *
   * `--unscoped` uses a class-level reading, where the `[ctor]` edges hang off the class
   * rather than the body: every field the class calls through anywhere opens, so a
   * sibling action's dependencies and the members it uses ride along. Members this
   * method never named are tagged `di·unscoped`, so the two trees stay distinguishable
   * without counting nodes.
   */
  function expandCalls(node, className, methodName, hops) {
    const calls = (index.callsByMethod.get(`${node.repo}|${className}|${methodName}`) || []).slice().sort(byLine);
    const receiverCalls = unscoped
      ? (index.callsByClass.get(`${node.repo}|${className}`) || []).slice().sort(byLine)
      : calls;
    if (calls.length === 0 && receiverCalls.length === 0) return false;
    const fields = (index.ctorFields.get(`${node.repo}|${className}`) || []).reduce((map, entry) => {
      if (!map.has(entry.fact.field)) map.set(entry.fact.field, entry);
      return map;
    }, new Map());
    const groups = new Map();
    const selfCalls = new Map();
    for (const entry of calls) {
      if (entry.fact.field !== 'this') continue;
      const called = entry.fact.calledMethod;
      const self = selfCalls.get(called) || { name: called, line: entry.fact.line, lines: [], facts: [] };
      self.lines.push(entry.fact.line);
      self.facts.push(entry.fact);
      self.line = Math.min(self.line, entry.fact.line);
      selfCalls.set(called, self);
    }
    const typeOfField = (field) => (fields.has(field) ? fields.get(field).fact.paramType : field);
    // A `receiverType` on the fact itself -- stamped by the service-locator extraction for a
    // `GetRequiredService<T>()`/`GetService<T>()` resolution -- names the receiver's type
    // directly, from the generic argument captured at the call site, and always wins over the
    // constructor's declared type: the field it is attached to (a local variable, or the
    // locator field's own call) was never itself a `ctor_field` for `T`.
    const effectiveType = (entry) => entry.fact.receiverType || typeOfField(entry.fact.field);
    const named = new Set(
      calls
        .filter((entry) => entry.fact.field !== 'this')
        .map((entry) => `${effectiveType(entry)}|${entry.fact.calledMethod}`),
    );
    for (const entry of receiverCalls) {
      const field = entry.fact.field;
      if (field === 'this') continue;
      const ctor = fields.get(field);
      const type = entry.fact.receiverType || (ctor ? ctor.fact.paramType : field);
      const group = groups.get(type) || { type, ctor, line: entry.fact.line, methods: [], elementAccess: false };
      // Any call on this field recorded against an *element* of it (a loop
      // variable or indexed access), rather than the field itself, marks the whole group --
      // a group is never a mix, since `extractElementCalls` and `extractMethodCalls` can
      // never both match the same call site.
      if (entry.fact.elementAccess === true) group.elementAccess = true;
      if (!group.methods.some((called) => called.name === entry.fact.calledMethod)) {
        group.methods.push({ name: entry.fact.calledMethod, line: entry.fact.line, lines: [], facts: [] });
      }
      const called = group.methods.find((item) => item.name === entry.fact.calledMethod);
      called.lines.push(entry.fact.line);
      called.facts.push(entry.fact);
      group.line = Math.min(group.line, entry.fact.line);
      groups.set(type, group);
    }
    const ordered = [
      ...[...selfCalls.values()].map((self) => ({ self, line: self.line })),
      ...[...groups.values()].map((group) => ({ group, line: group.line })),
    ].sort((a, b) => a.line - b.line || (a.self ? a.self.name : a.group.type).localeCompare(b.self ? b.self.name : b.group.type));

    for (const item of ordered) {
      if (item.self) {
        const self = item.self;
        if (self.name === methodName) continue;
        const anchor = methodAnchor(node.repo, className, self.name, { file: node.file, line: self.line });
        const selfNode = child(
          node,
          {
            repo: node.repo,
            kind: 'method',
            ref: `${className}.${self.name}`,
            file: anchor.file,
            line: anchor.line,
            class: className,
            method: self.name,
            selfCall: true,
            gates: intersectGates(self.lines.map((line) => gatesAt(node, line))),
          },
          'body',
          factEvidenceList(node.repo, self.facts),
        );
        expand(selfNode, selfNode.hops);
        continue;
      }
      const group = item.group;
      const ctorSite = group.ctor ? group.ctor.fact : null;
      const typeSite = classSite(node.repo, group.type);
      const typeNode = child(
        node,
        {
          repo: node.repo,
          kind: 'class',
          ref: group.type,
          file: typeSite ? typeSite.file : ctorSite ? ctorSite.file : node.file,
          line: typeSite ? typeSite.line : ctorSite ? ctorSite.line : group.line,
          class: group.type,
          gateLine: group.line,
          field: ctorSite ? ctorSite.field : undefined,
          ...(fanIn(group.type) >= infraFanIn ? { infra: true, fanIn: fanIn(group.type) } : {}),
        },
        'ctor',
      );
      if (!guard(typeNode)) continue;
      const guarded = [typeNode];

      const attachMethods = (target) => {
        if (isDb(node.repo, target.ref, target.file)) {
          target.kind = 'db';
          target.sink = true;
          target.effectInfra = !isPrimaryOwner(node);
          target.methods = group.methods.map((called) => called.name);
          markDbAccess(target, target.methods);
          target.gates = intersectGates(
            group.methods.flatMap((called) => called.lines.map((line) => gatesAt(node, line))),
          );
          addEvidenceToNodeEdge(
            target,
            factEvidenceList(
              node.repo,
              group.methods.flatMap((called) => called.facts),
            ),
          );
          return;
        }
        for (const called of group.methods) {
          const anchor = methodAnchor(node.repo, target.ref, called.name, { file: target.file, line: target.line });
          const methodNode = child(
            target,
            {
              repo: node.repo,
              kind: 'method',
              ref: `${target.ref}.${called.name}`,
              file: anchor.file,
              line: anchor.line,
              class: target.ref,
              method: called.name,
              gates: intersectGates(called.lines.map((line) => gatesAt(node, line))),
            },
            named.has(`${group.type}|${called.name}`) ? 'body' : UNSCOPED_VIA,
            factEvidenceList(node.repo, called.facts),
          );
          expand(methodNode, methodNode.hops);
        }
      };

      // A call recorded against an *element* of this field (a loop variable or an
      // indexed access, never the field itself) has no single receiver to resolve -- it fans
      // out to every known implementation of the element interface (`di_binding` union
      // `iface_impl`) instead of picking the first `di_binding`, one `interface_fanout` child
      // per implementation, capped at INTERFACE_FANOUT_CAP so a wide interface cannot
      // multiply the walk's node budget without bound. A group whose field is not one of the
      // recognised generic collection wrappers (or whose generic argument is not itself
      // interface-shaped) falls through to the ordinary single-receiver path below unchanged.
      const elementType = group.elementAccess ? collectionElementType(group.type) : null;
      if (elementType && isInterfaceName(elementType)) {
        const impls = interfaceImplementations(index, node.repo, elementType);
        typeNode.iface = elementType;
        typeNode.fanoutTotal = impls.length;
        const kept = exhaustive ? impls : impls.slice(0, INTERFACE_FANOUT_CAP);
        if (kept.length === 0) {
          typeNode.unresolved = true;
          typeNode.fanout = 'interface';
          releaseAll(guarded);
          continue;
        }
        if (impls.length > kept.length) typeNode.fanoutDropped = impls.length - kept.length;
        for (const implEntry of kept) {
          const implName = implEntry.fact.impl;
          const implSite = classSite(node.repo, implName);
          const implNode = child(
            typeNode,
            {
              repo: node.repo,
              kind: 'class',
              ref: implName,
              file: implSite ? implSite.file : implEntry.fact.file,
              line: implSite ? implSite.line : implEntry.fact.line,
              class: implName,
              iface: elementType,
              fanoutCount: kept.length,
            },
            'interface_fanout',
          );
          if (!guard(implNode)) continue;
          attachMethods(implNode);
          release(implNode);
        }
        releaseAll(guarded);
        continue;
      }

      const bindings = (index.diByIface.get(`${node.repo}|${group.type}`) || [])
        .slice()
        .sort((a, b) => a.fact.impl.localeCompare(b.fact.impl));
      let target = typeNode;
      if (bindings.length > 0) {
        const implName = bindings[0].fact.impl;
        const implSite = classSite(node.repo, implName);
        const implNode = child(
          typeNode,
          {
            repo: node.repo,
            kind: 'class',
            ref: implName,
            file: implSite ? implSite.file : bindings[0].fact.file,
            line: implSite ? implSite.line : bindings[0].fact.line,
            class: implName,
            ...(bindings.length > 1 ? { bindings: bindings.map((entry) => entry.fact.impl) } : {}),
          },
          'di',
        );
        if (!guard(implNode)) {
          releaseAll(guarded);
          continue;
        }
        guarded.push(implNode);
        target = implNode;
      } else if (isInterfaceName(group.type) && !isDb(node.repo, group.type, typeNode.file)) {
        typeNode.unresolved = true;
        releaseAll(guarded);
        continue;
      }
      attachMethods(target);
      releaseAll(guarded);
    }
    return true;
  }

  function expandMethod(node, hops) {
    if (!guard(node)) return;
    if (nodes.length >= maxNodes) {
      node.leaf = true;
      budgetHit = true;
      release(node);
      return;
    }
    if (!exhaustive && hops >= depth) {
      node.leaf = true;
      release(node);
      return;
    }
    const className = node.class;
    const methodName = node.method;
    const branches = mergeBranchFacts(
      pairElseFacts((index.branchesByMethod.get(`${node.repo}|${className}|${methodName}`) || []).slice().sort(byLine)),
    );
    node.branchSpans = [];
    for (const { repo, fact } of branches) {
      const branch = addBranch(node, repo, fact, className, methodName);
      if (!branch.dispositions || branch.primary !== true) continue;
      const disposition = blockDisposition(branch.branchKind, branch.text, branch.dispositions);
      const other = branch.dispositions.find((option) => option !== disposition);
      node.branchSpans.push({
        branch: branch.id,
        kind: branch.branchKind,
        line: branch.line,
        start: branch.line,
        end: fact.endLine ?? branch.line,
        disposition,
        elseDisposition: other ?? disposition,
        ...(fact.elseLine !== undefined ? { elseStart: fact.elseLine, elseEnd: fact.elseEndLine } : {}),
      });
    }
    const frontier = node.via === UNSCOPED_VIA;
    const expanded = frontier ? false : expandCalls(node, className, methodName, hops);
    addMethodOutcomes(node, hops);
    addFileOutcomes(node, hops);
    if (!frontier && (!expanded || forceGraph)) graphHop(node, className, hops);
    release(node);
  }

  /**
   * The methods a consumer is entered through. A consumer declares its entry by taking
   * the message it consumes -- `Consume(ConsumeContext<T>)`, `Run(JobContext<T>)`,
   * `Consume(ConsumeContext<Batch<T>>)` or the message itself -- so the first choice is
   * every declared method whose parameter types hand it that message. Only when no
   * parameter identifies one does the verb list decide (the built-in verbs plus
   * `consumerEntryMethods`). A class whose declared methods match neither way names no
   * entry: it is marked unresolved and no method is walked, rather than walking one the
   * code never said was the entry. A class with no method facts at all is left to the
   * graph hop as before, since there is nothing to choose between.
   */
  function consumerEntry(node) {
    const className = node.class || node.ref;
    const key = `${node.repo}|${className}`;
    const spans = index.spansByClass.get(key) || [];
    const declared = new Set([...(index.methodsByClass.get(key) || []), ...spans.map((span) => span.method)]);
    declared.delete(className);
    if (declared.size === 0) return { declared: false, methods: [] };
    const message = bareTypeName(node.message);
    const byType = message
      ? [...declared].filter((name) =>
          spans.some((span) => span.method === name && (span.paramTypes || []).some((type) => namesType(type, message))),
        )
      : [];
    const methods = byType.length > 0 ? byType : [...declared].filter((name) => consumerEntryMethods.includes(name));
    return { declared: true, methods };
  }

  function expandConsumer(node, hops) {
    const entry = consumerEntry(node);
    if (entry.declared && entry.methods.length === 0) node.unresolved = true;
    expandClass(node, hops, entry.methods);
  }

  function expandClass(node, hops, methodFilter) {
    if (!guard(node)) return;
    if (nodes.length >= maxNodes) {
      node.leaf = true;
      budgetHit = true;
      release(node);
      return;
    }
    if (!exhaustive && hops >= depth) {
      node.leaf = true;
      release(node);
      return;
    }
    const className = node.class || node.ref;
    const names = index.methodsByClass.get(`${node.repo}|${className}`) || new Set();
    const selected = [...names]
      .filter((name) => !methodFilter || methodFilter.includes(name))
      .sort((a, b) => a.localeCompare(b));
    for (const name of selected) {
      const anchor = (index.callsByMethod.get(`${node.repo}|${className}|${name}`) ||
        index.branchesByMethod.get(`${node.repo}|${className}|${name}`) ||
        [])
        .slice()
        .sort(byLine)[0];
      const methodNode = child(
        node,
        {
          repo: node.repo,
          kind: 'method',
          ref: `${className}.${name}`,
          file: anchor ? anchor.fact.file : node.file,
          line: anchor ? anchor.fact.line : node.line,
          class: className,
          method: name,
        },
        'body',
      );
      expand(methodNode, methodNode.hops);
    }
    addFileOutcomes(node, hops);
    if (selected.length === 0 || forceGraph) graphHop(node, className, hops);
    release(node);
  }

  function summarizeRoute(node) {
    if (summaries.has(node.ref)) return summaries.get(node.ref);
    const walked = trace(factSets, null, {
      ...options,
      inventory: false,
      seeds: true,
      // A route has no template handlers of its own — a `--from-handler` selector scoped
      // to the outer walk's UI would make resolveFromHandler find zero matches here and
      // short-circuit trace() before it produces `stats`. This summary always wants the
      // route's full stats, so it never inherits the outer handler selector.
      fromHandler: undefined,
      index,
      summaries,
      startNode: { repo: node.repo, kind: 'route', ref: node.ref, file: node.file, line: node.line, route: node.route },
    });
    const summary = {
      sinks: walked.stats.sinks,
      primaryBranches: walked.stats.primaryBranches,
      seeds: walked.seeds.length + walked.seedsTruncated,
    };
    summaries.set(node.ref, summary);
    return summary;
  }

  function expandRoute(node, hops) {
    if (!guard(node)) return;
    const route = node.route;
    if (!route) {
      release(node);
      return;
    }
    const action = child(
      node,
      {
        repo: node.repo,
        kind: 'action',
        ref: `${route.controller}.${route.action}`,
        file: route.file,
        line: route.line,
        class: route.controller,
        method: route.action,
      },
      'literal',
      [factEvidence(node.repo, route)],
    );
    expandMethod(action, action.hops);
    release(node);
  }

  /** Every route a set of `gateway_call` facts reaches, matched on the route key. */
  function addGatewayRoutes(node, entries) {
    for (const { fact } of entries.slice().sort(byLine)) {
      const match = matchRoute(index.routeIndex, fact.verb, fact.template, aliases);
      const callerKey = routeKey(fact.verb, fact.template);
      if (!match) {
        child(
          node,
          {
            repo: node.repo,
            kind: 'route',
            ref: callerKey,
            file: fact.file,
            line: fact.line,
            unresolved: true,
            caller: `${fact.service}.${fact.method}`,
            callerFile: fact.file,
            callerLine: fact.line,
            templateResolved: fact.resolved === true,
          },
          'literal',
          [factEvidence(node.repo, fact)],
        );
        continue;
      }
      const via = match.match === 'exact' ? 'literal' : match.match;
      const routeNode = child(
        node,
        {
          repo: match.route.repo,
          kind: 'route',
          ref: match.route.key,
          file: match.route.fact.file,
          line: match.route.fact.line,
          route: match.route.fact,
          caller: `${fact.service}.${fact.method}`,
          callerFile: fact.file,
          callerLine: fact.line,
          templateResolved: fact.resolved === true,
        },
        via,
        [factEvidence(node.repo, fact)],
      );
      routeNode.hops = 0;
      if (inventory) {
        routeNode.summary = summarizeRoute(routeNode);
        continue;
      }
      if (stopAtRoutes) continue;
      expandRoute(routeNode, 0);
    }
  }

  /**
   * Which members of each injected class this class calls, anywhere in its own bodies,
   * keyed by the injected class name a mobile `method_call` records as its receiver.
   * The `[ctor]` list says what a class holds; this says what it uses, and only what it
   * uses is walked.
   *
   * A field with no entry is not a field with no uses: the extractor leaves out gateway
   * and action-stream receivers by design, and a class whose bodies were never read has
   * no entries at all. Absence is no evidence, so the caller falls back to the whole
   * injected class there; a field that *does* appear is scoped to the members named.
   */
  function membersCalledByClass(repo, className) {
    const byField = new Map();
    for (const { fact } of index.callsByClass.get(`${repo}|${className}`) || []) {
      if (fact.field === 'this') continue;
      const members = byField.get(fact.field) || [];
      const seen = members.find((member) => member.name === fact.calledMethod);
      if (seen) seen.line = Math.min(seen.line, fact.line);
      else members.push({ name: fact.calledMethod, line: fact.line });
      byField.set(fact.field, members);
    }
    for (const members of byField.values()) {
      members.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    }
    return byField;
  }

  /**
   * A mobile method body: sibling calls stay in the class, an injected field's call opens
   * that class and the method named on it, and a `gateway_call` written in this method is
   * the request that leaves the app. This is the leg that says which user action reaches
   * which route, so only the methods actually called are walked.
   */
  function expandMobileMethod(node, hops) {
    if (!guard(node)) return;
    if (nodes.length >= maxNodes) {
      node.leaf = true;
      budgetHit = true;
      release(node);
      return;
    }
    if (!exhaustive && hops >= depth) {
      node.leaf = true;
      release(node);
      return;
    }
    const calls = (index.callsByMethod.get(`${node.repo}|${node.class}|${node.method}`) || []).slice().sort(byLine);
    const groups = new Map();
    for (const { fact } of calls) {
      const group = groups.get(fact.field) || { field: fact.field, line: fact.line, methods: [] };
      if (!group.methods.some((called) => called.name === fact.calledMethod)) {
        group.methods.push({ name: fact.calledMethod, line: fact.line, facts: [] });
      }
      group.methods.find((called) => called.name === fact.calledMethod).facts.push(fact);
      group.line = Math.min(group.line, fact.line);
      groups.set(fact.field, group);
    }
    const ordered = [...groups.values()].sort((a, b) => a.line - b.line || a.field.localeCompare(b.field));

    for (const group of ordered) {
      if (group.field === 'this') {
        for (const called of group.methods) {
          if (called.name === node.method) continue;
          const anchor = methodAnchor(node.repo, node.class, called.name, { file: node.file, line: called.line });
          const selfNode = child(
            node,
            {
              repo: node.repo,
              kind: 'method',
              ref: `${node.class}.${called.name}`,
              file: anchor.file,
              line: anchor.line,
              class: node.class,
              method: called.name,
              selfCall: true,
            },
            'body',
            factEvidenceList(node.repo, called.facts),
          );
          expandMobileMethod(selfNode, selfNode.hops);
        }
        continue;
      }
      const target = lastComponent(index, `${node.repo}|${group.field}`);
      const site = classSite(node.repo, group.field);
      const classNode = child(
        node,
        {
          repo: node.repo,
          kind: target ? componentKind(target.fact.role) : 'service',
          ref: group.field,
          file: target ? target.fact.file : site ? site.file : node.file,
          line: target ? target.fact.line : site ? site.line : group.line,
          class: group.field,
        },
        'di',
      );
      if (!guard(classNode)) continue;
      for (const called of group.methods) {
        const anchor = methodAnchor(node.repo, group.field, called.name, {
          file: classNode.file,
          line: classNode.line,
        });
        const methodNode = child(
          classNode,
          {
            repo: node.repo,
            kind: 'method',
            ref: `${group.field}.${called.name}`,
            file: anchor.file,
            line: anchor.line,
            class: group.field,
            method: called.name,
          },
          'body',
          factEvidenceList(node.repo, called.facts),
        );
        expandMobileMethod(methodNode, methodNode.hops);
      }
      release(classNode);
    }

    addDispatches(node);

    const owned = (index.gatewayByService.get(`${node.repo}|${node.class}`) || []).filter(
      (entry) => entry.fact.method === node.method,
    );
    addGatewayRoutes(node, owned);
    release(node);
  }

  /**
   * The actions a method dispatches. A dispatch names the action, never the code that
   * answers it, so the action itself is the node: what runs is whatever effects listen for
   * it, and one action reaching several effects is a real fan-out the walk keeps.
   */
  function addDispatches(node) {
    const dispatches = (index.dispatchesFrom.get(`${node.repo}|${node.class}|${node.method}`) || [])
      .slice()
      .sort(byLine);
    const seen = new Set();
    for (const { repo, fact } of dispatches) {
      if (seen.has(fact.action)) continue;
      seen.add(fact.action);
      const def = index.actionDefs.get(`${repo}|${fact.action}`);
      const actionNode = child(
        node,
        {
          repo,
          kind: 'store_action',
          ref: fact.action,
          file: def ? def.fact.file : fact.file,
          line: def ? def.fact.line : fact.line,
          action: fact.action,
          ...(def ? {} : { unresolved: true }),
        },
        'dispatch',
      );
      expandStoreAction(actionNode, actionNode.hops);
    }
  }

  /**
   * A dispatched action: every effect whose `ofType` names it, walked as the method body it
   * is. An effect that dispatches an action another effect consumes is a cycle the path
   * guard ends, and an action nothing listens for is a leaf, not an error.
   */
  function expandStoreAction(node, hops) {
    if (!guard(node)) return;
    if (nodes.length >= maxNodes) {
      node.leaf = true;
      budgetHit = true;
      release(node);
      return;
    }
    if (!exhaustive && hops >= depth) {
      node.leaf = true;
      release(node);
      return;
    }
    const effects = (index.effectsByAction.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    for (const { repo, fact } of effects) {
      const anchor = methodAnchor(repo, fact.class, fact.field, { file: fact.file, line: fact.line });
      const effectNode = child(
        node,
        {
          repo,
          kind: 'method',
          ref: `${fact.class}.${fact.field}`,
          file: anchor.file,
          line: anchor.line,
          class: fact.class,
          method: fact.field,
          effect: true,
        },
        'effect',
      );
      expandBody(effectNode, effectNode.hops);
    }
    release(node);
  }

  /** A method body, walked by the reader of the repository kind it was written in. */
  function expandBody(node, hops) {
    if (index.repos.get(node.repo) === 'web') expandWebMethod(node, hops);
    else expandMobileMethod(node, hops);
  }

  /**
   * A prop that carries an action creator: `connect(map, { creator })` binds the creator
   * to a prop name, so `this.props.creator(…)` is a dispatch written through the props
   * object. The hop lands on the creator itself, exactly as `dispatch` does, and a prop
   * with no binding in this component is the prop-drilling gap — one leaf, not silence.
   */
  function addPropHop(parent, componentName, propName, fact, event, evidence = [factEvidence(parent.repo, fact)]) {
    const bound = index.propTargets.get(`${parent.repo}|${componentName}|${propName}`);
    if (!bound) {
      child(
        parent,
        {
          repo: parent.repo,
          kind: 'store_action',
          ref: propName,
          file: fact.file,
          line: fact.line,
          action: propName,
          prop: propName,
          unresolved: true,
          ...(event ? { event } : {}),
        },
        'props',
        evidence,
      );
      return;
    }
    const target = bound.fact.target;
    const def = index.actionDefs.get(`${parent.repo}|${target}`);
    const propNode = child(
      parent,
      {
        repo: parent.repo,
        kind: 'store_action',
        ref: target,
        file: def ? def.fact.file : bound.fact.file,
        line: def ? def.fact.line : bound.fact.line,
        action: target,
        prop: propName,
        ...(event ? { event } : {}),
        ...(def ? {} : { unresolved: true }),
      },
      'props',
      evidence,
    );
    expandStoreAction(propNode, propNode.hops);
  }

  /**
   * A React component: the children it renders, the JSX `on*` handlers it binds, and any
   * gateway call written in its own body. A handler naming a bound prop is a `props` hop
   * to the creator that prop carries; every other handler is a function of this component,
   * whether or not the extractor found its body — an unresolved handler is stated, not
   * dropped, because that is the measured prop-drilling gap.
   */
  function expandWeb(node, hops) {
    if (!guard(node)) return;
    if (!exhaustive && hops >= depth && node.kind !== 'page') {
      node.leaf = true;
      release(node);
      return;
    }
    const renders = (index.rendersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    for (const { repo, fact } of renders) {
      const target = lastComponent(index, `${repo}|${fact.to}`) || index.componentBySelector.get(fact.to);
      const rendered = child(
        node,
        target
          ? {
              repo: target.repo,
              kind: componentKind(target.fact.role),
              ref: target.fact.name,
              file: target.fact.file,
              line: target.fact.line,
            }
          : { repo, kind: 'component', ref: fact.to, file: fact.file, line: fact.line, unresolved: true },
        'template',
      );
      if (target) expandWeb(rendered, rendered.hops);
    }

    const handlers = (index.handlersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    const bound = new Set();
    for (const { repo, fact } of handlers) {
      if (fact.kind === 'assign') continue;
      const binding = `${fact.event}|${fact.handler}`;
      if (bound.has(binding)) continue;
      bound.add(binding);
      const span = index.spanByMethod.get(`${repo}|${node.ref}|${fact.handler}`);
      const prop = index.propTargets.get(`${repo}|${node.ref}|${fact.handler}`);
      if (fact.kind === 'prop' || (!span && prop)) {
        addPropHop(node, node.ref, fact.handler, fact, fact.event);
        continue;
      }
      const anchor = methodAnchor(repo, node.ref, fact.handler, { file: fact.file, line: fact.line });
      const handlerNode = child(
        node,
        {
          repo,
          kind: 'method',
          ref: `${node.ref}.${fact.handler}`,
          file: anchor.file,
          line: anchor.line,
          class: node.ref,
          method: fact.handler,
          event: fact.event,
          ...(span ? {} : { unresolved: true }),
        },
        'handler',
      );
      if (span) expandWebMethod(handlerNode, handlerNode.hops);
    }

    addGatewayRoutes(node, index.gatewayByMethod.get(`${node.repo}|${node.ref}|${node.ref}`) || []);
    release(node);
  }

  /**
   * A web function body: a sibling call stays in the module's own bucket, an imported
   * callee opens the one span that answers to that name, a call through `props` is a
   * `props` hop, and a `gateway_call` written here is the request that leaves the browser.
   * A thunk reached by `effect` is walked by this same function — in the libraries this
   * extractor reads, the thunk *is* the effect, so there is no separate effects tier to cross.
   */
  function expandWebMethod(node, hops) {
    if (!guard(node)) return;
    if (nodes.length >= maxNodes) {
      node.leaf = true;
      budgetHit = true;
      release(node);
      return;
    }
    if (!exhaustive && hops >= depth) {
      node.leaf = true;
      release(node);
      return;
    }
    const calls = (index.callsByMethod.get(`${node.repo}|${node.class}|${node.method}`) || []).slice().sort(byLine);
    const groupedCalls = new Map();
    for (const { fact } of calls) {
      const key = `${fact.field}|${fact.calledMethod}`;
      const facts = groupedCalls.get(key) || [];
      facts.push(fact);
      groupedCalls.set(key, facts);
    }
    for (const facts of groupedCalls.values()) {
      const fact = facts[0];
      const evidence = factEvidenceList(node.repo, facts);
      if (fact.field === 'props') {
        addPropHop(node, node.class, fact.calledMethod, fact, null, evidence);
        continue;
      }
      if (fact.field === 'this') {
        if (fact.calledMethod === node.method) continue;
        const anchor = methodAnchor(node.repo, node.class, fact.calledMethod, { file: node.file, line: fact.line });
        const selfNode = child(
          node,
          {
            repo: node.repo,
            kind: 'method',
            ref: `${node.class}.${fact.calledMethod}`,
            file: anchor.file,
            line: anchor.line,
            class: node.class,
            method: fact.calledMethod,
            selfCall: true,
          },
          'body',
          evidence,
        );
        expandWebMethod(selfNode, selfNode.hops);
        continue;
      }
      const spans = index.spansByName.get(`${node.repo}|${fact.calledMethod}`) || [];
      const only = spans.length === 1 ? spans[0] : null;
      const target = child(
        node,
        only
          ? {
              repo: node.repo,
              kind: 'method',
              ref: `${only.class}.${only.method}`,
              file: only.file,
              line: only.line,
              class: only.class,
              method: only.method,
            }
          : {
              repo: node.repo,
              kind: 'method',
              ref: fact.calledMethod,
              file: fact.file,
              line: fact.line,
              class: node.class,
              method: fact.calledMethod,
              unresolved: true,
            },
        'body',
        evidence,
      );
      if (only) expandWebMethod(target, target.hops);
    }

    addDispatches(node);
    addGatewayRoutes(node, index.gatewayByMethod.get(`${node.repo}|${node.class}|${node.method}`) || []);
    release(node);
  }

  function expandMobile(node, hops) {
    if (!guard(node)) return;
    if (!exhaustive && hops >= depth && node.kind !== 'page') {
      node.leaf = true;
      release(node);
      return;
    }
    const renders = (index.rendersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    for (const { repo, fact } of renders) {
      const target = index.componentBySelector.get(fact.to);
      const rendered = child(
        node,
        target
          ? {
              repo: target.repo,
              kind: componentKind(target.fact.role),
              ref: target.fact.name,
              file: target.fact.file,
              line: target.fact.line,
            }
          : { repo, kind: 'component', ref: fact.to, file: fact.file, line: fact.line, unresolved: true },
        'template',
      );
      if (target) expandMobile(rendered, rendered.hops);
    }
    const handlers = (index.handlersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    const bound = new Set();
    for (const { repo, fact } of handlers) {
      if (fact.kind !== 'call') continue;
      const binding = `${fact.event}|${fact.handler}`;
      if (bound.has(binding)) continue;
      bound.add(binding);
      const anchor = methodAnchor(repo, node.ref, fact.handler, { file: fact.file, line: fact.line });
      const handlerNode = child(
        node,
        {
          repo,
          kind: 'method',
          ref: `${node.ref}.${fact.handler}`,
          file: anchor.file,
          line: anchor.line,
          class: node.ref,
          method: fact.handler,
          event: fact.event,
        },
        'handler',
      );
      expandMobileMethod(handlerNode, handlerNode.hops);
    }
    const injects = (index.injectsFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    const calledOnField = unscoped ? null : membersCalledByClass(node.repo, node.ref);
    for (const { repo, fact } of injects) {
      const target = lastComponent(index, `${repo}|${fact.to}`);
      const injected = child(
        node,
        target
          ? {
              repo: target.repo,
              kind: componentKind(target.fact.role),
              ref: target.fact.name,
              file: target.fact.file,
              line: target.fact.line,
            }
          : { repo, kind: 'service', ref: fact.to, file: fact.file, line: fact.line },
        'ctor',
      );
      const called = unscoped ? null : calledOnField.get(fact.to);
      if (!called) {
        expandMobile(injected, injected.hops);
        continue;
      }
      if (!guard(injected)) continue;
      for (const member of called) {
        const anchor = methodAnchor(node.repo, injected.ref, member.name, {
          file: injected.file,
          line: injected.line,
        });
        const methodNode = child(
          injected,
          {
            repo: node.repo,
            kind: 'method',
            ref: `${injected.ref}.${member.name}`,
            file: anchor.file,
            line: anchor.line,
            class: injected.ref,
            method: member.name,
          },
          'body',
        );
        expandMobileMethod(methodNode, methodNode.hops);
      }
      release(injected);
    }
    addGatewayRoutes(node, index.gatewayByService.get(`${node.repo}|${node.ref}`) || []);
    release(node);
  }

  function expand(node, hops) {
    switch (node.kind) {
      case 'page':
      case 'component':
      case 'service':
        if (index.repos.get(node.repo) === 'web') expandWeb(node, hops);
        else expandMobile(node, hops);
        break;
      case 'route':
        expandRoute(node, hops);
        break;
      case 'action':
        expandMethod(node, hops);
        break;
      case 'method': {
        const kind = index.repos.get(node.repo);
        if (kind === 'web') expandWebMethod(node, hops);
        else if (kind === 'mobile') expandMobileMethod(node, hops);
        else expandMethod(node, hops);
        break;
      }
      case 'store_action':
        expandStoreAction(node, hops);
        break;
      case 'message':
        expandMessage(node, hops);
        break;
      case 'consumer':
      case 'processor':
        expandConsumer(node, hops);
        break;
      case 'class':
        expandClass(node, hops, null);
        break;
      default:
        break;
    }
  }

  const root = makeNode({ ...resolved.node, hops: 0, via: 'start' });
  root.homeRepo = root.repo;
  root.methodEntered = root.kind === 'method' || root.kind === 'action';
  try {
    expand(root, 0);
  } catch (error) {
    if (error !== exhaustiveBudget) throw error;
    root.leaf = true;
  }

  let walked = nodes;
  let walkedEdges = edges;
  if (inventory) {
    const keep = new Set([root.id]);
    const mark = (node) => {
      let reaches = node.kind === 'route';
      for (const kid of node.children) {
        if (mark(kid)) reaches = true;
      }
      if (reaches) keep.add(node.id);
      return reaches;
    };
    mark(root);
    const prune = (node) => {
      node.children = node.children.filter((kid) => keep.has(kid.id));
      for (const kid of node.children) prune(kid);
    };
    prune(root);
    walked = nodes.filter((node) => keep.has(node.id));
    walkedEdges = edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  }

  let effectiveRoot = root;
  if (options.fromHandler) {
    const handlerNodes = walked.filter((node) => node.via === 'handler' || (node.via === 'props' && node.event));
    const resolved = resolveFromHandler(handlerNodes, options.fromHandler);
    if (resolved.candidates) return { fromHandlerCandidates: resolved.candidates };
    if (!resolved.node) {
      return {
        fromHandlerError: `no template handler matches "${options.fromHandler}"`,
        fromHandlerAvailable: resolved.available,
      };
    }
    effectiveRoot = resolved.node;
    const keep = new Set();
    const collect = (node) => {
      keep.add(node.id);
      for (const kid of node.children) collect(kid);
    };
    collect(effectiveRoot);
    walked = walked.filter((node) => keep.has(node.id));
    walkedEdges = walkedEdges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  }

  const sinks = walked.filter((node) => node.sink === true);
  const branches = walked.filter((node) => node.kind === 'branch');
  const primaryBranches = branches.filter((node) => node.primary === true);
  const routes = walked.filter((node) => node.kind === 'route');
  const seeds = options.seeds
    ? buildSeeds(effectiveRoot, effectiveRoot.ref, index.paramSources)
    : { list: [], truncated: 0 };
  const viaCounts = {};
  for (const edge of walkedEdges) viaCounts[edge.via] = (viaCounts[edge.via] || 0) + 1;
  const repos = [...new Set(walked.map((node) => node.repo))].filter((repo) => index.repos.has(repo)).sort();

  return {
    root: effectiveRoot,
    nodes: walked,
    edges: walkedEdges,
    sinks,
    branches,
    seeds: seeds.list,
    seedsTruncated: seeds.truncated,
    stats: {
      nodes: walked.length,
      edges: walkedEdges.length,
      sinks: sinks.length,
      branches: branches.length,
      primaryBranches: primaryBranches.length,
      seedCount: seeds.list.length + seeds.truncated,
      routes: routes.length,
      inventory,
      repos,
      via: viaCounts,
      depth,
      crossings,
      budgetHit,
      ...(exhaustive ? { exhaustive: true, complete: !budgetHit, maxNodes } : {}),
      graphUnavailable: nodes.filter((node) => node.graph === 'unavailable').length,
    },
  };
}

function branchLabel(node) {
  return `${node.branchKind}@${node.line}`;
}

function branchRecord(node, disposition) {
  return {
    kind: node.branchKind,
    line: node.line,
    class: node.class,
    method: node.method,
    text: node.text,
    ...(node.returnText ? { returnText: node.returnText } : {}),
    ...(node.response ? { response: node.response } : {}),
    ...(node.responseKind ? { responseKind: node.responseKind } : {}),
    ...(node.collapsed ? { collapsed: node.collapsed } : {}),
    ...(disposition ? { disposition } : {}),
  };
}

/** Every branch point in the tree, in the order the request meets them. */
function branchesInOrder(root) {
  const ordered = [];
  const walk = (node) => {
    const own = node.children.filter((kid) => kid.kind === 'branch').sort((a, b) => a.line - b.line);
    ordered.push(...own);
    for (const kid of node.children) {
      if (kid.kind !== 'branch') walk(kid);
    }
  };
  walk(root);
  return ordered;
}

/**
 * A data-access class the walk reached through a `method_call` that named the method it
 * calls. A class the code index attached to another class says only that the two types
 * appear together: there is no call, no method and no access to report, so it stays in
 * the tree as a guess and never becomes a use case a tester is asked to cover.
 */
function isCalledDb(node) {
  return node.kind === 'db' && node.via !== 'graph' && Array.isArray(node.methods) && node.methods.length > 0;
}

function firstDbSinks(node, found = []) {
  for (const kid of node.children) {
    if (kid.kind === 'db') {
      if (isCalledDb(kid)) found.push(`${kid.ref}.${kid.methods[0]}`);
    } else firstDbSinks(kid, found);
  }
  return found;
}

/** Outcome items: what the request writes, publishes or pushes, and where it is gated. */
function collectOutcomes(root) {
  const items = [];
  const walk = (node) => {
    if (node.kind === 'message' && node.asyncLeg !== true) {
      items.push({
        order: 2,
        kind: 'message',
        ref: node.ref,
        repo: node.repo,
        file: node.file,
        line: node.line,
        infra: node.effectInfra === true,
        gates: node.gates || [],
        consumers: node.children
          .filter((kid) => kid.kind === 'consumer' || kid.kind === 'processor')
          .map((kid) => ({ ref: kid.ref, repo: kid.repo, kind: kid.kind, sinks: firstDbSinks(kid) })),
      });
    } else if (node.sink === true && node.asyncLeg !== true && (node.kind !== 'db' || isCalledDb(node))) {
      const common = {
        kind: node.kind,
        ref: node.ref,
        repo: node.repo,
        file: node.file,
        line: node.line,
        infra: node.effectInfra === true,
        gates: node.gates || [],
      };
      if (node.kind === 'db') {
        for (const entry of node.methodAccess || [{ name: '', access: 'write', accessGuess: true }]) {
          items.push({
            order: entry.access === 'write' ? 0 : 1,
            ...common,
            ...(entry.name ? { method: entry.name } : {}),
            access: entry.access,
            ...(entry.accessGuess ? { accessGuess: true } : {}),
          });
        }
      } else {
        items.push({ order: node.kind === 'push' ? 3 : 4, ...common });
      }
    }
    for (const kid of node.children) walk(kid);
  };
  walk(root);
  return items;
}

function outcomeKey(item) {
  return `${item.kind}|${item.repo}|${item.ref}|${item.method || ''}`;
}

function sortOutcomes(items) {
  return items.sort((a, b) => a.order - b.order || a.ref.localeCompare(b.ref));
}

/**
 * One decision in the seed list, and every branch point that expresses it.
 *
 * Branch points are keyed by the file and line they sit on, so a method reached down two
 * paths contributes one decision, not two. Feature toggles are keyed by the toggle they
 * read instead: two `if (IsToggleEnabled(Toggles.X))` in two methods are one switch with
 * one state, and enumerating them apart invents a use case that cannot exist.
 */
function groupDecisions(branches) {
  const groups = [];
  const byKey = new Map();
  for (const branch of branches) {
    const toggle = branch.branchKind === 'toggle' ? toggleNameOf(branch.text) : null;
    const key = toggle ? `toggle|${toggle}` : `${branch.file}|${branch.line}`;
    let group = byKey.get(key);
    if (!group) {
      group = { rep: branch, members: [], lines: [], toggle };
      byKey.set(key, group);
      groups.push(group);
    }
    group.members.push(branch);
    if (!group.lines.includes(branch.line)) group.lines.push(branch.line);
  }
  return groups;
}

function gatedBy(gates, owner, ownerOf) {
  return (gates || []).some((gate) => ownerOf.get(gate.branch) === owner);
}

/**
 * Decisions that multiply whatever the walk can see downstream of them: the two that end
 * the request, and validation — an invalid request is a use case the tester writes
 * directly, whether or not the refusal it causes is a fact this trace holds.
 */
const ALWAYS_MULTIPLY = ['error_return', 'guard', 'validation'];

function alwaysMultiplies(group) {
  return ALWAYS_MULTIPLY.includes(group.rep.branchKind) || (group.rep.methodDepth ?? 0) === 0;
}

/**
 * Which decisions actually multiply the list.
 *
 * Two rules cut the combinations no tester can act on. The design cap: past two named
 * toggles the product stops being a use-case list, so later toggles are reported on the
 * path instead of doubling it. And a decision whose sides leave the same thing behind —
 * a null check that picks a shape, a toggle that changes a query the trace cannot see —
 * is a split with nothing on either side of it, so it collapses to one seed. The method
 * the trace started from is exempt: its own branches are the flow's stated contract.
 */
function selectMultiplying(groups, outcomes, ownerOf) {
  const multiplying = new Set(groups);
  let toggles = 0;
  for (const group of groups) {
    if (group.rep.branchKind !== 'toggle') continue;
    toggles += 1;
    if (toggles > MAX_MULTIPLYING_TOGGLES) {
      multiplying.delete(group);
      group.collapsed = 'toggle-cap';
    }
  }
  let settled = false;
  while (!settled) {
    settled = true;
    for (const group of groups) {
      if (!multiplying.has(group) || alwaysMultiplies(group)) continue;
      const decides =
        outcomes.some((item) => item.infra !== true && gatedBy(item.gates, group, ownerOf)) ||
        groups.some(
          (other) =>
            other !== group &&
            multiplying.has(other) &&
            other.members.some((member) => gatedBy(member.gates, group, ownerOf)),
        );
      if (decides) continue;
      multiplying.delete(group);
      group.collapsed = 'identical-outcomes';
      settled = false;
    }
  }
  return multiplying;
}

/**
 * The decisions a terminal seed actually depends on: the ones that end the request —
 * every one of them had to not fire for this one to — and the ones that gate the branch
 * it stops at. A toggle the request had already passed does not make a second way to
 * hit the same exception, so it is dropped from the vector rather than doubling it.
 */
function dominating(terminal, ownerOf) {
  const closure = new Set([terminal]);
  const stack = [terminal];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const gate of current.rep.gates || []) {
      const owner = ownerOf.get(gate.branch);
      if (!owner || closure.has(owner)) continue;
      closure.add(owner);
      stack.push(owner);
    }
  }
  return (group) => closure.has(group) || TERMINAL_DISPOSITIONS[group.rep.branchKind] !== undefined;
}

/**
 * Walk the deciding groups in order. A terminal disposition — an error return taken, a
 * guard tripped — ends the request, so nothing after it is enumerated.
 */
function enumerateDispositions(deciding, index, chosen, satisfies, emit, budget) {
  if (budget.left <= 0) return;
  if (index >= deciding.length) {
    budget.left -= 1;
    emit(chosen, null);
    return;
  }
  const group = deciding[index];
  const assigned = new Map(chosen.map((entry) => [entry.group, entry.disposition]));
  if (!satisfies(group.rep.gates, assigned, true)) {
    enumerateDispositions(deciding, index + 1, chosen, satisfies, emit, budget);
    return;
  }
  for (const disposition of group.rep.dispositions) {
    const next = [...chosen, { group, disposition }];
    if (TERMINAL_DISPOSITIONS[group.rep.branchKind] === disposition) {
      if (budget.left <= 0) return;
      budget.left -= 1;
      emit(next, group);
    } else {
      enumerateDispositions(deciding, index + 1, next, satisfies, emit, budget);
    }
  }
}

export const SEED_KEY_LENGTH = 8;

/** The side of each decision a request takes when nothing fails and nothing is switched on. */
export const NOMINAL_DISPOSITIONS = Object.freeze({
  toggle: 'off',
  validation: 'valid',
  error_return: 'not-taken',
  guard: 'clear',
});

/**
 * The token a decision contributes to a seed's identity. A toggle is named by the toggle
 * it reads, so moving the call or adding a second read of the same toggle leaves the
 * identity alone; every other decision is named by the line it sits on. A decision left
 * on its nominal side contributes nothing: it is what every other seed also did, so a
 * seed keeps its identity when a new guard appears upstream of it.
 */
export function dispositionToken(entry) {
  if (NOMINAL_DISPOSITIONS[entry.kind] === entry.disposition) return null;
  const where = entry.toggle ? entry.toggle : `${entry.file || ''}:${entry.line}`;
  return `${entry.kind}@${where}=${entry.disposition}`;
}

/**
 * A seed's stable identity: the flow it belongs to plus what tells this way through it
 * apart from the nominal one, sorted so enumeration order cannot move it. `id` is a
 * position in a printed list and changes whenever a neighbouring seed appears or
 * disappears; `key` does not, which is what a verdict written last week is matched on.
 */
export function seedKeyOf(routeRef, dispositions) {
  const tokens = (dispositions || []).map(dispositionToken).filter(Boolean).sort();
  const material = [routeRef || '', ...tokens].join('\n');
  return createHash('sha1').update(material).digest('hex').slice(0, SEED_KEY_LENGTH);
}

/**
 * Reachability, in the only terms a black-box caller can act in.
 *
 * `reachable` — something the request itself carries decides it, so a test can drive it.
 * `edge` — only a path segment decides it, which is sendable but degenerate: a
 * whitespace-only id is a request nobody makes on purpose. `unreachable` — every value
 * the condition reads was handed to the request by the platform (a JWT claim, an injected
 * dependency), so no caller can make the branch fire and a test written for it can never
 * pass. `unknown` — the provenance ran out before the answer did.
 */
export const REACHABILITY = Object.freeze(['reachable', 'edge', 'unreachable', 'unknown']);

const CALLER_DRIVEN_SOURCES = new Set(['body', 'query', 'header']);
const CALLER_BLIND_SOURCES = new Set(['jwt', 'di']);

/** Roots that name a type, a keyword or a literal rather than a value with a provenance. */
const CONDITION_STOPWORDS = new Set([
  'string', 'String', 'int', 'long', 'short', 'byte', 'char', 'bool', 'float', 'double', 'decimal',
  'object', 'var', 'null', 'true', 'false', 'this', 'base', 'new', 'throw', 'return', 'await',
  'is', 'as', 'not', 'and', 'or', 'nameof', 'typeof', 'default', 'case', 'when', 'switch', 'if',
  'else', 'Guid', 'DateTime', 'DateTimeOffset', 'TimeSpan', 'Math', 'Convert', 'Enum', 'Toggles',
  'StatusCodes', 'HttpStatusCode',
]);

const IDENTIFIER_CHAIN = /[A-Za-z_]\w*(?:\s*\??\.\s*[A-Za-z_]\w*)*/g;

/**
 * The boolean expression a branch tests, or the whole line when it has no `if`/`switch`.
 * String and character literals go first: a message like `"Group not found"` reads as an
 * identifier chain otherwise, and a literal never has a provenance worth naming.
 */
function conditionOf(text) {
  const trimmed = String(text || '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .trim();
  const opener = /\b(?:if|switch)\s*\(/.exec(trimmed);
  if (!opener) return trimmed;
  const start = opener.index + opener[0].length - 1;
  let depth = 0;
  for (let index = start; index < trimmed.length; index += 1) {
    if (trimmed[index] === '(') depth += 1;
    else if (trimmed[index] === ')') {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start + 1, index);
    }
  }
  return trimmed.slice(start + 1);
}

/**
 * The names whose provenance decides a condition: the root of every identifier chain it
 * reads. A chain that is itself a call contributes nothing unless it reads a member off
 * something first (`user.TenantId.Equals(x)` depends on `user`; `IsValid(x)` and
 * `_service.Check(x)` depend on their arguments, not on the thing being called).
 */
export function conditionRoots(text) {
  const condition = conditionOf(text);
  const roots = [];
  IDENTIFIER_CHAIN.lastIndex = 0;
  let match;
  while ((match = IDENTIFIER_CHAIN.exec(condition))) {
    const chain = match[0];
    const root = chain.split(/\s*\??\.\s*/)[0];
    const after = condition.slice(match.index + chain.length).match(/^\s*\(/);
    if (after && (!chain.includes('.') || root.startsWith('_') || CONDITION_STOPWORDS.has(root))) continue;
    if (CONDITION_STOPWORDS.has(root)) continue;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * One branch point's reachability, read off the `param_source` facts for the method it
 * sits in. A name with no `param_source` — a field, a local, or a value the extractor's
 * three hops did not reach — counts as unresolved, and one unresolved name is enough to
 * stop the branch being called unreachable.
 */
export function branchReachability(branch, paramSources) {
  if (branch.branchKind === 'toggle') return { reachability: 'reachable', reason: 'feature toggle' };
  const roots = conditionRoots(branch.text);
  const resolved = [];
  let unresolved = 0;
  for (const root of roots) {
    const found = paramSources.get(`${branch.repo}|${branch.class}|${branch.method}|${root}`);
    if (found && found.source !== 'unknown') resolved.push({ root, source: found.source });
    else unresolved += 1;
  }
  if (resolved.length === 0) {
    return { reachability: 'unknown', reason: roots.length > 0 ? `${roots[0]} ← unresolved` : 'no readable condition' };
  }
  const driven = resolved.find((entry) => CALLER_DRIVEN_SOURCES.has(entry.source));
  if (driven) return { reachability: 'reachable', reason: `${driven.root} ← ${driven.source}` };
  if (unresolved > 0) return { reachability: 'unknown', reason: `${resolved[0].root} ← ${resolved[0].source}, others unresolved` };
  if (resolved.every((entry) => CALLER_BLIND_SOURCES.has(entry.source))) {
    return { reachability: 'unreachable', reason: `${resolved[0].root} ← ${resolved[0].source}` };
  }
  const routed = resolved.find((entry) => entry.source === 'route') || resolved[0];
  return { reachability: 'edge', reason: `${routed.root} ← ${routed.source}` };
}

/**
 * A seed's reachability is decided by the branches it has to force, not by the ones it
 * lets alone: a decision left on its nominal side is what every other seed also does. One
 * branch no caller can fire makes the whole seed unreachable, however drivable the rest
 * are; short of that, one branch the request itself decides makes the seed reachable.
 * A feature toggle is a configuration axis rather than an argument, so it never decides
 * this either way.
 */
export function seedReachability(dispositions) {
  const forced = (dispositions || []).filter(
    (entry) => entry.kind !== 'toggle' && NOMINAL_DISPOSITIONS[entry.kind] !== entry.disposition,
  );
  if (forced.length === 0) return { reachability: 'reachable', reason: null };
  const order = ['unreachable', 'reachable', 'unknown', 'edge'];
  for (const level of order) {
    const hit = forced.find((entry) => entry.reachability === level);
    if (hit) return { reachability: level, reason: hit.reachabilityReason || null };
  }
  return { reachability: 'unknown', reason: null };
}

function groupRecord(group, disposition, reachOf) {
  const record = branchRecord(group.rep, disposition);
  record.file = group.rep.file;
  if (group.toggle) record.toggle = group.toggle;
  if (group.lines.length > 1) {
    record.lines = [...group.lines];
    record.count = group.lines.length;
  }
  const reach = reachOf ? reachOf.get(group) : null;
  if (reach) {
    record.reachability = reach.reachability;
    if (reach.reason) record.reachabilityReason = reach.reason;
  }
  return record;
}

/**
 * Turn the tree into use cases. Each seed fixes one disposition per deciding group on
 * the primary chain and lists only the outcomes those dispositions can actually reach:
 * an item inside a branch's block belongs to that branch's block disposition, an item
 * inside its `else` to the other, an item outside every block to every seed.
 */
function buildSeeds(root, routeRef, paramSources = new Map()) {
  const ordered = branchesInOrder(root);
  const outcomes = collectOutcomes(root);
  const groups = groupDecisions(ordered.filter((branch) => branch.primary === true && branch.dispositions));
  const ownerOf = new Map();
  for (const group of groups) {
    for (const member of group.members) ownerOf.set(member.id, group);
  }
  const multiplying = selectMultiplying(groups, outcomes, ownerOf);
  for (const group of groups) {
    if (multiplying.has(group)) continue;
    for (const member of group.members) member.collapsed = group.collapsed;
  }
  const deciding = groups.filter((group) => multiplying.has(group));
  const reachOf = new Map(deciding.map((group) => [group, branchReachability(group.rep, paramSources)]));
  const decides = (branch) => multiplying.has(ownerOf.get(branch.id));

  const satisfies = (gates, assigned, strict = false) =>
    (gates || []).every((gate) => {
      const owner = ownerOf.get(gate.branch);
      if (!owner || !multiplying.has(owner)) return true;
      if (!assigned.has(owner)) return !strict;
      return assigned.get(owner) === gate.disposition;
    });

  const seeds = [];
  const budget = { left: SEED_BUDGET };
  const dominators = new Map();
  const emitted = new Set();

  enumerateDispositions(deciding, 0, [], satisfies, (combo, terminal) => {
    const assigned = new Map(combo.map(({ group, disposition }) => [group, disposition]));
    let vector = combo;
    if (terminal) {
      if (!dominators.has(terminal)) dominators.set(terminal, dominating(terminal, ownerOf));
      const dominates = dominators.get(terminal);
      vector = combo.filter((entry) => dominates(entry.group));
      const key = `${terminal.rep.id}|${vector.map((entry) => `${entry.group.rep.id}=${entry.disposition}`).join(',')}`;
      if (emitted.has(key)) return;
      emitted.add(key);
    }
    const reachable = (gates) => satisfies(gates, assigned);
    const cut = terminal ? ordered.indexOf(terminal.rep) : ordered.length;
    const listed = new Set();
    const visible = ordered.slice(0, cut).filter((branch) => {
      if (!reachable(branch.gates)) return false;
      const label = `${branch.file}|${branch.line}`;
      if (listed.has(label)) return false;
      listed.add(label);
      return true;
    });
    const reached = terminal ? [] : outcomes.filter((item) => reachable(item.gates));
    const seen = new Set();
    const own = [];
    const always = [];
    for (const item of sortOutcomes(reached.slice())) {
      const key = outcomeKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      (item.infra ? always : own).push(item);
    }
    const dispositions = vector.map(({ group, disposition }) => groupRecord(group, disposition, reachOf));
    const reach = seedReachability(dispositions);
    seeds.push({
      key: seedKeyOf(routeRef, dispositions),
      kind: terminal ? terminal.rep.responseKind || 'reject' : 'effect',
      reachability: reach.reachability,
      ...(reach.reason ? { reachabilityReason: reach.reason } : {}),
      dispositions,
      response: terminal ? terminal.rep.response : null,
      outcomes: own,
      always,
      alsoOnPath: visible
        .filter((branch) => branch.primary === true && !decides(branch))
        .map((branch) => branchRecord(branch, null)),
      infrastructure: visible.filter((branch) => branch.primary === false).map((branch) => branchRecord(branch, null)),
    });
  }, budget);

  const list = seeds.slice(0, MAX_SEEDS).map((seed, position) => ({ id: `U${position + 1}`, ...seed }));
  return { list, truncated: Math.max(0, seeds.length - list.length) };
}
