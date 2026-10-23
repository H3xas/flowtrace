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
import { posix } from 'node:path';

import { factSetIdentity, factState } from './facts.js';
import { buildMessageIndex, buildRouteIndex, hasContract, matchMessage, matchRoute, normalizeAliases } from './join.js';
import { normalizeRoute, normalizeVerb, routeFactKey, routeKey } from './normalize.js';
import { buildPageRouteIndex, createPageLookup, lazyTarget } from './page-routes.js';
import { MOBILE_DECLARATION_UNRESOLVED, mobileDeclarationIndex, resolveMobileDependency, resolveMobileOwner } from './mobile-declarations.js';
import { buildExceptionIndex, exceptionStatus } from './exception-status.js';
import { buildStatus, raisedByOf } from './result-status.js';
import { REACH_KINDS, isKnownKind, structuralRank } from './scout.js';

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
/**
 * A fact's site as one string: its line, and its column when the fact states one. Two
 * declarations of the same trigger can be written on one line, so a line alone is not a
 * site — an entry identity built from one would name both.
 */
export function factSite(fact) {
  return Number.isInteger(fact.column) ? `${fact.line}:${fact.column}` : `${fact.line}`;
}

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
  reject: Object.freeze(['taken', 'not-taken']),
});

/** Dispositions that end the request there — no later branch point runs. */
export const TERMINAL_DISPOSITIONS = Object.freeze({ error_return: 'taken', guard: 'tripped', reject: 'taken' });

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
 * The backend decisions an expression makes. Each one is listed where it sits, but none
 * derives dispositions from its text: a conditional operator or a predicate is no statement
 * that ends the request, so it never multiplies seeds, and it never splits an `if` from the
 * error return that the `if` guards.
 */
const EXPRESSION_DECISION_KINDS = new Set(['ternary', 'coalesce', 'predicate']);
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
  'entry', 'mapper', 'queued', 'keyed_dispatch', 'gateway',
  UNSCOPED_VIA,
]);
const SINK_KINDS = new Set(['push', 'http_out', 'db']);
/**
 * The Angular and Ionic lifecycle hooks a mobile component span walks as entries, each with
 * the entry kind it fires as. A listed hook that the class inherits from a base class in the
 * repository is an entry of the class too. A hook outside this list is no entry: what it
 * reaches still prints, as an arm no entry reached.
 */
export const MOBILE_LIFECYCLE_KINDS = new Map([
  ['ngOnInit', 'mount'],
  ['ngAfterContentInit', 'mount'],
  ['ngAfterViewInit', 'mount'],
  ['ionViewWillEnter', 'mount'],
  ['ionViewDidEnter', 'mount'],
  ['ngOnChanges', 'update'],
  ['ngDoCheck', 'update'],
  ['ngAfterContentChecked', 'update'],
  ['ngAfterViewChecked', 'update'],
  ['ngOnDestroy', 'unmount'],
  ['ionViewWillLeave', 'unmount'],
  ['ionViewDidLeave', 'unmount'],
]);
/** Seeds past this many on one route are walked but not listed; `join --against` reads
 * this to name the cap it skipped a route's comparison for, rather than repeating the
 * number. */
export const MAX_SEEDS = 64;
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
const STATUS_CALL = /Status(?:Code)?\(\s*(?:StatusCodes\.Status)?(\d{3})/;

/**
 * Whether the branch ends the request by throwing. A thrown exception is a 500 the
 * caller never asked for, so it never reads as a status a black-box test targets, even
 * when the exception type is named after one.
 */
export function isFault(text) {
  return THROWS.test(String(text || ''));
}

/** Where the first `return` or `throw` keyword of `text` starts, outside string and char literals. */
function endingKeywordAt(text) {
  let quote = null;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\w/.test(text[at - 1] ?? '')) continue;
    if (/^(?:return|throw)\b/.test(text.slice(at, at + 7))) return at;
  }
  return -1;
}

/**
 * The statement a branch ends with: its own return line when the fact carries one, else the
 * `return` or `throw` of a one-line branch, else the text as written. A one-line branch holds
 * its condition too, and a condition that names a status must never answer for the return.
 */
export function branchEnding(entry) {
  if (entry.returnText) return String(entry.returnText);
  const text = String(entry.text || '');
  const at = endingKeywordAt(text);
  return at === -1 ? text : text.slice(at);
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
  const status = STATUS_CALL.exec(line);
  if (status) return status[1];
  if (/\breturn\b/.test(line)) return 'return';
  return line.slice(0, 40);
}

/** Whether a return answers a status that a response rule reads, which a bare `return;` does not. */
function readsStatus(text) {
  const line = String(text || '');
  return RESPONSE_RULES.some(([pattern]) => pattern.test(line)) || STATUS_CALL.test(line);
}

/**
 * A branch that refuses the request: a reject decision, an error return, or a guard that
 * throws or answers a status. Only these count at a pipeline step's pipeline depth.
 */
function isRefusal(fact) {
  if (fact.kind === 'reject' || fact.kind === 'error_return') return true;
  if (fact.kind !== 'guard') return false;
  const ending = branchEnding(fact);
  return isFault(ending) || readsStatus(ending);
}

const STATUS_NAMES = Object.freeze({
  204: 'NoContent',
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
});

/** A numeric status as the walk labels a response: `403 Forbidden`, or the bare number. */
export function statusLabel(status) {
  return STATUS_NAMES[status] ? `${status} ${STATUS_NAMES[status]}` : String(status);
}

/** How the walk orders gates: authorization filters run before action filters, then scope. */
const STAGE_RANK = Object.freeze({ authorization: 0, action: 1 });
const SCOPE_RANK = Object.freeze({ global: 0, controller: 1, action: 2 });

/** One exception status index per fact set and repository configuration. */
const EXCEPTION_MEMO = new WeakMap();

function exceptionIndexFor(factSets, repos) {
  const cached = EXCEPTION_MEMO.get(factSets);
  if (cached && cached.repos === repos) return cached.index;
  const index = buildExceptionIndex(factSets, repos);
  EXCEPTION_MEMO.set(factSets, { repos, index });
  return index;
}

/** Gate seeds walked once per fact set and walk configuration, whatever route reaches them. */
const GATE_MEMO = new WeakMap();

/**
 * One freshness probe per fact set and repository configuration, so a walk that runs more
 * than once — a schedule probe, a nested route summary — checks git once.
 */
const FRESHNESS_MEMO = new WeakMap();

function freshnessOf(factSets, options) {
  if (options.freshness) return options.freshness;
  const cached = FRESHNESS_MEMO.get(factSets);
  if (cached && cached.repos === options.repos) return cached.state;
  const state = factState(factSets, options.repos || []);
  FRESHNESS_MEMO.set(factSets, { repos: options.repos, state });
  return state;
}

function withinRange(range, line) {
  if (!range) return true;
  if (line < range.start || line > range.end) return false;
  return !(range.except || []).some((part) => line >= part.start && line <= part.end);
}

/** A `!flag` stop trips on a `false` write, a `flag` stop on a `true` one, either on an expression. */
function tripsStop(stop, write) {
  if (write.value === 'expression') return true;
  return stop.negated ? write.value === 'false' : write.value === 'true';
}

