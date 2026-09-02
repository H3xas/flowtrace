/**
 * Scaffold step — a named coverage gap into a starting spec in the target harness's
 * own conventions.
 *
 * `cover` names which seeds no test reaches. This module writes the next step: one spec file per **route**, every seed of that route a
 * `test()` block inside one `test.describe(route)`, in the naming, import, context and
 * assertion conventions the harness already uses — read from configuration, never
 * hardcoded to one harness.
 *
 * Three rules keep a scaffold honest:
 *
 * - **It never invents a seed.** Every emitted block comes from a seed the walker
 *   produced, carries that seed's stable key, and states the branch text that tells it
 *   apart.
 * - **It never writes into a repository.** The output directory is checked against every
 *   configured repository root; a scaffold is a starting point a person moves in, not an
 *   edit to a checkout this tool does not own.
 * - **It never asserts something it cannot derive.** A status the branch implies is
 *   asserted exactly; a status it does not is left as `UNRESOLVED_REJECT_STATUS`, an
 *   unfilled path parameter as `UNRESOLVED_PATH_PARAM`, an unknown read-back as
 *   `UNRESOLVED_READ_PATH` — greppable identifiers rather than comments, because the
 *   generated file carries no comment but the case-id placeholder.
 *
 * A seed whose owner is a `worker_processor` gets the message-driven shape instead:
 * publish through the harness's own worker-queue client, then poll a front-door read with
 * a bounded wait. No path, queue or fixture particular to one processor lives here — the
 * message and exchange come from the facts, everything else from the conventions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { HAPPY_DISPOSITIONS, PLAYWRIGHT_TERMINAL_CODES, STATE_ORDER } from './cover.js';
import { trace } from './trace.js';

/**
 * The house style a generated spec is written in. The structure below is the shape of a
 * Playwright API harness; the names in it are placeholders for the ones a given harness
 * actually exports. The `scaffold` key of the configuration file overrides the fields
 * docs/configuration.md lists, one field at a time — nested groups merge rather than
 * replace, and fields outside that list (`poll`, `importAliases.caseId`) change only
 * when a caller passes its own conventions through the API. `importAliases.caseId` is
 * unset by default; a caller that sets it, with a matching `caseIdPlaceholder`, gets
 * the reporter import emitted.
 */
export const DEFAULT_CONVENTIONS = Object.freeze({
  specRoot: 'tests',
  specSuffix: '.spec.ts',
  workerRoot: 'tests/workers',
  importAliases: Object.freeze({
    caseId: null,
    fixtures: './fixtures',
    utils: './utils',
    features: './features',
    generated: './generated',
  }),
  roles: Object.freeze({ default: 'admin', denied: 'denied', member: 'member' }),
  contextFactory: Object.freeze({
    store: 'ApiClientFactory',
    instance: false,
    instanceVariable: 'apiClients',
    method: 'get',
    as: 'Roles',
    api: 'Api.base',
    fixtures: Object.freeze(['session']),
    // Every name above is a placeholder for the harness's own vocabulary; the `scaffold`
    // key of the configuration file overrides these fields one at a time.
    variable: 'ctx',
  }),
  caseIdPlaceholder: "test.info().annotations.push({ type: 'case-id', description: 'TODO' })",
  poll: Object.freeze({ timeoutMs: 30000, intervalsMs: Object.freeze([1000, 2000, 5000]) }),
  worker: Object.freeze({
    module: 'worker',
    client: 'MessageClient',
    method: 'publish',
    builder: 'buildMessage',
  }),
  clientClassTemplate: '{Feature}Client',
  unresolvedRejectStatus: Object.freeze([400, 404]),
  okStatus: 200,
});

/** The levels `--max-level` accepts, least covered first. */
export const MAX_LEVELS = Object.freeze(['none', 'skipped', 'route', 'path']);

/** Statuses a status assertion promotes mechanically; anything else stays at `route`. */
const TERMINAL_CODES = new Set(PLAYWRIGHT_TERMINAL_CODES);

/** Why a `fault` block is parked: a 500 is a defect, never a contract to assert. */
const FAULT_FIXME_REASON = 'fault seed: decide the contract (expected status or handled error) before enabling';

