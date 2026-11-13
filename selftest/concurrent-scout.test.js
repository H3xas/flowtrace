/**
 * Concurrent code-index lookups: the query verbs answer their lookups in bounded parallel
 * passes, and the answer does not change.
 *
 * The fixture is `corpus/harbor-signals`. Its stub index answers one chain of lookups
 * (`HarborBridge` to `SignalRelay` to `RelaySink`), so a verb that follows it needs at
 * least three passes; every other lookup answers the indexer's own "no symbol matches"
 * page. `expected/` holds the serial pins, written by the corpus's own `pin.mjs` against
 * the base commit.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { SCOUT_CONCURRENCY_ENV, validateConfig } from '../lib/config.js';
import {
  LOOKUP_MAX_BUFFER, LOOKUP_TIMEOUT_MS, createScout, defaultConcurrency, runLookupAsync,
} from '../lib/scout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'flowtrace.js');
const FIXTURE = join(HERE, 'corpus', 'harbor-signals');
const EXPECTED = join(FIXTURE, 'expected');
const STUB = join(FIXTURE, 'scout', 'scout-stub.mjs');
const CONFIG = 'harbor.scout.config.json';
const TEMP = tmpdir();

// A walk's status identity hashes the fixture's head commit, so every input of that
// commit is fixed: the same tree then gives the same commit on any machine and any day.
const FIXTURE_COMMIT = {
  GIT_AUTHOR_NAME: 'flowtrace selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'flowtrace selftest',
  GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const FIXTURE_GIT = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

const INVOCATIONS = [
  { name: 'check', args: ['check', '--area', 'harbor.area.txt'] },
  { name: 'trace', args: ['trace', 'GET glasshouse/v1/zones/{zoneId}/watchers'] },
  { name: 'trace-area', args: ['trace', '--area', 'harbor.area.txt'] },
  { name: 'span', args: ['span', 'GET glasshouse/v1/zones/{zoneId}/watchers', '--out', 'span/page.html'] },
  { name: 'component-span', args: ['span', '--from-component', 'WatcherNotesPanel', '--out', 'span-panel/page.html'] },
  { name: 'surface', args: ['surface', 'GET glasshouse/v1/zones/{zoneId}/watchers'] },
  { name: 'skeleton', args: ['skeleton', 'GET glasshouse/v1/zones/{zoneId}/watchers', '--stub'] },
  { name: 'cover', args: ['cover', '--area', 'harbor.area.txt', '--packets', 'packets', '--md', 'cover.md'] },
  { name: 'scope', args: ['scope', '--area', 'harbor.area.txt'] },
  { name: 'affected', args: ['affected', '--area', 'harbor.area.txt', '--json'] },
  { name: 'scaffold', args: ['scaffold', '--area', 'harbor.area.txt'] },
  { name: 'cases', args: ['cases', '--area', 'harbor.area.txt'] },
  { name: 'readiness', args: ['readiness', '--areas', 'harbor.areas.txt'] },
];

const scratch = [];
const LOOKUP_LOGS = [];

process.on('exit', () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix) {
  const dir = mkdtempSync(join(TEMP, prefix));
  scratch.push(dir);
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync('git', [...FIXTURE_GIT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...FIXTURE_COMMIT },
  });
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
}

/** One prepared fixture: the corpus, its git baseline, and its facts. */
function prepare({ touch = false } = {}) {
  const dir = makeDir('flowtrace-concurrent-base-');
  cpSync(FIXTURE, dir, { recursive: true, filter: (source) => !source.includes(`${FIXTURE}/expected`) });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  if (touch) {
    const target = join(dir, 'backend', 'src', 'Controllers', 'ZoneWatchersController.cs');
    writeFileSync(target, `${readFileSync(target, 'utf8')}// touched for the diff\n`);
  }
  for (const command of ['extract', 'join']) {
    const run = runCli([command], { cwd: dir });
    assert.equal(run.status, 0, `${command}: ${run.stderr}`);
  }
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.FLOWTRACE_STUB_LOG;
  delete env.FLOWTRACE_SCOUT_CONCURRENCY;
  delete env.FLOWTRACE_STUB_DELAY_MS;
  return { ...env, ...extra };
}

