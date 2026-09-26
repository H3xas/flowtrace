/**
 * The journey harness's capture and replay protocol: what a manifest records, that capture
 * promotes only an unchanged source and never half a bundle, that replay reads facts without
 * rebuilding them, and that two replays of one bundle project to the same bytes. Capture's
 * phase hooks cannot be reached through a subprocess, so those cases import the capture module.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './helpers.js';
import {
  HARNESS,
  captureCli,
  copyPack,
  currentGeneration,
  diagnosticNames,
  readJson,
  replayCli,
  tempDir,
  treeBytes,
} from './journey-helpers.js';
import { capture } from '../scripts/journey-pack/capture.mjs';
import { contentIdentity } from '../scripts/journey-pack/identity.mjs';
import { project } from '../scripts/journey-pack/projection.mjs';
import { readLedger } from '../scripts/journey-pack/ledger.mjs';

const MANIFEST_KEYS = ['format', 'schemaVersion', 'step', 'result', 'tool', 'node', 'environment', 'snapshot', 'config', 'repositories', 'codeIndex', 'invocations', 'diagnostics'];
const HEX_KEYS = new Set(['checkoutHead', 'sourceDigest', 'digest', 'sha256', 'headSha', 'dirtyDigest', 'before', 'after', 'captureSha256']);

/** Hex identities are allowed only as the values of the identity fields that name them. */
function strayHex(value, key = '') {
  if (typeof value === 'string') return /\b[0-9a-f]{40,64}\b/.test(value) && !HEX_KEYS.has(key) ? [`${key}=${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item) => strayHex(item, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strayHex(v, k));
  return [];
}

function assertPortable(text) {
  assert.doesNotMatch(text, /(^|[^A-Za-z0-9._-])\/(Users|home|tmp|private|var)\//);
  assert.doesNotMatch(text, /[A-Za-z]:\\/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
}

function capturedPack(t) {
  const pack = copyPack(t);
  const result = captureCli(pack);
  assert.equal(result.status, 0, result.stderr);
  return pack;
}

test('a capture promotes one generation whose manifest carries every identity it establishes', (t) => {
  const pack = capturedPack(t);
  const generation = currentGeneration(pack.bundle);
  assert.deepEqual(readdirSync(generation).sort(), ['capture.json', 'snapshot.json']);
  const text = readFileSync(join(generation, 'capture.json'), 'utf8');
  const manifest = JSON.parse(text);
  const snapshot = readJson(join(generation, 'snapshot.json'));
  assert.deepEqual(Object.keys(manifest), MANIFEST_KEYS);
  assert.equal(manifest.format, 'flowtrace-journey-manifest');
  assert.equal(manifest.step, 'capture');
  assert.equal(manifest.result, 'promoted');
  assert.equal(manifest.tool.generatedFrom, `flowtrace ${snapshot.tool.version}`);
  assert.match(manifest.tool.checkoutHead, /^([0-9a-f]{40,64}|unknown)$/);
  assert.match(manifest.tool.sourceDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.node, process.version);
  assert.deepEqual(manifest.environment, { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', GIT_OPTIONAL_LOCKS: '0', FLOWTRACE_SCOUT_BIN: '(removed)' });
  assert.equal(manifest.snapshot.format, 'flowtrace-snapshot');
  assert.equal(manifest.snapshot.schemaVersion, snapshot.schemaVersion);
  assert.equal(manifest.config.rule, 'config/1');
  assert.deepEqual(manifest.config.roots, { backend: 'backend', web: 'web' });
  assert.deepEqual(manifest.codeIndex, { state: 'absent', configured: false });
  assert.deepEqual(manifest.invocations.map((entry) => entry.verb), ['extract', 'join']);
  for (const entry of manifest.invocations) {
    assert.equal(entry.exit, 0);
    assert.ok(Array.isArray(entry.args) && Array.isArray(entry.stderr));
  }
  assert.deepEqual(manifest.diagnostics, []);
  for (const repository of manifest.repositories) {
    const set = snapshot.factSets.find((entry) => entry.repo === repository.id);
    const { facts, ...identity } = set;
    assert.deepEqual(repository.factSet, identity, `${repository.id} fact set identity is copied verbatim`);
    assert.equal(repository.factSet.headSha, null, 'a non-git copy states no revision witness');
    assert.equal(repository.content.rule, 'scope/1');
    assert.match(repository.content.digest, /^[0-9a-f]{64}$/);
    assert.ok(repository.content.files > 0);
    assert.equal(repository.witness.before, repository.witness.after);
  }
  assertPortable(text);
  assert.deepEqual(strayHex(manifest), []);
  assert.equal(existsSync(join(pack.dir, 'out')), false, 'capture never writes beside the source configuration');
  assert.deepEqual(readdirSync(pack.bundle).sort(), ['current', readdirSync(pack.bundle).find((name) => name.startsWith('g-'))].sort());
});

test('the content scope covers every file the captured facts name', (t) => {
  const pack = capturedPack(t);
  const snapshot = readJson(join(currentGeneration(pack.bundle), 'snapshot.json'));
  const config = readJson(pack.config);
  for (const repo of config.repos) {
    const scoped = new Set(contentIdentity(repo, join(pack.dir, repo.root)).list.map((file) => file.rel));
    const named = new Set(snapshot.factSets.find((set) => set.repo === repo.id).facts.map((fact) => fact.file));
    assert.ok(named.size > 0);
    for (const file of named) assert.ok(scoped.has(file), `${repo.id}: ${file} is outside the content scope`);
  }
});

test('a replay runs only fact-reading verbs and leaves every fact set as it found it', (t) => {
  const pack = capturedPack(t);
  const out = tempDir(t, 'replay');
  const result = replayCli(pack, out);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(join(out, 'replay.json'), 'utf8');
  const manifest = JSON.parse(text);
  assert.equal(manifest.step, 'replay');
  assert.equal(manifest.result, 'replayed');
  const verbs = new Set(manifest.invocations.map((entry) => entry.verb));
  assert.deepEqual([...verbs].sort(), ['join', 'trace']);
  assert.ok(manifest.invocations.every((entry) => !entry.args.includes('--export-edges')));
  assert.deepEqual(manifest.invocations[0].args.slice(-2)[0], '--against');
  assert.ok(manifest.invocations.at(-1).args.includes('--snapshot'));
  const ledger = readLedger(pack.ledger);
  const distinct = new Set(ledger.runs.map((run) => JSON.stringify([run.start, run.args])));
  assert.equal(manifest.invocations.filter((entry) => entry.verb === 'trace').length, distinct.size);
  for (const entry of manifest.invocations.filter((item) => item.verb === 'trace')) assert.ok(entry.args.includes('--json'));
  for (const repository of manifest.repositories) {
    assert.deepEqual(repository.factSet.after, repository.factSet.before);
    assert.equal(repository.factSet.after.digest, repository.factSet.before.digest);
  }
  assert.deepEqual(manifest.codeIndex, { state: 'absent', configured: false });
  assert.equal(manifest.bundle.generation, readJson(join(pack.bundle, 'current')).current);
  assertPortable(text);
  assert.deepEqual(strayHex(manifest), []);
  for (const file of ['projection.json', 'report.txt']) assert.ok(existsSync(join(out, file)));
  for (const run of ledger.runs) assert.ok(existsSync(join(out, 'raw', `${run.id}.json`)));
});

test('two replays of one bundle project to the same bytes', (t) => {
  const pack = capturedPack(t);
  const first = tempDir(t, 'first');
  const second = tempDir(t, 'second');
  assert.equal(replayCli(pack, first).status, 0);
  assert.equal(replayCli(pack, second).status, 0);
  assert.equal(readFileSync(join(first, 'projection.json'), 'utf8'), readFileSync(join(second, 'projection.json'), 'utf8'));
  const projection = readFileSync(join(first, 'projection.json'), 'utf8');
  assertPortable(projection);
  assert.doesNotMatch(projection, /\b[0-9a-f]{7,64}\b/);
  assert.doesNotMatch(projection, /flowtrace \d|v\d+\.\d+\.\d+/);
  assert.doesNotMatch(projection, /\.(cs|tsx?)"/);
});

test('a --json field the projection does not read cannot move it', (t) => {
  const pack = capturedPack(t);
  const out = tempDir(t, 'isolation');
  assert.equal(replayCli(pack, out).status, 0);
  const ledger = readLedger(pack.ledger);
  const outputs = new Map();
  const widened = new Map();
  for (const run of ledger.runs) {
    const stdout = readFileSync(join(out, 'raw', `${run.id}.json`), 'utf8');
    const stderr = readFileSync(join(out, 'raw', `${run.id}.stderr.txt`), 'utf8');
    const exit = stdout.trim() === '' ? 2 : 0;
    outputs.set(run.id, { exit, stdout, stderr });
    if (exit !== 0) {
      widened.set(run.id, { exit, stdout, stderr });
      continue;
    }
    const document = JSON.parse(stdout);
    document.stats.graphUnknownKinds = { widened: 3 };
    document.stats.addedLater = true;
    for (const node of document.nodes) node.presentationHint = `hint-${node.id}`;
    for (const edge of document.edges) edge.weight = 1;
    widened.set(run.id, { exit, stdout: JSON.stringify(document), stderr });
  }
  assert.deepEqual(project(ledger, widened), project(ledger, outputs));
});

test('a source edit between the before and after digests is refused and nothing is promoted', (t) => {
  const pack = copyPack(t);
  const target = join(pack.dir, 'web', 'src', 'actions', 'notices.ts');
  const result = capture(
    { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
    { afterExtract: () => appendFileSync(target, 'export const LATE = 1;\n') },
  );
  assert.equal(result.exit, 3);
  assert.equal(result.diagnostics[0].name, 'capture-source-changed');
  assert.equal(result.diagnostics[0].repo, 'web');
  assert.match(result.diagnostics[0].detail, /\bweb\b/);
  assert.equal(existsSync(join(pack.bundle, 'current')), false);
  assert.deepEqual(readdirSync(pack.bundle).filter((name) => name.startsWith('.staging-') || name.startsWith('g-') || name === 'capture.lock'), []);
  assert.equal(readJson(join(pack.bundle, 'refused-capture.json')).result, 'refused');
});

test('a write outside the content scope during capture is refused by the witness', (t) => {
  const pack = copyPack(t);
  const result = capture(
    { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
    { afterExtract: () => writeFileSync(join(pack.dir, 'backend', 'build.log'), 'written by a build\n') },
  );
  assert.equal(result.exit, 3);
  assert.equal(result.diagnostics[0].name, 'source-written-during-capture');
  assert.match(result.diagnostics[0].detail, /backend: backend:build\.log/);
  assert.equal(existsSync(join(pack.bundle, 'current')), false);
});

test('a capture that stops before promotion leaves the promoted bundle byte for byte', (t) => {
  const pack = capturedPack(t);
  appendFileSync(join(pack.dir, 'web', 'src', 'actions', 'notices.ts'), 'export const LATER = 2;\n');
  const before = treeBytes(pack.bundle);
  assert.throws(
    () =>
      capture(
        { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
        {
          beforePromote: () => {
            throw new Error('interrupted before promotion');
          },
        },
      ),
    /interrupted before promotion/,
  );
  assert.deepEqual(treeBytes(pack.bundle), before);
});

test('a stale lock and leftover staging are reclaimed, and replay never reads staging', (t) => {
  const pack = capturedPack(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(exited.stdout);
  writeFileSync(join(pack.bundle, 'capture.lock'), `${JSON.stringify({ pid: deadPid, host: hostname() })}\n`);
  const staging = join(pack.bundle, '.staging-1-deadbeef', 'gen');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'snapshot.json'), '{"not":"a snapshot"}\n');
  const out = tempDir(t, 'staging');
  assert.equal(replayCli(pack, out).status, 0, 'replay follows current, never a staging directory');
  appendFileSync(join(pack.dir, 'web', 'src', 'actions', 'notices.ts'), 'export const RECLAIMED = 3;\n');
  const result = captureCli(pack);
  assert.equal(result.status, 0, result.stderr);
  const left = readdirSync(pack.bundle);
  assert.ok(!left.some((name) => name.startsWith('.staging-') || name === 'capture.lock'));
  const pointer = readJson(join(pack.bundle, 'current'));
  assert.notEqual(pointer.previous, null);
  assert.deepEqual(left.filter((name) => name.startsWith('g-')).sort(), [pointer.current, pointer.previous].sort());
});

test('a lock held by a running process refuses a second capture', (t) => {
  const pack = capturedPack(t);
  const before = readJson(join(pack.bundle, 'current'));
  writeFileSync(join(pack.bundle, 'capture.lock'), `${JSON.stringify({ pid: process.pid, host: hostname() })}\n`);
  t.after(() => rmSync(join(pack.bundle, 'capture.lock'), { force: true }));
  const result = captureCli(pack);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['capture-in-progress']);
  assert.deepEqual(readJson(join(pack.bundle, 'current')), before);
  assert.ok(existsSync(join(pack.bundle, 'capture.lock')), 'the holder keeps its lock');
});

test('a stale lock another capture reclaimed first is left to that capture', (t) => {
  const pack = capturedPack(t);
  const before = treeBytes(pack.bundle);
  const lock = join(pack.bundle, 'capture.lock');
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(lock, `${JSON.stringify({ pid: Number(exited.stdout), host: hostname() })}\n`);
  const winner = `${JSON.stringify({ pid: process.pid, host: hostname(), token: 'winner' })}\n`;
  const result = capture(
    { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
    {
      afterStaleLockRead: () => {
        rmSync(lock);
        writeFileSync(lock, winner);
      },
    },
  );
  assert.equal(result.exit, 3);
  assert.equal(result.diagnostics[0].name, 'capture-in-progress');
  assert.equal(readFileSync(lock, 'utf8'), winner, 'the winner keeps its lock');
  rmSync(lock);
  assert.deepEqual(treeBytes(pack.bundle), before);
});

test('a capture whose lock was taken over neither promotes nor removes the new holder', (t) => {
  const pack = capturedPack(t);
  const pointer = readFileSync(join(pack.bundle, 'current'), 'utf8');
  appendFileSync(join(pack.dir, 'web', 'src', 'actions', 'notices.ts'), 'export const TAKEN_OVER = 4;\n');
  const lock = join(pack.bundle, 'capture.lock');
  const other = `${JSON.stringify({ pid: process.pid, host: hostname(), token: 'other' })}\n`;
  const result = capture(
    { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
    { beforePromote: () => writeFileSync(lock, other) },
  );
  assert.equal(result.exit, 3);
  assert.equal(result.diagnostics[0].name, 'capture-in-progress');
  assert.equal(readFileSync(join(pack.bundle, 'current'), 'utf8'), pointer);
  assert.equal(readFileSync(lock, 'utf8'), other, 'the new holder keeps its lock');
});

test('a capture refused after its lock was taken over writes nothing into the bundle', (t) => {
  const pack = capturedPack(t);
  const before = treeBytes(pack.bundle);
  const lock = join(pack.bundle, 'capture.lock');
  const other = `${JSON.stringify({ pid: process.pid, host: hostname(), token: 'other' })}\n`;
  const result = capture(
    { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
    {
      afterExtract: () => {
        writeFileSync(lock, other);
        appendFileSync(join(pack.dir, 'web', 'src', 'actions', 'notices.ts'), 'export const DURING = 5;\n');
      },
    },
  );
  assert.equal(result.exit, 3);
  assert.equal(result.diagnostics[0].name, 'capture-source-changed');
  assert.equal(readFileSync(lock, 'utf8'), other, 'the new holder keeps its lock');
  rmSync(lock);
  assert.deepEqual(treeBytes(pack.bundle), before);
});

function exitedPid() {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}

function lockEntries(bundle) {
  return readdirSync(bundle).filter((name) => name.startsWith('capture.lock') || name.includes('.tmp-') || name.startsWith('.staging-'));
}

test('a lock is never visible without its content, and a publication stopped short blocks nothing', (t) => {
  const pack = capturedPack(t);
  const before = treeBytes(pack.bundle);
  const lock = join(pack.bundle, 'capture.lock');
  let staged = null;
  assert.throws(
    () =>
      capture(
        { config: pack.config, bundle: pack.bundle, harnessRoot: REPO_ROOT },
        {
          beforeLockPublish: (temporary) => {
            staged = readFileSync(temporary, 'utf8');
            assert.equal(existsSync(lock), false, 'the lock is not visible before its content is complete');
            throw new Error('stopped before the lock was published');
          },
        },
      ),
    /stopped before the lock was published/,
  );
  assert.equal(JSON.parse(staged).pid, process.pid);
  assert.deepEqual(treeBytes(pack.bundle), before);
  const result = captureCli(pack);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lockEntries(pack.bundle), []);
});

test('what a stopped lock publication leaves behind is swept by the next capture', (t) => {
  const pack = capturedPack(t);
  const dead = exitedPid();
  const leftovers = {
    [`capture.lock.tmp-${dead}-0badf00d`]: '{"pid":',
    [`capture.lock.tmp-${dead}-5eed5eed`]: `${JSON.stringify({ pid: dead, host: hostname(), token: 'left' })}\n`,
    [`capture.lock.reclaim.tmp-${dead}-0badf00d`]: '',
    [`refused-capture.json.tmp-${dead}-0badf00d`]: '{',
  };
  for (const [name, text] of Object.entries(leftovers)) writeFileSync(join(pack.bundle, name), text);
  const result = captureCli(pack);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lockEntries(pack.bundle), []);
});

test('a lock this harness cannot read is refused by name with the step that clears it', (t) => {
  for (const text of ['', '{"pid":']) {
    const pack = capturedPack(t);
    const lock = join(pack.bundle, 'capture.lock');
    writeFileSync(lock, text);
    const before = treeBytes(pack.bundle);
    const result = captureCli(pack);
    assert.equal(result.status, 3);
    assert.deepEqual(diagnosticNames(result.stderr), ['capture-in-progress']);
    assert.match(result.stderr, /capture\.lock cannot be read.*remove it/);
    assert.deepEqual(treeBytes(pack.bundle), before);
    rmSync(lock);
    assert.equal(captureCli(pack).status, 0);
  }
});

test('a reclaim guard left by a stopped capture is refused by name until it is removed', (t) => {
  const pack = capturedPack(t);
  const dead = exitedPid();
  const lock = join(pack.bundle, 'capture.lock');
  const guard = join(pack.bundle, 'capture.lock.reclaim');
  writeFileSync(lock, `${JSON.stringify({ pid: dead, host: hostname(), token: 'stale' })}\n`);
  writeFileSync(guard, `${JSON.stringify({ pid: dead, host: hostname(), token: 'guard' })}\n`);
  const before = treeBytes(pack.bundle);
  const result = captureCli(pack);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['capture-in-progress']);
  assert.match(result.stderr, /capture\.lock\.reclaim exists.*remove it/);
  assert.deepEqual(treeBytes(pack.bundle), before);
  rmSync(guard);
  const recovered = captureCli(pack);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(lockEntries(pack.bundle), []);
});

test('a capture stopped by a signal ends at once and the next capture recovers', async (t) => {
  const pack = capturedPack(t);
  const before = readFileSync(join(pack.bundle, 'current'), 'utf8');
  const lock = join(pack.bundle, 'capture.lock');
  const child = spawn(process.execPath, [HARNESS, 'capture', '--config', pack.config, '--bundle', pack.bundle], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  let seen = null;
  const outcome = await new Promise((resolveOutcome) => {
    const timer = setInterval(() => {
      try {
        seen = readFileSync(lock, 'utf8');
      } catch {
        return;
      }
      clearInterval(timer);
      process.kill(-child.pid, 'SIGTERM');
    }, 1);
    child.on('exit', (code, signal) => {
      clearInterval(timer);
      resolveOutcome({ code, signal });
    });
  });
  assert.deepEqual(outcome, { code: null, signal: 'SIGTERM' });
  // The signal lands the moment the lock is first seen, so these bytes are what it leaves behind.
  assert.equal(JSON.parse(seen).pid, child.pid);
  assert.equal(readFileSync(join(pack.bundle, 'current'), 'utf8'), before);
  const result = captureCli(pack);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lockEntries(pack.bundle), []);
});

test('replay refuses a missing bundle, a changed configuration, and changed or missing source', (t) => {
  const pack = copyPack(t);
  const out = tempDir(t, 'refusals');
  let result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['bundle-missing']);
  assert.equal(readJson(join(out, 'replay.json')).result, 'refused');
  assert.equal(existsSync(join(out, 'projection.json')), false);

  assert.equal(captureCli(pack).status, 0);
  const config = readJson(pack.config);
  writeFileSync(pack.config, `${JSON.stringify({ ...config, sinks: { db: ['Repository'] } }, null, 2)}\n`);
  result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['config-changed-since-capture']);
  writeFileSync(pack.config, `${JSON.stringify(config, null, 2)}\n`);

  appendFileSync(join(pack.dir, 'backend', 'src', 'Models', 'Zone.cs'), '\n');
  result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['source-changed-since-capture']);
  assert.match(result.stderr, /content of backend differs/);

  rmSync(join(pack.dir, 'backend'), { recursive: true, force: true });
  result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['source-unavailable']);
});

test('a ledger that no longer holds its anchors stops a replay before any run', (t) => {
  const pack = copyPack(t);
  const target = join(pack.dir, 'backend', 'src', 'Services', 'WatcherService.cs');
  const text = readFileSync(target, 'utf8');
  writeFileSync(target, `// moved\n${text}`);
  assert.equal(captureCli(pack).status, 0);
  const out = tempDir(t, 'anchors');
  const result = replayCli(pack, out);
  assert.equal(result.status, 2);
  assert.deepEqual(diagnosticNames(result.stderr), ['ledger-invalid']);
  assert.deepEqual(readJson(join(out, 'replay.json')).invocations, []);
});

