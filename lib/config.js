/**
 * Configuration loading and validation.
 *
 * Repository locations live only in `flowtrace.config.json`, which names machine-local
 * checkouts and is therefore meant to stay untracked. Every path in the file is resolved
 * relative to the file itself. Optional `aliases` carry caller-side route-prefix rewrites
 * the join step applies when a call finds no route; optional `scout.bin` and
 * per-repository `scout: true` enable the trace step's graph hops; optional `sinks.db`
 * overrides the file patterns that make a class a data sink; optional `caseId.calls`
 * names the call sites the Playwright extractor reads test-management case ids from;
 * optional `workerPatterns` supplies the backend extractor with a worker-queue
 * framework's own registration, publish, consumer-base, topology-binding, queue-prefix
 * and config-read patterns, since only public idioms are built in.
 *
 * `FLOWTRACE_SCOUT_BIN` in the environment supplies `scout.bin` when the file omits it,
 * so a shared configuration file never has to carry one machine's install path. A value
 * with no path separator is looked up on `PATH`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const CONFIG_FILENAME = 'flowtrace.config.json';
export const REPO_KINDS = Object.freeze(['backend', 'mobile', 'contracts', 'playwright', 'web']);
export const REPO_ROLES = Object.freeze(['api', 'worker', 'contracts']);
/** Source subdirectory a `web` repository's extractor walks, relative to its root. */
export const DEFAULT_SRC_SUBPATH = 'src';
export const DEFAULT_DB_SINKS = Object.freeze(['/DataAccess/', 'Repository', 'ResourceService']);
export const DEFAULT_WRITE_PREFIXES = Object.freeze([
  'Insert', 'Update', 'Upsert', 'Set', 'Delete', 'Remove', 'Save', 'Clear',
  'Add', 'Create', 'Archive', 'Mark', 'Increment', 'Decrement', 'Push', 'Replace', 'Write',
]);
export const DEFAULT_READ_PREFIXES = Object.freeze([
  'Get', 'Find', 'Fetch', 'Load', 'Read', 'Exists', 'Count',
  'List', 'Query', 'Search', 'Any', 'Has', 'Is',
]);

/** Environment variable that supplies `scout.bin` when the configuration file omits it. */
export const SCOUT_BIN_ENV = 'FLOWTRACE_SCOUT_BIN';

/**
 * The `workerPatterns` fields the backend extractor understands. Every field is an
 * array of regex-source strings; `docs/configuration.md` describes what each one
 * matches and which capture groups the whole-regex fields must expose.
 */
export const WORKER_PATTERN_FIELDS = Object.freeze([
  'registrations', 'topologyBindings', 'queuePrefixConstants',
  'publishCalls', 'consumerBases', 'broadcastCalls', 'configReads',
]);
export const MOBILE_CYPRESS_FIELDS = Object.freeze(['e2e', 'support']);
const SCAFFOLD_FIELDS = Object.freeze([
  'specRoot', 'specSuffix', 'workerRoot', 'importAliases', 'roles', 'contextFactory',
  'caseIdPlaceholder', 'worker', 'clientClassTemplate', 'unresolvedRejectStatus', 'okStatus',
]);
const SCAFFOLD_STRING_FIELDS = Object.freeze([
  'specRoot', 'specSuffix', 'workerRoot', 'caseIdPlaceholder', 'clientClassTemplate',
]);
const SCAFFOLD_IMPORT_ALIAS_FIELDS = Object.freeze(['fixtures', 'utils', 'features', 'generated']);
const SCAFFOLD_ROLE_FIELDS = Object.freeze(['default', 'denied', 'member']);
const SCAFFOLD_CONTEXT_STRING_FIELDS = Object.freeze([
  'store', 'instanceVariable', 'method', 'as', 'api', 'variable',
]);
const SCAFFOLD_CONTEXT_FIELDS = Object.freeze([
  ...SCAFFOLD_CONTEXT_STRING_FIELDS, 'instance', 'fixtures',
]);
const SCAFFOLD_WORKER_FIELDS = Object.freeze(['module', 'client', 'method', 'builder']);