function runCli(args, { cwd, env = {}, nodeArgs = [] } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, CLI, ...args, '--config', CONFIG], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Every regular file under `dir`, relative to it, in sorted order. */
function walk(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'stub.log' || entry.name.endsWith('.log')) continue;
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(path, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function snapshot(dir) {
  const map = new Map();
  for (const rel of walk(dir)) map.set(rel, readFileSync(join(dir, rel)));
  return map;
}

function changedFiles(dir, before) {
  const changed = new Map();
  for (const [rel, body] of snapshot(dir)) {
    const old = before.get(rel);
    if (!old || !old.equals(body)) changed.set(rel, body);
  }
  return changed;
}

function unroot(text, dir) {
  return text.split(dir).join('<ROOT>').split(resolve(dir)).join('<ROOT>');
}

function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function readPin(name, file) {
  return readFileSync(join(EXPECTED, name, file), 'utf8');
}

const PREPARE = { clean: null, diff: null };
function base(touch = false) {
  if (touch && !PREPARE.diff) PREPARE.diff = prepare({ touch: true });
  if (!touch && !PREPARE.clean) PREPARE.clean = prepare();
  return touch ? PREPARE.diff : PREPARE.clean;
}

/** Run one pinned invocation in a fresh copy, and compare the answer with its pin. */
function pinnedRun(invocation, limit) {
  const source = invocation.name === 'affected' ? base(true) : base();
  const dir = makeDir(`flowtrace-concurrent-${invocation.name}-`);
  cpSync(source, dir, { recursive: true });
  const before = snapshot(dir);
  const logPath = join(dir, 'stub.log');
  const run = runCli(invocation.args, {
    cwd: dir,
    env: {
      FLOWTRACE_STUB_LOG: logPath,
      ...(limit === undefined ? {} : { FLOWTRACE_SCOUT_CONCURRENCY: limit }),
    },
  });
  assert.equal(run.status, Number(readPin(invocation.name, 'status').trim()), `${invocation.name} exit status`);
  assert.equal(unroot(run.stdout, dir), readPin(invocation.name, 'stdout'), `${invocation.name} stdout`);
  assert.equal(unroot(run.stderr, dir), readPin(invocation.name, 'stderr'), `${invocation.name} stderr`);
  const changed = changedFiles(dir, before);
  const pinned = new Set();
  const filesDir = join(EXPECTED, invocation.name, 'files');
  for (const rel of existsSync(filesDir) ? walk(filesDir) : []) {
    pinned.add(rel);
    assert.ok(changed.has(rel), `${invocation.name} wrote no ${rel}`);
    assert.equal(unroot(changed.get(rel).toString('utf8'), dir), readFileSync(join(filesDir, rel), 'utf8'), `${invocation.name} file ${rel}`);
  }
  for (const rel of changed.keys()) assert.ok(pinned.has(rel), `${invocation.name} wrote unexpected ${rel}`);
  LOOKUP_LOGS.push({ name: invocation.name, limit: limit ?? 'default', entries: readLog(logPath) });
  return { dir, log: readLog(logPath) };
}

test('Concurrent scout lookups AC-1: every verb prints and writes the serial pin at the default limit and at limit 1', () => {
  for (const invocation of INVOCATIONS) {
    pinnedRun(invocation, undefined);
    pinnedRun(invocation, '1');
  }
  const traced = LOOKUP_LOGS.find((entry) => entry.name === 'trace' && entry.limit === 'default');
  const symbols = traced.entries.map((entry) => entry.args.join(' '));
  for (const expected of ['refs HarborBridge', 'refs SignalRelay', 'refs RelaySink']) {
    assert.ok(symbols.includes(expected), `the trace run asked the index for ${expected}`);
  }
  const lastStart = Math.max(...traced.entries.map((entry) => entry.start));
  assert.ok(traced.entries.some((entry) => entry.end < lastStart), 'a lookup started after another one ended, so at least two passes ran');
});

test('Concurrent scout lookups AC-2: the peak number of processes is bounded by the limit', () => {
  function peak(entries) {
    const events = [];
    for (const entry of entries) {
      events.push({ at: entry.start, delta: 1 });
      events.push({ at: entry.end, delta: -1 });
    }
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let live = 0;
    let high = 0;
    for (const event of events) {
      live += event.delta;
      high = Math.max(high, live);
    }
    return high;
  }

  for (const limit of ['2', '4']) {
    const dir = makeDir('flowtrace-concurrent-peak-');
    cpSync(base(), dir, { recursive: true });
    const logPath = join(dir, 'stub.log');
    const run = runCli(['scope', '--area', 'harbor.area.txt'], {
      cwd: dir,
      env: { FLOWTRACE_STUB_LOG: logPath, FLOWTRACE_STUB_DELAY_MS: '200', FLOWTRACE_SCOUT_CONCURRENCY: limit },
    });
    assert.equal(run.status, 0, run.stderr);
    const measured = peak(readLog(logPath));
    assert.ok(measured >= 2, `limit ${limit}: peak ${measured} should reach 2`);
    assert.ok(measured <= Number(limit), `limit ${limit}: peak ${measured} should stay within the limit`);
  }

  const single = makeDir('flowtrace-concurrent-peak-1-');
  cpSync(base(), single, { recursive: true });
  const singleLog = join(single, 'stub.log');
  const run = runCli(['scope', '--area', 'harbor.area.txt'], {
    cwd: single,
    env: { FLOWTRACE_STUB_LOG: singleLog, FLOWTRACE_STUB_DELAY_MS: '200', FLOWTRACE_SCOUT_CONCURRENCY: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(peak(readLog(singleLog)), 1, 'limit 1 runs one lookup at a time');
});

test('Concurrent scout lookups AC-3: one invocation asks the index for each key at most once', () => {
  assert.ok(LOOKUP_LOGS.length > 0, 'the AC-1 runs recorded their lookup logs');
  for (const run of LOOKUP_LOGS) {
    const seen = new Set();
    for (const entry of run.entries) {
      const key = `${entry.cwd}|${entry.args.join(' ')}`;
      assert.ok(!seen.has(key), `${run.name} at ${run.limit} repeated ${key}`);
      seen.add(key);
    }
  }
});

const REPO = { id: 'api', kind: 'backend', root: '/fixture/backend', scout: true };
const ROOT = REPO.root;

const OUT_TEXT = ['outbound:', '  uses-type (1):', '    Backend/A.cs:4  uses-type  -> Backend/B.cs', ''].join('\n');
const INBOUND_JSON = JSON.stringify({
  status: 'resolved',
  inbound: { 'ctor-di': { total: 1, dropped: 0, rows: [{ file: 'Tests/A.cs', line: 3 }] } },
});
const INBOUND_EMPTY = JSON.stringify({ status: 'resolved', inbound: {} });
const IMPACT_JSON = JSON.stringify({ status: 'resolved', rows: [{ file: 'Tests/A.cs', hop: 1 }], braked: [] });
const IMPACT_EMPTY = JSON.stringify({ status: 'resolved', rows: [], braked: [] });

const CASES = {
  outbound: [
    { name: 'edges', result: { status: 0, stdout: OUT_TEXT } },
    { name: 'ambiguous', result: { status: 1, stdout: 'Ambiguous: two matches\n' } },
    { name: 'exit 3', result: { status: 3, stdout: '' } },
    { name: 'no symbol matches', result: { status: 0, stdout: 'no symbol matches\n' } },
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } },
    { name: 'output above the limit', result: { status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' } } },
    { name: 'exit by signal', result: { status: null, signal: 'SIGTERM', error: null, stdout: '' } },
    { name: 'start throws', throws: true },
  ],
  inbound: [
    { name: 'edges', result: { status: 0, stdout: INBOUND_JSON } },
    { name: 'exit 3 with a payload', result: { status: 3, stdout: INBOUND_EMPTY } },
    { name: 'ambiguous', result: { status: 1, stdout: 'Ambiguous: two matches\n' } },
    { name: 'no symbol matches', result: { status: 0, stdout: 'no symbol matches\n' } },
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } },
    { name: 'exit by signal', result: { status: null, signal: 'SIGTERM', error: null, stdout: '' } },
    { name: 'start throws', throws: true },
  ],
  impact: [
    { name: 'edges', result: { status: 0, stdout: IMPACT_JSON } },
    { name: 'exit 3 with a payload', result: { status: 3, stdout: IMPACT_EMPTY } },
    { name: 'ambiguous', result: { status: 1, stdout: 'not a file\n' } },
    { name: 'no file match', result: { status: 0, stdout: 'no file match\n' } },
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } },
    { name: 'exit by signal', result: { status: null, signal: 'SIGTERM', error: null, stdout: '' } },
    { name: 'start throws', throws: true },
  ],
};

