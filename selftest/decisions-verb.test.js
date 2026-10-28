/**
 * The decisions verb on a git working tree built per test: a backend root and a web root in
 * one tree, a playwright root beside them, and a history whose commits the tests name.
 *
 *   base  the first commit
 *   a     changes a web condition, a backend condition, a web line a later commit replaces,
 *         and files that no fact covers
 *   b     adds a web method with three ternaries on one line, deletes a method, adds a draft
 *   c     replaces the line `a` added
 *   d     deletes the draft
 *   e1 e2 two commits on a side branch, merged by `m`
 *   s     a commit on a branch that is never merged
 *
 * The facts are extracted at `m`, so every listing reads the tree as `m` holds it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from './helpers.js';

const CONFIG = 'kiln.config.json';

const BACKEND = `namespace KilnYard.Api.Services
{
    public class TallyService
    {
        public int Count(int a)
        {
            if (a > 0)
            {
                return a;
            }
            return 0;
        }

        public int Other(int b)
        {
            return b;
        }
    }
}
`;

const WEB_BASE = `export class LedgerService {
  constructor(private http: HttpClient) {}

  pick(entry: Entry): string {
    if (entry.open) {
      return 'open';
    }
    return 'closed';
  }

  label(entry: Entry): string {
    return entry.name;
  }

  quiet(): number {
    return 1;
  }
}
`;

const WEB_A = WEB_BASE.replace('if (entry.open) {', 'if (entry.open && entry.total > 0) {')
  .replace('return entry.name;', "return entry.name ?? 'none';")
  .concat('export const LIMIT = 3;\n');

const RANK = '  rank(x: number): number { return x > 3 ? 1 : x > 2 ? 2 : x > 1 ? 3 : 4; }\n';

const WEB_B = WEB_A.replace("    return 'closed';\n  }\n", `    return 'closed';\n  }\n${RANK}`).replace(`
  quiet(): number {
    return 1;
  }
`, '');

const WEB_C = WEB_B.replace("return entry.name ?? 'none';", 'return entry.title;');

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function makeGit(dir) {
  return (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
}

function commit(git, message) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

function build(t) {
  const root = mkdtempSync(join(tmpdir(), 'flowtrace-decisions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'yard');
  mkdirSync(dir);
  const git = makeGit(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  write(dir, '.gitignore', 'out/\n');
  write(dir, CONFIG, `${JSON.stringify({
    out: 'out',
    repos: [
      { id: 'backend', kind: 'backend', root: 'backend', role: ['api'] },
      { id: 'web', kind: 'web', root: 'web', exclude: ['src/legacy'] },
      { id: 'e2e', kind: 'playwright', root: 'e2e' },
    ],
  }, null, 2)}\n`);
  write(dir, 'backend/src/Services/TallyService.cs', BACKEND);
  write(dir, 'web/src/ledger/LedgerService.ts', WEB_BASE);
  write(dir, 'e2e/tests/ledger.pw.ts', "import { test } from '@playwright/test';\n");
  const shas = { base: commit(git, 'base') };

  write(dir, 'web/src/ledger/LedgerService.ts', WEB_A);
  write(dir, 'backend/src/Services/TallyService.cs', BACKEND.replace('if (a > 0)', 'if (a > 1)'));
  write(dir, 'README.md', 'kiln yard\n');
  write(dir, 'web/src/legacy/Old.ts', 'export const OLD = 1;\n');
  write(dir, 'web/package.json', '{ "name": "kiln-web" }\n');
  write(dir, 'e2e/tests/ledger.pw.ts', "import { test } from '@playwright/test';\ntest('ledger', async () => {});\n");
  shas.a = commit(git, 'a');

  write(dir, 'web/src/ledger/LedgerService.ts', WEB_B);
  write(dir, 'web/src/ledger/Draft.ts', 'export const DRAFT = 1;\n');
  shas.b = commit(git, 'b');

  write(dir, 'web/src/ledger/LedgerService.ts', WEB_C);
  shas.c = commit(git, 'c');

  unlinkSync(join(dir, 'web/src/ledger/Draft.ts'));
  shas.d = commit(git, 'd');

  git('checkout', '-q', '-b', 'side');
  write(dir, 'web/src/ledger/Shelf.ts', 'export class Shelf {\n  size(n: number): number {\n    return n;\n  }\n}\n');
  shas.e1 = commit(git, 'e1');
  write(dir, 'web/src/ledger/Shelf.ts', 'export class Shelf {\n  size(n: number): number {\n    return n > 0 ? n : 0;\n  }\n}\n');
  shas.e2 = commit(git, 'e2');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'm', 'side');
  shas.m = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'stray', shas.d);
  write(dir, 'web/src/ledger/Stray.ts', 'export const STRAY = 1;\n');
  shas.s = commit(git, 's');
  git('checkout', '-q', 'main');

  const cli = (args) => runCli([...args, '--config', CONFIG], { cwd: dir });
  const extracted = cli(['extract']);
  if (extracted.status !== 0) throw new Error(`fixture extract failed: ${extracted.stderr}`);
  const json = (args) => {
    const result = cli(['decisions', ...args, '--json']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, dir, git, shas, cli, json };
}

function lineOf(text, needle) {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, needle);
  return index + 1;
}

const unitNames = (doc) => doc.units.map((unit) => `${unit.repo}:${unit.class}.${unit.method}`);

test('Decisions verb AC-4: changed units and decisions of two revisions', (t) => {
  const env = build(t);
  const doc = env.json(['--revs', `${env.shas.a.slice(0, 7)},${env.shas.b}`]);
  assert.deepEqual(unitNames(doc), ['backend:TallyService.Count', 'web:LedgerService.pick', 'web:LedgerService.rank']);

  const count = doc.units[0];
  const condition = lineOf(BACKEND, 'if (a > 0)');
  assert.equal(count.file, 'src/Services/TallyService.cs');
  assert.deepEqual(count.changedLines, [condition]);
  assert.deepEqual(count.revisions, [env.shas.a]);
  assert.ok(count.line < condition && count.endLine > condition);
  assert.deepEqual(count.decisions.map((decision) => decision.id), [`backend:src/Services/TallyService.cs:${condition}:if`]);

  const pick = doc.units[1];
  const ifLine = lineOf(WEB_C, 'if (entry.open && entry.total > 0)');
  assert.deepEqual(pick.changedLines, [ifLine]);
  assert.deepEqual(pick.decisions.map((decision) => [decision.id, decision.kind, decision.text, decision.line]), [
    [`web:src/ledger/LedgerService.ts:${ifLine}:if`, 'if', 'if (entry.open && entry.total > 0)', ifLine],
  ]);

  const rank = doc.units[2];
  const rankLine = lineOf(WEB_C, 'return x > 3');
  assert.deepEqual(rank.revisions, [env.shas.b]);
  assert.deepEqual(rank.changedLines, [rankLine]);
  const base = `web:src/ledger/LedgerService.ts:${rankLine}:ternary`;
  assert.deepEqual(rank.decisions.map((decision) => decision.id), [base, `${base}#2`, `${base}#3`]);

  assert.ok(!unitNames(doc).includes('web:LedgerService.label'), 'a unit whose changed line a later commit replaced is not listed');
  assert.ok(!unitNames(doc).includes('web:LedgerService.constructor'));
});

test('Decisions verb AC-5: lines that do not map', (t) => {
  const env = build(t);
  const doc = env.json(['--revs', `${env.shas.a},${env.shas.b}`]);
  const byReason = (reason) => doc.unmapped.filter((row) => row.reason === reason);

  const later = byReason('changed-later');
  assert.deepEqual(later.map((row) => [row.repo, row.file, row.line, row.commit, row.lastCommit]), [
    ['web', 'src/ledger/LedgerService.ts', lineOf(WEB_A, "return entry.name ?? 'none';"), env.shas.a, env.shas.b],
  ]);

  const deletions = byReason('deletion-only');
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].commit, env.shas.b);
  assert.equal(deletions[0].file, 'src/ledger/LedgerService.ts');

  const gone = byReason('file-gone');
  assert.deepEqual(gone.map((row) => [row.repo, row.file, row.commit]), [['web', 'src/ledger/Draft.ts', env.shas.b]]);
});

test('Decisions verb AC-5: a file renamed after the revision is file-gone at its old path', (t) => {
  const env = build(t);
  env.git('mv', 'web/src/ledger/Shelf.ts', 'web/src/ledger/Rack.ts');
  env.git('commit', '-q', '-m', 'rename');
  assert.equal(env.cli(['extract']).status, 0);
  const doc = env.json(['--revs', env.shas.e1]);
  assert.deepEqual(doc.unmapped.map((row) => [row.reason, row.file]), [['file-gone', 'src/ledger/Shelf.ts']]);
  assert.deepEqual(doc.units, []);
});

test('Decisions verb AC-6: lines outside units and files the facts cannot read', (t) => {
  const env = build(t);
  const doc = env.json(['--revs', env.shas.a]);
  assert.deepEqual(doc.outsideUnits.map((row) => [row.repo, row.file, row.line]), [
    ['web', 'src/ledger/LedgerService.ts', lineOf(WEB_C, 'export const LIMIT = 3;')],
  ]);
  assert.deepEqual(doc.notExtracted.map((row) => [row.repo, row.file, row.reason]), [
    [null, 'README.md', 'no-root'],
    ['e2e', 'tests/ledger.pw.ts', 'not-source'],
    ['web', 'package.json', 'no-facts'],
    ['web', 'src/legacy/Old.ts', 'excluded'],
  ]);
});

test('Decisions verb AC-7: revision resolution', (t) => {
  const env = build(t);

  const merged = env.json(['--revs', env.shas.m]);
  assert.equal(merged.revisions[0].merge, true);
  assert.deepEqual(merged.revisions[0].commits, [env.shas.e1, env.shas.e2, env.shas.m]);
  assert.deepEqual(unitNames(merged), ['web:Shelf.size']);
  assert.deepEqual(merged.units[0].decisions.map((decision) => decision.kind), ['ternary']);
  assert.match(env.cli(['decisions', '--revs', env.shas.m]).stdout, new RegExp(`merge of ${env.shas.e1.slice(0, 12)} ${env.shas.e2.slice(0, 12)}`));

  const stray = env.cli(['decisions', '--revs', env.shas.s, '--json']);
  assert.equal(stray.status, 0, stray.stderr);
  const strayDoc = JSON.parse(stray.stdout);
  assert.deepEqual(strayDoc.revisions[0].repos, [{ repo: 'web', status: 'not-ancestor' }]);
  assert.deepEqual(strayDoc.units, []);
  assert.deepEqual(strayDoc.unmapped, []);

  const rootCommit = env.json(['--revs', env.shas.base]);
  assert.deepEqual(rootCommit.revisions[0].commits, [env.shas.base]);
  assert.ok(unitNames(rootCommit).includes('backend:TallyService.Other'));
  assert.ok(unitNames(rootCommit).includes('web:LedgerService.constructor'));

  const shared = env.json(['--revs', env.shas.a]);
  assert.deepEqual([...new Set(shared.units.map((unit) => unit.repo))], ['backend', 'web']);
  assert.deepEqual(shared.revisions[0].repos, [
    { repo: 'backend', status: 'ancestor' },
    { repo: 'web', status: 'ancestor' },
  ]);

  const none = env.cli(['decisions', '--revs', '0123456789abcdef']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /revision 0123456789abcdef resolves in 0 working trees/);

  const mirror = join(env.root, 'mirror');
  spawnSync('git', ['clone', '-q', env.dir, mirror], { encoding: 'utf8' });
  write(env.dir, 'two.config.json', `${JSON.stringify({
    out: 'out',
    repos: [
      { id: 'backend', kind: 'backend', root: 'backend', role: ['api'] },
      { id: 'web', kind: 'web', root: 'web', exclude: ['src/legacy'] },
      { id: 'copy', kind: 'web', root: '../mirror/web' },
    ],
  }, null, 2)}\n`);
  const two = runCli(['decisions', '--revs', env.shas.a, '--config', 'two.config.json'], { cwd: env.dir });
  assert.equal(two.status, 1);
  assert.match(two.stderr, new RegExp(`revision ${env.shas.a} resolves in 2 working trees`));
  const limited = runCli(['decisions', '--revs', env.shas.a, '--repo', 'web', '--json', '--config', 'two.config.json'], { cwd: env.dir });
  assert.equal(limited.status, 0, limited.stderr);
  assert.deepEqual(JSON.parse(limited.stdout).units, shared.units);

  const unknown = env.cli(['decisions', '--revs', env.shas.a, '--repo', 'nowhere']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--repo nowhere: no configured repository with that id/);
});

test('Decisions verb AC-8: refused input', (t) => {
  const env = build(t);
  const refusal = 'flowtrace: decisions requires --revs <sha>[,<sha>...]: 7 to 40 hex characters each';
  const malformed = [
    [],
    ['--revs'],
    ['--revs', '--json'],
    ['--revs='],
    ['--revs', ''],
    ['--revs', ','],
    ['--revs', `${env.shas.a},`],
    ['--revs', `${env.shas.a},,${env.shas.b}`],
    ['--revs', 'abcdef'],
    ['--revs', `${env.shas.a}0`],
    ['--revs', 'abcdefg'],
  ];
  for (const args of malformed) {
    const result = env.cli(['decisions', ...args]);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stderr.split('\n')[0], refusal, args.join(' '));
  }
  assert.equal(env.cli(['trace', 'X', '--revs', env.shas.a]).status, 2);

  const facts = join(env.dir, 'out', 'facts', 'web.json');
  const original = readFileSync(facts, 'utf8');
  const rewrite = (change) => {
    const set = JSON.parse(original);
    change(set);
    writeFileSync(facts, JSON.stringify(set));
  };
  const refused = (pattern) => {
    const result = env.cli(['decisions', '--revs', env.shas.a]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /web: .*run "flowtrace extract" on a clean checkout/);
  };
  rewrite((set) => delete set.headSha);
  refused(/web: the fact set has no headSha/);
  rewrite((set) => {
    set.dirty = true;
  });
  refused(/web: the fact set was extracted from a dirty working tree/);
  unlinkSync(facts);
  refused(/web: the fact set is missing/);
});

test('Decisions verb AC-9: output contract', (t) => {
  const env = build(t);
  const args = ['decisions', '--revs', `${env.shas.a},${env.shas.b}`, '--json'];
  const first = env.cli(args);
  const second = env.cli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  const doc = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(doc), ['schemaVersion', 'revisions', 'repos', 'units', 'outsideUnits', 'notExtracted', 'unmapped']);
  assert.equal(doc.schemaVersion, 1);
  assert.doesNotMatch(first.stdout, /generatedAt|timestamp/);
  assert.deepEqual(doc.repos.map((repo) => Object.keys(repo)), [
    ['id', 'kind', 'headSha', 'generatedFrom', 'decisionFacts'],
    ['id', 'kind', 'headSha', 'generatedFrom', 'decisionFacts'],
  ]);
  const webSet = JSON.parse(readFileSync(join(env.dir, 'out', 'facts', 'web.json'), 'utf8'));
  const web = doc.repos.find((repo) => repo.id === 'web');
  assert.equal(web.headSha, env.shas.m);
  assert.equal(web.decisionFacts, webSet.facts.filter((item) => item.type === 'branch_point').length);
  assert.equal(first.stderr, '');

  const text = env.cli(['decisions', '--revs', `${env.shas.a},${env.shas.b}`]);
  assert.equal(text.status, 0);
  for (const unit of doc.units) {
    assert.ok(text.stdout.includes(`${unit.repo} ${unit.file}:${unit.line}-${unit.endLine} ${unit.class}.${unit.method}`));
    for (const decision of unit.decisions) assert.ok(text.stdout.includes(`${decision.id} ${decision.kind} ${decision.text}`));
  }
  for (const row of doc.unmapped) assert.ok(text.stdout.includes(row.reason));
  for (const row of doc.notExtracted) assert.ok(text.stdout.includes(`${row.file} ${row.reason}`));
  assert.ok(text.stdout.includes('outside units: 1'));

  const backendFacts = join(env.dir, 'out', 'facts', 'backend.json');
  const backend = JSON.parse(readFileSync(backendFacts, 'utf8'));
  backend.facts = backend.facts.filter((item) => item.type !== 'branch_point');
  writeFileSync(backendFacts, JSON.stringify(backend));
  const warned = env.cli(args);
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /decisions: backend holds no branch_point fact.*run "flowtrace extract" again/);
});

test('Decisions verb AC-4: a changed path with a space and a non-ASCII letter maps like any other', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flowtrace-decisions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = makeGit(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  write(root, '.gitignore', 'out/\n');
  write(root, CONFIG, `${JSON.stringify({ out: 'out', repos: [{ id: 'web', kind: 'web', root: 'web' }] })}\n`);
  const file = 'src/Ledger Café.ts';
  write(root, `web/${file}`, 'export class Cafe {\n  pick(a: boolean) {\n    return 1;\n  }\n}\n');
  commit(git, 'base');
  write(root, `web/${file}`, 'export class Cafe {\n  pick(a: boolean) {\n    return a ? 1 : 2;\n  }\n}\n');
  write(root, 'web/src/Gone Café.ts', 'export const GONE = 1;\n');
  const a = commit(git, 'a');
  unlinkSync(join(root, 'web/src/Gone Café.ts'));
  commit(git, 'gone');
  const cli = (args) => runCli([...args, '--config', CONFIG], { cwd: root });
  assert.equal(cli(['extract']).status, 0);
  const result = cli(['decisions', '--revs', a, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.deepEqual(doc.units.map((unit) => [unit.file, unit.method, unit.changedLines, unit.decisions.map((d) => d.kind)]), [
    [file, 'pick', [3], ['ternary']],
  ]);
  assert.deepEqual(doc.unmapped.map((row) => [row.reason, row.file]), [['file-gone', 'src/Gone Café.ts']]);
  assert.deepEqual(doc.notExtracted, []);
});
