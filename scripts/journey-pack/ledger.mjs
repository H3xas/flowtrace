/**
 * The expected ledger of a journey pack: what the source of the pack says each case should
 * find, written before anything was observed. This module only reads and checks it; it
 * never runs flowtrace, so a ledger can be validated against its sources on its own.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const LEDGER_FORMAT = 'flowtrace-journey-expected';
export const LEDGER_SCHEMA_VERSION = 1;

export const VOCABULARY = Object.freeze([
  'resolved',
  'discovery',
  'lifecycle',
  'join',
  'ordering',
  'budget',
  'stale-input',
  'configuration',
  'unsupported',
  'unresolved-cause',
]);

export const SITE_KINDS = Object.freeze([
  'page', 'mount', 'route', 'request', 'handler', 'lifecycle', 'dispatch', 'thunk', 'check',
  'lookup', 'filter', 'write', 'cache', 'branch', 'feedback', 'call',
]);

export const COVERS = Object.freeze([
  'nested-url', 'component-name', 'mount-vs-click', 'alias-join', 'check-order',
  'conditional-call', 'repeated-call', 'budget-traversal', 'effects', 'feedback',
]);

export const ASSERTS = Object.freeze(['routes', 'sinks']);

const TOP_KEYS = ['format', 'schemaVersion', 'pack', 'config', 'vocabulary', 'sites', 'unknowns', 'runs', 'cases'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Flags that change what a run prints or where it reads its configuration would let a ledger
// row decide its own evidence, so a run may only narrow or widen the walk itself.
const VALUED_FLAGS = new Set(['--depth', '--max-nodes']);
const BARE_FLAGS = new Set(['--seeds', '--expand']);
// A selector narrows the walk to one handler rather than changing what the run prints, so it
// belongs in the same family as the flags above; it is checked as a name, not as a number.
const SELECTOR_FLAGS = new Set(['--from-handler']);

export class LedgerError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** A repository-relative POSIX path that cannot leave its root by its spelling alone. */
function isContainedPath(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Every schema problem in a parsed ledger; an empty list means the shape is valid. */
export function ledgerProblems(ledger) {
  const problems = [];
  const fail = (message) => problems.push(message);
  if (!isPlainObject(ledger)) return ['ledger is not an object'];
  const keys = Object.keys(ledger);
  if (keys.join(',') !== TOP_KEYS.join(',')) fail(`top-level keys must be ${TOP_KEYS.join(', ')} in that order`);
  if (ledger.format !== LEDGER_FORMAT) fail(`format must be ${LEDGER_FORMAT}`);
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) fail(`schemaVersion must be ${LEDGER_SCHEMA_VERSION}`);
  if (!isNonEmptyString(ledger.pack) || !ID_RE.test(ledger.pack)) fail('pack must be a lowercase id');
  if (!isContainedPath(ledger.config)) fail('config must be a relative path beside the ledger');
  if (!Array.isArray(ledger.vocabulary) || ledger.vocabulary.join(',') !== VOCABULARY.join(',')) {
    fail(`vocabulary must be exactly ${VOCABULARY.join(', ')}`);
  }
  for (const table of ['sites', 'unknowns', 'runs', 'cases']) {
    if (!Array.isArray(ledger[table])) {
      fail(`${table} must be an array`);
      return problems;
    }
  }

  const ids = new Map();
  const claim = (id, where) => {
    if (!isNonEmptyString(id) || !ID_RE.test(id)) {
      fail(`${where}: id ${JSON.stringify(id)} is not a lowercase id`);
      return;
    }
    if (ids.has(id)) fail(`${where}: id ${id} is already used by ${ids.get(id)}`);
    else ids.set(id, where);
  };

  const siteIds = new Set();
  ledger.sites.forEach((site, index) => {
    const where = `sites[${index}]`;
    if (!isPlainObject(site)) return fail(`${where} is not an object`);
    claim(site.id, where);
    siteIds.add(site.id);
    if (!SITE_KINDS.includes(site.kind)) fail(`${where}: kind ${JSON.stringify(site.kind)} is not a site kind`);
    if (!isNonEmptyString(site.repo)) fail(`${where}: repo is required`);
    if (!isContainedPath(site.file)) fail(`${where}: file must be a relative path inside its repository`);
    if (!Number.isInteger(site.line) || site.line < 1) fail(`${where}: line must be a positive integer`);
    if (!isNonEmptyString(site.anchor)) fail(`${where}: anchor is required`);
    if (site.symbol !== null && !isNonEmptyString(site.symbol)) fail(`${where}: symbol must be a name or null`);
  });

  const unknownIds = new Set();
  ledger.unknowns.forEach((unknown, index) => {
    const where = `unknowns[${index}]`;
    if (!isPlainObject(unknown)) return fail(`${where} is not an object`);
    claim(unknown.id, where);
    unknownIds.add(unknown.id);
    if (!isNonEmptyString(unknown.repo)) fail(`${where}: repo is required`);
    if (!isContainedPath(unknown.file)) fail(`${where}: file must be a relative path inside its repository`);
    if (!Number.isInteger(unknown.line) || unknown.line < 1) fail(`${where}: line must be a positive integer`);
    if (!isNonEmptyString(unknown.anchor)) fail(`${where}: anchor is required`);
    if (!isNonEmptyString(unknown.reason)) fail(`${where}: reason is required`);
  });

  const runIds = new Set();
  ledger.runs.forEach((run, index) => {
    const where = `runs[${index}]`;
    if (!isPlainObject(run)) return fail(`${where} is not an object`);
    claim(run.id, where);
    runIds.add(run.id);
    if (!isNonEmptyString(run.start) || run.start.trim().startsWith('-')) fail(`${where}: start must be a trace start, not a flag`);
    for (const problem of argProblems(run.args)) fail(`${where}: ${problem}`);
    if (!ASSERTS.includes(run.asserts)) fail(`${where}: asserts must be one of ${ASSERTS.join(', ')}`);
    if (!Array.isArray(run.reach)) fail(`${where}: reach must be an array`);
    else for (const id of run.reach) if (!siteIds.has(id)) fail(`${where}: reach names unknown site ${id}`);
  });

  ledger.cases.forEach((entry, index) => {
    const where = `cases[${index}]`;
    if (!isPlainObject(entry)) return fail(`${where} is not an object`);
    claim(entry.id, where);
    if (!Array.isArray(entry.covers) || entry.covers.length === 0) fail(`${where}: covers must be a non-empty array`);
    else for (const tag of entry.covers) if (!COVERS.includes(tag)) fail(`${where}: covers tag ${JSON.stringify(tag)} is not known`);
    if (!runIds.has(entry.run)) fail(`${where}: run ${JSON.stringify(entry.run)} is not a run id`);
    if (!isNonEmptyString(entry.question)) fail(`${where}: question is required`);
    if (!Array.isArray(entry.expect) || entry.expect.length === 0) fail(`${where}: expect must name at least one site`);
    else for (const id of entry.expect) if (!siteIds.has(id)) fail(`${where}: expect names unknown site ${id}`);
    if (!Array.isArray(entry.unknowns)) fail(`${where}: unknowns must be an array`);
    else for (const id of entry.unknowns) if (!unknownIds.has(id)) fail(`${where}: unknowns names unknown id ${id}`);
    if (!Array.isArray(entry.assertions)) return fail(`${where}: assertions must be an array`);
    entry.assertions.forEach((assertion, position) => {
      const at = `${where}.assertions[${position}]`;
      if (!isPlainObject(assertion)) return fail(`${at} is not an object`);
      claim(assertion.id, at);
      const known = (id) => siteIds.has(id);
      if (assertion.kind === 'before') {
        if (!known(assertion.first) || !known(assertion.then)) fail(`${at}: before needs known first and then sites`);
      } else if (assertion.kind === 'reached-from') {
        if (!known(assertion.site) || !known(assertion.from)) fail(`${at}: reached-from needs known site and from`);
        if (assertion.match !== undefined && !isNonEmptyString(assertion.match)) fail(`${at}: match must be a name`);
      } else if (assertion.kind === 'at-site') {
        if (!Array.isArray(assertion.sites) || assertion.sites.length === 0 || !assertion.sites.every(known)) {
          fail(`${at}: at-site needs a non-empty list of known sites`);
        }
      } else if (assertion.kind === 'not-reached') {
        if (!known(assertion.site)) fail(`${at}: not-reached needs a known site`);
      } else {
        fail(`${at}: kind ${JSON.stringify(assertion.kind)} is not before, reached-from, at-site or not-reached`);
      }
    });
  });
  return problems;
}

