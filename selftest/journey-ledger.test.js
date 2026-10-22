/**
 * The journey pack's expected ledger against the pack's own sources: every site still sits on
 * the line its anchor names, every element the pack claims to contain has a site, and every
 * authored file is tracked, so a pack that silently lost a file or a line fails here before any
 * replay is compared.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './helpers.js';
import {
  COVERS,
  LedgerError,
  VOCABULARY,
  anchorProblems,
  argProblems,
  ledgerProblems,
  readLedger,
} from '../scripts/journey-pack/ledger.mjs';

const PACK = join(REPO_ROOT, 'selftest', 'corpus', 'greenhouse-alerts');
const LEDGER = join(PACK, 'expected.json');

function copyPack(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-journey-ledger-'));
  cpSync(PACK, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function packFiles(dir = PACK) {
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else found.push(relative(dir, path).split(sep).join('/'));
    }
  };
  visit(dir);
  return found.sort();
}

test('the committed ledger is valid and every site still holds its anchor', () => {
  const ledger = readLedger(LEDGER);
  assert.deepEqual(anchorProblems(LEDGER, ledger), []);
});

test('the ledger covers every journey shape the pack exists to pin', () => {
  const ledger = readLedger(LEDGER);
  const covered = new Set(ledger.cases.flatMap((entry) => entry.covers));
  for (const tag of [
    'nested-url',
    'component-name',
    'mount-vs-click',
    'alias-join',
    'check-order',
    'conditional-call',
    'repeated-call',
    'budget-traversal',
  ]) {
    assert.ok(covered.has(tag), `no case covers ${tag}`);
  }
  for (const tag of covered) assert.ok(COVERS.includes(tag));
  assert.deepEqual(ledger.vocabulary, [...VOCABULARY]);
});

test('every element the fixture claims to contain has a site of the right kind', () => {
  const ledger = readLedger(LEDGER);
  const kindOf = new Map(ledger.sites.map((site) => [site.id, site.kind]));
  const elements = {
    'nested route mounts': [['mount-greenhouse', 'mount'], ['mount-zone', 'mount'], ['mount-watchers', 'mount']],
    'lazily imported page': [['lazy-watchers-import', 'mount'], ['page-watcher-preferences', 'page']],
    'class component mount initialisation': [['mount-load-readings', 'lifecycle']],
    'hook effect initialisation': [['effect-load-watchers', 'lifecycle']],
    'selected save handler dispatching a thunk': [
      ['click-save-watchers', 'handler'],
      ['dispatch-save-watchers', 'dispatch'],
      ['thunk-save-watchers', 'thunk'],
    ],
    'gateway call joined through an alias': [['request-save-watchers', 'request'], ['route-put-watchers', 'route']],
    'authorisation check': [['check-identity', 'check'], ['check-access', 'check']],
    'watcher filtering': [['filter-eligible', 'filter']],
    'storage write': [['write-watchers', 'write']],
    'cache refresh': [['refresh-cache', 'cache']],
    'success and failure feedback': [['notice-saved', 'feedback'], ['notice-failed', 'feedback'], ['reject-empty-selection', 'branch']],
  };
  for (const [element, sites] of Object.entries(elements)) {
    for (const [id, kind] of sites) assert.equal(kindOf.get(id), kind, `${element}: site ${id}`);
  }
  const lazy = ledger.sites.find((site) => site.id === 'lazy-watchers-import');
  assert.match(lazy.anchor, /lazy\(/);
  const aliasCase = ledger.cases.find((entry) => entry.covers.includes('alias-join'));
  assert.ok(aliasCase.assertions.some((assertion) => assertion.kind === 'reached-from' && assertion.match === 'alias'));
  const config = JSON.parse(readFileSync(join(PACK, ledger.config), 'utf8'));
  assert.deepEqual(config.aliases, [{ from: 'greenhouse/', to: 'glasshouse/' }]);
});

test('the two budget runs differ only in their node budget', () => {
  const ledger = readLedger(LEDGER);
  const budget = ledger.cases.filter((entry) => entry.covers.includes('budget-traversal'));
  assert.equal(budget.length, 2);
  const [small, large] = budget.map((entry) => ledger.runs.find((run) => run.id === entry.run));
  assert.equal(small.start, large.start);
  assert.deepEqual(small.reach, large.reach);
  const without = (args) => {
    const copy = args.slice();
    const at = copy.indexOf('--max-nodes');
    return { rest: [...copy.slice(0, at), ...copy.slice(at + 2)], budget: Number(copy[at + 1]) };
  };
  assert.deepEqual(without(small.args).rest, without(large.args).rest);
  assert.ok(without(small.args).budget < without(large.args).budget);
  assert.deepEqual(budget[0].expect, budget[1].expect);
});

test('pack paths avoid every name the repository ignores or the extractors skip', () => {
  const forbidden = new Set(['test', 'fixtures', 'out', 'bin', 'obj', 'dist', 'node_modules']);
  for (const file of packFiles()) {
    const parts = file.split('/');
    for (const part of parts) assert.ok(!forbidden.has(part), `${file} has a path component named ${part}`);
    assert.notEqual(parts.at(-1), 'flowtrace.config.json', `${file} would be ignored as a machine-local configuration`);
    if (parts[0] === 'backend') assert.ok(!/Tests|automation/.test(file), `${file} would be skipped by the backend extractor`);
    assert.match(file, /^[\x20-\x7e]+$/);
  }
});

test('every file in the pack is tracked and none is ignored', (t) => {
  const git = (...args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (git('rev-parse', '--is-inside-work-tree').stdout.trim() !== 'true') {
    t.skip('not a git work tree');
    return;
  }
  const prefix = relative(REPO_ROOT, PACK).split(sep).join('/');
  const listed = new Set(git('ls-files', '--', prefix).stdout.split('\n').filter(Boolean));
  const files = packFiles().map((file) => `${prefix}/${file}`);
  for (const file of files) assert.ok(listed.has(file), `${file} is not tracked`);
  const ignored = git('check-ignore', '--no-index', '--', ...files).stdout.trim();
  assert.equal(ignored, '');
});

test('a site whose line no longer holds its anchor is reported, not re-found', (t) => {
  const dir = copyPack(t);
  const target = join(dir, 'backend', 'src', 'Services', 'WatcherService.cs');
  writeFileSync(target, `\n${readFileSync(target, 'utf8')}`);
  const ledgerFile = join(dir, 'expected.json');
  const problems = anchorProblems(ledgerFile, readLedger(ledgerFile));
  assert.ok(problems.some((problem) => problem.includes('check-identity') && problem.includes('does not hold its anchor')));
});

test('a site path that leaves its repository root is refused', (t) => {
  const dir = copyPack(t);
  const ledgerFile = join(dir, 'expected.json');
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  ledger.sites[0].file = '../web/src/app/AppRoutes.tsx';
  assert.ok(ledgerProblems(ledger).some((problem) => problem.includes('inside its repository')));
  ledger.sites[0].file = '/src/app/AppRoutes.tsx';
  assert.ok(ledgerProblems(ledger).some((problem) => problem.includes('inside its repository')));
});

test('a site reached through a link that leaves its repository root is refused', (t) => {
  const dir = copyPack(t);
  const outside = mkdtempSync(join(tmpdir(), 'flowtrace-journey-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'Escape.tsx'), 'export const escape = 1;\n');
  symlinkSync(outside, join(dir, 'web', 'src', 'linked'));
  const ledgerFile = join(dir, 'expected.json');
  const ledger = readLedger(ledgerFile);
  ledger.sites[0].file = 'src/linked/Escape.tsx';
  ledger.sites[0].line = 1;
  ledger.sites[0].anchor = 'escape';
  assert.ok(anchorProblems(ledgerFile, ledger).some((problem) => problem.includes('outside its repository root')));
});

test('a run may not choose its own output, configuration or unknown flags', () => {
  assert.deepEqual(argProblems(['--depth', '6', '--max-nodes', '24', '--seeds', '--expand']), []);
  for (const bad of [['--config', 'other.json'], ['--json'], ['--graph'], ['--html', 'x.html'], ['--out', 'x'], ['--max-nodes', '0'], ['--depth']]) {
    assert.notDeepEqual(argProblems(bad), [], bad.join(' '));
  }
});

test('ids are lowercase, unique across tables, and every reference resolves', () => {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  assert.deepEqual(ledgerProblems(ledger), []);
  const duplicate = structuredClone(ledger);
  duplicate.unknowns[0].id = duplicate.sites[0].id;
  assert.ok(ledgerProblems(duplicate).some((problem) => problem.includes('already used')));
  const upper = structuredClone(ledger);
  upper.cases[0].id = 'Nested-Page';
  assert.ok(ledgerProblems(upper).some((problem) => problem.includes('not a lowercase id')));
  const dangling = structuredClone(ledger);
  dangling.cases[0].expect.push('no-such-site');
  assert.ok(ledgerProblems(dangling).some((problem) => problem.includes('no-such-site')));
  assert.throws(() => {
    const problems = ledgerProblems(dangling);
    if (problems.length > 0) throw new LedgerError(problems);
  }, LedgerError);
});
