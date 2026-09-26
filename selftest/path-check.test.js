/**
 * `scripts/path-check.sh` keeps the machine a change was written on out of the published tree.
 * In a linked worktree `.git` is a one-line pointer file naming the main checkout's git
 * directory, so it holds a home path on every contributor machine and must never be scanned,
 * while every other file, including one whose name merely ends in `.git`, still must be.
 *
 * The pointer is written by hand rather than made with `git worktree add`: a worktree created
 * under the temp directory points at a temp path the pattern does not match, so it would pass
 * with or without the exclusion. Machine-shaped strings are assembled at run time because the
 * check scans this file too.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/path-check.sh', import.meta.url));

const HOME = ['', 'Users', 'selftest-user'].join('/');
const LINUX_HOME = ['', 'home', 'selftest-user'].join('/');
const WINDOWS_HOME = ['C:', 'Users', 'selftest-user', 'src'].join('\\');
const FILE_URL = ['file:', '', '', 'srv', 'data.json'].join('/');
const POINTER = `gitdir: ${HOME}/src/project/.git/worktrees/some-branch\n`;

function bashUnavailable() {
  if (process.platform === 'win32') return 'the path check is a bash script and is not run on Windows';
  const probe = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'bash is not available';
  return false;
}

const skip = bashUnavailable();

/** A disposable tree holding the check at `scripts/path-check.sh` (it scans its own parent
 * directory) plus the given files. `.git` is a pointer file unless the caller supplies a
 * `.git/` directory instead. */
function tree(t, files, { pointer = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-path-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'path-check.sh'));
  if (pointer) writeFileSync(join(dir, '.git'), POINTER);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function pathCheck(dir) {
  const result = spawnSync('bash', ['scripts/path-check.sh'], { cwd: dir, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

/** The files named by a failing run, sorted, one per hit line under the heading. */
function namedFiles(stderr) {
  const [heading, ...hits] = stderr.trimEnd().split('\n');
  assert.equal(heading, 'path-check: absolute machine paths found');
  return [...new Set(hits.map((line) => line.slice(0, line.indexOf(':'))))].sort();
}

function assertClean(result) {
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
  assert.equal(result.status, 0);
}

function assertNames(result, expected) {
  assert.equal(result.stdout, '');
  assert.deepEqual(namedFiles(result.stderr), expected);
  assert.equal(result.status, 1);
}

test('a worktree pointer file with a home-shaped gitdir is not reported', { skip }, (t) => {
  const dir = tree(t, { 'README.md': 'nothing machine-shaped here\n' });
  assertClean(pathCheck(dir));
});

test('a pointer file in a nested directory is not reported either', { skip }, (t) => {
  const dir = tree(t, { 'nested/.git': POINTER });
  assertClean(pathCheck(dir));
});

test('a home-shaped file inside a .git directory is not reported', { skip }, (t) => {
  const dir = tree(t, { '.git/config': `[remote "origin"]\n\turl = ${HOME}/src/project\n` }, { pointer: false });
  assertClean(pathCheck(dir));
});

test('a home path in an ordinary file beside the pointer is reported by name', { skip }, (t) => {
  const dir = tree(t, { 'notes.md': `built in ${HOME}/src/project\n` });
  assertNames(pathCheck(dir), ['./notes.md']);
});

test('a home path in a nested file is reported by name', { skip }, (t) => {
  const dir = tree(t, { 'docs/deep/guide.md': `see ${HOME}/src/project/guide\n` });
  assertNames(pathCheck(dir), ['./docs/deep/guide.md']);
});

test('a file whose name only ends in .git is still scanned', { skip }, (t) => {
  const dir = tree(t, { 'vendor.git': `origin ${HOME}/mirrors/vendor\n`, 'nested/lib.git': `${HOME}/x\n` });
  assertNames(pathCheck(dir), ['./nested/lib.git', './vendor.git']);
});

test('every machine-path shape is still reported beside the pointer', { skip }, (t) => {
  const dir = tree(t, {
    'mac.txt': `${HOME}/a\n`,
    'linux.txt': `${LINUX_HOME}/a\n`,
    'windows.txt': `${WINDOWS_HOME}\n`,
    'url.txt': `${FILE_URL}\n`,
  });
  assertNames(pathCheck(dir), ['./linux.txt', './mac.txt', './url.txt', './windows.txt']);
});
