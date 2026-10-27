/**
 * `scope` reads a fact snapshot. A snapshot that was reviewed and frozen stays readable
 * after HEAD moves, so these checks pin three things: the route rows do not change when
 * only the repository moves, the freshness state travels in the report and on stderr
 * instead of in the exit code, and the boundaries that were already scope's stay scope's
 * — area usage errors, key order, placeholder rows, the frozen walk's automation and gate
 * columns.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { factState } from '../lib/facts.js';
import { scope } from '../lib/scope.js';
import { copyCorpus, copyGitCorpus, extract, REPO_ROOT, runCli } from './helpers.js';

const CONFIG = 'gizmo.config.json';
const AREA = 'area.txt';
const KEYS = ['GET gizmos/v1/catalog', 'POST gizmos/v1/activate'];
const AREA_TEXT = ['# the gizmo area', '', ...KEYS, '# a repeat is not a second row', KEYS[0], ''].join('\n');

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function cleanTree(dir) {
  return git(dir, 'status', '--porcelain') === '';
}

/** The digest `factsHeader` stamps for the tree as it stands: sorted changed paths, sha1. */
function dirtyDigestOf(dir) {
  const changed = git(dir, 'status', '--porcelain').split('\n').filter((line) => line.length > 0);
  return createHash('sha1').update([...changed].sort().join('\n')).digest('hex');
}

/** A committed corpus with the area file in the commit, then an extraction: so the facts
 * name a commit and a tree that no fixture write after them disturbs. */
function frozenCorpus(t) {
  const dir = copyGitCorpus(t);
  writeFileSync(join(dir, AREA), AREA_TEXT);
  commitAll(dir, 'record the area');
  extract(dir, CONFIG);
  return dir;
}

function scopeJson(dir) {
  return runCli(['scope', '--config', CONFIG, '--area', AREA, '--json'], { cwd: dir });
}

test('Scope freshness AC-1: a frozen snapshot keeps its ordered rows after an unrelated commit and a real source commit', (t) => {
  const dir = frozenCorpus(t);
  const baseline = scopeJson(dir);
  assert.equal(baseline.status, 0, baseline.stderr);
  const before = JSON.parse(baseline.stdout);
  assert.deepEqual(before.routes.map((route) => route.key), KEYS);
  assert.deepEqual(Object.keys(before.routes[0]).sort(), ['automation', 'file', 'key', 'line', 'repo', 'serverGate']);
  assert.equal(before.freshness.value, 'matching');

  const human = runCli(['scope', '--config', CONFIG, '--area', AREA], { cwd: dir });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /freshness: matching/);

  writeFileSync(join(dir, 'notes.txt'), 'a commit that touches no configured root\n');
  commitAll(dir, 'unrelated change');
  assert.equal(cleanTree(dir), true);

  const unrelated = scopeJson(dir);
  assert.equal(unrelated.status, 0, unrelated.stderr);
  const afterUnrelated = JSON.parse(unrelated.stdout);
  assert.deepEqual(afterUnrelated.routes, before.routes);
  assert.deepEqual(afterUnrelated.routes.map((route) => route.key), KEYS);
  assert.deepEqual(afterUnrelated.freshness, { value: 'mismatched', sets: [{ repo: 'api', freshness: 'head-stale' }] });

  const controller = join(dir, 'backend', 'src', 'Controllers', 'GizmoController.cs');
  writeFileSync(controller, readFileSync(controller, 'utf8').replace('public async Task<IActionResult> GetCatalog()', 'public async Task<IActionResult> ListCatalog()'));
  commitAll(dir, 'rename the action');
  assert.equal(cleanTree(dir), true);

  const drifted = scopeJson(dir);
  assert.equal(drifted.status, 0, drifted.stderr);
  const afterDrift = JSON.parse(drifted.stdout);
  assert.deepEqual(afterDrift.routes, before.routes);
  assert.equal(afterDrift.freshness.value, 'mismatched');

  const humanDrifted = runCli(['scope', '--config', CONFIG, '--area', AREA], { cwd: dir });
  assert.equal(humanDrifted.status, 0, humanDrifted.stderr);
  assert.match(humanDrifted.stdout, /freshness: mismatched/);
  for (const key of KEYS) assert.ok(humanDrifted.stdout.includes(`${key} — api:`), key);
});

function witnessRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'flowtrace-freshness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'selftest@example.invalid');
  git(root, 'config', 'user.name', 'flowtrace selftest');
  writeFileSync(join(root, 'source.txt'), 'one\n');
  commitAll(root, 'one');
  return root;
}

/** One route the walk resolves without touching git, so only the witness varies. */
function routeSet(witness = {}) {
  return {
    repo: 'demo',
    kind: 'backend',
    ...witness,
    facts: [
      {
        type: 'route', file: 'Controllers/GizmoController.cs', line: 5,
        controller: 'GizmoController', action: 'GetCatalog', verb: 'GET', template: 'gizmos/v1/catalog',
      },
      { type: 'method_span', file: 'Controllers/GizmoController.cs', line: 5, endLine: 9, class: 'GizmoController', method: 'GetCatalog' },
    ],
  };
}