const ARGUMENT = {
  outbound: ['ZoneWatchersController'],
  inbound: ['ZoneWatchersController'],
  impact: ['backend/src/Services/ZoneReadingService.cs', { hops: 3 }],
};

function shape(result) {
  return {
    edges: Array.from(result, (edge) => ({ ...edge })),
    unavailable: Boolean(result && result.unavailable),
    reason: result && result.reason ? result.reason : null,
    counts: result && result.counts ? result.counts : null,
    dropped: result && result.dropped !== undefined ? result.dropped : null,
    braked: result && result.braked ? result.braked : null,
  };
}

async function bothPaths(kind, item) {
  const run = () => {
    if (item.throws) throw new Error('cannot start');
    return item.result;
  };
  const runAsync = async () => run();
  const sync = createScout({ bin: '/bin/scout', outDir: 'out', repos: [REPO], run });
  const passes = createScout({ bin: '/bin/scout', outDir: 'out', repos: [REPO], runAsync });
  const serial = sync[kind](ROOT, ...ARGUMENT[kind]);
  const concurrent = await passes.passes((lookups) => lookups[kind](ROOT, ...ARGUMENT[kind]));
  return [shape(serial), shape(concurrent)];
}

test('Concurrent scout lookups AC-4: every lookup kind keeps the serial edges, mark and reason', async () => {
  for (const [kind, cases] of Object.entries(CASES)) {
    for (const item of cases) {
      const [serial, concurrent] = await bothPaths(kind, item);
      assert.deepEqual(concurrent, serial, `${kind}: ${item.name}`);
    }
  }

  // A path binary that is not on disk never reaches a process, on either path.
  for (const kind of Object.keys(CASES)) {
    const sync = createScout({ bin: '/missing/scout', repos: [REPO], fileExists: () => false });
    const passes = createScout({ bin: '/missing/scout', repos: [REPO], fileExists: () => false });
    const serial = shape(sync[kind](ROOT, ...ARGUMENT[kind]));
    const concurrent = shape(await passes.passes((lookups) => lookups[kind](ROOT, ...ARGUMENT[kind])));
    assert.deepEqual(concurrent, serial, `${kind}: missing binary`);
    assert.equal(serial.reason, 'binary not found');
  }
});