/** Problems with one run's extra `trace` arguments; the harness adds `--json` and `--config`. */
export function argProblems(args) {
  if (!Array.isArray(args)) return ['args must be an array'];
  const problems = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      problems.push(`args[${index}] is not a string`);
      continue;
    }
    if (VALUED_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) problems.push(`${arg} needs a positive integer`);
      index += 1;
      continue;
    }
    if (BARE_FLAGS.has(arg)) continue;
    if (SELECTOR_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('-')) {
        problems.push(`${arg} needs a selector`);
      }
      index += 1;
      continue;
    }
    problems.push(`argument ${JSON.stringify(arg)} is not allowed in a run`);
  }
  return problems;
}

/** Read and validate a ledger file; throws `LedgerError` naming every problem. */
export function readLedger(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new LedgerError([`ledger cannot be read (${error.message})`]);
  }
  const problems = ledgerProblems(parsed);
  if (problems.length > 0) throw new LedgerError(problems);
  return parsed;
}

/** Repository roots named by the configuration a ledger points at, keyed by repository id. */
export function ledgerRoots(ledgerFile, ledger) {
  const configFile = resolve(dirname(ledgerFile), ledger.config);
  let config;
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new LedgerError([`configuration ${ledger.config} cannot be read (${error.message})`]);
  }
  if (!isPlainObject(config) || !Array.isArray(config.repos)) throw new LedgerError([`configuration ${ledger.config} has no repos`]);
  const roots = new Map();
  for (const repo of config.repos) {
    if (isPlainObject(repo) && isNonEmptyString(repo.id) && isNonEmptyString(repo.root)) {
      roots.set(repo.id, resolve(dirname(configFile), repo.root));
    }
  }
  return roots;
}