function freshnessOf(root, sets) {
  return scope(sets, {
    area: 'area',
    keys: ['GET gizmos/v1/catalog'],
    repos: root ? [{ id: 'demo', root }] : [],
    gatePatterns: [],
  }).freshness;
}

test('Scope freshness AC-2: the freshness field reports each witness state and the aggregate rule', (t) => {
  const root = witnessRepo(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const clean = dirtyDigestOf(root);

  assert.deepEqual(freshnessOf(root, [routeSet({ headSha: head, dirty: false, dirtyDigest: clean })]),
    { value: 'matching', sets: [{ repo: 'demo', freshness: 'matching' }] });

  assert.deepEqual(freshnessOf(root, [routeSet({ headSha: 'a'.repeat(40), dirty: false, dirtyDigest: clean })]),
    { value: 'mismatched', sets: [{ repo: 'demo', freshness: 'head-stale' }] });

  assert.deepEqual(freshnessOf(root, [routeSet({ headSha: head, dirty: false, dirtyDigest: 'b'.repeat(40) })]),
    { value: 'mismatched', sets: [{ repo: 'demo', freshness: 'worktree-stale' }] });

  assert.deepEqual(freshnessOf(root, [routeSet({ headSha: head, dirty: false })]),
    { value: 'matching', sets: [{ repo: 'demo', freshness: 'matching' }] });

  assert.deepEqual(freshnessOf(root, [routeSet()]),
    { value: 'unknown', sets: [{ repo: 'demo', freshness: 'no-witness' }] });

  assert.deepEqual(freshnessOf(null, [routeSet({ headSha: head, dirty: false, dirtyDigest: clean })]),
    { value: 'unknown', sets: [{ repo: 'demo', freshness: 'not-observed' }] });

  assert.deepEqual(
    freshnessOf(root, [routeSet({ headSha: head, dirty: false, dirtyDigest: clean }), routeSet()]),
    { value: 'unknown', sets: [{ repo: 'demo', freshness: 'matching' }, { repo: 'demo', freshness: 'no-witness' }] },
  );

  assert.deepEqual(
    freshnessOf(root, [routeSet({ headSha: 'a'.repeat(40), dirty: false, dirtyDigest: clean }), routeSet()]),
    { value: 'mismatched', sets: [{ repo: 'demo', freshness: 'head-stale' }, { repo: 'demo', freshness: 'no-witness' }] },
  );
});

test('Scope freshness AC-2: a legacy witness reads from the tree it can see, and reports head-stale when that tree is dirty', (t) => {
  const root = witnessRepo(t);
  const head = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'source.txt'), 'edited, uncommitted\n');
  assert.deepEqual(freshnessOf(root, [routeSet({ headSha: head, dirty: false })]),
    { value: 'mismatched', sets: [{ repo: 'demo', freshness: 'worktree-stale' }] });
  assert.deepEqual(freshnessOf(root, [routeSet({ headSha: head, dirty: true })]),
    { value: 'mismatched', sets: [{ repo: 'demo', freshness: 'head-stale' }] });
});

test('Scope freshness AC-2: an unchanged input and observation yield byte-identical JSON at schema version 1', (t) => {
  const root = witnessRepo(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const sets = [routeSet({ headSha: head, dirty: false, dirtyDigest: dirtyDigestOf(root) })];
  const options = { area: 'area', keys: ['GET gizmos/v1/catalog'], repos: [{ id: 'demo', root }], gatePatterns: [] };
  const first = scope(sets, options);
  const second = scope(sets, options);
  assert.equal(first.schemaVersion, 1);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(second).includes('timestamp'), false);
});

test('Scope freshness AC-3: stale facts warn on stderr in both modes and keep the exit code at 0', (t) => {
  const dir = frozenCorpus(t);
  writeFileSync(join(dir, 'notes.txt'), 'moved\n');
  commitAll(dir, 'moved on');

  const human = runCli(['scope', '--config', CONFIG, '--area', AREA], { cwd: dir });
  assert.equal(human.status, 0);
  assert.match(human.stderr, /flowtrace: facts for api are stale/);
  assert.match(human.stdout, /^scope area: 2 routes — freshness: mismatched/m);
  assert.match(human.stdout, /^GET gizmos\/v1\/catalog — api:/m);

  const json = scopeJson(dir);
  assert.equal(json.status, 0);
  assert.match(json.stderr, /flowtrace: facts for api are stale/);
  const report = JSON.parse(json.stdout);
  assert.equal(report.freshness.value, 'mismatched');
  assert.deepEqual(report.routes.map((route) => route.key), KEYS);
});