/**
 * Exception types whose own name is the contract. `UnauthorizedAccessException` is
 * deliberately absent: it is a 500 however it is named, which is the whole reason a
 * `fault` seed is parked rather than asserted.
 */
const EXCEPTION_CODES = Object.freeze([
  [/\bBadRequestException\b/, 400],
  [/\bUnauthorizedException\b/, 401],
  [/\bForbiddenException\b/, 403],
  [/\bNotFoundException\b/, 404],
  [/\bConflictException\b/, 409],
  [/\bGoneException\b/, 410],
]);

const TITLE_CAP = 90;
const SEPARATOR = ' · ';

/** Response names a branch's own text implies when the seed carries no numeric code. */
const RESPONSE_CODES = Object.freeze([
  [/StatusCodes?\.Status(\d{3})/, (match) => Number(match[1])],
  [/\bBadRequest\b/, () => 400],
  [/\bUnauthorized\b/, () => 401],
  [/\bForbid(den)?\b/, () => 403],
  [/\bNotFound\b/, () => 404],
  [/\bConflict\b/, () => 409],
  [/\bGone\b/, () => 410],
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One level of override per nested convention group; arrays replace wholesale. */
export function mergeConventions(override) {
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_CONVENTIONS)) {
    merged[key] = Array.isArray(value) ? [...value] : isPlainObject(value) ? { ...value } : value;
  }
  if (!isPlainObject(override)) return merged;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = { ...merged[key], ...value };
      continue;
    }
    merged[key] = Array.isArray(value) ? [...value] : value;
  }
  return merged;
}

/** The validated `scaffold` conventions carried by `loadConfig`. */
export function readScaffoldConventions(config) {
  return isPlainObject(config?.scaffold) ? config.scaffold : {};
}