/**
 * A binary reference is either a path — resolved against the configuration file's own
 * directory so a relative one means the same thing from any working directory — or a bare
 * command name, which is left alone for a `PATH` lookup at spawn time.
 */
function resolveBinValue(value, baseDir) {
  return value.includes('/') || value.includes('\\') ? resolve(baseDir, value) : value;
}

function fail(file, message) {
  throw new Error(`config ${file}: ${message}`);
}

function requireString(value, field, file) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(file, `"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireObject(value, field, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(file, `"${field}" must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, field, allowed, file) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(file, `"${field}.${key}" is not a recognised field (expected one of ${allowed.join(', ')})`);
    }
  }
}

function validateStringFields(value, field, file) {
  const validated = {};
  for (const key of Object.keys(value)) {
    validated[key] = requireString(value[key], `${field}.${key}`, file);
  }
  return validated;
}

function validateScaffold(value, file) {
  if (value === undefined) return {};
  const raw = requireObject(value, 'scaffold', file);
  rejectUnknownFields(raw, 'scaffold', SCAFFOLD_FIELDS, file);
  const scaffold = {};

  for (const field of SCAFFOLD_STRING_FIELDS) {
    if (raw[field] !== undefined) scaffold[field] = requireString(raw[field], `scaffold.${field}`, file);
  }

  if (raw.importAliases !== undefined) {
    const aliases = requireObject(raw.importAliases, 'scaffold.importAliases', file);
    rejectUnknownFields(aliases, 'scaffold.importAliases', SCAFFOLD_IMPORT_ALIAS_FIELDS, file);
    scaffold.importAliases = validateStringFields(aliases, 'scaffold.importAliases', file);
  }

  if (raw.roles !== undefined) {
    const roles = requireObject(raw.roles, 'scaffold.roles', file);
    rejectUnknownFields(roles, 'scaffold.roles', SCAFFOLD_ROLE_FIELDS, file);
    scaffold.roles = validateStringFields(roles, 'scaffold.roles', file);
  }

  if (raw.contextFactory !== undefined) {
    const factory = requireObject(raw.contextFactory, 'scaffold.contextFactory', file);
    rejectUnknownFields(factory, 'scaffold.contextFactory', SCAFFOLD_CONTEXT_FIELDS, file);
    const validated = {};
    for (const field of SCAFFOLD_CONTEXT_STRING_FIELDS) {
      if (factory[field] !== undefined) {
        validated[field] = requireString(factory[field], `scaffold.contextFactory.${field}`, file);
      }
    }
    if (factory.instance !== undefined) {
      if (typeof factory.instance !== 'boolean') {
        fail(file, '"scaffold.contextFactory.instance" must be true or false');
      }
      validated.instance = factory.instance;
    }
    if (factory.fixtures !== undefined) {
      if (!Array.isArray(factory.fixtures) || factory.fixtures.some((entry) => typeof entry !== 'string')) {
        fail(file, '"scaffold.contextFactory.fixtures" must be an array of strings');
      }
      validated.fixtures = factory.fixtures.slice();
    }
    scaffold.contextFactory = validated;
  }

  if (raw.worker !== undefined) {
    const worker = requireObject(raw.worker, 'scaffold.worker', file);
    rejectUnknownFields(worker, 'scaffold.worker', SCAFFOLD_WORKER_FIELDS, file);
    scaffold.worker = validateStringFields(worker, 'scaffold.worker', file);
  }

  if (raw.unresolvedRejectStatus !== undefined) {
    if (
      !Array.isArray(raw.unresolvedRejectStatus) ||
      raw.unresolvedRejectStatus.some((status) => typeof status !== 'number' || !Number.isFinite(status))
    ) {
      fail(file, '"scaffold.unresolvedRejectStatus" must be an array of numbers');
    }
    scaffold.unresolvedRejectStatus = raw.unresolvedRejectStatus.slice();
  }
  if (raw.okStatus !== undefined) {
    if (typeof raw.okStatus !== 'number' || !Number.isFinite(raw.okStatus)) {
      fail(file, '"scaffold.okStatus" must be a number');
    }
    scaffold.okStatus = raw.okStatus;
  }
  return scaffold;
}

