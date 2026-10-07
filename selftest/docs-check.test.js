/**
 * `scripts/docs-check.mjs` fails, naming the file and the line, for every way the
 * documentation can drift from the code it describes: a link to something that is not
 * there, a fragment naming no heading, `docs/cli.md` behind `--help`, a file that cannot be
 * read, and a checkout whose own file listing fails. The last two matter most: a
 * documentation check that cannot read what it is checking must fail rather than report a
 * tree with nothing to check.
 *
 * Each case runs against a disposable copy of the checkout's `bin/`, `lib/`, the script and
 * its markdown, because the check derives the tree it reads from its own location.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './helpers.js';

const SCRIPT = join(REPO_ROOT, 'scripts', 'docs-check.mjs');

/** A disposable checkout carrying the CLI, the check and the given files. */
function tree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-docs-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(REPO_ROOT, 'bin'), join(dir, 'bin'), { recursive: true });
  cpSync(join(REPO_ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  cpSync(SCRIPT, join(dir, 'scripts', 'docs-check.mjs'));
  // The command reference this check writes links the two documents the CLI's help header
  // names, so a tree that has the reference has them too.
  const withHeaderTargets = { 'docs/getting-started.md': '# Getting started\n', 'docs/concepts.md': '# Concepts\n', ...files };
  for (const [path, text] of Object.entries(withHeaderTargets)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

function docsCheck(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'docs-check.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The `docs/cli.md` a run writes, so a tree can start from a document that matches --help. */
function writtenCliDoc(dir) {
  const result = docsCheck(dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

/** A permission failure needs a non-root account on a POSIX system. */
function cannotWithholdReads(t) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    t.skip('a permission failure needs a non-root account on a POSIX system');
    return true;
  }
  return false;
}

test('a tree whose documentation matches the CLI passes', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  const result = docsCheck(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'docs-check: ok\n');
});

test('a relative link to a file that is not there is reported with its line', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  writeFileSync(join(dir, 'docs', 'README.md'), '# Docs\n\nSee [the guide](guide.md).\n');
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/README\.md:3: link target does not exist: guide\.md/);
});

test('a fragment naming no heading is reported', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n', 'docs/guide.md': '# The Guide\n' });
  writtenCliDoc(dir);
  writeFileSync(join(dir, 'docs', 'README.md'), '# Docs\n\nSee [the other part](guide.md#the-other-part).\n');
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/README\.md:3: no heading "#the-other-part" in docs\/guide\.md/);
});

test('a missing command reference is reported with the command that writes it', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/cli\.md is missing; run: node scripts\/docs-check\.mjs --write/);
});

test('a command reference behind --help is reported with the command that rewrites it', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n', 'docs/cli.md': 'stale\n' });
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/cli\.md is behind `flowtrace --help`; run: node scripts\/docs-check\.mjs --write/);
});

test('a markdown file that cannot be read is reported by name', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  if (cannotWithholdReads(t)) return;
  chmodSync(join(dir, 'docs', 'README.md'), 0o000);
  t.after(() => {
    if (existsSync(join(dir, 'docs', 'README.md'))) chmodSync(join(dir, 'docs', 'README.md'), 0o600);
  });
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/README\.md: cannot be read \(.+\); restore it or fix its permissions/);
});

test('a checkout that cannot list its own files fails instead of checking the few it can walk', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  // An index git refuses to parse still leaves the tree "inside a work tree", which is the
  // state that must not fall back to the walk: the listing broke, not the checkout.
  const index = join(dir, 'unreadable-index');
  writeFileSync(index, 'not an index\n');
  const result = docsCheck(dir, [], { GIT_INDEX_FILE: index });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs-check: could not list the markdown files \([\s\S]+\); fix the git failure and rerun/);
  assert.doesNotMatch(result.stdout, /docs-check: ok/);
});
