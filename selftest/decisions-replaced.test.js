/**
 * The decisions verb names the commit that replaced a `changed-later` line, on a git working
 * tree built per test:
 *
 *   base  the first commit
 *   a     adds two lines to one method
 *   b     replaces the first line that `a` added
 *   c     replaces the second line that `a` added, and is never listed
 *   e1 e2 two commits on a side branch: `e1` adds a line, `e2` replaces it, and `m` merges them
 *
 * The facts are extracted at `m`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from './helpers.js';

const CONFIG = 'yard.config.json';
const FILE = 'src/ledger/LedgerService.ts';

const BASE = `export class LedgerService {
  label(entry: Entry): string {
    return entry.name;
  }

  shelf(entry: Entry): number {
    return entry.size;
  }
}
`;

const A = BASE.replace('    return entry.name;\n', "    const shown = entry.name ?? 'none';\n    const kept = entry.open ? 1 : 0;\n    return entry.name;\n");
const B = A.replace("const shown = entry.name ?? 'none';", 'const shown = entry.title;');
const C = B.replace('const kept = entry.open ? 1 : 0;', 'const kept = entry.open && 1;');
const E1 = C.replace('    return entry.size;\n', '    const width = entry.size > 2 ? 2 : 1;\n    return entry.size;\n');
const E2 = E1.replace('const width = entry.size > 2 ? 2 : 1;', 'const width = entry.size;');

function build(t) {
  const root = mkdtempSync(join(tmpdir(), 'flowtrace-replaced-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'yard');
  mkdirSync(dir);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const record = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  write('.gitignore', 'out/\n');
  write(CONFIG, `${JSON.stringify({ out: 'out', repos: [{ id: 'web', kind: 'web', root: 'web' }] }, null, 2)}\n`);
  write(`web/${FILE}`, BASE);
  const shas = { base: record('base') };
  write(`web/${FILE}`, A);
  shas.a = record('a');
  write(`web/${FILE}`, B);
  shas.b = record('b');
  write(`web/${FILE}`, C);
  shas.c = record('c');
  git('checkout', '-q', '-b', 'side');
  write(`web/${FILE}`, E1);
  shas.e1 = record('e1');
  write(`web/${FILE}`, E2);
  shas.e2 = record('e2');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'm', 'side');
  shas.m = git('rev-parse', 'HEAD');

  const cli = (args) => runCli([...args, '--config', CONFIG], { cwd: dir });
  const extracted = cli(['extract']);
  if (extracted.status !== 0) throw new Error(`fixture extract failed: ${extracted.stderr}`);
  return { shas, cli };
}

const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

test('Decisions replaced lines AC-6: a changed-later row names the listed commit that replaced its line', (t) => {
  const env = build(t);
  const run = (args) => {
    const result = env.cli(['decisions', ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const revs = `${env.shas.a},${env.shas.b}`;
  const first = run(['--revs', revs, '--json']);
  assert.equal(run(['--revs', revs, '--json']), first, 'two runs give the same bytes');
  const doc = JSON.parse(first);
  assert.equal(doc.schemaVersion, 1);
  const later = doc.unmapped.filter((row) => row.reason === 'changed-later');
  assert.deepEqual(
    later.map((row) => [row.file, row.line, row.commit, row.lastCommit, row.replacedBy]),
    [
      [FILE, lineOf(A, 'const shown'), env.shas.a, env.shas.a, { commit: env.shas.b, revision: env.shas.b }],
      [FILE, lineOf(A, 'const kept'), env.shas.a, env.shas.b, null],
    ],
  );

  const text = run(['--revs', revs]);
  const short = (sha) => sha.slice(0, 12);
  const rowOf = (needle) => text.split('\n').find((line) => line.includes(`${FILE}:${needle} changed-later`));
  assert.equal(
    rowOf(lineOf(A, 'const shown')).trim(),
    `web ${FILE}:${lineOf(A, 'const shown')} changed-later in ${short(env.shas.a)} last held in ${short(env.shas.a)} replaced by ${short(env.shas.b)} in ${short(env.shas.b)}`,
  );
  assert.equal(
    rowOf(lineOf(A, 'const kept')).trim(),
    `web ${FILE}:${lineOf(A, 'const kept')} changed-later in ${short(env.shas.a)} last held in ${short(env.shas.b)}`,
  );

  const merged = JSON.parse(run(['--revs', env.shas.m, '--json']));
  const inMerge = merged.unmapped.filter((row) => row.reason === 'changed-later');
  assert.deepEqual(
    inMerge.map((row) => [row.line, row.commit, row.lastCommit, row.replacedBy]),
    [[lineOf(E1, 'const width'), env.shas.e1, env.shas.e1, { commit: env.shas.e2, revision: env.shas.m }]],
  );
});
