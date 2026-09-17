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

/** Copies one named fixture under `corpus/` into a fresh temp directory, registered for
 * cleanup on `t` (a node:test TestContext). Returns the directory. */
export function copyFixture(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-selftest-'));
  cpSync(join(HERE, 'corpus', name), dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies the synthetic corpus into a fresh temp directory, registered for cleanup on
 * `t` (a node:test TestContext). Returns the directory. */
export function copyCorpus(t) {
  return copyFixture(t, 'gizmo-shop');
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

/** A provider document stating one route the corpus extractor does not, named `action`, so
 * two documents that differ only in `action` compare to the extraction with equal counts. */
export function providerDocument({ producer = 'route-lister', version = '2.1.0', action = 'Archive' } = {}) {
  return {
    producer,
    version,
    facts: [
      {
        type: 'route',
        file: 'src/Controllers/GizmoController.cs',
        line: 90,
        controller: 'GizmoController',
        action,
        verb: 'POST',
        template: 'gizmos/v1/archive',
      },
    ],
  };
}

/** Writes `<name>` beside the corpus configuration: the same `api` repository, taking
 * `provider.json` under `merge` when given one, plus any `extraRepos`, writing under `out`. */
export function writeConfig(dir, name, { merge = null, extraRepos = [], out = 'out' } = {}) {
  const api = { id: 'api', kind: 'backend', root: 'backend', role: ['api'] };
  if (merge) api.factsProvider = { file: 'provider.json', merge };
  writeFileSync(join(dir, name), `${JSON.stringify({ out, repos: [api, ...extraRepos] }, null, 2)}\n`);
}

export function writeJsonFile(dir, name, value) {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export function extract(dir, config = 'gizmo.config.json') {
  const result = runCli(['extract', '--config', config], { cwd: dir });
  if (result.status !== 0) {
    throw new Error(`fixture extract failed: ${result.stderr}`);
  }
  return result;
}
