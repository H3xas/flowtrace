/**
 * Concurrent code-index lookups: the query verbs answer their lookups in bounded parallel
 * passes, and the answer does not change.
 *
 * The fixture is `corpus/buoy-signals`. Its stub index answers one chain of outbound
 * lookups (`HarborBridge` to `SignalRelay` to `RelaySink` to `RelayGate`), which the
 * backend route reaches from the web app and from the mobile app, so a verb that follows it
 * needs at least four passes. Only the last two answers reach the `RelayGate` gate and the
 * repository behind it, so a walk kept from an early pass shows neither. A changed controller widens through `impact` to `WatcherService`, and only the
 * inbound answer for that class selects a test class. Every other lookup answers the
 * indexer's own "no symbol matches" page. `expected/` holds the serial pins, written by the
 * corpus's own `pin.mjs` against the base commit, and `pinned.mjs` holds what both read.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { SCOUT_CONCURRENCY_ENV, validateConfig } from '../lib/config.js';
import {
  LOOKUP_MAX_BUFFER, LOOKUP_TIMEOUT_MS, createScout, defaultConcurrency, runLookupAsync,
} from '../lib/scout.js';
import {
  ARGUMENT, BARE_BIN, BARE_REPO, BIN, CASES, CHAINS, CONFIG, INVOCATIONS, REPO, ROOT,
  bareSerial, caseRunner, missingSerial, serialCase, shape,
} from './corpus/buoy-signals/pinned.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'flowtrace.js');
const FIXTURE = join(HERE, 'corpus', 'buoy-signals');
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

/** Every regular file under `dir`, relative to it, in sorted order; logs and `.git` are no answer. */
function walkFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name.endsWith('.log')) continue;
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(path, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function readFiles(dir) {
  const map = new Map();
  for (const rel of walkFiles(dir)) map.set(rel, readFileSync(join(dir, rel)));
  return map;
}

/**
 * What a run did to its directory: each file it created or changed, and each file it
 * deleted, which `pin.mjs` records in a `removed` pin with one path per line. A rename is
 * both.
 */
function fileDelta(before, after) {
  const changed = new Map();
  for (const [rel, body] of after) {
    const old = before.get(rel);
    if (!old || !old.equals(body)) changed.set(rel, body);
  }
  const removed = [...before.keys()].filter((rel) => !after.has(rel)).sort();
  return { changed, removed };
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

/**
 * The files a run created, changed and deleted, against the pin of `name`: every pinned
 * file with its pinned body, no other created or changed file, and exactly the pinned
 * deletions.
 */
function assertPinnedFiles(name, dir, before, expected = EXPECTED) {
  const { changed, removed } = fileDelta(before, readFiles(dir));
  const filesDir = join(expected, name, 'files');
  const pinned = existsSync(filesDir) ? readFiles(filesDir) : new Map();
  for (const [rel, body] of pinned) {
    assert.ok(changed.has(rel), `${name} wrote no ${rel}`);
    assert.equal(unroot(changed.get(rel).toString('utf8'), dir), body.toString('utf8'), `${name} file ${rel}`);
  }
  for (const rel of changed.keys()) assert.ok(pinned.has(rel), `${name} wrote unexpected ${rel}`);
  const removedPin = join(expected, name, 'removed');
  const pinnedRemoved = existsSync(removedPin) ? readFileSync(removedPin, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepEqual(removed, pinnedRemoved, `${name} deleted files`);
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
  const before = readFiles(dir);
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
  assertPinnedFiles(invocation.name, dir, before);
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

test('Concurrent scout lookups AC-1: the file comparison sees a deleted file and a renamed file', () => {
  const run = makeDir('flowtrace-concurrent-delta-run-');
  const expected = makeDir('flowtrace-concurrent-delta-pins-');
  const reset = () => {
    rmSync(run, { recursive: true, force: true });
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'kept.txt'), 'kept\n');
    writeFileSync(join(run, 'gone.txt'), 'gone\n');
    return readFiles(run);
  };
  const pin = (name, files, removed) => {
    mkdirSync(join(expected, name, 'files'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(expected, name, 'files', rel), body);
    if (removed) writeFileSync(join(expected, name, 'removed'), removed);
  };
  pin('untouched', {});
  pin('deletes', {}, 'gone.txt\n');
  pin('renames', { 'moved.txt': 'gone\n' }, 'gone.txt\n');
  pin('renames-unpinned', { 'moved.txt': 'gone\n' });

  let before = reset();
  rmSync(join(run, 'gone.txt'));
  assert.throws(() => assertPinnedFiles('untouched', run, before, expected), /untouched deleted files/);
  assertPinnedFiles('deletes', run, before, expected);

  before = reset();
  cpSync(join(run, 'gone.txt'), join(run, 'moved.txt'));
  rmSync(join(run, 'gone.txt'));
  assert.throws(() => assertPinnedFiles('renames-unpinned', run, before, expected), /renames-unpinned deleted files/);
  assert.throws(() => assertPinnedFiles('deletes', run, before, expected), /deletes wrote unexpected moved\.txt/);
  assertPinnedFiles('renames', run, before, expected);

  before = reset();
  assert.throws(() => assertPinnedFiles('deletes', run, before, expected), /deletes deleted files/);
  assertPinnedFiles('untouched', run, before, expected);
});

test('Concurrent scout lookups AC-1: git ignores no pinned file, so a clean checkout holds every pin', (t) => {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: EXPECTED, encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    t.skip('not a git checkout');
    return;
  }
  const pins = walkFiles(EXPECTED);
  assert.ok(pins.some((rel) => rel.includes('/files/out/')), 'the pins hold files a verb writes under out/');
  const ignored = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: EXPECTED, encoding: 'utf8', input: `${pins.join('\n')}\n`,
  });
  assert.equal(ignored.status, 1, `git ignores these pins: ${ignored.stdout}${ignored.stderr}`);
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

// A preload that writes as many bytes on stderr as the index writes on stdout. Each stream
// then holds exactly a limit equal to the answer's length, and the two together pass it.
const ECHO = `
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  process.stderr.write('e'.repeat(Buffer.byteLength(chunk)));
  return write(chunk, ...rest);
};
`;
let echoFile = null;
function echoPreload() {
  if (!echoFile) {
    echoFile = join(makeDir('flowtrace-concurrent-echo-'), 'echo.mjs');
    writeFileSync(echoFile, ECHO);
  }
  return pathToFileURL(echoFile).href;
}

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

  // Both streams count against one limit, as spawnSync counts them: here each stream holds
  // exactly the limit, which alone is allowed, and the two together pass it.
  const answerBytes = Buffer.byteLength(normal.sync.stdout);
  const atLimit = pair(['refs', 'HarborBridge'], { cwd: FIXTURE, timeout: 30000, maxBuffer: answerBytes });
  const atLimitAsync = await atLimit.async;
  assert.equal(code(atLimit.sync), null, 'one stream at the limit is allowed');
  assert.equal(code(atLimitAsync), null);
  assert.equal(atLimitAsync.stdout, atLimit.sync.stdout);
  const echoArgs = ['--import', echoPreload(), STUB, 'refs', 'HarborBridge'];
  const split = {
    sync: spawnSync(process.execPath, echoArgs, { cwd: FIXTURE, encoding: 'utf8', timeout: 30000, maxBuffer: answerBytes }),
    async: runLookupAsync(process.execPath, echoArgs, { cwd: FIXTURE, timeout: 30000, maxBuffer: answerBytes }),
  };
  const splitAsync = await split.async;
  assert.equal(code(split.sync), 'ENOBUFS', 'spawnSync counts both streams together');
  assert.equal(code(splitAsync), code(split.sync));
  assert.equal(splitAsync.status, split.sync.status);
  assert.equal(splitAsync.signal, split.sync.signal);

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

test('Concurrent scout lookups AC-4: every lookup kind marks output above the limit across both streams unavailable', async () => {
  const preload = echoPreload();
  const stub = (args, env, maxBuffer, echo = false) => {
    const argv = [...(echo ? ['--import', preload] : []), STUB, ...args];
    return {
      sync: () => spawnSync(process.execPath, argv, { cwd: FIXTURE, env, encoding: 'utf8', timeout: 30000, maxBuffer }),
      async: () => runLookupAsync(process.execPath, argv, { cwd: FIXTURE, env, timeout: 30000, maxBuffer }),
    };
  };
  const lookups = [
    ['outbound', 'HarborBridge'],
    ['inbound', 'WatcherService'],
    ['impact', 'src/Controllers/ZoneWatchersController.cs', { hops: 2 }],
  ];
  for (const [kind, argument, extra] of lookups) {
    const asked = [];
    const probe = createScout({
      bin: BIN, outDir: 'out', repos: [REPO], fileExists: () => true,
      run: (bin, args) => { asked.push(args); return { status: 0, stdout: '' }; },
    });
    probe[kind](ROOT, argument, extra);
    const [args] = asked;
    const plain = stub(args, process.env, LOOKUP_MAX_BUFFER).sync();
    assert.equal(plain.status, 0, `${kind}: the stub answers ${args.join(' ')}`);
    const limit = Buffer.byteLength(plain.stdout);

    const answered = (runner) => createScout({
      bin: BIN, outDir: 'out', repos: [REPO], fileExists: () => true,
      run: (bin, lookupArgs, options) => runner(lookupArgs, options.env).sync(),
      runAsync: (bin, lookupArgs, options) => runner(lookupArgs, options.env).async(),
    });
    const within = (lookupArgs, env) => stub(lookupArgs, env, limit);
    const serialWithin = shape(answered(within)[kind](ROOT, argument, extra));
    assert.ok(serialWithin.edges.length > 0 && !serialWithin.unavailable, `${kind}: one stream at the limit answers edges`);
    const sharedWithin = shape(await answered(within).passes((scoutLookups) => scoutLookups[kind](ROOT, argument, extra)));
    assert.deepEqual(sharedWithin, serialWithin, `${kind}: one stream at the limit, shared path`);

    const over = (lookupArgs, env) => stub(lookupArgs, env, limit, true);
    const serialOver = shape(answered(over)[kind](ROOT, argument, extra));
    assert.equal(serialOver.unavailable, true, `${kind}: the serial path marks both streams above the limit unavailable`);
    assert.equal(serialOver.reason, 'indexer exited with an error');
    const sharedOver = shape(await answered(over).passes((scoutLookups) => scoutLookups[kind](ROOT, argument, extra)));
    assert.deepEqual(sharedOver, serialOver, `${kind}: both streams above the limit, shared path`);
  }
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
  // The last pass starts only after the last lookup answered, so a write or a print before
  // that moment belongs to an earlier pass, whether it falls before, between or after the
  // lookups of that pass.
  const observed = ['cases', 'scaffold', 'cover', 'span'].map((name) => INVOCATIONS.find((entry) => entry.name === name));
  for (const invocation of observed) {
    const dir = makeDir(`flowtrace-concurrent-io-${invocation.name}-`);
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

    const real = realpathSync(dir);
    const written = events.filter((event) => event.kind === 'file').map((event) => relative(real, resolve(real, event.path)).split(sep).join('/'));
    const counts = new Map();
    for (const path of written) counts.set(path, (counts.get(path) || 0) + 1);
    for (const [path, count] of counts) assert.equal(count, 1, `${invocation.name} wrote ${path} ${count} times`);
    const filesDir = join(EXPECTED, invocation.name, 'files');
    const pinned = existsSync(filesDir) ? walkFiles(filesDir) : [];
    assert.ok(pinned.length > 0, `${invocation.name} has pinned files`);
    assert.deepEqual([...counts.keys()].sort(), [...pinned].sort(), `${invocation.name} wrote each pinned file`);

    const last = Math.max(...lookups.map((entry) => entry.end));
    const early = events.filter((event) => event.at < last);
    assert.deepEqual(early, [], `${invocation.name} wrote or printed before its last lookup answered`);

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

/**
 * Written into the instrumented copy as `lib/holder-record.js`. It counts each build of a
 * shared value with the pass it ran in and the lookups asked while it ran, tags every walk
 * result, gate memo and pass result with the pass that first returned it, and writes what
 * it saw to `FLOWTRACE_HOLDER_LOG` when the process ends. After the last pass it builds each
 * value again from the same arguments and compares the two.
 */
const HOLDER_RECORD = `
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const state = {
  pass: 0, building: 0, lookups: 0, thrown: false, failed: 0, builds: [], kept: [], tags: new WeakMap(), reused: [], seen: {}, walks: [],
};

function tag(kind, value) {
  if (!value || typeof value !== 'object') return value;
  state.seen[kind] = (state.seen[kind] || 0) + 1;
  const from = state.tags.get(value);
  if (from === undefined) state.tags.set(value, state.pass);
  else if (from < state.pass) state.reused.push({ kind, pass: state.pass, from });
  return value;
}

export const record = {
  build(name, raw, args) {
    const before = state.lookups;
    state.building += 1;
    let value;
    try {
      value = raw(...args);
    } finally {
      state.building -= 1;
    }
    state.builds.push({ name, pass: state.pass, lookups: state.lookups - before });
    state.kept.push({ name, raw, args, value });
    return value;
  },
  lookup() {
    state.lookups += 1;
  },
  pass() {
    state.pass += 1;
  },
  miss() {
    if (process.env.FLOWTRACE_HOLDER_THROW && !state.thrown) {
      state.thrown = true;
      throw new Error('the first pass ends in an error');
    }
  },
  failed() {
    state.failed += 1;
  },
  result(value) {
    if (value && typeof value === 'object') for (const [key, part] of Object.entries(value)) tag('result ' + key, part);
    return value;
  },
  walk(args, value) {
    const traceIndex = state.kept.find((entry) => entry.name === 'traceIndex');
    const options = args[2] || {};
    if (typeof args[1] === 'string') {
      state.walks.push({ pass: state.pass, start: args[1], shared: Boolean(traceIndex) && options.index === traceIndex.value });
    }
    return tag('walk', value);
  },
  tag,
};

process.on('exit', () => {
  const file = process.env.FLOWTRACE_HOLDER_LOG;
  if (!file) return;
  const keys = (name, value) => {
    if (name === 'evidenceIndex') return [...value.byRoute.keys()];
    if (name === 'dispositionCandidates') return [...value.keys()];
    return null;
  };
  writeFileSync(file, JSON.stringify({
    passes: state.pass,
    failed: state.failed,
    builds: state.builds,
    fresh: state.kept.map((entry) => ({ name: entry.name, equal: isDeepStrictEqual(entry.value, entry.raw(...entry.args)), keys: keys(entry.name, entry.value) })),
    reused: state.reused,
    seen: state.seen,
    walks: state.walks,
  }));
});
`;

/** Each edit the instrumented copy makes, as `[file, original text, replacement]`. */
const HOLDER_EDITS = [
  ['lib/trace.js', 'export function buildTraceIndex(factSets) {',
    "export function buildTraceIndex(...args) {\n  return record.build('traceIndex', buildTraceIndexRaw, args);\n}\nfunction buildTraceIndexRaw(factSets) {"],
  ['lib/trace.js', 'export function trace(factSets, start, options = {}) {',
    'export function trace(...args) {\n  return record.walk(args, traceRaw(...args));\n}\nfunction traceRaw(factSets, start, options = {}) {'],
  ['lib/trace.js', 'const memo = byLookup.get(lookupKey);', "const memo = record.tag('gate memo', byLookup.get(lookupKey));"],
  ['lib/trace.js', 'if (memo.has(signature)) return memo.get(signature);', "if (memo.has(signature)) return record.tag('gate', memo.get(signature));"],
  ['lib/trace.js', 'memo.set(signature, kept);', "memo.set(signature, record.tag('gate', kept));"],
  ['lib/cover.js', 'export function buildEvidenceIndex(factSets, options = {}) {',
    "export function buildEvidenceIndex(...args) {\n  return record.build('evidenceIndex', buildEvidenceIndexRaw, args);\n}\nfunction buildEvidenceIndexRaw(factSets, options = {}) {"],
  ['lib/cover.js', 'export function buildDispositionCandidates(factSets, evidenceIndex) {',
    "export function buildDispositionCandidates(...args) {\n  return record.build('dispositionCandidates', buildDispositionCandidatesRaw, args);\n}\nfunction buildDispositionCandidatesRaw(factSets, evidenceIndex) {"],
  ['lib/scout.js', 'result = await compute(lookups);', 'record.pass();\n        result = record.result(await compute(lookups));'],
  ['lib/scout.js', 'function lookupInPass(kind, repoRoot, argument, extra, misses) {',
    'function lookupInPass(kind, repoRoot, argument, extra, misses) {\n    record.lookup();'],
  ['lib/scout.js', "return markUnavailable([], 'lookup pending');", "record.miss();\n    return markUnavailable([], 'lookup pending');"],
  ['lib/scout.js', 'if (misses.size === 0) throw error;', 'record.failed();\n        if (misses.size === 0) throw error;'],
  ['bin/flowtrace.js', 'main().then(', '(process.env.FLOWTRACE_HOLDER_TWICE ? main().then(() => main()) : main()).then('],
];

let holderCopy = null;
/** A copy of `bin/` and `lib/` with the edits above, made once for the file. */
function instrumentedCli() {
  if (holderCopy) return holderCopy;
  const root = makeDir('flowtrace-concurrent-holder-');
  for (const part of ['bin', 'lib', 'package.json']) cpSync(join(HERE, '..', part), join(root, part), { recursive: true });
  writeFileSync(join(root, 'lib', 'holder-record.js'), HOLDER_RECORD);
  const touched = new Set();
  for (const [file, original, replacement] of HOLDER_EDITS) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.split(original).length, 2, `${file} holds exactly one "${original}"`);
    writeFileSync(path, text.replace(original, () => replacement));
    touched.add(file);
  }
  for (const file of touched) {
    if (file.startsWith('bin/')) continue;
    const path = join(root, file);
    writeFileSync(path, `import { record } from './holder-record.js';\n${readFileSync(path, 'utf8')}`);
  }
  holderCopy = join(root, 'bin', 'flowtrace.js');
  return holderCopy;
}

/** Run a verb through the instrumented copy in a fresh fixture copy, and read its record. */
function holderRun(args, { limit, twice = false, env = {} } = {}) {
  const dir = makeDir('flowtrace-concurrent-holder-run-');
  cpSync(base(), dir, { recursive: true });
  const logPath = join(dir, 'holder.json');
  const stubLog = join(dir, 'stub.log');
  const result = spawnSync(process.execPath, [instrumentedCli(), ...args, '--config', CONFIG], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv({
      FLOWTRACE_HOLDER_LOG: logPath,
      FLOWTRACE_STUB_LOG: stubLog,
      ...(twice ? { FLOWTRACE_HOLDER_TWICE: '1' } : {}),
      ...env,
      ...(limit === undefined ? {} : { FLOWTRACE_SCOUT_CONCURRENCY: limit }),
    }),
  });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  return { dir, stdout: unroot(result.stdout, dir), record: JSON.parse(readFileSync(logPath, 'utf8')), lookups: readLog(stubLog) };
}

const SHARED = ['traceIndex', 'evidenceIndex', 'dispositionCandidates'];
const HOLDER_VERBS = [
  { name: 'scope', args: ['scope', '--area', 'harbor.area.txt'] },
  { name: 'cover', args: ['cover', '--area', 'harbor.area.txt'] },
];

test('Concurrent scout lookups AC-10: each shared value is built once per invocation, with no lookup, and equals a new build', () => {
  for (const verb of HOLDER_VERBS) {
    for (const limit of [undefined, '1']) {
      const label = `${verb.name} at ${limit ?? 'default'}`;
      const { record } = holderRun(verb.args, { limit });
      assert.ok(record.passes >= 4, `${label} ran ${record.passes} passes`);
      for (const name of SHARED) {
        const builds = record.builds.filter((build) => build.name === name);
        assert.equal(builds.length, 1, `${label} built ${name} ${builds.length} times`);
        assert.equal(builds[0].pass, 0, `${label} built ${name} before the first pass`);
        assert.equal(builds[0].lookups, 0, `${label} asked a lookup while it built ${name}`);
        const fresh = record.fresh.filter((entry) => entry.name === name);
        assert.equal(fresh.length, 1, `${label} kept one ${name}`);
        assert.equal(fresh[0].equal, true, `${label} ${name} equals a new build after the last pass`);
      }
    }
  }

  const twice = holderRun(HOLDER_VERBS[0].args, { twice: true }).record;
  for (const name of SHARED) {
    const builds = twice.builds.filter((build) => build.name === name);
    assert.equal(builds.length, 2, `two invocations built ${name} ${builds.length} times`);
    assert.ok(builds[1].pass > builds[0].pass, `the second invocation built its own ${name} after the passes of the first`);
  }
});

test('Concurrent scout lookups AC-10: the last pass gets no walk result, gate memo entry or walk counter of an earlier pass', () => {
  for (const verb of HOLDER_VERBS) {
    for (const limit of [undefined, '1']) {
      const label = `${verb.name} at ${limit ?? 'default'}`;
      const { record } = holderRun(verb.args, { limit });
      assert.ok(record.passes >= 2, `${label} ran ${record.passes} passes`);
      assert.ok(record.seen.walk > 0, `${label} tagged its walks`);
      assert.ok(record.seen['gate memo'] > 0, `${label} reached the gate memo ${JSON.stringify(record.seen)}`);
      assert.deepEqual(record.reused, [], `${label} handed a value of an earlier pass to a later one`);
    }
  }
  const scoped = holderRun(HOLDER_VERBS[0].args).record;
  assert.ok(scoped.seen['result walkCounts'] >= scoped.passes, 'scope returned a walk counter from each pass');

  const budget = holderRun(['cover', '--area', 'harbor.area.txt', '--max-nodes', '6']);
  assert.match(budget.stdout, /node-budget/, 'cover under a small node budget stopped on it');
  assert.deepEqual(budget.record.reused, [], 'cover under a node budget handed a value of an earlier pass to a later one');

  const failed = holderRun(HOLDER_VERBS[0].args, { env: { FLOWTRACE_HOLDER_THROW: '1' } });
  assert.equal(failed.record.failed, 1, 'the first pass ended in an error and the passes went on');
  assert.deepEqual(failed.record.reused, [], 'scope after a failed pass handed a value of an earlier pass to a later one');
  for (const name of SHARED) {
    assert.equal(failed.record.builds.filter((build) => build.name === name).length, 1, `scope after a failed pass built ${name} once`);
  }
  assert.equal(failed.stdout, readPin('scope', 'stdout'), 'scope after a failed pass prints the serial pin');
});

test('Concurrent scout lookups AC-11: an answer only a later pass asks for reaches the scope and cover output', () => {
  const late = CHAINS.outbound[CHAINS.outbound.length - 1];
  for (const verb of HOLDER_VERBS) {
    const invocation = INVOCATIONS.find((entry) => entry.name === verb.name);
    assert.ok(invocation, `${verb.name} has a serial pin`);
    for (const limit of [undefined, '1']) {
      const label = `${verb.name} at ${limit ?? 'default'}`;
      const { log } = pinnedRun(invocation, limit);
      assert.ok(log.some((entry) => entry.args.join(' ') === late), `${label} asked the index for ${late}`);

      const { record } = holderRun(verb.args, { limit });
      const lastPass = record.passes;
      const watchers = record.walks.filter((walk) => walk.pass === lastPass && walk.start === 'GET glasshouse/v1/zones/*/watchers');
      assert.ok(watchers.length > 0, `${label} walked the watchers route in its last pass`);
      assert.ok(watchers.every((walk) => walk.shared), `${label} walked the watchers route over the shared trace index`);
      for (const name of ['evidenceIndex', 'dispositionCandidates']) {
        const kept = record.fresh.find((entry) => entry.name === name);
        assert.ok(kept.keys.includes('GET glasshouse/v1/zones/*/watchers'), `${label} ${name} holds the watchers route`);
      }
    }
  }
  assert.match(readPin('scope', 'stdout'), /watchers — .* — automation: yes — server-gate: backend:backend\/src\/Services\/RelayGate\.cs:1$/m);
  const coverPin = readPin('cover', 'stdout').split('\n').find((line) => line.includes('GET glasshouse/v1/zones/*/watchers  '));
  assert.ok(coverPin && !coverPin.includes('seed count partial'), `the cover pin holds a complete watchers walk: ${coverPin}`);
});
