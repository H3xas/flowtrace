/**
 * Shared plumbing for the public contract suite: spawn the CLI exactly as a user would
 * (a child process, never an in-process import of `lib/`), and give each test its own
 * disposable copy of the synthetic corpus so `out/` writes and git state never touch the
 * tracked fixture or leak between tests.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const CLI = join(REPO_ROOT, 'bin', 'flowtrace.js');
export const CORPUS = join(HERE, 'corpus', 'gizmo-shop');

/** Runs the CLI as a subprocess, the way a user's shell would. */
export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? REPO_ROOT,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Copies the synthetic corpus into a fresh temp directory, registered for cleanup on
 * `t` (a node:test TestContext). Returns the directory. */
export function copyCorpus(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-selftest-'));
  cpSync(CORPUS, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Same as copyCorpus, but also makes it a git checkout with one commit and `out/`
 * gitignored — what `affected` needs to read a diff against. */
export function copyGitCorpus(t) {
  const dir = copyCorpus(t);
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

export function extract(dir) {
  const result = runCli(['extract', '--config', 'gizmo.config.json'], { cwd: dir });
  if (result.status !== 0) {
    throw new Error(`fixture extract failed: ${result.stderr}`);
  }
  return result;
}