test('Concurrent scout lookups AC-4: the async runner gives the same result as spawnSync', async () => {
  const pair = (args, options) => ({
    sync: spawnSync(process.execPath, [STUB, ...args], { encoding: 'utf8', ...options }),
    async: runLookupAsync(process.execPath, [STUB, ...args], options),
  });
  const code = (result) => (result.error && result.error.code) || null;

  const normal = pair(['refs', 'HarborBridge'], { cwd: FIXTURE, timeout: 30000, maxBuffer: LOOKUP_MAX_BUFFER });
  const normalAsync = await normal.async;
  assert.equal(normalAsync.status, normal.sync.status);
  assert.equal(normalAsync.signal, normal.sync.signal);
  assert.equal(code(normalAsync), code(normal.sync));
  assert.equal(normalAsync.stdout, normal.sync.stdout);

  const signal = pair(['refs', 'AnySymbol__signal'], { cwd: FIXTURE, timeout: 30000, maxBuffer: LOOKUP_MAX_BUFFER });
  const signalAsync = await signal.async;
  assert.equal(signalAsync.status, signal.sync.status);
  assert.equal(signalAsync.signal, signal.sync.signal);
  assert.equal(code(signalAsync), code(signal.sync));

  const flood = pair(['refs', 'AnySymbol__flood'], { cwd: FIXTURE, timeout: 30000, maxBuffer: 1000 });
  const floodAsync = await flood.async;
  assert.equal(floodAsync.status, flood.sync.status);
  assert.equal(code(floodAsync), code(flood.sync));

  const timeout = pair(['refs', 'AnySymbol__timeout'], { cwd: FIXTURE, timeout: 300, maxBuffer: LOOKUP_MAX_BUFFER });
  const timeoutAsync = await timeout.async;
  assert.equal(timeoutAsync.status, timeout.sync.status);
  assert.equal(timeoutAsync.signal, timeout.sync.signal);
  assert.equal(code(timeoutAsync), code(timeout.sync));
  assert.equal(code(timeoutAsync), 'ETIMEDOUT');

  const missing = spawnSync(process.execPath, [join(FIXTURE, 'no-such-script.mjs')], { encoding: 'utf8' });
  const missingAsync = await runLookupAsync(process.execPath, [join(FIXTURE, 'no-such-script.mjs')], { cwd: FIXTURE });
  assert.equal(missingAsync.status, missing.status);
  assert.equal(code(missingAsync), code(missing));
});