/** Resolve the configuration file path, honouring an explicit `--config` value. */
export function resolveConfigPath(explicitPath, cwd = process.cwd()) {
  const candidate = explicitPath
    ? resolve(cwd, explicitPath)
    : resolve(cwd, CONFIG_FILENAME);
  if (!existsSync(candidate)) {
    throw new Error(
      `config: no configuration file at ${candidate} — copy ${CONFIG_FILENAME.replace('.json', '.example.json')} and edit the roots, or pass --config <path>`,
    );
  }
  return candidate;
}

/** Validate a parsed configuration object and resolve its paths against `baseDir`. */
export function validateConfig(raw, { baseDir = process.cwd(), file = CONFIG_FILENAME, env = process.env } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(file, 'the top level must be an object');
  }
  const out = requireString(raw.out, 'out', file);
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail(file, '"repos" must be a non-empty array');
  }
  let aliases = [];
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases)) fail(file, '"aliases" must be an array');
    aliases = raw.aliases.map((entry, index) => {
      const at = `aliases[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(file, `"${at}" must be an object with "from" and "to"`);
      }
      return {
        from: requireString(entry.from, `${at}.from`, file),
        to: requireString(entry.to, `${at}.to`, file),
      };
    });
  }
  let scout = null;
  if (raw.scout !== undefined) {
    if (!raw.scout || typeof raw.scout !== 'object' || Array.isArray(raw.scout)) {
      fail(file, '"scout" must be an object with "bin"');
    }
    scout = { bin: resolveBinValue(requireString(raw.scout.bin, 'scout.bin', file), baseDir) };
  } else if (typeof env[SCOUT_BIN_ENV] === 'string' && env[SCOUT_BIN_ENV].trim() !== '') {
    scout = { bin: resolveBinValue(env[SCOUT_BIN_ENV].trim(), baseDir) };
  }

  const sinks = {
    db: [...DEFAULT_DB_SINKS],
    writePrefixes: [...DEFAULT_WRITE_PREFIXES],
    readPrefixes: [...DEFAULT_READ_PREFIXES],
  };
  if (raw.sinks !== undefined) {
    if (!raw.sinks || typeof raw.sinks !== 'object' || Array.isArray(raw.sinks)) {
      fail(file, '"sinks" must be an object');
    }
    for (const field of ['db', 'writePrefixes', 'readPrefixes']) {
      if (raw.sinks[field] === undefined) continue;
      if (!Array.isArray(raw.sinks[field]) || raw.sinks[field].some((value) => typeof value !== 'string')) {
        fail(file, `"sinks.${field}" must be an array of strings`);
      }
      sinks[field] = raw.sinks[field].slice();
    }
  }

  const caseId = { calls: [] };
  if (raw.caseId !== undefined) {
    if (!raw.caseId || typeof raw.caseId !== 'object' || Array.isArray(raw.caseId)) {
      fail(file, '"caseId" must be an object');
    }
    if (raw.caseId.calls !== undefined) {
      if (
        !Array.isArray(raw.caseId.calls) ||
        raw.caseId.calls.some((value) => typeof value !== 'string' || value.trim() === '')
      ) {
        fail(file, '"caseId.calls" must be an array of non-empty strings');
      }
      caseId.calls = raw.caseId.calls.map((value) => value.trim());
    }
  }

  const scaffold = validateScaffold(raw.scaffold, file);

  const workerPatterns = Object.fromEntries(WORKER_PATTERN_FIELDS.map((field) => [field, []]));
  if (raw.workerPatterns !== undefined) {
    if (!raw.workerPatterns || typeof raw.workerPatterns !== 'object' || Array.isArray(raw.workerPatterns)) {
      fail(file, `"workerPatterns" must be an object with any of: ${WORKER_PATTERN_FIELDS.join(', ')}`);
    }
    for (const field of Object.keys(raw.workerPatterns)) {
      if (!WORKER_PATTERN_FIELDS.includes(field)) {
        fail(file, `"workerPatterns.${field}" is not a recognised field (expected one of ${WORKER_PATTERN_FIELDS.join(', ')})`);
      }
      const values = raw.workerPatterns[field];
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
        fail(file, `"workerPatterns.${field}" must be an array of non-empty strings`);
      }
      workerPatterns[field] = values.map((value) => {
        const source = value.trim();
        try {
          new RegExp(source);
        } catch (error) {
          fail(file, `"workerPatterns.${field}" entry ${JSON.stringify(source)} is not a valid regular expression (${error.message})`);
        }
        return source;
      });
    }
  }

  const seen = new Set();
  const repos = raw.repos.map((entry, index) => {
    const at = `repos[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(file, `"${at}" must be an object`);
    }
    const id = requireString(entry.id, `${at}.id`, file);
    if (seen.has(id)) fail(file, `"${at}.id" duplicates an earlier repo id "${id}"`);
    seen.add(id);
    const kind = requireString(entry.kind, `${at}.kind`, file);
    if (!REPO_KINDS.includes(kind)) {
      fail(file, `"${at}.kind" must be one of ${REPO_KINDS.join(', ')} (got "${kind}")`);
    }
    const root = requireString(entry.root, `${at}.root`, file);
    let exclude = [];
    if (entry.exclude !== undefined) {
      if (!Array.isArray(entry.exclude) || entry.exclude.some((value) => typeof value !== 'string')) {
        fail(file, `"${at}.exclude" must be an array of strings`);
      }
      exclude = entry.exclude.slice();
    }
    if (entry.scout !== undefined && typeof entry.scout !== 'boolean') {
      fail(file, `"${at}.scout" must be true or false`);
    }
    let role = [];
    if (entry.role !== undefined) {
      if (!Array.isArray(entry.role) || entry.role.some((value) => typeof value !== 'string')) {
        fail(file, `"${at}.role" must be an array of strings`);
      }
      const unknown = entry.role.find((value) => !REPO_ROLES.includes(value));
      if (unknown !== undefined) {
        fail(file, `"${at}.role" must contain only ${REPO_ROLES.join(', ')} (got "${unknown}")`);
      }
      role = entry.role.slice();
    }
    let srcSubpath = DEFAULT_SRC_SUBPATH;
    if (entry.srcSubpath !== undefined) {
      srcSubpath = requireString(entry.srcSubpath, `${at}.srcSubpath`, file);
    }
    let cypressSubpath = '';
    if (entry.cypressSubpath !== undefined) {
      cypressSubpath = requireString(entry.cypressSubpath, `${at}.cypressSubpath`, file);
    }
    let featureRoots = [];
    if (entry.featureRoots !== undefined) {
      if (!Array.isArray(entry.featureRoots) || entry.featureRoots.some((value) => typeof value !== 'string')) {
        fail(file, `"${at}.featureRoots" must be an array of strings`);
      }
      featureRoots = entry.featureRoots.slice();
    }
    let cypress = null;
    if (entry.cypress !== undefined) {
      if (!entry.cypress || typeof entry.cypress !== 'object' || Array.isArray(entry.cypress)) {
        fail(file, `"${at}.cypress" must be an object`);
      }
      cypress = {};
      for (const field of Object.keys(entry.cypress)) {
        if (!MOBILE_CYPRESS_FIELDS.includes(field)) {
          fail(file, `"${at}.cypress.${field}" is not a recognised field (expected one of ${MOBILE_CYPRESS_FIELDS.join(', ')})`);
        }
        cypress[field] = requireString(entry.cypress[field], `${at}.cypress.${field}`, file);
      }
    }
    return {
      id, kind, root: resolve(baseDir, root), exclude, scout: entry.scout === true, role, featureRoots,
      srcSubpath, cypressSubpath, cypress,
    };
  });
  return { file, out: resolve(baseDir, out), repos, aliases, scout, sinks, caseId, workerPatterns, scaffold };
}

/** Read, parse and validate the configuration file. */
export function loadConfig({ configPath, cwd = process.cwd(), env = process.env } = {}) {
  const file = resolveConfigPath(configPath, cwd);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`config ${file}: not valid JSON (${error.message})`);
  }
  return validateConfig(raw, { baseDir: dirname(file), file, env });
}