test('a sink or branch beneath a folded node is still found, though nothing is shown to reach it', () => {
  const site = (id, kind, file, line, symbol) => ({ id, kind, repo: 'api', file, line, anchor: 'x', symbol });
  const ledger = {
    pack: 'folded',
    sites: [
      site('route', 'route', 'src/Api.cs', 3, 'Api.Save'),
      site('guard', 'branch', 'src/Store.cs', 12, null),
      site('write', 'write', 'src/Store.cs', 14, 'StoreRepository.Put'),
    ],
    unknowns: [],
    runs: [{ id: 'walk', start: 'Api.Save', args: [], asserts: 'sinks', reach: ['write'] }],
    cases: [
      {
        id: 'hidden',
        run: 'walk',
        expect: ['route', 'guard', 'write'],
        unknowns: [],
        assertions: [{ id: 'write-from-route', kind: 'reached-from', site: 'write', from: 'route' }],
      },
    ],
  };
  const document = {
    nodes: [
      { id: 'n1', repo: 'api', kind: 'action', ref: 'Api.Save', file: 'src/Api.cs', line: 3, class: 'Api', method: 'Save' },
      { id: 'n2', repo: 'api', kind: 'class', ref: 'Store', file: 'src/Store.cs', line: 1 },
      { id: 'n3', ref: 'n2' },
    ],
    edges: [
      { from: 'n1', to: 'n2', via: 'ctor' },
      { from: 'n1', to: 'n3', via: 'ctor' },
    ],
    sinks: [{ id: 'n7', repo: 'api', kind: 'db', ref: 'StoreRepository', file: 'src/Store.cs', line: 20, class: 'StoreRepository', methods: ['Put'], sink: true }],
    branches: [{ id: 'n6', repo: 'api', kind: 'branch', ref: 'Store.Put@12', file: 'src/Store.cs', line: 12, class: 'Store', method: 'Put' }],
    stats: { budgetHit: false },
  };
  const outputs = new Map([['walk', { exit: 0, stdout: JSON.stringify(document), stderr: '' }]]);
  const [entry] = project(ledger, outputs).cases;
  assert.deepEqual(entry.sites.map((item) => [item.id, item.found, item.by]), [
    ['route', true, 'both'],
    ['guard', true, 'site'],
    ['write', true, 'symbol'],
  ]);
  assert.deepEqual(entry.assertions, [{ id: 'write-from-route', held: false, reason: 'not-reached' }]);
  assert.equal(project(ledger, outputs).runs[0].outside.length, 0);
});