test('Scope freshness AC-3: a worktree-only change warns without gating, and no witness claims nothing', (t) => {
  const dir = frozenCorpus(t);
  writeFileSync(join(dir, 'backend', 'src', 'Repositories', 'WidgetLedgerRepository.cs'), '// uncommitted\n', { flag: 'a' });

  const human = runCli(['scope', '--config', CONFIG, '--area', AREA], { cwd: dir });
  assert.equal(human.status, 0);
  assert.match(human.stderr, /not stale, gates nothing/);
  assert.match(human.stdout, /freshness: mismatched/);

  const plain = copyCorpus(t);
  writeFileSync(join(plain, AREA), AREA_TEXT);
  extract(plain, CONFIG);
  const unobserved = scopeJson(plain);
  assert.equal(unobserved.status, 0, unobserved.stderr);
  assert.equal(unobserved.stderr.includes('stale'), false);
  const report = JSON.parse(unobserved.stdout);
  assert.deepEqual(report.freshness, { value: 'unknown', sets: [{ repo: 'api', freshness: 'no-witness' }] });
  assert.equal(report.routes.length, 2);
});

test('Scope freshness AC-4: scope reports the classifier state that cover, trace and factState report', (t) => {
  const dir = frozenCorpus(t);
  writeFileSync(join(dir, 'notes.txt'), 'moved\n');
  commitAll(dir, 'moved on');

  const root = join(dir, 'backend');
  const document = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'api.json'), 'utf8'));
  const sets = [{
    repo: document.repo, kind: document.kind, facts: document.facts,
    headSha: document.headSha, dirty: document.dirty, dirtyDigest: document.dirtyDigest,
  }];
  const expected = factState(sets, [{ id: 'api', root }]);
  const direct = scope(sets, { area: 'area', keys: KEYS, repos: [{ id: 'api', root }], gatePatterns: [] });
  assert.deepEqual(direct.freshness, { value: expected.value, sets: expected.sets });

  const scopeRun = runCli(['scope', '--config', CONFIG, '--area', AREA, '--json'], { cwd: dir });
  const coverRun = runCli(['cover', '--config', CONFIG, '--area', AREA, '--json'], { cwd: dir });
  const traceRun = runCli(['trace', '--config', CONFIG, '--area', AREA, '--json'], { cwd: dir });
  for (const run of [scopeRun, coverRun, traceRun]) {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /flowtrace: facts for api are stale/);
  }
  const scopeReport = JSON.parse(scopeRun.stdout);
  assert.equal(scopeReport.freshness.value, expected.value);
  assert.deepEqual(scopeReport.freshness.sets, expected.sets);
  const traceStatus = JSON.parse(traceRun.stdout)[0].status;
  assert.equal(traceStatus.freshness, scopeReport.freshness.value);
  assert.deepEqual(traceStatus.factSets, scopeReport.freshness.sets);
});

test('Scope freshness AC-5: area usage stays exit 2, and key order, placeholders and the frozen walk stay unchanged', (t) => {
  const dir = frozenCorpus(t);

  const missing = runCli(['scope', '--config', CONFIG], { cwd: dir });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /scope requires --area <file\|name>/);

  const unresolved = runCli(['scope', '--config', CONFIG, '--area', 'no-such-area', '--json'], { cwd: dir });
  assert.equal(unresolved.status, 2);
  assert.match(unresolved.stderr, /no area file at/);

  writeFileSync(join(dir, 'sparse.txt'), '# comment\n\nGET nowhere/v1/x\nGET gizmos/v1/catalog\n\n');
  const sparse = runCli(['scope', '--config', CONFIG, '--area', 'sparse.txt', '--json'], { cwd: dir });
  assert.equal(sparse.status, 0, sparse.stderr);
  const report = JSON.parse(sparse.stdout);
  assert.deepEqual(report.routes, [
    { key: 'GET nowhere/v1/x', repo: null, file: null, line: null, automation: 'no', serverGate: null },
    {
      key: 'GET gizmos/v1/catalog', repo: 'api', file: 'src/Controllers/GizmoController.cs',
      line: 17, automation: 'no', serverGate: null,
    },
  ]);
});

test('Scope freshness AC-7: help, generated CLI docs, the package inventory and the changelog state the snapshot contract', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /The rows describe the fact snapshot/);
  assert.match(help.stdout, /freshness: \{ value, sets \}/);
  assert.match(help.stdout, /warn on stderr in both modes/);
  assert.match(help.stdout, /Exit 0 the area resolved, 2 a missing or unresolvable/);
  assert.equal(help.stdout.includes('4 facts behind the repository HEAD'), false);

  const docs = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'docs-check.mjs')], { encoding: 'utf8' });
  assert.equal(docs.status, 0, docs.stderr);

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.split(' ').includes('selftest/scope-freshness.test.js'));

  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## Unreleased$/m);
  assert.match(changelog, /`scope --area` reads a fact snapshot/);
});