function byFactLine(a, b) {
  return a.line - b.line || String(a.file).localeCompare(String(b.file));
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

/**
 * Whether a branch fact is one line that holds its own `return` or `throw`. Such a branch
 * ends where it stands, so the error return on a later line is another branch, never its body.
 */
function endsItself(fact) {
  if ((fact.endLine ?? fact.line) !== fact.line) return false;
  return branchEnding({ text: fact.text }) !== String(fact.text || '');
}

export function mergeBranchFacts(entries) {
  const merged = [];
  const skipped = new Set();
  for (let position = 0; position < entries.length; position += 1) {
    if (skipped.has(position)) continue;
    const current = entries[position];
    let nextPosition = position + 1;
    while (
      nextPosition < entries.length &&
      EXPRESSION_DECISION_KINDS.has(entries[nextPosition].fact.kind) &&
      entries[nextPosition].fact.class === current.fact.class &&
      entries[nextPosition].fact.method === current.fact.method
    ) {
      nextPosition += 1;
    }
    const next = entries[nextPosition];
    const foldable =
      (current.fact.kind === 'if' || current.fact.kind === 'guard') &&
      !endsItself(current.fact) &&
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
      skipped.add(nextPosition);
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
 * start — a DI field, a mobile `injects` edge target, a web name declared once — still
 * wants one component to land on; it takes the last-processed declaration while name
 * resolution reports the complete candidate list. A web `renders` target goes through
 * `renderTarget` instead.
 */
function lastComponent(index, key) {
  const entries = index.componentByName.get(key);
  return entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
}

const MODULE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

/** The repository path a relative module specifier written in `file` names, extension dropped. */
function importedModule(file, specifier) {
  if (!specifier || !/^\.\.?(?:\/|$)/.test(specifier)) return null;
  return posix.normalize(posix.join(posix.dirname(file), specifier)).replace(MODULE_EXT_RE, '');
}

/**
 * What a statement chain settles: `name` as written in `file`, which that file declares
 * itself or imports from `specifier` under `exported` (`default` for a default import). A
 * module is followed to the one file it names, and binds only a component whose `exports`
 * states the imported name; a `lazy()` binding stands for the default export of the module it
 * loads. `{ target }` is the declaration reached. `{}` is a module the facts settle that binds
 * nothing under that name — a component it declares without exporting, a name it does not
 * export, a relative path no component file answers for a default import, or a file whose
 * facts state no exports at all — and anything a followed file names that cannot be followed
 * on, so nothing may stand in for it under the same name elsewhere. `{ candidates }` is a path
 * more than one file answers. Undefined only when the rendering file itself names no file to
 * follow: a tag it neither declares nor imports, a module outside relative reach, a named
 * import whose path no component file answers (a barrel re-exporting it, say), or its own
 * chain coming back on itself.
 */
function settledDeclaration(index, repo, fact) {
  const visited = new Set();
  let file = fact.file;
  let name = fact.to;
  let specifier = fact.source;
  let exported = fact.imported ?? fact.to;
  let unsettled;
  while (!visited.has(`${file}|${name}`)) {
    visited.add(`${file}|${name}`);
    const here = (index.componentsInFile.get(`${repo}|${file}`) || []).filter((entry) => entry.fact.name === name);
    const body = here.find((entry) => entry.fact.lazy === undefined);
    if (body) return { target: body };
    if (here.length > 0) {
      specifier = here[0].fact.lazy;
      exported = 'default';
    } else if (unsettled) {
      return unsettled;
    }
    const module = importedModule(file, specifier);
    if (!module) return unsettled;
    const files = [module, `${module}/index`].flatMap((stem) => [...(index.componentModules.get(`${repo}|${stem}`) || [])]);
    if (files.length > 1) return { candidates: files.sort() };
    if (files.length === 0) return exported === 'default' ? {} : unsettled;
    [file] = files;
    const binding = index.componentsInFile
      .get(`${repo}|${file}`)
      .find((entry) => Array.isArray(entry.fact.exports) && entry.fact.exports.includes(exported));
    if (!binding) return {};
    name = binding.fact.name;
    specifier = undefined;
    unsettled = {};
  }
  return unsettled;
}

/**
 * The declaration a web `renders` edge lands on. What the rendering file itself says comes
 * first: its own declaration of the tag, or the module it imports the tag from and the name
 * that module exports it under — so a child imported under another local name is the child
 * its module declares, and a child its module does not export is an unknown target, never a
 * declaration elsewhere that merely shares the name. Only where no statement names a file
 * to follow is the name the child is exported under looked up instead: the tag itself, or
 * `A` for `{ A as B }`. An import reaching that lookup (a path alias, a barrel) can only bind
 * a declaration its module exports, so a component that states no export is no candidate. A
 * name declared once is that declaration; a name declared in more than one file is
 * `{ candidates }`, every declaring file, so the walk states an unknown target at the site
 * instead of entering whichever was read last.
 */
export function renderTarget(index, repo, fact) {
  const settled = settledDeclaration(index, repo, fact);
  if (settled) return settled;
  const exported = fact.imported !== undefined && fact.imported !== 'default' ? fact.imported : fact.to;
  const key = `${repo}|${exported}`;
  if (fact.source === undefined) {
    if (!index.sharedComponents.has(key)) {
      return { target: lastComponent(index, key) || index.componentBySelector.get(exported) };
    }
    return { candidates: [...new Set(index.componentByName.get(key).map((entry) => entry.fact.file))].sort() };
  }
  const bound = (index.componentByName.get(key) || []).filter((entry) => entry.fact.exports?.length > 0);
  const files = [...new Set(bound.map((entry) => entry.fact.file))].sort();
  return files.length > 1 ? { candidates: files } : { target: bound[bound.length - 1] };
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

/** A keyed-collection key that is known before run time: a literal or an `E.Member` value. */
function isConstantKey(key) {
  return /^(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|[A-Z]\w*(?:\.[A-Za-z_]\w*)+)$/.test(String(key || ''));
}

/** Two constant keys name the same value: equal text, or the same `E.Member` tail. */
function sameKey(a, b) {
  if (a === b) return true;
  const tail = (text) => (/^[A-Za-z_]/.test(text) ? text.split('.').slice(-2).join('.') : text);
  return tail(a) === tail(b);
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
    entriesFrom: new Map(),
    dispatchesFrom: new Map(),
    effectsByAction: new Map(),
    actionDefs: new Map(),
    injectsFrom: new Map(),
    propTargets: new Map(),
    propBinds: new Map(),
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
    compositions: new Map(),
    loopStops: new Map(),
    flagWrites: new Map(),
    sentinels: new Map(),
    returnFlows: new Map(),
    sentinelMaps: new Map(),
    authFilters: new Map(),
    filterResults: new Map(),
    globalFilters: [],
    filtersOnClass: new Map(),
    filtersOnMethod: new Map(),
    classBase: new Map(),
    mapperMaps: new Map(),
    mapperCalls: new Map(),
    queueCalls: new Map(),
    keyedCollections: new Map(),
    keyedCalls: new Map(),
    keyProperties: new Map(),
    gatewayRoutes: new Map(),
    gatewayHandlers: new Map(),
    gatewayMiddleware: new Map(),
    pageRoutes: buildPageRouteIndex(factSets),
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
        case 'component_entry':
          pushInto(index.entriesFrom, `${repo}|${fact.component}`, entry);
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
          pushInto(index.propBinds, `${repo}|${fact.component}|${fact.prop}`, entry);
          break;
        case 'gateway_call':
          pushInto(index.gatewayByService, `${repo}|${fact.service}`, entry);
          if (set.kind === 'web') webGateways.push(entry);
          break;
        case 'route': {
          index.routeEntries.push(entry);
          const key = routeFactKey(fact);
          if (key !== null) pushInto(index.routesByKey, key, entry);
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
          // The walk reads backend decisions only. A caller decision would add its method to
          // the children of a class start, and the walk has no rule for caller decisions yet.
          if (set.kind === 'web' || set.kind === 'mobile') break;
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
        case 'step_composition':
          index.compositions.set(`${repo}|${fact.class}|${fact.field}`, fact);
          break;
        case 'loop_stop':
          pushInto(index.loopStops, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'flag_write':
          pushInto(index.flagWrites, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'sentinel_return':
          pushInto(index.sentinels, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'return_flow':
          pushInto(index.returnFlows, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'sentinel_map':
          pushInto(index.sentinelMaps, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'auth_filter':
          pushInto(index.authFilters, `${repo}|${fact.name}`, fact);
          break;
        case 'filter_result':
          pushInto(index.filterResults, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'filter_use':
          if (fact.scope === 'global') index.globalFilters.push(entry);
          else if (fact.scope === 'controller') pushInto(index.filtersOnClass, `${repo}|${fact.class}`, fact);
          else if (fact.scope === 'action') pushInto(index.filtersOnMethod, `${repo}|${fact.class}|${fact.method}`, fact);
          break;
        case 'class_base':
          index.classBase.set(`${repo}|${fact.class}`, fact.base);
          break;
        case 'mapper_map':
          pushInto(index.mapperMaps, repo, fact);
          break;
        case 'mapper_call':
          pushInto(index.mapperCalls, `${repo}|${fact.class}|${fact.method}`, fact);
          addMethod(repo, fact.class, fact.method);
          break;
        case 'queue_call':
          pushInto(index.queueCalls, `${repo}|${fact.class}|${fact.method}`, fact);
          addMethod(repo, fact.class, fact.method);
          break;
        case 'keyed_collection':
          index.keyedCollections.set(`${repo}|${fact.class}|${fact.field}`, fact);
          break;
        case 'keyed_call':
          pushInto(index.keyedCalls, `${repo}|${fact.class}|${fact.method}`, fact);
          addMethod(repo, fact.class, fact.method);
          break;
        case 'key_property':
          pushInto(index.keyProperties, `${repo}|${fact.class}`, fact);
          break;
        case 'gateway_route':
          pushInto(index.gatewayRoutes, `${repo}|${routeKey(fact.verb, fact.template)}`, fact);
          break;
        case 'gateway_handler':
          pushInto(index.gatewayHandlers, repo, fact);
          break;
        case 'gateway_middleware':
          pushInto(index.gatewayMiddleware, repo, fact);
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
  index.sharedComponents = new Set();
  index.componentsInFile = new Map();
  index.componentModules = new Map();
  index.mobileDeclarations = mobileDeclarationIndex(factSets);
  for (const [key, entries] of index.componentByName) {
    const kindOfRepo = index.repos.get(entries[0].repo);
    if (kindOfRepo !== 'web' && kindOfRepo !== 'mobile') continue;
    if (new Set(entries.map((entry) => entry.fact.file)).size > 1) index.sharedComponents.add(key);
    for (const entry of entries) {
      pushInto(index.componentsInFile, `${entry.repo}|${entry.fact.file}`, entry);
      const stem = `${entry.repo}|${entry.fact.file.replace(MODULE_EXT_RE, '')}`;
      if (!index.componentModules.has(stem)) index.componentModules.set(stem, new Set());
      index.componentModules.get(stem).add(entry.fact.file);
    }
  }
  index.routeIndex = buildRouteIndex(index.routeEntries);
  index.messages = buildMessageIndex(factSets);
  return index;
}

/**
 * A web component name declared in more than one file keys the facts of every declaration
 * under one `repo|name`. A walk standing in one declaration keeps only the facts written in
 * that declaration's file, or a start `--file` picked would answer with the other file's
 * entries, bindings and requests. A name declared once keeps every fact, as it always has.
 */
export function ownFacts(index, list, repo, owner, file) {
  if (!file || !index.sharedComponents.has(`${repo}|${owner}`)) return list;
  return list.filter((entry) => (entry.fact || entry).file === file);
}

/** The method body `owner.method` answers to, from the owner's own file when its name is shared. */
export function ownSpan(index, repo, owner, method, file) {
  if (!file || !index.sharedComponents.has(`${repo}|${owner}`)) {
    return index.spanByMethod.get(`${repo}|${owner}|${method}`);
  }
  return ownFacts(index, index.spansByClass.get(`${repo}|${owner}`) || [], repo, owner, file).find(
    (fact) => fact.method === method,
  );
}

/** The creator a prop of `owner` is bound to, from the owner's own file when its name is shared. */
export function ownPropTarget(index, repo, owner, prop, file) {
  const key = `${repo}|${owner}|${prop}`;
  if (!file || !index.sharedComponents.has(`${repo}|${owner}`)) return index.propTargets.get(key);
  return ownFacts(index, index.propBinds.get(key) || [], repo, owner, file)[0];
}

/**
 * The method bodies a bare name may call. Inside a declaration whose name is shared, a body
 * of that name written in the declaration's own file is the one the call reaches — a module's
 * own function shadows any other — so the other declaration's copy does not make it ambiguous.
 */
export function namedSpans(index, repo, name, owner, file) {
  const spans = index.spansByName.get(`${repo}|${name}`) || [];
  if (spans.length < 2 || !file || !index.sharedComponents.has(`${repo}|${owner}`)) return spans;
  const local = spans.filter((fact) => fact.file === file);
  return local.length > 0 ? local : spans;
}

/** The narrowest method body that contains a line, or null when no span covers it. */
export function innermostSpan(index, repo, file, line) {
  const spans = index.methodSpans.get(`${repo}|${file}`);
  if (!spans) return null;
  let best = null;
  for (const { fact } of spans) {
    if (fact.line > line || fact.endLine < line) continue;
    if (!best || fact.endLine - fact.line < best.endLine - best.line) best = fact;
  }
  return best;
}

/**
 * One way execution reaches a component, in the shape every reader of it shares. `kind`
 * states where the trigger fires — a class lifecycle callback, a hook effect, the cleanup
 * an effect returns, a JSX event handler, or a trigger this extractor could not read —
 * never how often the body runs and never an order between two entries. `id` is that
 * identity, `ref` the readable label the tree prints.
 */
export function entryIdentity(fact) {
  const identity = {
    id: [
      fact.component,
      fact.kind,
      fact.trigger,
      ...(fact.handler ? [fact.handler] : []),
      `@${fact.file}:${factSite(fact)}`,
    ].join(':'),
    component: fact.component,
    kind: fact.kind,
    trigger: fact.trigger,
    handler: fact.handler ?? null,
    guards: Array.isArray(fact.guards) ? fact.guards.slice() : [],
    file: fact.file,
    line: fact.line,
  };
  if (Number.isInteger(fact.column)) identity.column = fact.column;
  if (Array.isArray(fact.deps)) identity.deps = fact.deps.slice();
  if (fact.depsUnknown === true) identity.depsUnknown = true;
  if (fact.unresolved !== undefined) identity.unresolved = fact.unresolved;
  return identity;
}

export function entryRef(fact) {
  return `${fact.component}.${fact.trigger}@${factSite(fact)}`;
}

/** A JSX `on*` binding is an entry too: the event is its trigger, the handler its target. */
export function eventEntry(component, fact) {
  const entry = {
    id: [component, 'event', fact.event, fact.handler, `@${fact.file}:${factSite(fact)}`].join(':'),
    component,
    kind: 'event',
    trigger: fact.event,
    handler: fact.handler ?? null,
    guards: [],
    file: fact.file,
    line: fact.line,
  };
  if (Number.isInteger(fact.column)) entry.column = fact.column;
  return entry;
}

function candidateList(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!seen.has(entry.key)) seen.set(entry.key, entry);
  }
  return [...seen.values()];
}

/** A route's key for a start label; a route whose template is incomplete names the argument
 * the extractor could not read instead of a key no request can reach. */
function routeLabel(fact) {
  const key = routeFactKey(fact);
  return key !== null ? key : `${normalizeVerb(fact.verb)} unresolved argument ${fact.unresolvedArgument.text}`;
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
 * Every string a `role: "page"` component answers to in a fact set extracted before route
 * declarations were recorded (no `page_route` facts): its own `<Route path>` and, when the
 * extractor read a browser prefix off the library's own `navigate()` literals, that prefix
 * in front of it, a relative path read from the mount root. Both readings are inference, so
 * a start resolved this way is tagged. A fact set that records its routes is looked up
 * through `lib/page-routes.js` instead, which composes the parent chain.
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
  if (role === 'class') return 'class';
  return 'component';
}

/**
 * Resolve a start string to one node, in the contract's order: mobile class, mobile
 * selector, route key, backend `Class.Method`, backend class, web component name, web
 * page path. The two web tiers are appended last on purpose — a name shared with a
 * mobile component resolves to the mobile one rather than becoming cross-tier ambiguous.
 * Returns `{node}` on a single match, `{candidates, reason: 'ambiguous'}` when a tier matches
 * more than one thing, and `{error, reason}` otherwise; a web page path's `reason` also says
 * whether a mount, an unsupported declaration or nothing at all stopped it (`frontier` names
 * what), per `lib/page-routes.js`.
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
      if (entry.fact.role === 'class' && index.repos.get(entry.repo) === 'mobile') continue;
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
      if (routeFactKey(entry.fact) !== asRoute.key) continue;
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
        label: `${className}.${methodName} (route ${routeLabel(entry.fact)}) ${entry.repo}`,
      });
    }
    if (methodHits.length === 0) {
      // A method whose only calls are queued, mapped or keyed holds those facts, not a call.
      const sites = new Map();
      const note = (key, fact) => {
        const known = sites.get(key);
        if (!known || byLine({ fact }, { fact: known }) < 0) sites.set(key, fact);
      };
      for (const [key, entries] of index.callsByMethod) for (const entry of entries) note(key, entry.fact);
      for (const map of [index.queueCalls, index.mapperCalls, index.keyedCalls]) {
        for (const [key, entries] of map) for (const fact of entries) note(key, fact);
      }
      for (const [key, firstFact] of sites) {
        const [repo, cls, method] = key.split('|');
        if (cls !== className || method !== methodName || !inRepo(repo)) continue;
        // Two mobile declarations of one class name can each write the method, and their
        // calls share this bucket. Each file is its own candidate, so the first call by
        // line never picks one of them.
        if (index.repos.get(repo) === 'mobile') {
          const files = new Map();
          const facts = [
            ...(index.callsByMethod.get(key) || []).map((entry) => entry.fact),
            ...[index.queueCalls, index.mapperCalls, index.keyedCalls].flatMap((map) => map.get(key) || []),
          ];
          for (const fact of facts) {
            const site = files.get(fact.file);
            if (!site || fact.line < site.line) files.set(fact.file, { file: fact.file, line: fact.line });
          }
          for (const span of index.spansByClass.get(`${repo}|${className}`) || []) {
            if (span.method === methodName && !files.has(span.file)) files.set(span.file, { file: span.file, line: span.line });
          }
          if (files.size > 1) {
            for (const site of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
              methodHits.push({
                key: `${repo}|${className}.${methodName}|${site.file}`,
                node: { repo, kind: 'method', ref: `${className}.${methodName}`, file: site.file, line: site.line, class: className, method: methodName },
                label: `${className}.${methodName} ${repo} ${site.file}:${site.line}`,
              });
            }
            continue;
          }
        }
        const first = { fact: firstFact };
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

  // A plain mobile class is a class start beside backend classes, one hit for each
  // declaration, so a name both declare is ambiguous and `--repo` qualifies it.
  const classHits = [];
  for (const [key, site] of index.classSite) {
    const separator = key.indexOf('|');
    const repo = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (name !== wanted || !inRepo(repo)) continue;
    if (index.repos.get(repo) === 'web' && index.componentByName.has(key)) continue;
    const plain =
      index.repos.get(repo) === 'mobile'
        ? (index.mobileDeclarations.byName.get(key) || []).filter((declaration) => declaration.role === 'class')
        : [];
    if (plain.length > 0) {
      for (const declaration of plain) {
        classHits.push({
          key: `${repo}|${name}|${declaration.file}:${declaration.line}`,
          node: { repo, kind: 'class', ref: name, file: declaration.file, line: declaration.line, class: name },
          label: `${name} ${repo} ${declaration.file}:${declaration.line}`,
        });
      }
      continue;
    }
    classHits.push({
      key,
      node: { repo, kind: 'class', ref: name, file: site.file, line: site.line },
      label: `${name} ${repo} ${site.file}:${site.line}`,
    });
  }
  if (classHits.length > 0) return finish(classHits);

  const webHits = [];
  for (const [, entries] of index.componentByName) {
    for (const found of entries) {
      if (index.repos.get(found.repo) !== 'web') continue;
      if (found.fact.name !== wanted || !inRepo(found.repo)) continue;
      const entry = strictComponentNames ? lazyAlias(index, found) : found;
      webHits.push({
        key: componentKey(entry),
        node: {
          repo: entry.repo,
          kind: componentKind(entry.fact.role),
          ref: entry.fact.name,
          file: entry.fact.file,
          line: entry.fact.line,
        },
        label:
          `${entry.fact.name} (${entry.fact.role}) ${entry.repo} ${entry.fact.file}:${entry.fact.line}` +
          (entry === found ? '' : ` (lazy ${found.fact.name} ${found.fact.file}:${found.fact.line})`),
      });
    }
  }
  if (webHits.length > 0) return finish(webHits);

  const wantedPath = normalizePagePath(wanted);
  let answered = null;
  if (wantedPath) {
    answered = createPageLookup(index.pageRoutes, { repo: repoFilter, repos: options.repos }).lookup(wanted);
    const pageHits = [];
    for (const entry of index.webPages) {
      if (!inRepo(entry.repo) || index.pageRoutes.has(entry.repo)) continue;
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
    if (pageHits.length > 0 && answered && (answered.node || answered.candidates)) {
      const labels = answered.node ? [pageLabel(answered.node)] : answered.candidates;
      return { candidates: [...labels, ...candidateList(pageHits).map((hit) => hit.label)].sort(), reason: 'ambiguous' };
    }
    if (pageHits.length > 0) return finish(pageHits);
    if (answered && answered.node) return { node: answered.node, index };
    if (answered) return answered;
  }

  return { error: `no page, component, service, route, method or class matches "${wanted}"`, reason: 'no-declaration' };

  function finish(hits) {
    const unique = candidateList(hits).sort((a, b) => a.key.localeCompare(b.key));
    if (unique.length > 1) return { candidates: unique.map((hit) => hit.label), reason: 'ambiguous' };
    return { node: unique[0].node, index };
  }
}

/** How one mount segment reads in a tree line. */
function mountRef(segment) {
  switch (segment.kind) {
    case 'host':
      return `mounted at ${segment.path}`;
    case 'index':
      return `index route${segment.element ? ` → ${segment.element}` : ''}`;
    case 'lazy':
      return `lazy import ${segment.specifier}`;
    case 'redirect':
      return `redirect ${segment.from} → ${segment.to}`;
    case 'render':
      return `rendered by ${segment.from}`;
    default:
      return `route ${segment.path === '' ? '(layout)' : segment.path}${segment.element ? ` → ${segment.element}` : ''}`;
  }
}

function pageLabel(node) {
  return `${node.ref} (page ${node.pagePath}) ${node.repo} ${node.file}:${node.line}`;
}

/**
 * The declaration a lazy binding stands for, when its import resolves to one: the binding and
 * the component it loads are one entry, so a name they share is not two candidates, and a
 * binding name shared by two loads of different components is two.
 */
function lazyAlias(index, entry) {
  if (!entry.fact.lazy) return entry;
  const repoRoutes = index.pageRoutes.get(entry.repo);
  const components = repoRoutes ? repoRoutes.components : [];
  const target = lazyTarget(components, entry.fact);
  return target ? { repo: entry.repo, fact: target } : entry;
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
/** The one usage refusal of a `--from-handler` site suffix that is not `@<line>[:<column>]`. */
export const HANDLER_SITE_USAGE = '--from-handler site must be @<line> or @<line>:<column>';

/**
 * A `--from-handler` selector: the display form `(event) method()`, the compact form
 * `event:method` or a bare method name, each with an optional `@<line>` or
 * `@<line>:<column>` suffix that names one binding site. No event or method name holds
 * `@`, so the first one starts the suffix. A malformed suffix returns `{ error }`.
 */
export function parseHandlerSelector(selector) {
  let trimmed = String(selector).trim();
  let site = null;
  const at = trimmed.indexOf('@');
  if (at !== -1) {
    const suffix = trimmed.slice(at + 1).match(/^\s*([1-9]\d*)(?::([1-9]\d*))?\s*$/);
    if (!suffix) return { error: HANDLER_SITE_USAGE };
    site = { line: Number(suffix[1]), ...(suffix[2] ? { column: Number(suffix[2]) } : {}) };
    trimmed = trimmed.slice(0, at).trim();
  }
  const display = trimmed.match(/^\(([^)]*)\)\s*([^\s()]+)\s*\(\s*\)$/);
  if (display) return { event: display[1].trim(), method: display[2].trim(), site };
  const compact = trimmed.match(/^([^:()]+):([^:()]+)$/);
  if (compact) return { event: compact[1].trim(), method: compact[2].trim(), site };
  return { event: null, method: trimmed, site };
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
 * Where a handler node's binding is written: a web node's entry, a mobile node's kept
 * binding site, else the node's own anchor.
 */
function bindingSiteOf(node) {
  const source = node.entry || node.bindingSite;
  if (source && source.file && Number.isInteger(source.line)) {
    return { file: source.file, line: source.line, ...(Number.isInteger(source.column) ? { column: source.column } : {}) };
  }
  return { file: node.file, line: node.line };
}

function siteText(site) {
  return `${site.file}:${site.line}${Number.isInteger(site.column) ? `:${site.column}` : ''}`;
}

function handlerSiteLabel(node) {
  return `(${node.event}) ${handlerMethod(node)}() ${node.ref} ${node.repo} ${siteText(bindingSiteOf(node))}`;
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
  if (parsed.error) return { error: parsed.error };
  // One binding site is one way in: a node a fold repeats folds away, a second site does not.
  const seen = new Map();
  for (const node of handlerNodes) {
    const key = `${node.ref}|${siteText(bindingSiteOf(node))}`;
    if (!seen.has(key)) seen.set(key, node);
  }
  const unique = [...seen.values()];
  const matches = unique.filter((node) => {
    if (handlerMethod(node) !== parsed.method) return false;
    if (parsed.event !== null && node.event !== parsed.event) return false;
    if (!parsed.site) return true;
    const site = bindingSiteOf(node);
    if (site.line !== parsed.site.line) return false;
    return parsed.site.column === undefined || site.column === parsed.site.column;
  });
  if (matches.length === 1) return { node: matches[0] };
  if (matches.length > 1) return { candidates: matches.map(handlerSiteLabel) };
  return { available: [...new Set(unique.map(handlerLabel))] };
}

/**
 * Walk from `start` to every sink. `factSets` are the loaded `out/facts/*.json` bodies;
 * `options.outbound(repoRoot, className)` supplies graph hops and may be omitted.
 * `options.stopAtRoutes` (implied by `options.inventory`) treats a route reached from a
 * component as a leaf and folds a revisited subtree by the same memoisation `inventory`
 * already applies, without `inventory`'s own destructive prune of non-route-reaching
 * branches — the mode `lib/component-span.js` walks a component start in. A web entry is
 * walked in a scope of its own, so the fold never spans two entries.
 * `options.componentEntries` gives a mobile component the same entries: its template call
 * bindings and its lifecycle hooks, each walked in a scope of its own, with an injected
 * class folded only against a hop that calls the same members of it. Without the option a
 * mobile walk is the one `trace`, `--from-handler`, `cover` and readiness have always read.
 */
export function trace(factSets, start, options = {}) {
  const index = options.index || buildTraceIndex(factSets);
  const resolved = options.startNode
    ? { node: options.startNode }
    : resolveStart(factSets, start, { index, repo: options.repo, repos: options.repos, strictComponentNames: true });
  if (resolved.candidates) return { candidates: resolved.candidates, reason: resolved.reason || 'ambiguous' };
  if (resolved.error) {
    return { error: resolved.error, reason: resolved.reason || 'no-declaration', ...(resolved.frontier ? { frontier: resolved.frontier } : {}) };
  }

  const exhaustive = options.exhaustive === true;
  const depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : DEFAULT_DEPTH;
  const maxNodes =
    Number.isInteger(options.maxNodes) && options.maxNodes > 0
      ? options.maxNodes
      : exhaustive
        ? EXHAUSTIVE_MAX_NODES
        : DEFAULT_MAX_NODES;
  const limits = { depth, maxNodes };
  const first = walkTrace(factSets, start, options, index, resolved, {
    schedule: { order: 'depth-first' },
    ...limits,
  });
  if (exhaustive) return first;
  const stopped = first.status && first.status.frontier.some((entry) => entry.reason === 'node-budget');
  if (!stopped) return first;
  return fairWalk(factSets, start, options, index, resolved, limits, first);
}

/**
 * A walk the node budget stopped runs again under a level schedule: every call within the
 * deepest level that fits is entered, and the level that does not fit spends the rest of
 * the budget in call-site order. A walk the budget never stopped is returned untouched, so
 * nothing below the limit moves.
 */
function fairWalk(factSets, start, options, index, resolved, limits, first) {
  let level = 0;
  for (let candidate = 1; candidate < limits.depth; candidate += 1) {
    const probe = walkTrace(factSets, start, options, index, resolved, {
      schedule: { order: 'level', level: candidate, probe: true },
      ...limits,
    });
    if (probe.stats.budgetHit) break;
    level = candidate;
  }
  if (level === 0) return first;
  return walkTrace(factSets, start, options, index, resolved, {
    schedule: { order: 'level', level, probe: false },
    ...limits,
  });
}

function walkTrace(factSets, start, options, index, resolved, run) {
  const exhaustive = options.exhaustive === true;
  const depth = run.depth;
  const maxNodes = run.maxNodes;
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
  const componentEntries = Boolean(options.componentEntries);
  const summaries = options.summaries instanceof Map ? options.summaries : new Map();
  const primaryDepth = Number.isInteger(options.primaryDepth) ? options.primaryDepth : DEFAULT_PRIMARY_DEPTH;
  const infraFanIn = Number.isInteger(options.infraFanIn) ? options.infraFanIn : DEFAULT_INFRA_FANIN;
  const outbound = typeof options.outbound === 'function' ? options.outbound : null;
  const repoRoots = new Map((options.repos || []).map((repo) => [repo.id, repo.root]));
  const exceptionIndex = exceptionIndexFor(factSets, options.repos);
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
  const unknownGraphKinds = new Set();
  let counter = 0;
  let crossings = 0;
  let budgetHit = false;
  const exhaustiveBudget = Symbol('exhaustive walk node budget');
  const gateWalk = options.gateWalk === true;
  const parentOf = new WeakMap();
  const stepOf = new WeakMap();
  let nodeById = null;
  const linkMemo = new Map();
  const pipelines = new Map();
  // `<pipeline node id>|<stop line>` of each block stop a step reject has walked.
  const claimedBlocks = new Set();
  // The call site behind every node a body produced, kept only when the caller asks for it.
  // The projection needs the fact (for its column and its control evidence) at the node the
  // walk placed it on; the walk itself never reads these records, so a run without
  // `recordCalls` makes the same nodes, edges, stats and budget.
  const recordCalls = options.recordCalls === true;
  const callRecords = new Map();
  function recordCall(owner, entry) {
    if (!recordCalls) return;
    const list = callRecords.get(owner.id);
    if (list) list.push(entry);
    else callRecords.set(owner.id, [entry]);
  }
  // Call level from the start, never set back: the measure the level schedule cuts on.
  // Kept out of the node record so no output of today moves when this is added.
  const levelOf = new WeakMap();
  const stopOf = new WeakMap();
  const schedule = run.schedule;
  let inComposition = 0;
  let compositionCut = false;

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
    parentOf.set(node, parent);
    edges.push({
      from: parent.id,
      to: node.id,
      via,
      fromRepo: parent.homeRepo ?? null,
      toRepo: node.homeRepo ?? null,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(node.match ? { match: node.match } : {}),
      ...(node.caller ? { caller: node.caller } : {}),
      ...(via === 'keyed_dispatch' ? { inferred: true, key: node.keyed } : {}),
      ...(node.conditional === true ? { conditional: true } : {}),
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
    const parentLevel = levelOf.get(parent) || 0;
    levelOf.set(node, fields.selfCall === true ? parentLevel : nextHops(parentLevel, via));
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

  /**
   * Whether this node cannot be entered, and why. One test replaces the depth check every
   * expander carried and the budget check five of them carried, so the two schedules cannot
   * disagree about which stop a node met. The first schedule keeps today's order — budget
   * before depth where the budget was tested — and states `depth` when both apply, because
   * a larger node budget alone does not enter a node at the depth limit. The level schedule
   * tests depth first, then its own cut, then the budget at the level the cut leaves open.
   */
  function halt(node, reason) {
    node.leaf = true;
    stopOf.set(node, { reason });
    // The projection reads the stop from the node it stands on; the walk itself never reads it,
    // so a run without `recordCalls` makes the same nodes, edges, stats and budget.
    if (recordCalls) node.stop = reason;
    // A composition that the budget or the schedule cut part-way is taken back out by
    // `walkComposition`: a cut step list would read as the whole ordered list.
    if (inComposition > 0) compositionCut = true;
    return true;
  }

  function stopsHere(node, hops, { page = false, budget = true } = {}) {
    const overDepth = !exhaustive && hops >= depth && !page;
    if (schedule.order === 'level') {
      if (overDepth) return halt(node, 'depth');
      const level = levelOf.get(node) || 0;
      if (schedule.probe) {
        if (!page && level >= schedule.level) return halt(node, 'node-budget');
        if (budget && level < schedule.level && nodes.length >= maxNodes) {
          budgetHit = true;
          return halt(node, 'node-budget');
        }
        return false;
      }
      if (!page && level > schedule.level) return halt(node, 'node-budget');
      if (budget && level >= schedule.level && nodes.length >= maxNodes) {
        budgetHit = true;
        return halt(node, 'node-budget');
      }
      return false;
    }
    if (budget && nodes.length >= maxNodes) {
      budgetHit = true;
      return halt(node, overDepth ? 'depth' : 'node-budget');
    }
    if (overDepth) return halt(node, 'depth');
    return false;
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

  /**
   * The identity a mobile node is folded on. A name declared in more than one file is one
   * declaration per file, so the file joins the identity; a unique name keeps the identity
   * it always had, and every other repository kind is untouched.
   */
  function mobileGuardIdentity(node) {
    const owner = node.class || node.ref;
    if (node.repo && node.file && index.repos.get(node.repo) === 'mobile' && index.sharedComponents.has(`${node.repo}|${owner}`)) {
      return `${node.repo}|${node.file}|${node.ref}`;
    }
    return `${node.repo}|${node.ref}`;
  }

  function guard(node) {
    if (SINK_KINDS.has(node.kind) || node.kind === 'branch') return true;
    // A node whose identity is its site says so: two dispatches of one action creator are
    // two nodes, and folding the second into the first would drop its answer.
    const identity = mobileGuardIdentity(node);
    const key = node.guardSite ? `${identity}|${node.guardSite}` : identity;
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

  /**
   * One web entry's own walk, with the fold's memoisation starting over. Two entries that
   * call the same thunk share most of their chain, and under one shared memoisation the
   * second entry would be folded into the first — leaving it looking as though it reached
   * nothing, which is the one thing the entry it is attributed to must not say. The path
   * guard is untouched, so a genuine cycle still ends where it began.
   */
  function inEntryScope(expand) {
    const snapshot = new Map(visited);
    visited.clear();
    try {
      expand();
    } finally {
      visited.clear();
      for (const [key, id] of snapshot) visited.set(key, id);
    }
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

  function methodAnchor(repo, className, methodName, fallback, file) {
    const span = ownSpan(index, repo, className, methodName, file);
    if (span) return { file: span.file, line: span.line };
    const own = (list) => ownFacts(index, list || [], repo, className, file);
    const call = own(index.callsByMethod.get(`${repo}|${className}|${methodName}`)).slice().sort(byLine)[0];
    const branch = own(index.branchesByMethod.get(`${repo}|${className}|${methodName}`)).slice().sort(byLine)[0];
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
      const ending = branchEnding(fact);
      branch.response = responseOf(ending);
      branch.responseKind = isFault(ending) ? 'fault' : 'reject';
      if (branch.responseKind === 'fault') {
        const mapped = faultMapping(parent, repo, branch.response);
        if (mapped) branch.mappedStatus = mapped;
      }
    }
    // A step's refusals end the pipeline that runs it, so they count where the pipeline
    // method sits; the step's other branches keep the depth the step itself is at, or a
    // resolved composition would move seed keys that the name-sorted fan-out printed.
    const step = stepOf.get(parent);
    const decidingDepth = step && isRefusal(fact) ? step.depth : branch.methodDepth ?? 0;
    const onPrimaryChain =
      branch.infra !== true && branch.asyncLeg !== true && (decidingDepth <= primaryDepth || mapsToReject(branch));
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
    if (EXPRESSION_DECISION_KINDS.has(fact.kind) && index.repos.get(repo) === 'backend') return branch;
    const discriminator = discriminatorOf(fact.text);
    if (discriminator) branch.dispositions = discriminator;
    return branch;
  }

  /**
   * What a thrown exception answers the caller under the action the walk reached it from,
   * read through the one exception status rule, or null when nothing maps it.
   */
  function faultMapping(parent, repo, response) {
    const type = /^throw (\w+)/.exec(String(response || ''));
    let action = parent;
    while (action && action.kind !== 'action') action = parentOf.get(action);
    if (!type || !action) return null;
    const found = exceptionStatus(exceptionIndex, repo, type[1], action.class, action.method);
    if (!found) return null;
    return {
      status: Number(found.status),
      scope: found.scope,
      via: found.via,
      ...(found.file !== undefined ? { file: found.file, line: found.line } : {}),
    };
  }

  /** A deep throw a catch, a filter or the table maps to a 4xx is a refusal the caller asks for. */
  function mapsToReject(branch) {
    return Boolean(branch.mappedStatus) && branch.mappedStatus.status >= 400 && branch.mappedStatus.status < 500;
  }

  /**
   * The run-time conditions that decide an outcome and that a static read cannot evaluate:
   * each toggle on its path, the gate test the pipeline makes of the step that holds it, and
   * each flag that step, or a step the pipeline runs before it, stores from a call. Every
   * condition names its kind, the file and line it is written at, and its source text.
   */
  function outcomeConditions(terminal, dispositions) {
    const conditions = [];
    const seen = new Set();
    const add = (condition) => {
      const key = `${condition.kind}|${condition.file}|${condition.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      conditions.push(condition);
    };
    const toggle = (branch) => add({ kind: 'toggle', file: branch.file, line: branch.line, text: branch.text });
    for (const entry of dispositions) if (entry.kind === 'toggle') toggle(entry);
    if (!terminal) return conditions;
    if (!nodeById) nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const gate of terminal.gates || []) {
      const branch = gate.kind === 'toggle' ? nodeById.get(gate.branch) : null;
      if (branch) toggle(branch);
    }
    let holder = terminal;
    while (holder && !stepOf.has(holder)) holder = parentOf.get(holder);
    if (!holder) return conditions;
    const { stop, pipeline } = stepOf.get(holder);
    if (stop.gate) {
      const declared = methodSpanOf(holder.repo, holder.class, stop.gate.method);
      add({
        kind: 'step-gate',
        file: stop.file,
        line: stop.gate.line,
        text: stop.gate.text,
        step: holder.class,
        method: stop.gate.method,
        ...(declared ? { declaration: { file: declared.file, line: declared.line } } : {}),
      });
    }
    const steps = nodes.filter((node) => stepOf.has(node) && stepOf.get(node).pipeline === pipeline);
    const upTo = steps.indexOf(holder);
    for (const step of upTo === -1 ? [holder] : steps.slice(0, upTo + 1)) {
      const writes = index.flagWrites.get(`${step.repo}|${step.class}|${step.method}`) || [];
      for (const write of writes.slice().sort(byFactLine)) {
        if (!write.call || write.member !== stop.flag) continue;
        add({ kind: 'flag-call', file: write.file, line: write.line, text: write.text, call: { ...write.call } });
      }
    }
    return conditions;
  }

  /** The `method_span` that declares `Class.method` in one repository, or null. */
  function methodSpanOf(repo, className, methodName) {
    return index.spanByMethod.get(`${repo}|${className}|${methodName}`) || null;
  }

  /** The method or action that called `node`, past the class nodes that resolved the call. */
  function methodParent(node) {
    let current = parentOf.get(node);
    while (current && current.kind !== 'method' && current.kind !== 'action') current = parentOf.get(current);
    return current || null;
  }

  /**
   * Where a sentinel `value` that `node` returns surfaces: up through every caller that
   * returns the call's value unchanged (`return_flow`) to the action, whose `sentinel_map` for
   * that call gives the status. `linked` is false when a caller does anything else with the
   * value, or when the walk did not start at a route.
   */
  function sentinelLink(node, value) {
    if (value !== 'null' && value !== 'false') return { linked: false };
    const memo = `${node.id}|${value}`;
    if (linkMemo.has(memo)) return linkMemo.get(memo);
    let current = node;
    let answer = { linked: false };
    while (current && current.kind !== 'action') {
      const caller = methodParent(current);
      if (!caller) break;
      const fields = current.callFields || [];
      const matches = (fact) => fact.calledMethod === current.method && fields.includes(fact.field);
      if (caller.kind === 'action') {
        const map = (index.sentinelMaps.get(`${caller.repo}|${caller.class}|${caller.method}`) || [])
          .filter((fact) => matches(fact) && fact.sentinel === value)
          .sort(byFactLine)[0];
        answer = map
          ? { linked: true, status: map.status, via: { file: map.file, line: map.line } }
          : { linked: true, status: null };
        break;
      }
      if (!(index.returnFlows.get(`${caller.repo}|${caller.class}|${caller.method}`) || []).some(matches)) break;
      current = caller;
    }
    linkMemo.set(memo, answer);
    return answer;
  }

  /**
   * A reject decision: a site that ends the request with a status the action answers, which no
   * `branch_point` states — a stop-flag write, a step's `false`, a sentinel, a filter's result.
   * Kind `reject`, `taken` on the refusing side. A status the walk cannot read is never guessed:
   * the decision is still listed, with `response: null` and `statusReason: "status-unmapped"`.
   */
  function addReject(parent, site) {
    const branch = addBranch(
      parent,
      parent.repo,
      {
        kind: 'reject',
        file: site.file,
        line: site.line,
        text: site.text,
        ...(site.returnText ? { returnText: site.returnText, returnLine: site.line } : {}),
      },
      parent.class,
      parent.method,
    );
    branch.rejectForm = site.form;
    if (site.lines && site.lines.length > 1) branch.lines = site.lines;
    if (site.ifLine !== undefined) branch.ifLine = site.ifLine;
    branch.responseKind = 'reject';
    if (typeof site.status === 'number') {
      branch.response = statusLabel(site.status);
      if (site.via) branch.statusVia = site.via;
    } else {
      branch.response = null;
      branch.statusReason = 'status-unmapped';
    }
    return branch;
  }

  /**
   * The statements a block stop runs before its jump, walked as one method node of the
   * pipeline method that covers only those lines. Under a step's reject branch, its outcomes
   * are gated by that branch; under the pipeline method, by the method's own branches.
   */
  function walkRejectBlock(parent, pipelineNode, stop, branch) {
    if (stop.rejectFrom === undefined) return;
    claimedBlocks.add(`${pipelineNode.id}|${stop.line}`);
    const kid = child(
      parent,
      {
        repo: pipelineNode.repo,
        kind: 'method',
        ref: `${pipelineNode.class}.${pipelineNode.method}`,
        file: stop.file,
        line: stop.rejectFrom,
        class: pipelineNode.class,
        method: pipelineNode.method,
        guardSite: `reject-block:${stop.line}:${parent.id}`,
        gates: branch
          ? [...(branch.gates || []), { branch: branch.id, kind: branch.branchKind, line: branch.line, disposition: TERMINAL_DISPOSITIONS.reject }]
          : gatesAt(pipelineNode, stop.rejectFrom),
      },
      'body',
    );
    kid.spanRange = { start: stop.rejectFrom, end: stop.rejectTo };
    // The block is the pipeline method's own code, at that method's depth.
    kid.methodDepth = pipelineNode.methodDepth ?? 0;
    expand(kid, kid.hops);
  }

  /** Mark the branch that answers "no step granted access" for a first-allow loop's flag. */
  function markNoGrant(owner, test) {
    const branch = owner.children.find(
      (kid) =>
        kid.kind === 'branch' &&
        ['error_return', 'guard', 'reject'].includes(kid.branchKind) &&
        test(kid),
    );
    if (branch) branch.rejectForm = 'no-grant';
  }

  /**
   * The reject decisions a method body holds beyond its `branch_point` facts: a resolved
   * pipeline step's stop-flag writes or `return false`, a sentinel at primary depth that
   * reaches the action unchanged, and — in a gate's own walk — a filter's result assignments.
   */
  function addRejects(node) {
    if (index.repos.get(node.repo) !== 'backend') return;
    const key = `${node.repo}|${node.class}|${node.method}`;
    const range = node.spanRange || null;
    const step = stepOf.get(node);
    if (step && step.stop.form === 'flag-return') {
      const writes = (index.flagWrites.get(key) || [])
        .filter((write) => write.member === step.stop.flag && withinRange(range, write.line) && tripsStop(step.stop, write))
        .sort(byFactLine);
      if (writes.length > 0) {
        const branch = addReject(node, {
          file: writes[0].file,
          line: writes[0].line,
          text: writes[0].text || `${writes[0].param || 'request'}.${writes[0].member} = ${writes[0].value}`,
          form: 'flag-write',
          lines: writes.map((write) => write.line),
          ...sentinelLink(step.pipeline, step.stop.returns),
        });
        walkRejectBlock(branch, step.pipeline, step.stop, branch);
      }
    } else if (step && step.stop.form === 'bool-return') {
      const falses = (index.sentinels.get(key) || [])
        .filter((sentinel) => sentinel.value === 'false' && withinRange(range, sentinel.line))
        .sort(byFactLine);
      if (falses.length > 0) {
        const branch = addReject(node, {
          file: falses[0].file,
          line: falses[0].line,
          text: falses[0].text || 'return false;',
          returnText: 'return false;',
          form: 'bool-false',
          lines: falses.map((sentinel) => sentinel.line),
          ...sentinelLink(step.pipeline, step.stop.returns),
        });
        walkRejectBlock(branch, step.pipeline, step.stop, branch);
      }
    }

    const stops = index.loopStops.get(key) || [];
    const onPrimaryChain = node.infra !== true && node.asyncLeg !== true && isPrimaryOwner(node);
    if (onPrimaryChain) {
      const carriers = stops.filter((stop) => stop.form === 'flag-return' || stop.form === 'bool-return');
      const sentinels = (index.sentinels.get(key) || [])
        .filter((sentinel) => sentinel.ifLine !== undefined && withinRange(range, sentinel.line))
        .filter((sentinel) => !carriers.some((stop) => sentinel.line >= stop.line && sentinel.line <= stop.endLine))
        .sort(byFactLine);
      for (const sentinel of sentinels) {
        const link = sentinelLink(node, sentinel.value);
        if (!link.linked) continue;
        const existing = node.children.find(
          (kid) =>
            kid.kind === 'branch' &&
            (kid.branchKind === 'guard' || kid.branchKind === 'error_return') &&
            (kid.line === sentinel.line || kid.line === sentinel.ifLine || kid.returnLine === sentinel.line),
        );
        if (existing) {
          if (typeof link.status === 'number') {
            existing.response = statusLabel(link.status);
            existing.responseKind = 'reject';
            if (link.via) existing.statusVia = link.via;
          }
          continue;
        }
        addReject(node, {
          file: sentinel.file,
          line: sentinel.line,
          text: sentinel.text,
          returnText: `return ${sentinel.value};`,
          ifLine: sentinel.ifLine,
          form: 'sentinel',
          ...link,
        });
      }
    }

    if (gateWalk) {
      for (const result of (index.filterResults.get(key) || []).slice().sort(byFactLine)) {
        addReject(node, {
          file: result.file,
          line: result.line,
          text: `context.Result → ${statusLabel(result.status)}`,
          form: 'filter-result',
          status: result.status,
          via: { file: result.file, line: result.line },
        });
      }
    }

    for (const stop of stops) {
      if (stop.form !== 'flag-break') continue;
      if (typeof stop.after === 'number') {
        markNoGrant(node, (kid) => kid.line === stop.after || kid.ifLine === stop.after);
      } else {
        node.grantFlag = stop.flag;
      }
    }
  }

  /** One pipeline the walk met, by the method its loop sits in and the field it iterates. */
  function recordPipeline(node, className, methodName, field, state) {
    const ref = `${className}.${methodName} ${field || '?'}`;
    if (pipelines.has(ref)) return;
    const stop = (index.loopStops.get(`${node.repo}|${className}|${methodName}`) || []).find((entry) => entry.field === field);
    pipelines.set(ref, {
      ref,
      file: stop ? stop.file : node.file,
      line: stop ? stop.line : node.line,
      ...state,
    });
  }

  /**
   * Whether the element loop of `group` runs a composition the walk can read whole: the
   * ordered steps, the loop's stop rule and, for a step whose class declares the called method
   * more than once, the one overload whose first parameter is the loop argument's type.
   * Anything short of that is `unresolved` with the first reason found.
   */
  function readPipeline(node, className, methodName, group) {
    const field = group.ctor ? group.ctor.fact.field : null;
    const unresolved = (reason, extra = {}) => ({ state: 'unresolved', reason, field, ...extra });
    if (!field) return unresolved('composition-not-extracted');
    const composition = index.compositions.get(`${node.repo}|${className}|${field}`);
    if (!composition) return unresolved('composition-not-extracted');
    if (!Array.isArray(composition.steps)) return unresolved(composition.reason || 'composition');
    const stop = (index.loopStops.get(`${node.repo}|${className}|${methodName}`) || []).find((entry) => entry.field === field);
    if (!stop) return unresolved('stop-rule');
    const stopUnread = stop.form === 'unresolved';
    if (stopUnread && stop.reason !== 'stop-rule') return unresolved(stop.reason);
    const steps = [];
    for (const step of composition.steps) {
      const ranges = {};
      for (const called of group.methods) {
        const spans = (index.spansByClass.get(`${node.repo}|${step.type}`) || []).filter((span) => span.method === called.name);
        if (spans.length <= 1) continue;
        const matching = stop.argType
          ? spans.filter((span) => bareTypeName(String((span.paramTypes || [])[0] || '').replace(/\?$/, '')) === stop.argType)
          : [];
        if (matching.length !== 1) return stopUnread ? unresolved('stop-rule') : unresolved('overload', { step: step.type });
        ranges[called.name] = { file: matching[0].file, start: matching[0].line, end: matching[0].endLine };
      }
      steps.push({ ...step, ranges });
    }
    // The steps still run in registration order when only the stop rule is unreadable.
    if (stopUnread) return { ...unresolved('stop-rule'), ordered: true, source: composition.source, steps, stop };
    return { state: 'resolved', source: composition.source, steps, stop, field };
  }

  /**
   * Walk a resolved composition: its steps in source order, with no fan-out cap, each step's
   * entry method one level below its pipeline method. When the node budget runs out part-way, the
   * steps are taken back out of the tree and the caller walks the loop as an unresolved
   * pipeline instead, so a cut list never reads as a complete one.
   */
  function walkComposition(node, typeNode, group, pipeline, elementType) {
    const saved = {
      nodes: nodes.length,
      edges: edges.length,
      counter,
      crossings,
      budgetHit,
      visited: new Map(visited),
      fileFactsUsed: new Set(fileFactsUsed),
      graphReached: new Set(graphReached),
      unknownGraphKinds: new Set(unknownGraphKinds),
      compositionCut,
      claimedBlocks: new Set(claimedBlocks),
    };
    budgetHit = false;
    compositionCut = false;
    typeNode.composition = { state: 'resolved', source: pipeline.source, steps: pipeline.steps.map((step) => step.type) };
    inComposition += 1;
    pipeline.steps.forEach((step, position) => {
      const site = classSite(node.repo, step.type);
      const implNode = child(
        typeNode,
        {
          repo: node.repo,
          kind: 'class',
          ref: step.type,
          file: site ? site.file : step.file,
          line: site ? site.line : step.line,
          class: step.type,
          iface: elementType,
          step: position + 1,
          // A step after the first runs only when no earlier step stopped the loop.
          ...(position > 0 && pipeline.stop.form !== 'none' ? { conditional: true } : {}),
        },
        'step',
      );
      if (!guard(implNode)) return;
      for (const called of group.methods) {
        const range = step.ranges[called.name] || null;
        const anchor = range
          ? { file: range.file, line: range.start }
          : methodAnchor(node.repo, step.type, called.name, { file: implNode.file, line: implNode.line });
        const methodNode = child(
          implNode,
          {
            repo: node.repo,
            kind: 'method',
            ref: `${step.type}.${called.name}`,
            file: anchor.file,
            line: anchor.line,
            class: step.type,
            method: called.name,
            gates: intersectGates(called.lines.map((line) => gatesAt(node, line))),
          },
          'body',
          factEvidenceList(node.repo, called.facts),
        );
        if (range) methodNode.spanRange = { start: range.start, end: range.end };
        stepOf.set(methodNode, { stop: pipeline.stop, pipeline: node, depth: node.methodDepth ?? 0 });
        expand(methodNode, methodNode.hops);
      }
      release(implNode);
    });
    inComposition -= 1;
    if (!budgetHit && !compositionCut) {
      budgetHit = saved.budgetHit;
      compositionCut = saved.compositionCut;
      return true;
    }
    nodes.length = saved.nodes;
    edges.length = saved.edges;
    counter = saved.counter;
    crossings = saved.crossings;
    budgetHit = saved.budgetHit;
    compositionCut = saved.compositionCut;
    typeNode.children = [];
    visited.clear();
    for (const [key, id] of saved.visited) visited.set(key, id);
    fileFactsUsed.clear();
    for (const key of saved.fileFactsUsed) fileFactsUsed.add(key);
    graphReached.clear();
    for (const key of saved.graphReached) graphReached.add(key);
    unknownGraphKinds.clear();
    for (const key of saved.unknownGraphKinds) unknownGraphKinds.add(key);
    claimedBlocks.clear();
    for (const key of saved.claimedBlocks) claimedBlocks.add(key);
    return false;
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
      .filter((entry) => withinRange(node.spanRange, entry.fact.line))
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
    if (stopsHere(node, hops, { budget: false })) {
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
    const candidates = [];
    for (const edge of result) {
      if (!isKnownKind(edge.kind)) {
        unknownGraphKinds.add(edge.kind);
        continue;
      }
      if (!REACH_KINDS.has(edge.kind)) continue;
      const target = edge.target;
      if (matchesAny(GRAPH_PRUNE, target)) continue;
      const name = classNameFromPath(target);
      if (!name || name === className) continue;
      if (graphReached.has(`${node.repo}|${name}`) || visited.has(`${node.repo}|${name}`)) continue;
      candidates.push({ name, target, line: edge.line, rank: structuralRank(edge.kind) });
    }
    // The fan-out cap cannot be spent in arrival order. Member calls are emitted per call
    // site and outnumber every other kind, so a busy class would lose the edges naming its
    // base, its interface and what it is handed -- the ones that lead somewhere behavioural.
    // The sort is stable, so file order still decides within one kind.
    candidates.sort((a, b) => a.rank - b.rank);
    const seen = new Set();
    const kept = [];
    let dropped = 0;
    for (const candidate of candidates) {
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      if (kept.length >= GRAPH_FANOUT) {
        dropped += 1;
        continue;
      }
      kept.push(candidate);
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
    const inSpan = (entry) => withinRange(node.spanRange, entry.fact.line);
    const calls = (index.callsByMethod.get(`${node.repo}|${className}|${methodName}`) || []).filter(inSpan).sort(byLine);
    const receiverCalls = unscoped
      ? (index.callsByClass.get(`${node.repo}|${className}`) || []).slice().sort(byLine)
      : calls;
    if (calls.length === 0 && receiverCalls.length === 0) return false;
    // Under --unscoped the class's calls from its other methods ride along. They are not
    // written in this body, so the record says so and the source-flow view keeps them out
    // of this body's order.
    const ownCalls = new Set(calls.map((entry) => entry.fact));
    const record = (entry) => recordCall(node, ownCalls.has(entry.fact) ? entry : { ...entry, unscoped: true });
    // A field scoped to one method by `method` -- a handler parameter the framework injects
    // into a minimal-API lambda -- is a field of that action only, never of its siblings,
    // and inside that action it shadows a class field of the same name.
    const fields = (index.ctorFields.get(`${node.repo}|${className}`) || [])
      .filter((entry) => entry.fact.method === undefined || entry.fact.method === methodName)
      .reduce((map, entry) => {
        const current = map.get(entry.fact.field);
        if (!current || (entry.fact.method !== undefined && current.fact.method === undefined)) {
          map.set(entry.fact.field, entry);
        }
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
        if (self.name === methodName) {
          for (const fact of self.facts) record({ repo: node.repo, fact, nodes: [], skipped: 'recursion' });
          continue;
        }
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
        for (const fact of self.facts) record({ repo: node.repo, fact, nodes: [selfNode.id] });
        selfNode.callFields = ['this'];
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
      if (!guard(typeNode)) {
        for (const called of group.methods) {
          for (const fact of called.facts) record({ repo: node.repo, fact, nodes: [], skipped: 'cycle' });
        }
        continue;
      }
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
          for (const called of group.methods) {
            for (const fact of called.facts) record({ repo: node.repo, fact, nodes: [target.id] });
          }
          return;
        }
        for (const called of group.methods) {
          const anchor = methodAnchor(node.repo, target.ref, called.name, { file: target.file, line: target.line });
          const via = named.has(`${group.type}|${called.name}`) ? 'body' : UNSCOPED_VIA;
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
            via,
            factEvidenceList(node.repo, called.facts),
          );
          for (const fact of called.facts) {
            record({
              repo: node.repo,
              fact,
              nodes: [target.id, methodNode.id],
            });
          }
          methodNode.callFields = [...new Set(called.facts.map((fact) => fact.field))];
          expand(methodNode, methodNode.hops);
          if (methodNode.grantFlag) {
            const tested = new RegExp(`\\.\\s*${methodNode.grantFlag}\\b`);
            const after = Math.max(...called.lines);
            markNoGrant(node, (kid) => kid.line > after && tested.test(kid.text || ''));
          }
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
        const pipeline = readPipeline(node, className, methodName, group);
        if (pipeline.ordered) {
          if (walkComposition(node, typeNode, group, pipeline, elementType)) {
            typeNode.composition = { state: 'unresolved', reason: 'stop-rule' };
            recordPipeline(node, className, methodName, pipeline.field, { state: 'unresolved', reason: 'stop-rule' });
            releaseAll(guarded);
            continue;
          }
          pipeline.reason = 'node-budget';
        }
        if (pipeline.state === 'resolved') {
          if (walkComposition(node, typeNode, group, pipeline, elementType)) {
            recordPipeline(node, className, methodName, pipeline.field, {
              state: 'resolved',
              source: pipeline.source,
              steps: pipeline.steps.length,
            });
            releaseAll(guarded);
            continue;
          }
          pipeline.state = 'unresolved';
          pipeline.reason = 'node-budget';
        }
        typeNode.composition = { state: 'unresolved', reason: pipeline.reason, ...(pipeline.step ? { step: pipeline.step } : {}) };
        recordPipeline(node, className, methodName, pipeline.field, {
          state: 'unresolved',
          reason: pipeline.reason,
          ...(pipeline.step ? { step: pipeline.step } : {}),
        });
        const kept = exhaustive ? impls : impls.slice(0, INTERFACE_FANOUT_CAP);
        if (kept.length === 0) {
          typeNode.unresolved = true;
          typeNode.fanout = 'interface';
          for (const called of group.methods) {
            for (const fact of called.facts) record({ repo: node.repo, fact, nodes: [], skipped: 'unresolved' });
          }
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
        for (const called of group.methods) {
          for (const fact of called.facts) record({ repo: node.repo, fact, nodes: [], skipped: 'unresolved' });
        }
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
    if (stopsHere(node, hops)) {
      release(node);
      return;
    }
    const className = node.class;
    const methodName = node.method;
    const branches = mergeBranchFacts(
      pairElseFacts(
        (index.branchesByMethod.get(`${node.repo}|${className}|${methodName}`) || [])
          .filter((entry) => withinRange(node.spanRange, entry.fact.line))
          .sort(byLine),
      ),
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
    addRejects(node);
    const frontier = node.via === UNSCOPED_VIA;
    const blocks = frontier ? [] : rejectBlocksOf(node);
    if (blocks.length > 0) {
      const range = node.spanRange || { start: -Infinity, end: Infinity };
      node.spanRange = { ...range, except: [...(range.except || []), ...blocks.map((stop) => ({ start: stop.rejectFrom, end: stop.rejectTo }))] };
    }
    const called = frontier ? false : expandCalls(node, className, methodName, hops);
    for (const stop of blocks) {
      if (!claimedBlocks.has(`${node.id}|${stop.line}`)) walkRejectBlock(node, node, stop, null);
    }
    const expanded = (!frontier && expandFactEdges(node)) || called;
    addMethodOutcomes(node, hops);
    addFileOutcomes(node, hops);
    if (!frontier && (!expanded || forceGraph)) graphHop(node, className, hops);
    release(node);
  }

  /** The block stops of a backend method's step loops whose statements a step reject runs. */
  function rejectBlocksOf(node) {
    if (index.repos.get(node.repo) !== 'backend') return [];
    return (index.loopStops.get(`${node.repo}|${node.class}|${node.method}`) || []).filter(
      (stop) => stop.rejectFrom !== undefined && withinRange(node.spanRange, stop.line) && (stop.form === 'flag-return' || stop.form === 'bool-return'),
    );
  }

  /** One method's own facts of one kind, within its span, in line order. */
  function ownFactsOf(map, node) {
    return (map.get(`${node.repo}|${node.class}|${node.method}`) || [])
      .filter((fact) => withinRange(node.spanRange, fact.line))
      .sort((a, b) => a.line - b.line);
  }

  /**
   * The hops a method's own facts add beside its calls. Returns whether it added any, so a
   * method whose only call is one of these is not handed to the code index as unexpanded.
   */
  function expandFactEdges(node) {
    const mapped = expandMapperCalls(node);
    const queued = expandQueueCalls(node);
    const keyed = expandKeyedCalls(node);
    return mapped || queued || keyed;
  }

  /**
   * A call through a keyed collection reaches the called method of each implementation of
   * the element interface. A constant key keeps only the implementations whose key property
   * returns that constant, and those whose key the reader could not read. A run-time key
   * keeps them all, under the interface fan-out cap.
   */
  function expandKeyedCalls(node) {
    const calls = ownFactsOf(index.keyedCalls, node);
    for (const call of calls) {
      const collection = index.keyedCollections.get(`${node.repo}|${call.class}|${call.field}`);
      if (!collection) continue;
      const impls = interfaceImplementations(index, node.repo, collection.iface);
      const constant = isConstantKey(call.key);
      const matching = constant
        ? impls.filter((impl) => {
            const property = (index.keyProperties.get(`${node.repo}|${impl.fact.impl}`) || []).find(
              (item) => item.property === collection.key,
            );
            return !property || sameKey(property.value, call.key);
          })
        : impls;
      // The call comes first: the frontier names a stop by the first evidence site.
      const evidence = [...factEvidenceList(node.repo, [call]), ...factEvidenceList(node.repo, [collection])];
      if (matching.length === 0) {
        child(
          node,
          {
            repo: node.repo,
            kind: 'class',
            ref: collection.iface,
            file: call.file,
            line: call.line,
            class: collection.iface,
            keyed: call.key,
            inferred: true,
            unresolved: 'no implementation of the keyed collection element',
            gateLine: call.line,
          },
          'keyed_dispatch',
          evidence,
        ).leaf = true;
        continue;
      }
      const kept = exhaustive ? matching : matching.slice(0, INTERFACE_FANOUT_CAP);
      if (matching.length > kept.length) node.fanoutDropped = (node.fanoutDropped || 0) + matching.length - kept.length;
      for (const impl of kept) {
        methodHop(node, impl.fact.impl, call.calledMethod, { file: call.file, line: call.line }, 'keyed_dispatch', evidence, {
          keyed: call.key,
          inferred: true,
          gateLine: call.line,
        });
      }
    }
    return calls.length > 0;
  }

  /**
   * A call that hands a delegate to a background queue is one queue node. The work the
   * delegate does runs later and apart from the request, so its calls are the queue node's
   * children through `queued` edges and never children of the method that queues it. The
   * queue method itself is not entered.
   */
  function expandQueueCalls(node) {
    const calls = ownFactsOf(index.queueCalls, node);
    for (const call of calls) {
      const queueNode = child(
        node,
        {
          repo: node.repo,
          kind: 'queue',
          ref: `${call.receiver}.${call.calledMethod}`,
          file: call.file,
          line: call.line,
          class: node.class,
          method: call.target,
          queueRule: call.rule,
          gateLine: call.line,
        },
        'body',
        factEvidenceList(node.repo, [call]),
      );
      if (call.delegate === 'method-group') {
        methodHop(queueNode, node.class, call.target, { file: call.file, line: call.line }, 'queued', []);
        continue;
      }
      expandMethod(queueNode, queueNode.hops);
      for (const kid of queueNode.children) {
        if (kid.kind === 'branch') continue;
        kid.via = 'queued';
        const edge = edges.find((item) => item.to === kid.id);
        if (edge) edge.via = 'queued';
      }
    }
    return calls.length > 0;
  }

  /** A method node for `className.methodName`, entered through `via` from `parent`. */
  function methodHop(parent, className, methodName, fallback, via, evidence, extra = {}) {
    const anchor = methodAnchor(parent.repo, className, methodName, fallback);
    const kid = child(
      parent,
      {
        repo: parent.repo,
        kind: 'method',
        ref: `${className}.${methodName}`,
        file: anchor.file,
        line: anchor.line,
        class: className,
        method: methodName,
        ...extra,
      },
      via,
      evidence,
    );
    expand(kid, kid.hops);
    return kid;
  }

  /**
   * A mapper call runs the converters, resolvers and actions of each map whose types it
   * names: the one-type form matches the destination, the two-type form both types.
   */
  function expandMapperCalls(node) {
    const calls = ownFactsOf(index.mapperCalls, node);
    if (calls.length === 0) return false;
    const maps = (index.mapperMaps.get(node.repo) || []).slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    let added = false;
    for (const call of calls) {
      const seen = new Set();
      for (const map of maps) {
        if (map.dest !== call.dest || (call.source !== undefined && map.source !== call.source)) continue;
        const key = `${map.target}.${map.method}`;
        if (seen.has(key)) continue;
        seen.add(key);
        methodHop(node, map.target, map.method, { file: map.file, line: map.line }, 'mapper', [...factEvidenceList(node.repo, [call]), ...factEvidenceList(node.repo, [map])], { gateLine: call.line });
        added = true;
      }
    }
    return added;
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
    if (stopsHere(node, hops)) {
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
    expandGateway(node, route);
    release(node);
  }

  /**
   * A route the gateway table forwards: one gateway hop after the action, whose children
   * are the work the gateway does in order. The middleware that runs before the gateway,
   * the global handlers the route does not name, the handlers it names, then the
   * downstream call itself as an `http_out` sink.
   */
  function expandGateway(node, route) {
    const forwards = index.gatewayRoutes.get(`${node.repo}|${routeKey(route.verb, route.template)}`) || [];
    for (const forward of forwards.slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      const hop = child(
        node,
        {
          repo: node.repo,
          kind: 'gateway',
          ref: `${forward.verb} ${forward.template} → ${forward.downstreamVerb} ${forward.downstreamTemplate}`,
          file: forward.file,
          line: forward.line,
          upstream: forward.template,
          downstream: forward.downstreamTemplate,
        },
        'gateway',
        factEvidenceList(node.repo, [forward]),
      );
      const middleware = (index.gatewayMiddleware.get(node.repo) || []).slice().sort((a, b) => a.position - b.position);
      for (const entry of middleware) {
        const declared = new Set((index.spansByClass.get(`${node.repo}|${entry.middleware}`) || []).map((span) => span.method));
        const method = declared.has('InvokeAsync') ? 'InvokeAsync' : 'Invoke';
        gatewayStage(hop, entry.middleware, method, entry);
      }
      const named = new Set(forward.handlers);
      const handlers = (index.gatewayHandlers.get(node.repo) || []).slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      for (const entry of handlers) {
        if (entry.global === true && !named.has(entry.handler)) gatewayStage(hop, entry.handler, 'SendAsync', entry);
      }
      for (const name of forward.handlers) {
        gatewayStage(hop, name, 'SendAsync', handlers.find((entry) => entry.handler === name) || forward);
      }
      const host = forward.hosts[0] || '';
      child(
        hop,
        {
          repo: node.repo,
          kind: 'http_out',
          ref: `${forward.downstreamVerb} ${host}${host ? '/' : ''}${normalizeRoute(forward.downstreamTemplate)}`,
          file: forward.file,
          line: forward.line,
          sink: true,
          effectInfra: false,
        },
        'http_out',
        factEvidenceList(node.repo, [forward]),
      );
    }
  }

  /** One gateway stage: the stage method of a declared class, else an unresolved node. */
  function gatewayStage(hop, className, methodName, evidenceFact) {
    const site = classSite(hop.repo, className);
    if (!site) {
      child(
        hop,
        {
          repo: hop.repo,
          kind: 'class',
          ref: className,
          file: evidenceFact.file,
          line: evidenceFact.line,
          class: className,
          unresolved: 'no declared class',
        },
        'gateway',
        factEvidenceList(hop.repo, [evidenceFact]),
      ).leaf = true;
      return;
    }
    methodHop(hop, className, methodName, site, 'gateway', factEvidenceList(hop.repo, [evidenceFact]));
  }

  /** Every route a set of `gateway_call` facts reaches, matched on the route key. */
  function addGatewayRoutes(node, entries) {
    for (const { fact } of entries.slice().sort(byLine)) {
      const match = matchRoute(index.routeIndex, fact.verb, fact.template, aliases);
      const callerKey = routeKey(fact.verb, fact.template);
      if (!match) {
        const missing = child(
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
        recordCall(node, { repo: node.repo, fact, nodes: [missing.id], skipped: 'unresolved' });
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
      recordCall(node, { repo: node.repo, fact, nodes: [routeNode.id] });
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
  function membersCalledByClass(repo, className, file) {
    const byField = new Map();
    for (const { fact } of index.callsByClass.get(`${repo}|${className}`) || []) {
      if (fact.field === 'this' || fact.static === true) continue;
      if (file && fact.file !== file) continue;
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
   * The fold identity of a hop into an injected class: the members it calls. Keyed on the
   * class alone, a second hop into one service would fold into the first, and the members
   * only the second one calls would lose their requests.
   */
  function memberSet(members) {
    return members
      .map((member) => member.name)
      .sort()
      .join(',');
  }

  /**
   * A mobile method body: sibling calls stay in the class, an injected field's call opens
   * that class and the method named on it, and a `gateway_call` written in this method is
   * the request that leaves the app. This is the leg that says which user action reaches
   * which route, so only the methods actually called are walked.
   */
  function expandMobileMethod(node, hops) {
    if (!guard(node)) return;
    if (stopsHere(node, hops)) {
      release(node);
      return;
    }
    // Only the bodies written in this declaration's own file belong to this method: two
    // same-named classes keep separate member calls, even when the member names match.
    const calls = (index.callsByMethod.get(`${node.repo}|${node.class}|${node.method}`) || [])
      .filter((entry) => entry.fact.file === node.file)
      .sort(byLine);
    // A static call names a class, not an injected field, so it is its own group even when
    // the class name equals the type an injected field records.
    const groups = new Map();
    for (const { fact } of calls) {
      const groupKey = `${fact.static === true ? 'static' : 'field'}|${fact.field}`;
      const group = groups.get(groupKey) || {
        field: fact.field,
        static: fact.static === true,
        line: fact.line,
        methods: [],
        facts: [],
      };
      if (!group.methods.some((called) => called.name === fact.calledMethod)) {
        group.methods.push({ name: fact.calledMethod, line: fact.line, facts: [] });
      }
      group.methods.find((called) => called.name === fact.calledMethod).facts.push(fact);
      group.facts.push(fact);
      group.line = Math.min(group.line, fact.line);
      groups.set(groupKey, group);
    }
    const ordered = [...groups.values()].sort(
      (a, b) => a.line - b.line || a.field.localeCompare(b.field) || Number(a.static) - Number(b.static),
    );

    for (const group of ordered) {
      if (group.field === 'this') {
        for (const called of group.methods) {
          if (called.name === node.method) continue;
          const anchor = methodAnchor(node.repo, node.class, called.name, { file: node.file, line: called.line }, node.file);
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
          for (const fact of called.facts) recordCall(node, { repo: node.repo, fact, nodes: [selfNode.id] });
          expandMobileMethod(selfNode, selfNode.hops);
        }
        continue;
      }
      // One binding, one hop. Two calls of one local spelling that state different
      // provenance are contradictory evidence, so the site refuses instead of folding.
      const signature = (fact) => JSON.stringify([fact.source ?? null, fact.imported ?? null, fact.unresolved ?? null]);
      const signatures = new Set(group.facts.map(signature));
      const first = group.facts[0];
      const dependency =
        signatures.size === 1
          ? resolveMobileDependency(index.mobileDeclarations, node.repo, node.file, {
              name: group.field,
              source: first.source,
              imported: first.imported,
              unresolved: first.unresolved,
            })
          : { unresolved: MOBILE_DECLARATION_UNRESOLVED };
      const hopVia = group.static ? 'static' : 'di';
      if (dependency.unresolved) {
        const refused = child(
          node,
          {
            repo: node.repo,
            kind: group.static ? 'class' : 'service',
            ref: group.field,
            file: first.file,
            line: first.line,
            class: group.field,
            unresolved: MOBILE_DECLARATION_UNRESOLVED,
            callerFile: first.file,
            callerLine: first.line,
            ...(dependency.candidates ? { candidates: dependency.candidates } : {}),
          },
          hopVia,
          factEvidenceList(node.repo, group.facts),
        );
        refused.leaf = true;
        // A body with no call record reads as a wrapper of its only child in the source-flow
        // view, which would put this refusal at the call site of the body that makes it.
        for (const fact of group.facts) recordCall(node, { repo: node.repo, fact, nodes: [refused.id], skipped: 'unresolved' });
        continue;
      }
      const target = dependency.target;
      const classNode = child(
        node,
        {
          repo: node.repo,
          kind: componentKind(target.role),
          ref: target.name,
          file: target.file,
          line: target.line,
          class: target.name,
          ...(componentEntries ? { guardSite: memberSet(group.methods) } : {}),
        },
        hopVia,
        group.static ? factEvidenceList(node.repo, group.facts) : [],
      );
      if (!guard(classNode)) {
        for (const fact of group.facts) recordCall(node, { repo: node.repo, fact, nodes: [], skipped: 'cycle' });
        continue;
      }
      for (const called of group.methods) {
        const anchor = methodAnchor(node.repo, target.name, called.name, {
          file: target.file,
          line: called.line,
        }, target.file);
        const methodNode = child(
          classNode,
          {
            repo: node.repo,
            kind: 'method',
            ref: `${target.name}.${called.name}`,
            file: anchor.file,
            line: anchor.line,
            class: target.name,
            method: called.name,
          },
          'body',
          factEvidenceList(node.repo, called.facts),
        );
        for (const fact of called.facts) recordCall(node, { repo: node.repo, fact, nodes: [methodNode.id] });
        expandMobileMethod(methodNode, methodNode.hops);
      }
      release(classNode);
    }

    addDispatches(node);

    const owned = (index.gatewayByService.get(`${node.repo}|${node.class}`) || []).filter(
      (entry) => entry.fact.method === node.method && entry.fact.file === node.file,
    );
    addGatewayRoutes(node, owned);
    release(node);
  }

  /**
   * The actions a method dispatches. A dispatch names the action, never the code that
   * answers it, so the action itself is the node: what runs is whatever effects listen for
   * it, and one action reaching several effects is a real fan-out the walk keeps.
   *
   * One dispatch site is one node. Two dispatches of the same action creator at two sites
   * are two places a reader may have to look, so folding them into one node would answer
   * for the second with the first's evidence — and a dispatch written inside a request's
   * response handler keeps that request on its edge, so the answer says which settling of
   * which request reached it.
   */
  function addDispatches(node) {
    const dispatches = ownFacts(
      index,
      index.dispatchesFrom.get(`${node.repo}|${node.class}|${node.method}`) || [],
      node.repo,
      node.class,
      node.file,
    )
      .slice()
      .sort(byLine);
    for (const { repo, fact } of dispatches) {
      const def = index.actionDefs.get(`${repo}|${fact.action}`);
      const answers = Number.isInteger(fact.continuesLine)
        ? { file: fact.continuesFile, line: fact.continuesLine }
        : null;
      const evidence = [factEvidence(repo, fact)];
      if (answers) {
        evidence.push({
          key: factProvenanceKey(repo, { type: 'gateway_call', ...answers }),
          repo,
          type: 'gateway_call',
          ...answers,
        });
      }
      const actionNode = child(
        node,
        {
          repo,
          kind: 'store_action',
          ref: fact.action,
          file: def ? def.fact.file : fact.file,
          line: def ? def.fact.line : fact.line,
          action: fact.action,
          guardSite: factSite(fact),
          ...(def ? {} : { unresolved: true }),
          callerFile: fact.file,
          callerLine: fact.line,
          ...(answers ? { continuedBy: answers, outcome: fact.outcome } : {}),
        },
        'dispatch',
        evidence,
      );
      recordCall(node, { repo, fact, nodes: [actionNode.id] });
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
    if (stopsHere(node, hops)) {
      release(node);
      return;
    }
    const effects = (index.effectsByAction.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    for (const { repo, fact } of effects) {
      // A mobile effect fact names its own declaration file, and a same-named effect in another
      // file must not answer for this action. Web keeps the anchor it always had.
      const declarationFile = index.repos.get(repo) === 'mobile' ? fact.file : undefined;
      const anchor = methodAnchor(repo, fact.class, fact.field, { file: fact.file, line: fact.line }, declarationFile);
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
  function addPropHop(parent, componentName, propName, fact, event, evidence = [factEvidence(parent.repo, fact)], entry = null) {
    const bound = ownPropTarget(index, parent.repo, componentName, propName, parent.file);
    if (!bound) {
      return child(
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
          ...(entry ? { entry } : {}),
        },
        'props',
        evidence,
      );
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
        ...(entry ? { entry } : {}),
        ...(def ? {} : { unresolved: true }),
      },
      'props',
      evidence,
    );
    expandStoreAction(propNode, propNode.hops);
    return propNode;
  }

  /**
   * A React component: the children it renders, the lifecycle and hook entries that reach
   * it, the JSX `on*` handlers it binds, and any gateway call written in its own body. A
   * handler naming a bound prop is a `props` hop to the creator that prop carries; every
   * other handler is a function of this component, whether or not the extractor found its
   * body — an unresolved handler is stated, not dropped, because that is the measured
   * prop-drilling gap. An entry is walked the same way and is not merged with its siblings:
   * what runs on mount and what runs when a button is clicked are two answers, never one
   * list of steps a reader might take for a sequence.
   */
  function expandWeb(node, hops) {
    if (!guard(node)) return;
    if (stopsHere(node, hops, { page: node.kind === 'page', budget: false })) {
      release(node);
      return;
    }
    const own = (list) => ownFacts(index, list || [], node.repo, node.ref, node.file);
    const renders = own(index.rendersFrom.get(`${node.repo}|${node.ref}`)).slice().sort(byLine);
    for (const { repo, fact } of renders) {
      const { target, candidates } = renderTarget(index, repo, fact);
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
          : {
              repo,
              kind: 'component',
              ref: fact.to,
              file: fact.file,
              line: fact.line,
              unresolved: true,
              ...(candidates ? { candidates } : {}),
              ...(fact.source ? { source: fact.source } : {}),
            },
        'template',
      );
      if (target) expandWeb(rendered, rendered.hops);
    }

    const handlers = own(index.handlersFrom.get(`${node.repo}|${node.ref}`)).slice().sort(byLine);
    const bound = new Set();
    for (const { repo, fact } of handlers) {
      if (fact.kind === 'assign') continue;
      // The site is part of the key: the same handler bound at two places is two ways in, each
      // its own entry, and only a repeated statement of one binding may fold into one.
      const binding = `${fact.event}|${fact.handler}|${fact.file}:${factSite(fact)}`;
      if (bound.has(binding)) continue;
      bound.add(binding);
      const entry = eventEntry(node.ref, fact);
      const span = ownSpan(index, repo, node.ref, fact.handler, node.file);
      const prop = ownPropTarget(index, repo, node.ref, fact.handler, node.file);
      if (fact.kind === 'prop' || (!span && prop)) {
        addPropHop(node, node.ref, fact.handler, fact, fact.event, [], entry);
        continue;
      }
      const anchor = methodAnchor(repo, node.ref, fact.handler, { file: fact.file, line: fact.line }, node.file);
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
          entry,
          ...(span ? {} : { unresolved: true }),
        },
        'handler',
      );
      if (span) inEntryScope(() => expandWebMethod(handlerNode, handlerNode.hops));
    }

    const entries = own(index.entriesFrom.get(`${node.repo}|${node.ref}`)).slice().sort(byLine);
    for (const { repo, fact } of entries) {
      const entry = entryIdentity(fact);
      const fields = {
        repo,
        kind: 'entry',
        ref: entryRef(fact),
        file: fact.file,
        line: fact.line,
        endLine: fact.endLine,
        entry,
      };
      if (fact.unresolved) {
        child(node, { ...fields, unresolved: true }, 'entry');
        continue;
      }
      if (fact.method) {
        const target = child(node, { ...fields, class: node.ref, method: fact.method }, 'entry');
        inEntryScope(() => expandWebMethod(target, target.hops));
        continue;
      }
      const spans = fact.handler ? namedSpans(index, repo, fact.handler, node.ref, node.file) : [];
      const only = spans.length === 1 ? spans[0] : null;
      const target = child(
        node,
        only
          ? { ...fields, class: only.class, method: only.method }
          : { ...fields, class: node.ref, method: fact.handler || fact.trigger, unresolved: true },
        'entry',
      );
      if (only) inEntryScope(() => expandWebMethod(target, target.hops));
    }

    addGatewayRoutes(node, own(index.gatewayByMethod.get(`${node.repo}|${node.ref}|${node.ref}`)));
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
    if (stopsHere(node, hops)) {
      release(node);
      return;
    }
    const own = (list) => ownFacts(index, list || [], node.repo, node.class, node.file);
    const calls = own(index.callsByMethod.get(`${node.repo}|${node.class}|${node.method}`)).slice().sort(byLine);
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
        const propNode = addPropHop(node, node.class, fact.calledMethod, fact, null, evidence);
        for (const item of facts) recordCall(node, { repo: node.repo, fact: item, nodes: propNode ? [propNode.id] : [], skipped: propNode ? undefined : 'unresolved' });
        continue;
      }
      if (fact.field === 'this') {
        if (fact.calledMethod === node.method) {
          for (const item of facts) recordCall(node, { repo: node.repo, fact: item, nodes: [], skipped: 'recursion' });
          continue;
        }
        const anchor = methodAnchor(node.repo, node.class, fact.calledMethod, { file: node.file, line: fact.line }, node.file);
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
        for (const item of facts) recordCall(node, { repo: node.repo, fact: item, nodes: [selfNode.id] });
        expandWebMethod(selfNode, selfNode.hops);
        continue;
      }
      const spans = namedSpans(index, node.repo, fact.calledMethod, node.class, node.file);
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
      for (const item of facts) {
        recordCall(node, { repo: node.repo, fact: item, nodes: [target.id], skipped: only ? undefined : 'unresolved' });
      }
      if (only) expandWebMethod(target, target.hops);
    }

    addDispatches(node);
    addGatewayRoutes(node, own(index.gatewayByMethod.get(`${node.repo}|${node.class}|${node.method}`)));
    release(node);
  }

  /**
   * The declaration that owns one template fact, or the refusal it carries. A fact the
   * resolver proves belongs to a different declaration is filtered out by the caller,
   * never turned into a failure on the declaration being walked.
   */
  function mobileTemplateOwner(node, ownerName, fact) {
    return resolveMobileOwner(index.mobileDeclarations, node.repo, ownerName, {
      file: fact.file,
      componentFile: fact.componentFile,
    });
  }

  function sameMobileDeclaration(node, target) {
    return (
      target.repo === node.repo &&
      target.name === node.ref &&
      (!node.file || target.file === node.file)
    );
  }

  /** One terminal refusal at a recognized mobile binding or ownership site. */
  function mobileRefusal(parent, repo, fields, via, evidence) {
    const refused = child(parent, { repo, ...fields, unresolved: MOBILE_DECLARATION_UNRESOLVED }, via, evidence);
    refused.leaf = true;
    return refused;
  }

  /**
   * The entries a mobile component span gives a class: each template binding that calls a
   * method of it, at its own site, and each listed lifecycle hook its own declaration
   * writes. Each one is walked with the fold's memoisation starting over, as a web entry is.
   */
  function addMobileEntries(node) {
    const handlers = (index.handlersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    const bound = new Set();
    for (const { repo, fact } of handlers) {
      if (fact.kind !== 'call') continue;
      const owner = mobileTemplateOwner(node, fact.component, fact);
      if (owner.unresolved) {
        mobileRefusal(
          node,
          repo,
          {
            kind: 'method',
            ref: `${node.ref}.${fact.handler}`,
            file: fact.file,
            line: fact.line,
            class: node.ref,
            method: fact.handler,
            callerFile: fact.file,
            callerLine: fact.line,
            ...(owner.candidates ? { candidates: owner.candidates } : {}),
          },
          'handler',
          [factEvidence(repo, fact)],
        );
        continue;
      }
      if (!sameMobileDeclaration(node, owner.target)) continue;
      const binding = `${fact.event}|${fact.handler}|${fact.file}:${factSite(fact)}`;
      if (bound.has(binding)) continue;
      bound.add(binding);
      const anchor = methodAnchor(repo, node.ref, fact.handler, { file: fact.file, line: fact.line }, node.file);
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
          entry: eventEntry(node.ref, fact),
        },
        'handler',
      );
      inEntryScope(() => expandMobileMethod(handlerNode, handlerNode.hops));
    }
    // A class declared twice under one name shares its index buckets, so only the hooks
    // written in this declaration's own file are its entries.
    const hooks = lifecycleHooks(node.repo, node.ref, node.file).map((fact) => ({ fact, owner: node.ref }));
    const declared = new Set(hooks.map(({ fact }) => fact.method));
    const inherited = inheritedHooks(node, declared);
    for (const { fact, owner } of [...hooks, ...inherited.hooks]) {
      const hook = { component: node.ref, kind: MOBILE_LIFECYCLE_KINDS.get(fact.method), trigger: fact.method, file: fact.file, line: fact.line };
      const target = child(
        node,
        {
          repo: node.repo,
          kind: 'entry',
          ref: entryRef(hook),
          file: fact.file,
          line: fact.line,
          endLine: fact.endLine,
          class: owner,
          method: fact.method,
          entry: entryIdentity(hook),
        },
        'entry',
      );
      inEntryScope(() => expandMobileMethod(target, target.hops));
    }
    if (inherited.refused) {
      const { declaration, candidates } = inherited.refused;
      mobileRefusal(node, node.repo, {
        kind: 'class',
        ref: declaration.extends,
        file: declaration.file,
        line: declaration.line,
        class: declaration.extends,
        callerFile: declaration.file,
        callerLine: declaration.line,
        ...(candidates ? { candidates } : {}),
      }, 'entry', []);
    }
  }

  function lifecycleHooks(repo, className, file) {
    return (index.spansByClass.get(`${repo}|${className}`) || [])
      .filter((fact) => MOBILE_LIFECYCLE_KINDS.has(fact.method) && (!file || fact.file === file))
      .sort(byLine);
  }

  /**
   * The listed hooks a mobile class inherits: for each hook it does not declare, the first
   * base up its `extends` chain that declares it. Each base is found by declaration
   * identity from the file that names it. A base imported from a package, or a bare name
   * no declaration in the repository answers, ends the chain with nothing. A relative or
   * ambiguous base that does not resolve ends it with one refusal at the `extends` site.
   */
  function inheritedHooks(node, declared) {
    const hooks = [];
    const named = index.mobileDeclarations.byName.get(`${node.repo}|${node.ref}`) || [];
    let current = node.file ? named.find((declaration) => declaration.file === node.file) : named.length === 1 ? named[0] : null;
    const visited = new Set();
    while (current && current.extends) {
      const key = `${current.file}|${current.name}`;
      if (visited.has(key)) break;
      visited.add(key);
      if (current.extendsSource !== undefined && !/^\.\.?(?:\/|$)/.test(current.extendsSource)) break;
      const site = {
        name: current.extends,
        ...(current.extendsSource !== undefined ? { source: current.extendsSource } : {}),
        ...(current.extendsImported !== undefined ? { imported: current.extendsImported } : {}),
      };
      const resolved = resolveMobileDependency(index.mobileDeclarations, node.repo, current.file, site);
      if (resolved.unresolved) {
        if (current.extendsSource === undefined && !resolved.candidates) break;
        return { hooks, refused: { declaration: current, candidates: resolved.candidates } };
      }
      const base = resolved.target;
      for (const fact of lifecycleHooks(node.repo, base.name, base.file)) {
        if (declared.has(fact.method)) continue;
        declared.add(fact.method);
        hooks.push({ fact, owner: base.name });
      }
      current = (index.mobileDeclarations.byFile.get(`${node.repo}|${base.file}`) || []).find(
        (declaration) => declaration.name === base.name,
      );
    }
    return { hooks };
  }

  /**
   * A plain mobile class: each member written in its own declaration file, in line order,
   * walked as a method body. A plain class renders no template and owns no entries.
   */
  function expandMobileClass(node, hops) {
    if (!guard(node)) return;
    if (stopsHere(node, hops)) {
      release(node);
      return;
    }
    const className = node.class || node.ref;
    const members = (index.spansByClass.get(`${node.repo}|${className}`) || [])
      .filter((fact) => !node.file || fact.file === node.file)
      .slice()
      .sort((a, b) => a.line - b.line || a.method.localeCompare(b.method));
    for (const span of members) {
      const methodNode = child(
        node,
        {
          repo: node.repo,
          kind: 'method',
          ref: `${className}.${span.method}`,
          file: span.file,
          line: span.line,
          class: className,
          method: span.method,
        },
        'body',
      );
      expandMobileMethod(methodNode, methodNode.hops);
    }
    release(node);
  }

  function expandMobile(node, hops) {
    if (!guard(node)) return;
    if (stopsHere(node, hops, { page: node.kind === 'page', budget: false })) {
      release(node);
      return;
    }
    // Only the start and a component its template renders own entries. A class reached
    // through its constructor is a dependency, and its requests are the component's own.
    const ownsEntries = componentEntries && (node.via === 'start' || node.via === 'template');
    const renders = (index.rendersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    for (const { repo, fact } of renders) {
      const owner = mobileTemplateOwner(node, fact.from, fact);
      if (owner.unresolved) {
        mobileRefusal(
          node,
          repo,
          {
            kind: 'component',
            ref: fact.to,
            file: fact.file,
            line: fact.line,
            callerFile: fact.file,
            callerLine: fact.line,
            ...(owner.candidates ? { candidates: owner.candidates } : {}),
          },
          'template',
          [factEvidence(repo, fact)],
        );
        continue;
      }
      if (!sameMobileDeclaration(node, owner.target)) continue;
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
    if (ownsEntries) addMobileEntries(node);
    const handlers = ownsEntries ? [] : (index.handlersFrom.get(`${node.repo}|${node.ref}`) || []).slice().sort(byLine);
    // A pair bound at two or more sites names its site on each node, so the two nodes and
    // their subtrees stay apart in every output.
    const sitesOfPair = new Map();
    for (const { fact } of handlers) {
      if (fact.kind !== 'call') continue;
      const owner = mobileTemplateOwner(node, fact.component, fact);
      if (owner.unresolved || !sameMobileDeclaration(node, owner.target)) continue;
      const pair = `${fact.event}|${fact.handler}`;
      const sites = sitesOfPair.get(pair) || new Set();
      sites.add(`${fact.file}:${factSite(fact)}`);
      sitesOfPair.set(pair, sites);
    }
    const bound = new Set();
    for (const { repo, fact } of handlers) {
      if (fact.kind !== 'call') continue;
      const owner = mobileTemplateOwner(node, fact.component, fact);
      if (owner.unresolved) {
        mobileRefusal(
          node,
          repo,
          {
            kind: 'method',
            ref: `${node.ref}.${fact.handler}`,
            file: fact.file,
            line: fact.line,
            class: node.ref,
            method: fact.handler,
            callerFile: fact.file,
            callerLine: fact.line,
            ...(owner.candidates ? { candidates: owner.candidates } : {}),
          },
          'handler',
          [factEvidence(repo, fact)],
        );
        continue;
      }
      if (!sameMobileDeclaration(node, owner.target)) continue;
      const binding = `${fact.event}|${fact.handler}|${fact.file}:${factSite(fact)}`;
      if (bound.has(binding)) continue;
      bound.add(binding);
      const bindingSite = { file: fact.file, line: fact.line, ...(Number.isInteger(fact.column) ? { column: fact.column } : {}) };
      const repeated = (sitesOfPair.get(`${fact.event}|${fact.handler}`) || new Set()).size > 1;
      const anchor = methodAnchor(repo, node.ref, fact.handler, { file: fact.file, line: fact.line }, node.file);
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
          ...(repeated ? { site: { ...bindingSite }, guardSite: `@${fact.file}:${factSite(fact)}` } : {}),
        },
        'handler',
      );
      // Selection reads the site of every handler node; the output shows it only where a
      // pair has more than one, so a single binding prints as it always has.
      Object.defineProperty(handlerNode, 'bindingSite', { value: bindingSite, enumerable: false });
      // Under one shared memoisation the second site would fold into the first and print
      // as reaching nothing, so each repeated site is walked in a scope of its own.
      if (repeated) inEntryScope(() => expandMobileMethod(handlerNode, handlerNode.hops));
      else expandMobileMethod(handlerNode, handlerNode.hops);
    }
    const injects = (index.injectsFrom.get(`${node.repo}|${node.ref}`) || [])
      .filter((entry) => !node.file || entry.fact.file === node.file)
      .sort(byLine);
    const calledOnField = unscoped ? null : membersCalledByClass(node.repo, node.ref, node.file);
    for (const { repo, fact } of injects) {
      const called = unscoped ? null : calledOnField.get(fact.to);
      const dependency = resolveMobileDependency(index.mobileDeclarations, node.repo, node.file, {
        name: fact.to,
        source: fact.source,
        imported: fact.imported,
        unresolved: fact.unresolved,
      });
      // A dependency the class never calls on is no traversal anchor, and a written
      // specifier outside the repository can name no declaration here. Such a declared
      // dependency keeps the legacy unexpanded node instead of becoming a refusal.
      const outsideRepository =
        typeof fact.source === 'string' && !/^\.\.?(?:\/|$)/.test(fact.source);
      if (dependency.unresolved && outsideRepository && !called) {
        const legacy = child(
          node,
          { repo, kind: 'service', ref: fact.to, file: fact.file, line: fact.line },
          'ctor',
          [factEvidence(repo, fact)],
        );
        expandMobile(legacy, legacy.hops);
        continue;
      }
      if (dependency.unresolved) {
        mobileRefusal(
          node,
          repo,
          {
            kind: 'service',
            ref: fact.to,
            file: fact.file,
            line: fact.line,
            class: fact.to,
            callerFile: fact.file,
            callerLine: fact.line,
            ...(dependency.candidates ? { candidates: dependency.candidates } : {}),
          },
          'ctor',
          [factEvidence(repo, fact)],
        );
        continue;
      }
      const target = dependency.target;
      const injected = child(
        node,
        {
          repo,
          kind: componentKind(target.role),
          ref: target.name,
          file: target.file,
          line: target.line,
          class: target.name,
        },
        'ctor',
        [factEvidence(repo, fact)],
      );
      if (!called) {
        expandMobile(injected, injected.hops);
        continue;
      }
      if (componentEntries) injected.guardSite = memberSet(called);
      if (!guard(injected)) continue;
      for (const member of called) {
        const anchor = methodAnchor(node.repo, target.name, member.name, {
          file: target.file,
          line: target.line,
        }, target.file);
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
    addGatewayRoutes(
      node,
      (index.gatewayByService.get(`${node.repo}|${node.ref}`) || []).filter(
        (entry) => !node.file || entry.fact.file === node.file,
      ),
    );
    release(node);
  }

  /**
   * A page reached by its browser path is walked from the page, and the chain that mounts it
   * is hung beneath it as `mount` hops, one per segment that has a source site, so every
   * segment is a node a reader can open. A mount hop spends no depth.
   */
  function addMountChain(node) {
    if (!node.mount || !Array.isArray(node.mount.chain)) return;
    const segments = [];
    const host = node.mount.host;
    if (host && host.file) segments.push({ kind: 'host', path: host.path, file: host.file, line: host.line, source: host.source });
    segments.push(...node.mount.chain.filter((segment) => segment.file));
    // Added after the walk and outside its node budget: the chain is how the start was found,
    // not part of what it reaches, so a URL start and a name start spend the same budget.
    const added = [];
    for (const segment of segments) {
      counter += 1;
      const mount = {
        id: `n${counter}`,
        children: [],
        repo: node.repo,
        kind: 'mount',
        ref: mountRef(segment),
        file: segment.file,
        line: segment.line,
        ...(segment.entryFile ? { entryFile: segment.entryFile, entryLine: segment.entryLine } : {}),
        segment: segment.kind,
        source: segment.source,
        hops: node.hops,
        gates: [],
        methodEntered: false,
        methodDepth: 0,
      };
      nodes.push(mount);
      added.push(attach(node, mount, 'mount'));
    }
    node.children = [...added, ...node.children.filter((kid) => !added.includes(kid))];
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
        if (index.repos.get(node.repo) === 'mobile') expandMobileClass(node, hops);
        else expandClass(node, hops, null);
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
  addMountChain(root);

  let walked = nodes;
  let walkedEdges = edges;
  if (inventory) {
    const keep = new Set([root.id]);
    const mark = (node) => {
      let reaches = node.kind === 'route' || node.kind === 'mount';
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
    if (resolved.error) return { fromHandlerError: resolved.error };
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
  const routeSeeds = options.seeds
    ? buildSeeds(effectiveRoot, effectiveRoot.ref, index.paramSources, outcomeConditions)
    : { list: [], truncated: 0, exhausted: false, conditions: new Map() };
  const gated =
    options.seeds && !gateWalk && effectiveRoot.kind === 'route' && effectiveRoot.route
      ? withGateSeeds(effectiveRoot, routeSeeds)
      : { seeds: routeSeeds, gates: [], walks: [] };
  const seeds = gated.seeds;
  const pipelineList = [...pipelines.values()];
  const viaCounts = {};
  for (const edge of walkedEdges) viaCounts[edge.via] = (viaCounts[edge.via] || 0) + 1;
  const repos = [...new Set(walked.map((node) => node.repo))].filter((repo) => index.repos.has(repo)).sort();
  // A level-scheduled walk is partial by construction: the budget is what chose the level.
  if (schedule.order === 'level' && !schedule.probe) budgetHit = true;
  const status = buildWalkStatus();

  return {
    root: effectiveRoot,
    nodes: walked,
    edges: walkedEdges,
    sinks,
    branches,
    seeds: seeds.list,
    seedsTruncated: seeds.truncated,
    seedConditions: routeSeeds.conditions,
    ...(recordCalls ? { callRecords } : {}),
    status,
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
      graphUnknownKinds: [...unknownGraphKinds].sort(),
      ...(pipelineList.length > 0
        ? {
            pipelines: {
              resolved: pipelineList.filter((entry) => entry.state === 'resolved').length,
              unresolved: pipelineList
                .filter((entry) => entry.state === 'unresolved')
                .map(({ state, ...entry }) => entry),
            },
          }
        : {}),
      ...(gated.gates.length > 0 ? { gates: gated.gates } : {}),
    },
  };

  /**
   * The status every printer reads. One walk, one object: traversal, freshness, evidence,
   * the scope it was asked for, the limits it ran under, the schedule it ran, every place
   * it stopped, and the identity of the inputs it read. The frontier keeps walk order;
   * cap entries that belong to no single node follow, in reason order.
   */
  function buildWalkStatus() {
    const freshness = freshnessOf(factSets, options);
    const byId = new Map();
    for (const node of nodes) byId.set(node.id, node);
    const edgeInto = new Map();
    for (const edge of edges) edgeInto.set(edge.to, edge);

    const scoped = (node) => {
      if (!options.fromHandler || effectiveRoot === root) return true;
      let current = node;
      while (current) {
        if (current === effectiveRoot) return true;
        current = parentOf.get(current);
      }
      return false;
    };

    const frontier = [];
    const frontierNodes = [];
    const stops = {};
    const stopsByNode = new Map();
    const add = (entry, node = null) => {
      frontier.push(entry);
      frontierNodes.push(node);
      stops[entry.reason] = (stops[entry.reason] || 0) + 1;
    };

    const nodeEntry = (node, reason, extra = {}) => {
      const callerNode = methodParent(node) || parentOf.get(node) || null;
      const edge = edgeInto.get(node.id) || null;
      const evidence = edge && edge.evidence && edge.evidence.length > 0 ? edge.evidence[0] : null;
      const callSite = evidence
        ? { file: evidence.file, line: evidence.line ?? null }
        : node.file
          ? { file: node.file, line: node.line ?? null }
          : null;
      return {
        reason,
        repo: node.repo,
        target: node.ref,
        caller: callerNode
          ? { ref: callerNode.ref, file: callerNode.file ?? null, line: callerNode.line ?? null }
          : null,
        callSite,
        via: node.via || null,
        remaining: extra.remaining !== undefined ? extra.remaining : remainingWork(node),
        ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
        ...(extra.gate !== undefined ? { gate: extra.gate } : {}),
        raisedBy: raisedByOf(reason),
      };
    };

    for (const node of nodes) {
      if (!scoped(node)) continue;
      const stop = stopOf.get(node);
      if (stop) {
        stopsByNode.set(node, stop);
        add(nodeEntry(node, stop.reason), node);
        continue;
      }
      if (node.fanoutDropped) {
        add(nodeEntry(node, 'fan-out-cap', { remaining: node.fanoutDropped, detail: 'interface' }), node);
      }
      if (node.dropped) {
        add(nodeEntry(node, 'fan-out-cap', { remaining: node.dropped, detail: 'graph' }), node);
      }
      if (node.graph === 'unavailable') add(nodeEntry(node, 'provider-unavailable'), node);
      if (node.unresolved) {
        add(
          nodeEntry(node, 'unresolved-target', {
            detail: typeof node.unresolved === 'string' ? node.unresolved : undefined,
          }),
          node,
        );
      }
    }

    // A gate walk's stops are the route's stops: the seeds it kept are part of the answer,
    // so a route whose own body fitted the budget still cannot name what the filter missed.
    for (const walk of gated.walks || []) {
      for (const entry of walk.status.frontier) {
        add({ ...entry, gate: walk.gate });
      }
    }

    for (const pipeline of pipelineList) {
      if (pipeline.state !== 'unresolved') continue;
      const site = { file: pipeline.file ?? null, line: pipeline.line ?? null };
      if (pipeline.reason === 'node-budget') {
        add({
          reason: 'node-budget',
          repo: root.repo,
          target: pipeline.ref,
          caller: null,
          callSite: site,
          via: 'step',
          remaining: null,
          detail: 'pipeline',
          raisedBy: raisedByOf('node-budget'),
        });
      } else {
        add({
          reason: 'unresolved-pipeline',
          repo: root.repo,
          target: pipeline.ref,
          caller: null,
          callSite: site,
          via: 'step',
          remaining: null,
          ...(pipeline.reason ? { detail: pipeline.reason } : {}),
          raisedBy: null,
        });
      }
    }

    if (options.seeds && (seeds.truncated > 0 || seeds.exhausted)) {
      add({
        reason: 'seed-cap',
        repo: effectiveRoot.repo,
        target: effectiveRoot.ref,
        caller: null,
        callSite: effectiveRoot.file ? { file: effectiveRoot.file, line: effectiveRoot.line ?? null } : null,
        via: effectiveRoot.via || 'start',
        remaining: seeds.truncated > 0 && !seeds.exhausted ? seeds.truncated : null,
        raisedBy: null,
      });
    }

    for (const kind of [...unknownGraphKinds].sort()) {
      add({
        reason: 'unknown-edge-kind',
        repo: root.repo,
        target: kind,
        caller: null,
        callSite: null,
        via: 'graph',
        remaining: null,
        raisedBy: null,
      });
    }

    const evidence = { 'source-supported': 0, inferred: 0 };
    for (const edge of walkedEdges) {
      const child = byId.get(edge.to);
      const inferred =
        edge.via === 'graph' ||
        edge.via === 'interface_fanout' ||
        edge.via === 'keyed_dispatch' ||
        Boolean(child && (child.bindings || child.inferred === true || child.source === 'inferred'));
      evidence[inferred ? 'inferred' : 'source-supported'] += 1;
    }

    const scope = {
      start: {
        repo: resolved.node.repo,
        kind: resolved.node.kind,
        ref: resolved.node.ref,
        file: resolved.node.file ?? null,
        line: resolved.node.line ?? null,
      },
      mode: inventory ? 'inventory' : stopAtRoutes ? 'to-routes' : 'full',
      fromHandler: options.fromHandler || null,
      unscoped,
      graph: forceGraph,
      seeds: Boolean(options.seeds),
      entries: componentEntries,
    };
    const statusLimits = {
      depth,
      maxNodes,
      seedCap: MAX_SEEDS,
      interfaceFanOut: INTERFACE_FANOUT_CAP,
      graphFanOut: GRAPH_FANOUT,
    };
    const scheduleOf = schedule.order === 'level' ? { order: 'level', level: schedule.level } : { order: 'depth-first' };
    // The identity of one analysis: the fact sets it read, the start, the scope it was asked
    // for, the limits it ran under and the configuration that shaped the walk. Repository
    // roots stay out, so the same inputs in another checkout keep the same identity.
    const identityInputs = [
      factSets.map((set) => factSetIdentity(set)),
      scope.start,
      scope,
      statusLimits,
      {
        aliases,
        sinks: {
          db: dbPatterns,
          writePrefixes: accessPrefixes.writePrefixes,
          readPrefixes: accessPrefixes.readPrefixes,
        },
        consumerEntryMethods,
        repos: (options.repos || []).map((repo) => ({ id: repo.id, kind: repo.kind, role: repo.role || [] })),
        primaryDepth,
        infraFanIn,
      },
    ];
    const identity = `sha256:${createHash('sha256').update(JSON.stringify(identityInputs)).digest('hex')}`;

    return buildStatus({
      freshness: { value: freshness.value, sets: freshness.sets },
      evidence,
      scope,
      limits: statusLimits,
      schedule: scheduleOf,
      stops,
      frontier,
      frontierNodes,
      identity,
      stopsByNode,
    });
  }

  /**
   * The direct child facts the stopped node's own expander reads. Work the facts count is
   * a number; work they cannot count is `null`, never `0`, so an unreadable remainder is
   * never read as an empty one.
   */
  function remainingWork(node) {
    const key = `${node.repo}|${node.class}|${node.method}`;
    const inSpan = (list) => (list || []).filter((entry) => withinRange(node.spanRange, entry.fact.line));
    switch (node.kind) {
      case 'action':
      case 'method':
        return (
          inSpan(index.callsByMethod.get(key)).length +
          [index.mapperCalls, index.queueCalls, index.keyedCalls]
            .map((map) => (map.get(key) || []).filter((fact) => withinRange(node.spanRange, fact.line)).length)
            .reduce((sum, count) => sum + count, 0) +
          (index.gatewayByMethod.get(key) || []).length +
          (index.dispatchesFrom.get(key) || []).length
        );
      case 'class':
      case 'consumer':
      case 'processor': {
        const names = index.methodsByClass.get(`${node.repo}|${node.class || node.ref}`);
        return names ? names.size : null;
      }
      case 'store_action':
        return (index.effectsByAction.get(`${node.repo}|${node.ref}`) || []).length;
      case 'message': {
        const publishFact = node.messageFact || { message: node.ref, fqn: node.fqn };
        const consumers = index.consumeAll.filter(
          (entry) => matchMessage(index.messages, publishFact, entry.fact) !== null,
        ).length;
        const processors = index.processorAll.filter(
          (entry) => matchMessage(index.messages, publishFact, entry.fact) !== null,
        ).length;
        return consumers + processors;
      }
      case 'route':
        return node.route ? 1 : null;
      default:
        return null;
    }
  }

  /**
   * The framework filters a controller action meets before it runs, in the order ASP.NET Core
   * runs them: authorization before action filters, then a literal `Order`, then global,
   * controller and action scope, then registration order. A filter whose exemption attribute
   * the action or its controller chain carries is listed with `exempt` and walks nothing.
   */
  function routeGates(routeNode) {
    const route = routeNode.route;
    const repo = routeNode.repo;
    if (!route.controller || !/Controller$/.test(route.controller)) return [];
    const chain = [];
    for (let cls = route.controller; cls && !chain.includes(cls); cls = index.classBase.get(`${repo}|${cls}`)) chain.push(cls);
    const onClasses = chain.flatMap((cls) => index.filtersOnClass.get(`${repo}|${cls}`) || []);
    const onAction = index.filtersOnMethod.get(`${repo}|${route.controller}|${route.action}`) || [];
    const carried = new Set([...onClasses, ...onAction].map((use) => use.filter));
    const uses = [
      ...index.globalFilters
        .filter((entry) => entry.repo === repo)
        .map((entry) => ({ use: entry.fact, scope: 'global', rank: entry.fact.position ?? 0 })),
      ...onClasses.map((use, rank) => ({ use, scope: 'controller', rank })),
      ...onAction.map((use, rank) => ({ use, scope: 'action', rank })),
    ];
    const gates = [];
    const seen = new Set();
    for (const { use, scope, rank } of uses) {
      const entries = index.authFilters.get(`${repo}|${use.filter}`) || [];
      if (entries.length === 0 || seen.has(use.filter)) continue;
      seen.add(use.filter);
      for (const entry of entries) {
        const exempt = (entry.exemptions || []).find((name) => carried.has(name));
        gates.push({
          filter: use.filter,
          class: entry.class,
          method: entry.method,
          file: entry.file,
          line: entry.line,
          scope,
          stage: entry.stage,
          shared: scope === 'global',
          order: entry.order ?? 0,
          rank,
          ...(exempt ? { exempt } : {}),
        });
      }
    }
    return gates.sort(
      (a, b) =>
        STAGE_RANK[a.stage] - STAGE_RANK[b.stage] ||
        a.order - b.order ||
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        a.rank - b.rank ||
        a.method.localeCompare(b.method),
    );
  }

  /**
   * One gate's own seeds: its entry method walked as a start of its own, with its own node
   * budget, keeping only the seeds a filter result ends. Its toggles therefore decide only its
   * own seeds and never multiply the route's. Walked once per fact set and configuration. The
   * walk's status is kept beside the seeds, because a route whose seeds came from a stopped
   * gate walk answers with the filter's incomplete knowledge, whatever its own body reached.
   */
  function gateSeedsOf(gate, repo) {
    if (!GATE_MEMO.has(factSets)) GATE_MEMO.set(factSets, new Map());
    const memo = GATE_MEMO.get(factSets);
    const signature = JSON.stringify([
      repo, gate.class, gate.method, depth, maxNodes, primaryDepth, infraFanIn, exhaustive, unscoped, options.sinks || null,
    ]);
    if (memo.has(signature)) return memo.get(signature);
    const walked = trace(factSets, null, {
      ...options,
      seeds: true,
      gateWalk: true,
      inventory: false,
      fromHandler: undefined,
      index,
      summaries,
      startNode: { repo, kind: 'method', ref: `${gate.class}.${gate.method}`, file: gate.file, line: gate.line, class: gate.class, method: gate.method },
    });
    const seeds = (walked.seeds || []).filter((seed) => {
      const last = seed.dispositions[seed.dispositions.length - 1];
      return last && last.kind === 'reject' && last.rejectForm === 'filter-result' && last.disposition === 'taken';
    });
    const kept = { seeds, status: walked.status || null };
    memo.set(signature, kept);
    return kept;
  }

  function withGateSeeds(routeNode, own) {
    const gates = routeGates(routeNode);
    if (gates.length === 0) return { seeds: own, gates: [], walks: [] };
    const found = [];
    const report = [];
    const walks = [];
    for (const gate of gates) {
      const { order, rank, ...listed } = gate;
      if (gate.exempt) {
        report.push({ ...listed, seeds: 0 });
        continue;
      }
      const gateWalk = gateSeedsOf(gate, routeNode.repo);
      const gateSeeds = gateWalk.seeds;
      report.push({ ...listed, seeds: gateSeeds.length });
      if (gateWalk.status && gateWalk.status.traversal !== 'complete') {
        walks.push({ gate: gate.filter, status: gateWalk.status });
      }
      for (const seed of gateSeeds) {
        found.push({
          ...seed,
          key: seedKeyOf(routeNode.ref, seed.dispositions),
          gate: { filter: gate.filter, class: gate.class, method: gate.method, scope: gate.scope, stage: gate.stage, shared: gate.shared },
        });
      }
    }
    const kept = found.slice(0, MAX_SEEDS);
    const list = [...kept, ...own.list].map((seed, position) => ({ ...seed, id: `U${position + 1}` }));
    return {
      seeds: {
        list,
        truncated: own.truncated + found.length - kept.length,
        exhausted: own.exhausted === true,
      },
      gates: report,
      walks,
    };
  }
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
    ...(node.rejectForm ? { rejectForm: node.rejectForm } : {}),
    ...(node.lines ? { lines: [...node.lines] } : {}),
    ...(node.statusReason ? { statusReason: node.statusReason } : {}),
    ...(node.statusVia ? { statusVia: { ...node.statusVia } } : {}),
    ...(node.mappedStatus ? { mappedStatus: { ...node.mappedStatus } } : {}),
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
const ALWAYS_MULTIPLY = ['error_return', 'guard', 'validation', 'reject'];

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
  if (budget.left <= 0) {
    budget.exhausted = true;
    return;
  }
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
      if (budget.left <= 0) {
        budget.exhausted = true;
        return;
      }
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
  reject: 'not-taken',
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

/**
 * A step gate or a flag stored from a call decides an outcome at run time, so a seed that
 * needs one reads `unknown` unless a branch it forces is one the request itself drives. A
 * seed with none keeps the reachability its branches give it, and so does one no caller can
 * reach at all.
 */
export function conditionedReachability(base, dispositions, conditions) {
  const runtime = (conditions || []).find((entry) => entry.kind === 'step-gate' || entry.kind === 'flag-call');
  if (!runtime || base.reachability === 'unreachable') return base;
  const driven = (dispositions || []).some(
    (entry) => entry.kind !== 'toggle' && NOMINAL_DISPOSITIONS[entry.kind] !== entry.disposition && entry.reachability === 'reachable',
  );
  if (driven) return base;
  return { reachability: 'unknown', reason: conditionText(runtime) };
}

/** The run-time conditions a walked seed's outcome depends on, empty when it names none. */
export function seedConditions(result, seed) {
  const found = result && result.seedConditions && seed ? result.seedConditions.get(seed.key) : null;
  return found ? found.map((entry) => ({ ...entry })) : [];
}

/** The words a reachability reason names a condition in: its kind, what it calls and where it is written. */
export function conditionText(condition) {
  const at = `${condition.file}:${condition.line}`;
  if (condition.kind === 'step-gate') return `step gate ${condition.step}.${condition.method} at ${at}`;
  if (condition.kind === 'flag-call') {
    const call = condition.call || {};
    return `flag call ${call.field && call.field !== 'this' ? `${call.field}.` : ''}${call.calledMethod} at ${at}`;
  }
  return `toggle at ${at}`;
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
function underTerminal(gates, terminal) {
  const ending = TERMINAL_DISPOSITIONS[terminal.rep.branchKind];
  return (gates || []).some(
    (gate) => gate.disposition === ending && terminal.members.some((member) => member.id === gate.branch),
  );
}

function buildSeeds(root, routeRef, paramSources = new Map(), conditionsOf = null) {
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
  const seedConditions = [];
  const budget = { left: SEED_BUDGET };
  const dominators = new Map();
  const emitted = new Set();

  enumerateDispositions(deciding, 0, [], satisfies, (combo, terminal) => {
    const assigned = new Map(combo.map(({ group, disposition }) => [group, disposition]));
    let vector = combo;
    if (terminal) {
      if (!dominators.has(terminal)) dominators.set(terminal, dominating(terminal, ownerOf));
      const dominates = dominators.get(terminal);
      // The branch an `if` map answers a sentinel with is that sentinel's carrier, not a
      // decision of its own: the reject already states the status it gives.
      const via = terminal.rep.statusVia;
      const carrier = (entry) =>
        via && entry.group !== terminal && entry.group.rep.file === via.file && entry.group.rep.line === via.line;
      vector = combo.filter((entry) => dominates(entry.group) && !carrier(entry));
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
    // A reject seed reaches only what its own reject branch runs before the request ends.
    const reached = terminal
      ? outcomes.filter((item) => reachable(item.gates) && underTerminal(item.gates, terminal))
      : outcomes.filter((item) => reachable(item.gates));
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
    const conditions = conditionsOf ? conditionsOf(terminal ? terminal.rep : null, dispositions) : [];
    const reach = conditionedReachability(seedReachability(dispositions), dispositions, conditions);
    seedConditions.push(conditions);
    seeds.push({
      key: seedKeyOf(routeRef, dispositions),
      kind: terminal ? terminal.rep.responseKind || 'reject' : 'effect',
      reachability: reach.reachability,
      ...(reach.reason ? { reachabilityReason: reach.reason } : {}),
      dispositions,
      response: terminal ? terminal.rep.response : null,
      ...(terminal && terminal.rep.statusReason ? { statusReason: terminal.rep.statusReason } : {}),
      ...(terminal && terminal.rep.statusVia ? { statusVia: { ...terminal.rep.statusVia } } : {}),
      outcomes: own,
      always,
      alsoOnPath: visible
        .filter((branch) => branch.primary === true && !decides(branch))
        .map((branch) => branchRecord(branch, null)),
      infrastructure: visible.filter((branch) => branch.primary === false).map((branch) => branchRecord(branch, null)),
    });
  }, budget);

  const list = seeds.slice(0, MAX_SEEDS).map((seed, position) => ({ id: `U${position + 1}`, ...seed }));
  const conditions = new Map(list.map((seed, position) => [seed.key, seedConditions[position]]));
  return { list, truncated: Math.max(0, seeds.length - list.length), exhausted: Boolean(budget.exhausted), conditions };
}