function compare(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `POST orders/v1/cart/items/*` -> `{verb, path}`; a start with no verb keeps an empty one. */
export function splitRouteKey(key) {
  const match = /^([A-Z]+)\s+(.*)$/.exec(String(key || '').trim());
  if (!match) return { verb: '', path: String(key || '').trim() };
  return { verb: match[1], path: match[2] };
}

function pascal(text) {
  const value = String(text || '');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function camel(text) {
  const value = String(text || '');
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Prose for a test title: one line, no braces or backticks, escaped for a `'…'`. */
export function titleText(text, cap = TITLE_CAP) {
  const flat = String(text ?? '')
    .replace(/[`{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
  return clipped.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** A value for a `'…'` literal: escaped, but faithful — a queue name keeps its braces. */
function literal(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

/**
 * The spec path the route key mirrors: every named segment a directory, the last one the
 * file. Two routes that differ only in their wildcards would claim one path, so the
 * second takes the verb as a suffix and, past that, a counter — decided in sorted route
 * order so a rerun writes the same names.
 */
export function specPathFor(routeKey, conventions, taken = new Set()) {
  const { verb, path } = splitRouteKey(routeKey);
  const named = path.split('/').filter((segment) => segment && segment !== '*');
  const base = named.length > 0 ? named[named.length - 1] : 'route';
  const dirs = named.slice(0, -1);
  const stem = (suffix) => [conventions.specRoot, ...dirs, suffix ? `${base}.${suffix}` : base].join('/');
  let candidate = stem('');
  if (taken.has(candidate)) candidate = stem(verb.toLowerCase() || 'route');
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = stem(`${verb.toLowerCase() || 'route'}.${counter}`);
    counter += 1;
  }
  taken.add(candidate);
  return `${candidate}${conventions.specSuffix}`;
}

/** The message-driven spec path for a processor: the work type names the file. */
export function processorSpecPathFor(entry, conventions, taken = new Set()) {
  const base = camel(entry.workType || entry.processor || 'processor');
  let candidate = `${conventions.workerRoot}/${base}`;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${conventions.workerRoot}/${base}.${counter}`;
    counter += 1;
  }
  taken.add(candidate);
  return `${candidate}${conventions.specSuffix}`;
}

function nonHappy(seed) {
  return (seed.dispositions || []).filter((branch) => HAPPY_DISPOSITIONS[branch.kind] !== branch.disposition);
}

function toggleVector(seed) {
  return (seed.dispositions || [])
    .filter((branch) => branch.kind === 'toggle' && branch.disposition !== HAPPY_DISPOSITIONS.toggle)
    .map((branch) => ({ name: branch.toggle || branch.text, disposition: branch.disposition }))
    .sort((a, b) => compare(a.name, b.name));
}

function isRead(outcome) {
  return outcome.kind === 'db' && outcome.access === 'read';
}

function outcomeLabel(outcome) {
  if (outcome.kind === 'message') return `⇝ ${outcome.ref}`;
  if (outcome.kind === 'db') return `db ${outcome.ref}${outcome.method ? `.${outcome.method}` : ''}`;
  return `${outcome.kind} ${outcome.ref}`;
}

/** An effect the request itself leaves behind — something a follow-up read can observe. */
function mutates(seed) {
  return (seed.outcomes || []).some((outcome) => !isRead(outcome));
}

/** An effect whose evidence is only visible after another process has run. */
function sinkFed(seed) {
  return (seed.outcomes || []).some(
    (outcome) => outcome.kind === 'message' || outcome.kind === 'push' || outcome.kind === 'http_out',
  );
}

/**
 * The status the branch implies. A seed's own response answers first; failing that the
 * branch's return text is read for the response name that produced it. `null` means the
 * scaffold must not pin a code.
 */
export function statusFor(seed) {
  const response = String(seed.response || '');
  const leading = /^(\d{3})\b/.exec(response);
  if (leading) return Number(leading[1]);
  const parenthesised = /\((\d{3})\)/.exec(response);
  if (parenthesised) return Number(parenthesised[1]);
  const branches = nonHappy(seed);
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const text = `${branches[index].returnText || ''} ${branches[index].text || ''}`;
    for (const [pattern, read] of RESPONSE_CODES) {
      const match = pattern.exec(text);
      if (match) return read(match);
    }
  }
  return null;
}

/**
 * The status a thrown exception is actually contracted to produce, when the facts say so:
 * the exception's own name carries it (`BadRequestException`), or the branch that throws
 * it names a status literal. `null` means the flow ends in an unhandled 500, which is a
 * defect rather than a contract — the block is parked instead of asserting it.
 */
export function mappedFaultStatus(seed) {
  const sources = [String(seed.response || '')];
  for (const branch of nonHappy(seed)) sources.push(`${branch.text || ''} ${branch.returnText || ''}`);
  const named = sources.join(' ').replace(/\(\d{3}\)/g, ' ');
  const literalCode = /StatusCodes?\.Status(\d{3})/.exec(named);
  if (literalCode) return Number(literalCode[1]);
  for (const [pattern, code] of EXCEPTION_CODES) {
    if (pattern.test(named)) return code;
  }
  return null;
}

/** `<kind> · <outcome> · <branch text>` — what this seed is, what it does, why it differs. */
export function testTitle(seed) {
  const kind = seed.kind || 'effect';
  const effects = (seed.outcomes || []).filter((outcome) => !isRead(outcome)).map(outcomeLabel);
  let outcome;
  if (kind === 'effect') outcome = effects.length > 0 ? effects[0] : 'reads only';
  else outcome = seed.response || `${kind}`;
  const branches = nonHappy(seed);
  const last = branches.length > 0 ? branches[branches.length - 1] : null;
  const branch = last
    ? `${last.text}${last.disposition === 'taken' ? '' : ` = ${last.disposition}`}`
    : 'happy path';
  const title = [titleText(kind, 20), titleText(outcome, 60), titleText(branch)].join(SEPARATOR);
  return seed.reachability === 'edge' ? `${title} (edge: route arg)` : title;
}

/**
 * The seeds a black-box caller cannot force at all, and why. `cases` and `scaffold` drop
 * them from their output rather than emitting a test nobody can ever make pass, and list
 * them instead; `--include-unreachable` puts them back exactly as they were.
 */
export function unreachableFooter(entries) {
  if (entries.length === 0) return null;
  const listed = entries
    .map((entry) => `${entry.id} \`#${entry.key}\`${entry.reason ? ` (${entry.reason})` : ''}`)
    .join('; ');
  return `Unreachable from a black-box caller (${entries.length}): ${listed}`;
}

/** `{ id, key, reason }` for every seed this run dropped as unreachable. */
export function unreachableEntry(seed) {
  return { id: seed.id, key: seed.key || null, reason: seed.reachabilityReason || null };
}

/** Whether a seed survives the reachability filter. */
export function keepsSeed(seed, includeUnreachable) {
  return includeUnreachable === true || seed.reachability !== 'unreachable';
}

/**
 * What the level of this seed becomes if the scaffolded block is filled in and passes: a
 * status assertion pinned to a terminal code promotes mechanically to `disposition`, an
 * effect observed by a follow-up read reaches `path` once a reader confirms it, and a
 * status the branch did not imply proves only that the route ran.
 */
function projectedLevel(seed, status) {
  if (seed.kind === 'fault' && status === null) return 'none';
  if (seed.kind === 'reject' || seed.kind === 'fault') {
    return status !== null && TERMINAL_CODES.has(status) ? 'disposition' : 'route';
  }
  return mutates(seed) ? 'path' : 'route';
}

function lowestLevel(levels) {
  return levels.reduce(
    (lowest, level) => (STATE_ORDER[level] < STATE_ORDER[lowest] ? level : lowest),
    levels[0] || 'none',
  );
}

/** Every seed's current level, keyed `<route>::<seed key>`, from a `cover` report. */
function levelIndex(report) {
  const levels = new Map();
  for (const route of (report && report.routes) || []) {
    for (const seed of route.seeds || []) {
      if (seed.key) levels.set(`${route.key}::${seed.key}`, seed.level || seed.state || 'none');
      levels.set(`${route.key}::#${seed.id}`, seed.level || seed.state || 'none');
    }
  }
  return levels;
}

/**
 * Client methods that already send this route's request, keyed by route. A packet's
 * `helperExcerpt` is the only place a request resolved `via: "helper"` names the code
 * that sent it; the feature module comes from that file's own `features/<name>/` segment,
 * and the class from the harness's `{Feature}Client` naming. An assertion helper asserts
 * its own status, so it is recorded but never reused as the act line.
 */
export function helperIndex(options = {}, conventions = DEFAULT_CONVENTIONS) {
  const index = new Map();
  for (const packet of readPackets(options.packets)) {
    for (const candidate of packet.candidates || []) {
      const helper = candidate.helperExcerpt;
      if (!helper || !helper.name || !helper.file) continue;
      const segments = String(helper.file).split('/');
      const at = segments.lastIndexOf('features');
      if (at === -1 || at + 2 > segments.length - 1) continue;
      const feature = segments[at + 1];
      const kind = /^expect/.test(helper.name) || /assertions?\.[jt]s$/.test(helper.file) ? 'assertion' : 'client';
      const entry = {
        name: helper.name,
        file: helper.file,
        feature,
        kind,
        module: `${conventions.importAliases.features}/${feature}`,
        className: conventions.clientClassTemplate.replace('{Feature}', pascal(feature)),
      };
      const existing = index.get(packet.route);
      if (!existing || (existing.kind !== 'client' && entry.kind === 'client')) index.set(packet.route, entry);
    }
  }
  for (const [key, entry] of Object.entries(options.helpers || {})) index.set(key, entry);
  return index;
}

function readPackets(packets) {
  if (Array.isArray(packets)) return packets;
  if (typeof packets !== 'string' || !existsSync(packets)) return [];
  return readdirSync(packets)
    .filter((name) => name.endsWith('.packet.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(packets, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Every `worker_processor` fact, reachable by processor name and by work type. */
export function processorIndex(factSets) {
  const byName = new Map();
  const queues = new Map();
  for (const set of factSets || []) {
    for (const item of set.facts || []) {
      if (item.type === 'queue_name') queues.set(item.message, item.name);
    }
  }
  for (const set of factSets || []) {
    for (const item of set.facts || []) {
      if (item.type !== 'worker_processor') continue;
      const entry = {
        repo: set.repo,
        processor: item.processor,
        workType: item.workType,
        message: item.message || null,
        exchange: queues.get(item.message) || item.workType || null,
      };
      if (item.processor) byName.set(item.processor, entry);
      if (item.workType && !byName.has(item.workType)) byName.set(item.workType, entry);
    }
  }
  return byName;
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
    owner: entry.owner || null,
    seeds: entry.seeds || [],
    error: entry.error || null,
  }));
}

/**
 * A scaffold is a starting point a person moves into a harness, never an edit this tool
 * makes to a checkout it does not own.
 */
function assertOutsideRepos(outDir, repoRoots) {
  const target = resolve(outDir);
  for (const root of repoRoots || []) {
    if (!root) continue;
    const base = resolve(root);
    if (target === base || target.startsWith(`${base}${sep}`)) {
      throw new Error(`scaffold: refusing to write inside a configured repository (${outDir})`);
    }
  }
}

function indent(depth) {
  return '  '.repeat(depth);
}

/** The store is a class with a static reader, or an instance the module holds. */
function storeReference(conventions) {
  const factory = conventions.contextFactory;
  return factory.instance ? factory.instanceVariable : factory.store;
}

function contextLine(conventions, role) {
  const factory = conventions.contextFactory;
  const args = [`${factory.api}`, `${factory.as}.${role}()`, ...(factory.fixtures || [])];
  return `const ${factory.variable} = await ${storeReference(conventions)}.${factory.method}(${args.join(', ')});`;
}

function pollLines(conventions, target, depth) {
  const pad = indent(depth);
  return [
    `${pad}await expect`,
    `${pad}  .poll(async () => (await ${conventions.contextFactory.variable}.get(${target})).status(), { timeout: POLL_TIMEOUT_MS, intervals: POLL_INTERVALS_MS })`,
    `${pad}  .toBe(${conventions.okStatus});`,
  ];
}

/** The act line: a client method that already sends this request, or a raw context call. */
function actLines(plan, conventions, depth) {
  const pad = indent(depth);
  const variable = conventions.contextFactory.variable;
  if (plan.helper && plan.helper.kind === 'client') {
    return [
      `${pad}const client = new ${plan.helper.className}(${variable});`,
      `${pad}const response = await client.${plan.helper.name}();`,
    ];
  }
  return [`${pad}const response = await ${variable}.${plan.verbMethod}(ROUTE_PATH);`];
}

function renderTestBlock(block, plan, conventions, depth) {
  const pad = indent(depth);
  const lines = [`${pad}test('${block.title}', async ({ ${(conventions.contextFactory.fixtures || []).join(', ')} }) => {`];
  if (block.fixme) lines.push(`${pad}  test.fixme(true, '${FAULT_FIXME_REASON}');`);
  lines.push(`${pad}  ${conventions.caseIdPlaceholder};`);
  lines.push(`${pad}  ${contextLine(conventions, block.role)}`);
  if (block.processor) {
    const engine = conventions.worker;
    lines.push(`${pad}  const worker = new ${engine.client}(${conventions.contextFactory.variable});`);
    lines.push(
      `${pad}  const published = await worker.${engine.method}(${engine.builder}({ exchange: PROCESSOR_EXCHANGE, message: PROCESSOR_MESSAGE, payload: {} }));`,
    );
    lines.push(`${pad}  expect(published.status()).toBe(${conventions.okStatus});`);
    lines.push(...pollLines(conventions, 'UNRESOLVED_READ_PATH', depth + 1));
    lines.push(`${pad}});`);
    return lines;
  }
  lines.push(...actLines(plan, conventions, depth + 1));
  if (block.kind === 'reject' || block.kind === 'fault') {
    if (block.fixme) lines.push(`${pad}  expect(response.status()).toBeLessThan(500);`);
    else if (block.status === null) lines.push(`${pad}  expect(UNRESOLVED_REJECT_STATUS).toContain(response.status());`);
    else lines.push(`${pad}  expect(response.status()).toBe(${block.status});`);
  } else {
    lines.push(`${pad}  expect(response.status()).toBe(${conventions.okStatus});`);
    if (block.mutates) {
      lines.push(`${pad}  const readBack = await ${conventions.contextFactory.variable}.get(ROUTE_PATH);`);
      lines.push(`${pad}  expect(readBack.status()).toBe(${conventions.okStatus});`);
    }
    if (block.sinkFed) lines.push(...pollLines(conventions, 'ROUTE_PATH', depth + 1));
  }
  lines.push(`${pad}});`);
  return lines;
}

function renderGroups(plan, conventions, depth) {
  const lines = [];
  let first = true;
  for (const group of plan.groups) {
    if (!first) lines.push('');
    first = false;
    if (!group.title) {
      let inner = true;
      for (const block of group.blocks) {
        if (!inner) lines.push('');
        inner = false;
        lines.push(...renderTestBlock(block, plan, conventions, depth));
      }
      continue;
    }
    const pad = indent(depth);
    lines.push(`${pad}test.describe('${group.title}', () => {`);
    lines.push(`${pad}  test.describe.configure({ mode: 'serial' });`);
    for (const block of group.blocks) {
      lines.push('');
      lines.push(...renderTestBlock(block, plan, conventions, depth + 1));
    }
    lines.push(`${pad}});`);
  }
  return lines;
}

function renderConsts(plan, conventions) {
  const lines = [];
  if (conventions.contextFactory.instance) {
    lines.push(`const ${conventions.contextFactory.instanceVariable} = new ${conventions.contextFactory.store}();`);
  }
  if (plan.processor) {
    lines.push(`const PROCESSOR_EXCHANGE = '${literal(plan.processor.exchange || '')}';`);
    lines.push(`const PROCESSOR_MESSAGE = '${literal(plan.processor.message || '')}';`);
    lines.push("const UNRESOLVED_READ_PATH = '';");
  } else {
    if (plan.wildcards > 0) {
      lines.push("const UNRESOLVED_PATH_PARAM = '';");
      const parts = plan.path
        .split('/')
        .map((segment) => (segment === '*' ? '${UNRESOLVED_PATH_PARAM}' : segment))
        .join('/');
      lines.push(`const ROUTE_PATH = \`${parts}\`;`);
    } else {
      lines.push(`const ROUTE_PATH = '${literal(plan.path)}';`);
    }
    if (plan.needsUnresolvedStatus) {
      lines.push(`const UNRESOLVED_REJECT_STATUS = [${conventions.unresolvedRejectStatus.join(', ')}];`);
    }
  }
  if (plan.needsPoll) {
    lines.push(`const POLL_TIMEOUT_MS = ${conventions.poll.timeoutMs};`);
    lines.push(`const POLL_INTERVALS_MS = [${(conventions.poll.intervalsMs || []).join(', ')}];`);
  }
  return lines;
}

/**
 * The reporter import a configured case-id placeholder needs. `importAliases.caseId`
 * names the module; the imported symbol is the placeholder's own leading identifier, so
 * the two settings cannot drift apart. The default placeholder starts at `test`, which
 * every spec already imports, so nothing is emitted until a harness configures both.
 */
export function caseIdImportLine(conventions) {
  const module = conventions.importAliases.caseId;
  if (!module) return null;
  const m = /^([A-Za-z_$][\w$]*)/.exec(String(conventions.caseIdPlaceholder || ''));
  if (!m || m[1] === 'test') return null;
  return `import { ${m[1]} } from '${module}';`;
}

function renderImports(plan, conventions) {
  const aliases = conventions.importAliases;
  const factory = conventions.contextFactory;
  const lines = [];
  const caseIdImport = caseIdImportLine(conventions);
  if (caseIdImport) lines.push(caseIdImport);
  lines.push(
    `import { expect, test } from '${aliases.fixtures}';`,
    `import { ${[factory.api.split('.')[0], factory.store, factory.as].join(', ')} } from '${aliases.utils}';`,
  );
  if (plan.processor) {
    const engine = conventions.worker;
    lines.push(`import { ${engine.builder}, ${engine.client} } from '${aliases.features}/${engine.module}';`);
  } else if (plan.helper && plan.helper.kind === 'client') {
    lines.push(`import { ${plan.helper.className} } from '${plan.helper.module}';`);
  }
  return lines;
}

/** One spec file: imports, the consts the body actually uses, then the route's describe. */
export function renderSpec(plan, conventions) {
  const lines = [...renderImports(plan, conventions), ''];
  const consts = renderConsts(plan, conventions);
  if (consts.length > 0) lines.push(...consts, '');
  lines.push(`test.describe('${plan.title}', () => {`);
  lines.push(...renderGroups(plan, conventions, 1));
  lines.push('});');
  const footer = unreachableFooter(plan.unreachable || []);
  if (footer) lines.push('', `// ${footer}`, '// Re-run with --include-unreachable to scaffold them anyway.');
  return `${lines.join('\n')}\n`;
}

const VERB_METHODS = Object.freeze({ GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' });

/**
 * Two seeds can differ only in a disposition the branch text does not name. A title is
 * what a person reads and what a test-management case is later matched against, so a collision is
 * broken by the seed's own stable key rather than by position.
 */
function uniqueTitles(blocks) {
  const counts = new Map();
  for (const block of blocks) counts.set(block.title, (counts.get(block.title) || 0) + 1);
  for (const block of blocks) {
    if (counts.get(block.title) > 1 && block.seedKey) block.title = `${block.title} [${block.seedKey}]`;
  }
}

function planFor(route, context) {
  const { conventions, helpers, processors, levels, maxLevel, seedFilter, taken, includeUnreachable } = context;
  const processor = processors.get(route.key) || (route.owner === 'worker_processor' ? { processor: route.key } : null);
  const { verb, path } = splitRouteKey(route.key);
  const blocks = [];
  const dropped = [];
  for (const seed of route.seeds || []) {
    const level = levels.get(`${route.key}::${seed.key}`) || levels.get(`${route.key}::#${seed.id}`) || 'none';
    if (STATE_ORDER[level] > STATE_ORDER[maxLevel]) continue;
    if (seedFilter && !seedFilter.has(seed.key)) continue;
    if (!keepsSeed(seed, includeUnreachable)) {
      dropped.push(unreachableEntry(seed));
      continue;
    }
    const kind = seed.kind || 'effect';
    const mapped = kind === 'fault' ? mappedFaultStatus(seed) : null;
    const status = kind === 'fault' ? mapped : statusFor(seed);
    blocks.push({
      fixme: kind === 'fault' && mapped === null,
      id: seed.id,
      seedKey: seed.key || null,
      kind,
      status,
      level,
      after: projectedLevel(seed, status),
      title: testTitle(seed),
      role: status === 403 || status === 401 ? conventions.roles.denied : conventions.roles.default,
      mutates: kind === 'effect' && mutates(seed),
      sinkFed: kind === 'effect' && sinkFed(seed),
      processor: Boolean(processor),
      toggles: toggleVector(seed),
    });
  }
  if (dropped.length > 0) context.unreachableByRoute.set(route.key, dropped);
  if (blocks.length === 0) return null;
  uniqueTitles(blocks);

  const groups = new Map();
  for (const block of blocks) {
    const title = block.toggles.map((entry) => `toggle ${entry.name} = ${entry.disposition}`).join(SEPARATOR);
    const group = groups.get(title) || { title, blocks: [] };
    group.blocks.push(block);
    groups.set(title, group);
  }
  const ordered = [...groups.values()].sort((a, b) => compare(a.title, b.title));

  const plan = {
    route: route.key,
    unreachable: dropped,
    title: titleText(route.key, 120),
    verb,
    path,
    verbMethod: VERB_METHODS[verb] || 'post',
    wildcards: path.split('/').filter((segment) => segment === '*').length,
    helper: processor ? null : helpers.get(route.key) || null,
    processor,
    groups: ordered,
    blocks,
    needsUnresolvedStatus: blocks.some((block) => block.kind === 'reject' && block.status === null),
    needsPoll: Boolean(processor) || blocks.some((block) => block.sinkFed),
  };
  plan.file = processor
    ? processorSpecPathFor(processor, conventions, taken)
    : specPathFor(route.key, conventions, taken);
  return plan;
}

/** `route -> file -> tests -> level before/after`, the one page a reviewer reads first. */
export function renderIndex(result) {
  const lines = [
    `# scaffold — ${result.area}`,
    '',
    `${result.counts.routes} routes · ${result.counts.tests} tests · ` +
      `${result.counts.helperReuse} reusing an existing helper · ${result.counts.processor} worker-shaped · ` +
      `${result.counts.unreachable} unreachable`,
    '',
    'Levels are the mechanical coverage levels: `after` is what each route reaches once every',
    'block below is arranged, given a case id and passes.',
    '',
    '| route | file | tests | before | after |',
    '|---|---|---|---|---|',
  ];
  for (const file of result.files) {
    lines.push(`| \`${file.route}\` | \`${file.file}\` | ${file.tests.length} | ${file.levelBefore} | ${file.levelAfter} |`);
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
 * Walk every route, keep the seeds at or below `filter.maxLevel`, and write one spec per
 * route plus the index. `dryRun` returns the same result with nothing on disk.
 * `includeUnreachable` restores the seeds no black-box caller can force, which are
 * dropped by default.
 */
export function scaffold(options = {}) {
  const conventions = mergeConventions(options.conventions);
  const filter = options.filter || {};
  const maxLevel = filter.maxLevel || 'skipped';
  if (!MAX_LEVELS.includes(maxLevel)) {
    throw new Error(`scaffold: unknown level "${maxLevel}" (expected ${MAX_LEVELS.join(', ')})`);
  }
  const outDir = options.outDir || null;
  if (outDir) assertOutsideRepos(outDir, options.repoRoots);

  const routes = options.seeds ? normaliseSeedInput(options.seeds) : walkRoutes(options);
  const context = {
    conventions,
    helpers: helperIndex(options, conventions),
    processors: processorIndex(options.facts),
    levels: levelIndex(options.cover),
    maxLevel,
    seedFilter: filter.seedKeys && filter.seedKeys.length > 0 ? new Set(filter.seedKeys) : null,
    includeUnreachable: options.includeUnreachable === true,
    unreachableByRoute: new Map(),
    taken: new Set(),
  };

  const ordered = [...routes].sort((a, b) => compare(a.key, b.key));
  const files = [];
  const skipped = [];
  for (const route of ordered) {
    const plan = planFor(route, context);
    if (!plan) {
      skipped.push(route.key);
      continue;
    }
    files.push({
      route: plan.route,
      file: plan.file,
      helper: plan.helper && plan.helper.kind === 'client' ? plan.helper.name : null,
      processor: Boolean(plan.processor),
      tests: plan.blocks.map((block) => ({
        id: block.id,
        key: block.seedKey,
        kind: block.kind,
        title: block.title,
        status: block.status,
        level: block.level,
        after: block.after,
      })),
      levelBefore: lowestLevel(plan.blocks.map((block) => block.level)),
      levelAfter: lowestLevel(plan.blocks.map((block) => block.after)),
      contents: renderSpec(plan, conventions),
    });
  }

  const unreachable = [];
  for (const [route, entries] of context.unreachableByRoute) {
    for (const entry of entries) unreachable.push({ route, ...entry });
  }
  const result = {
    area: filter.area || options.area || 'area',
    outDir,
    dryRun: options.dryRun === true,
    files,
    skipped,
    unreachable,
    includeUnreachable: options.includeUnreachable === true,
    counts: {
      routes: files.length,
      tests: files.reduce((sum, file) => sum + file.tests.length, 0),
      helperReuse: files.filter((file) => file.helper).length,
      processor: files.filter((file) => file.processor).length,
      skipped: skipped.length,
      unreachable: unreachable.length,
    },
    maxLevel,
  };
  result.index = renderIndex(result);

  if (outDir && options.dryRun !== true) {
    for (const file of files) {
      const target = join(outDir, file.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'INDEX.md'), result.index);
    result.written = files.length;
  } else {
    result.written = 0;
  }
  return result;
}