function insideRoot(root, file) {
  const target = resolve(root, file);
  if (!existsSync(target)) return { ok: false, reason: 'does not exist' };
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch (error) {
    return { ok: false, reason: `cannot be resolved (${error.message})` };
  }
  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    return { ok: false, reason: 'resolves outside its repository root' };
  }
  if (!statSync(realTarget).isFile()) return { ok: false, reason: 'is not a file' };
  return { ok: true, path: realTarget };
}

/**
 * Every place where the ledger and its sources disagree: a repository the configuration
 * does not name, a file that is missing or escapes its root, or a line that no longer holds
 * its anchor. A moved line is reported, never silently re-found, because the ledger is the
 * record of what was expected and a correction to it is its own change.
 */
export function anchorProblems(ledgerFile, ledger) {
  const roots = ledgerRoots(ledgerFile, ledger);
  const problems = [];
  const cache = new Map();
  const check = (entry, where) => {
    const root = roots.get(entry.repo);
    if (!root) {
      problems.push(`${where} ${entry.id}: repository ${entry.repo} is not in the configuration`);
      return;
    }
    const found = insideRoot(root, entry.file);
    if (!found.ok) {
      problems.push(`${where} ${entry.id}: ${entry.repo}/${entry.file} ${found.reason}`);
      return;
    }
    if (!cache.has(found.path)) cache.set(found.path, readFileSync(found.path, 'utf8').split(/\r\n|\n|\r/));
    const lines = cache.get(found.path);
    const text = lines[entry.line - 1];
    if (text === undefined) problems.push(`${where} ${entry.id}: line ${entry.line} is past the end of ${entry.repo}/${entry.file}`);
    else if (!text.includes(entry.anchor)) problems.push(`${where} ${entry.id}: line ${entry.line} of ${entry.repo}/${entry.file} does not hold its anchor`);
  };
  for (const site of ledger.sites) check(site, 'site');
  for (const unknown of ledger.unknowns) check(unknown, 'unknown');
  return problems;
}

/** The ledger's pack directory: the directory the ledger file sits in. */
export function packDir(ledgerFile) {
  return dirname(resolve(ledgerFile));
}

