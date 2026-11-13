/**
 * Concurrent code-index lookups: the query verbs answer their lookups in bounded parallel
 * passes, and the answer does not change.
 *
 * The fixture is `corpus/harbor-signals`. Its stub index answers one chain of outbound
 * lookups (`HarborBridge` to `SignalRelay` to `RelaySink`), which the backend route reaches
 * from the web app and from the mobile app, so a verb that follows it needs at least three
 * passes. A changed controller widens through `impact` to `WatcherService`, and only the
 * inbound answer for that class selects a test class. Every other lookup answers the
 * indexer's own "no symbol matches" page. `expected/` holds the serial pins, written by the
 * corpus's own `pin.mjs` against the base commit, and `pinned.mjs` holds what both read.
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
import {
  ARGUMENT, BARE_BIN, BARE_REPO, BIN, CASES, CHAINS, CONFIG, INVOCATIONS, REPO, ROOT,
  bareSerial, caseRunner, missingSerial, serialCase, shape,
} from './corpus/harbor-signals/pinned.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'flowtrace.js');
const FIXTURE = join(HERE, 'corpus', 'harbor-signals');
const EXPECTED = join(FIXTURE, 'expected');
const STUB = join(FIXTURE, 'scout', 'scout-stub.mjs');
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
  const source = invocation.touch ? base(true) : base();
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
  for (const run of LOOKUP_LOGS) {
    const invocation = INVOCATIONS.find((entry) => entry.name === run.name);
    for (const chain of invocation.chains) {
      const links = CHAINS[chain].map((lookup) => {
        const entry = run.entries.find((logged) => logged.args.join(' ') === lookup);
        assert.ok(entry, `${run.name} at ${run.limit} asked the index for ${lookup}`);
        return entry;
      });
      for (let at = 1; at < links.length; at += 1) {
        assert.ok(
          links[at].start >= links[at - 1].end,
          `${run.name} at ${run.limit} asked for ${CHAINS[chain][at]} only after ${CHAINS[chain][at - 1]} answered`,
        );
      }
    }
  }
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

const LOOKUPS = JSON.parse(readFileSync(join(EXPECTED, 'lookups.json'), 'utf8'));

/** One case through the shared path: the lookup is asked in a pass and answered by `runAsync`. */
async function passesCase(kind, item, { fileExists = () => true } = {}) {
  const runner = caseRunner(item);
  const scout = createScout({ bin: BIN, outDir: 'out', repos: [REPO], runAsync: runner.runAsync, fileExists });
  const result = await scout.passes((lookups) => lookups[kind](ROOT, ...ARGUMENT[kind]));
  return { ...shape(result), calls: runner.calls };
}

test('Concurrent scout lookups AC-4: every lookup kind keeps the base serial edges, mark and reason', async () => {
  for (const [kind, cases] of Object.entries(CASES)) {
    for (const item of cases) {
      const pinned = LOOKUPS.cases[kind][item.name];
      assert.ok(pinned, `${kind}: ${item.name} has a base pin`);
      assert.equal(pinned.calls.length, 1, `${kind}: ${item.name}: the base path started one process`);
      assert.deepEqual(serialCase(createScout, kind, item), pinned, `${kind}: ${item.name}: serial path`);
      assert.deepEqual(await passesCase(kind, item), pinned, `${kind}: ${item.name}: shared path`);
    }
    const answers = Object.values(LOOKUPS.cases[kind]);
    assert.ok(answers.some((answer) => answer.edges.length > 0 && !answer.unavailable), `${kind}: a case answers edges`);
    const reasons = new Set(answers.map((answer) => answer.reason));
    for (const reason of ['indexer exited with an error', 'indexer could not be started']) {
      assert.ok(reasons.has(reason), `${kind}: a case answers "${reason}"`);
    }
    assert.ok(reasons.has(kind === 'impact' ? 'no file match' : 'no symbol matches'), `${kind}: a case answers no match`);
  }

  // A path binary that is not on disk never reaches a process, on either path.
  for (const kind of Object.keys(CASES)) {
    const pinned = LOOKUPS.missing[kind];
    assert.equal(pinned.reason, 'binary not found');
    assert.deepEqual(pinned.calls, []);
    assert.deepEqual(missingSerial(createScout, kind), pinned, `${kind}: missing binary, serial path`);
    assert.deepEqual(await passesCase(kind, CASES[kind][0], { fileExists: () => false }), pinned, `${kind}: missing binary, shared path`);
  }

  // A bare name is looked up on `PATH` only when the process starts, so the real runners
  // meet the missing binary and must report it the same way.
  for (const kind of Object.keys(CASES)) {
    const pinned = LOOKUPS.bare[kind];
    assert.equal(pinned.unavailable, true, `${kind}: the base marks a binary on no PATH unavailable`);
    assert.deepEqual(bareSerial(createScout, kind), pinned, `${kind}: bare binary, serial path`);
    const scout = createScout({ bin: BARE_BIN, outDir: 'out', repos: [BARE_REPO] });
    const shared = shape(await scout.passes((lookups) => lookups[kind](BARE_REPO.root, ...ARGUMENT[kind])));
    assert.deepEqual(shared, pinned, `${kind}: bare binary, shared path`);
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
  assert.equal(floodAsync.signal, flood.sync.signal);
  assert.equal(code(floodAsync), code(flood.sync));
  assert.equal(code(floodAsync), 'ENOBUFS');

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
