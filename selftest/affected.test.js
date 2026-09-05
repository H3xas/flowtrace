/**
 * `affected`'s exit code is the shape of its answer (docs/cli.md): 0 a list was produced,
 * 3 nothing was affected, 2 usage, 1 refusal, 4 the selection was widened. This checks the
 * two a contributor hits first without needing a real diff: the required-flag usage error,
 * and the clean "nothing changed" answer over a fresh git checkout of the corpus.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyGitCorpus, extract, runCli } from './helpers.js';

test('neither --area nor --all-routes exits 2 with a usage message', (t) => {
  const dir = copyGitCorpus(t);
  extract(dir);
  const { status, stdout, stderr } = runCli(['affected', '--config', 'gizmo.config.json', '--json'], { cwd: dir });
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /affected requires --area <file\|name> or --all-routes/);
});

test('a clean checkout with no diff exits 3 and reports nothing affected', (t) => {
  const dir = copyGitCorpus(t);
  extract(dir);
  const { status, stdout, stderr } = runCli(
    ['affected', '--config', 'gizmo.config.json', '--all-routes', '--json'],
    { cwd: dir },
  );
  assert.equal(status, 3, stderr);

  const result = JSON.parse(stdout);
  assert.equal(result.exit, 3);
  assert.deepEqual(result.changed.files, []);
  assert.deepEqual(result.routes, []);
  assert.equal(result.universe.source, 'all-routes');
});