test('Concurrent scout lookups AC-4: the default timeout and output limit are the documented constants', () => {
  assert.equal(LOOKUP_TIMEOUT_MS, 30000);
  assert.equal(LOOKUP_MAX_BUFFER, 32 * 1024 * 1024);
});

const RECORDER = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.FLOWTRACE_IO_LOG;
const emit = (event) => {
  if (log) fs.appendFileSync(log, JSON.stringify({ ...event, at: Date.now() }) + '\\n');
};
const write = fs.writeFileSync;
fs.writeFileSync = function (target, ...rest) {
  if (String(target) !== log) emit({ kind: 'file', path: String(target) });
  return write.call(this, target, ...rest);
};
const out = process.stdout.write.bind(process.stdout);
const err = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { emit({ kind: 'stdout' }); return out(chunk, ...rest); };
process.stderr.write = (chunk, ...rest) => { emit({ kind: 'stderr' }); return err(chunk, ...rest); };
syncBuiltinESMExports();
`;

test('Concurrent scout lookups AC-5: a verb writes each file once, after the last pass', () => {
  const recorder = join(makeDir('flowtrace-concurrent-recorder-'), 'recorder.mjs');
  writeFileSync(recorder, RECORDER);
  const observed = [
    { name: 'cases', args: ['cases', '--area', 'harbor.area.txt'] },
    { name: 'scaffold', args: ['scaffold', '--area', 'harbor.area.txt'] },
    { name: 'cover --packets', args: ['cover', '--area', 'harbor.area.txt', '--packets', 'packets'] },
    { name: 'span page', args: ['span', 'GET glasshouse/v1/zones/{zoneId}/watchers', '--out', 'span/page.html'] },
  ];
  for (const invocation of observed) {
    const dir = makeDir(`flowtrace-concurrent-io-${invocation.name.split(' ')[0]}-`);
    cpSync(base(), dir, { recursive: true });
    const ioLog = join(dir, 'io.jsonl');
    const stubLog = join(dir, 'stub.log');
    const run = runCli(invocation.args, {
      cwd: dir,
      nodeArgs: ['--import', pathToFileURL(recorder).href],
      env: { FLOWTRACE_IO_LOG: ioLog, FLOWTRACE_STUB_LOG: stubLog },
    });
    assert.equal(run.status, 0, `${invocation.name}: ${run.stderr}`);
    const events = readFileSync(ioLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const lookups = readLog(stubLog);
    assert.ok(lookups.length >= 2, `${invocation.name} reached the index`);

    const written = events.filter((event) => event.kind === 'file').map((event) => event.path);
    const counts = new Map();
    for (const path of written) counts.set(path, (counts.get(path) || 0) + 1);
    for (const [path, count] of counts) assert.equal(count, 1, `${invocation.name} wrote ${path} ${count} times`);

    const first = Math.min(...lookups.map((entry) => entry.start));
    const last = Math.max(...lookups.map((entry) => entry.end));
    const during = events.filter((event) => event.at > first && event.at < last);
    assert.deepEqual(during, [], `${invocation.name} wrote or printed between the first and last lookup`);

    const starts = lookups.map((entry) => entry.start).sort((a, b) => a - b);
    const lateStarts = lookups.filter((entry) => entry.start > starts[0]);
    assert.ok(
      lateStarts.some((entry) => lookups.some((other) => other !== entry && other.end < entry.start)),
      `${invocation.name} ran at least two passes`,
    );
  }
});

const RAW = {
  out: 'out',
  repos: [{ id: 'api', kind: 'backend', root: '.' }],
};
const NO_BIN = { ...RAW, scout: { bin: '/bin/scout' } };

function requiredParallelism() {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("node:os").availableParallelism()))'], {
    encoding: 'utf8',
  }).stdout;
}

test('Concurrent scout lookups AC-6: the file wins over the variable, and the default is bounded', () => {
  const load = (raw, env) => validateConfig(raw, { baseDir: '/fixture', file: 'harbor.json', env });
  assert.equal(load({ ...RAW, scout: { bin: '/bin/scout', concurrency: 3 } }, { [SCOUT_CONCURRENCY_ENV]: '5' }).scout.concurrency, 3);
  assert.equal(load(NO_BIN, { [SCOUT_CONCURRENCY_ENV]: ' 5 ' }).scout.concurrency, 5);
  assert.equal(load(NO_BIN, { [SCOUT_CONCURRENCY_ENV]: '   ' }).scout.concurrency, defaultConcurrency());
  assert.equal(load(NO_BIN, {}).scout.concurrency, defaultConcurrency());
  assert.equal(defaultConcurrency(), Math.min(8, Number(requiredParallelism())));
  const envOnly = load(RAW, { FLOWTRACE_SCOUT_BIN: 'scout-bin', [SCOUT_CONCURRENCY_ENV]: '2' });
  assert.equal(envOnly.scout.concurrency, 2);
});

test('Concurrent scout lookups AC-7: a malformed limit fails the load and starts no process', () => {
  const load = (raw, env = {}) => validateConfig(raw, { baseDir: '/fixture', file: 'harbor.json', env });
  for (const value of [0, -1, 1.5, '4', true, null, [], 2 ** 53]) {
    assert.throws(() => load({ ...RAW, scout: { bin: '/bin/scout', concurrency: value } }), /scout\.concurrency/, JSON.stringify(value));
  }
  for (const value of ['0', 'abc', '1.5', '-2', '+3', '4x', '9007199254740993']) {
    assert.throws(() => load(NO_BIN, { [SCOUT_CONCURRENCY_ENV]: value }), new RegExp(SCOUT_CONCURRENCY_ENV), value);
  }

  for (const [label, env, expected] of [
    ['file', {}, 'scout.concurrency'],
    ['variable', { [SCOUT_CONCURRENCY_ENV]: 'abc' }, SCOUT_CONCURRENCY_ENV],
  ]) {
    const dir = makeDir('flowtrace-concurrent-refuse-');
    cpSync(base(), dir, { recursive: true });
    const configPath = join(dir, 'refused.config.json');
    if (label === 'file') {
      const raw = JSON.parse(readFileSync(join(dir, CONFIG), 'utf8'));
      raw.scout.concurrency = 0;
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    } else {
      cpSync(join(dir, CONFIG), configPath);
    }
    const stubLog = join(dir, 'stub.log');
    const result = spawnSync(process.execPath, [CLI, 'scope', '--area', 'harbor.area.txt', '--config', configPath], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv({ FLOWTRACE_STUB_LOG: stubLog, ...env }),
    });
    assert.equal(result.status, 2, `${label}: exit status ${result.stderr}`);
    const firstLine = (result.stderr || '').split('\n')[0];
    assert.ok(firstLine.includes(expected), `${label}: "${firstLine}" names ${expected}`);
    assert.equal(existsSync(stubLog), false, `${label}: no lookup process started`);
  }
});

test('Concurrent scout lookups AC-8: both documents state the key, the variable, the winner and the default', () => {
  for (const file of ['docs/configuration.md', 'docs/scout.md']) {
    const text = readFileSync(join(HERE, '..', file), 'utf8');
    assert.match(text, /scout\.concurrency/, `${file} names the key`);
    assert.match(text, /FLOWTRACE_SCOUT_CONCURRENCY/, `${file} names the variable`);
  }
  const scoutDoc = readFileSync(join(HERE, '..', 'docs', 'scout.md'), 'utf8');
  assert.match(scoutDoc, /file value wins/i, 'the document says which input wins');
  assert.match(scoutDoc, /min\(8, os\.availableParallelism\(\)\)/, 'the document states the default');
  assert.match(scoutDoc, /one lookup at a time/i, 'the document states what a limit of 1 does');
});