test('a ledger written for another configuration is refused before any run', (t) => {
  const pack = capturedPack(t);
  const other = copyPack(t);
  const out = tempDir(t, 'foreign-ledger');
  const result = replayCli(pack, out, [], { ledger: other.ledger });
  assert.equal(result.status, 2);
  assert.deepEqual(diagnosticNames(result.stderr), ['ledger-invalid']);
  assert.match(result.stderr, /names another configuration/);
});

test('a promoted generation that cannot be read is refused by name', (t) => {
  const pack = capturedPack(t);
  const generation = currentGeneration(pack.bundle);
  const out = tempDir(t, 'unreadable');
  writeFileSync(join(generation, 'capture.json'), '{ not json');
  let result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['bundle-mismatch']);
  rmSync(join(generation, 'capture.json'));
  result = replayCli(pack, out);
  assert.equal(result.status, 3);
  assert.deepEqual(diagnosticNames(result.stderr), ['bundle-missing']);
});

test('a pointer that names anything but a generation of its own bundle is refused', (t) => {
  const pack = capturedPack(t);
  const pointerFile = join(pack.bundle, 'current');
  const pointer = readJson(pointerFile);
  const elsewhere = join(pack.work, 'elsewhere');
  cpSync(join(pack.bundle, pointer.current), join(elsewhere, pointer.current), { recursive: true });
  for (const current of [`../elsewhere/${pointer.current}`, '.', `${pointer.current}/..`]) {
    writeFileSync(pointerFile, `${JSON.stringify({ ...pointer, current })}\n`);
    const result = replayCli(pack, tempDir(t, 'pointer'));
    assert.equal(result.status, 3, `${current}: ${result.stderr}`);
    assert.deepEqual(diagnosticNames(result.stderr), ['bundle-missing'], current);
  }
});

test('a configuration that cannot be read is a usage error, never a drift or a crash', (t) => {
  const pack = copyPack(t);
  writeFileSync(pack.config, '{ "repos": [');
  let result = captureCli(pack);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^journey-pack: usage: configuration .* cannot be read/m);
  const out = tempDir(t, 'bad-config');
  result = replayCli(pack, out);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^journey-pack: usage: configuration .* cannot be read/m);
  assert.doesNotMatch(result.stderr, /at .*\.mjs:\d+/);
});
