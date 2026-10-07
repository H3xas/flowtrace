/**
 * `scripts/docs-check.mjs` fails, naming the file and the line, for every way the
 * documentation can drift from the code it describes: a link to something that is not
 * there, a fragment naming no heading, `docs/cli.md` behind `--help`, a file that cannot be
 * read, a checkout whose own listing or pointer fails, git pointed at another checkout by the
 * environment, and a directory the walk cannot list. Those last five matter most: a
 * documentation check that cannot read what it is checking must fail rather than report a
 * tree with nothing to check, and its repair must name the subsystem that actually failed.
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
function tree(t, files, { git = true } = {}) {
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
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

/** A `git` earlier on PATH than the real one, standing in for a git that cannot answer. */
function brokenGit(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-git-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH}` };
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

test('a tree outside any git checkout is walked, and its links are checked', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n\nSee [the guide](guide.md).\n', 'docs/guide.md': '# The Guide\n' }, { git: false });
  writtenCliDoc(dir);
  const result = docsCheck(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'docs-check: ok\n');
});

test('a git that cannot answer at all fails instead of walking a tree it may have failed to list', (t) => {
  if (process.platform === 'win32') {
    t.skip('a shell shim needs a POSIX system');
    return;
  }
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  const result = docsCheck(dir, [], brokenGit(t, 'exit 1'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs-check: could not list the markdown files \([\s\S]+\); fix the git failure and rerun/);
  assert.doesNotMatch(result.stdout, /docs-check: ok/);
});

test('a checkout whose own pointer no longer resolves fails instead of reporting clean', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  // The pointer is this checkout's own evidence and it is still there, so git reporting no
  // repository beside it is this checkout failing to answer, not an unpacked tree.
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  writeFileSync(join(dir, '.git'), `gitdir: ${join(dir, 'no-such-gitdir')}\n`);
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs-check: could not list the markdown files \([\s\S]+\); fix the git failure and rerun/);
  assert.doesNotMatch(result.stdout, /docs-check: ok/);
});

test('git pointed at another checkout by the environment fails instead of reporting clean', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  const other = tree(t, { 'docs/README.md': '# Other\n' });
  // Each of these changes what git enumerates, so a check that trusted the answer would be
  // vouching for a scope it never read.
  for (const [name, value] of [
    ['GIT_DIR', join(other, '.git')],
    ['GIT_INDEX_FILE', join(other, '.git', 'index')],
    ['GIT_WORK_TREE', other],
  ]) {
    const result = docsCheck(dir, [], { [name]: value });
    assert.equal(result.status, 1, `${name} was trusted`);
    assert.match(result.stderr, new RegExp(`docs-check: could not list the markdown files \\(git answers for another checkout while ${name} is set\\); unset ${name} and rerun`));
    assert.doesNotMatch(result.stdout, /docs-check: ok/);
  }
});

test('a directory the walk cannot read is named with its own repair, not git', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' }, { git: false });
  writtenCliDoc(dir);
  if (cannotWithholdReads(t)) return;
  const unreadable = join(dir, 'docs', 'unreadable');
  mkdirSync(unreadable, { recursive: true });
  chmodSync(unreadable, 0o000);
  let result;
  try {
    result = docsCheck(dir);
  } finally {
    // Restored before the tree's own cleanup: a directory that cannot be listed also cannot
    // be removed.
    chmodSync(unreadable, 0o700);
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/unreadable cannot be listed \(.+\); restore it or fix its permissions and rerun/);
  assert.doesNotMatch(result.stderr, /fix the git failure/);
  assert.doesNotMatch(result.stdout, /docs-check: ok/);
});

test('a checkout that cannot list its own files fails instead of checking the few it can walk', (t) => {
  const dir = tree(t, { 'docs/README.md': '# Docs\n' });
  writtenCliDoc(dir);
  // An index git refuses to parse still leaves the tree "inside a work tree", which is the
  // state that must not fall back to the walk: the listing broke, not the checkout.
  writeFileSync(join(dir, '.git', 'index'), 'not an index\n');
  const result = docsCheck(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs-check: could not list the markdown files \([\s\S]+\); fix the git failure and rerun/);
  assert.doesNotMatch(result.stdout, /docs-check: ok/);
});
