/**
 * `routes-of` is the one verb whose failure modes are still JSON on stdout (an "error
 * envelope"), not just a stderr line — see docs/cli.md. This checks both the resolved and
 * unresolved shapes carry the documented schemaVersion and verdict.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyCorpus, extract, runCli } from './helpers.js';

test('a resolved symbol reports schemaVersion 1 and the routes reaching it', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const { status, stdout, stderr } = runCli(
    ['routes-of', 'GizmoController.Activate', '--symbol', '--config', 'gizmo.config.json', '--json'],
    { cwd: dir },
  );
  assert.equal(status, 0, stderr);

  const result = JSON.parse(stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.resolution.status, 'resolved');
  assert.equal(result.verdict, 'routes');
  assert.ok(Array.isArray(result.routes));
  assert.ok(result.routes.some((r) => r.key === 'POST gizmos/v1/activate'));
});

test('an unresolved literal exits 2 but still emits a schemaVersioned JSON envelope', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const { status, stdout, stderr } = runCli(
    ['routes-of', 'not-a-real-literal-anywhere', '--literal', '--config', 'gizmo.config.json', '--json'],
    { cwd: dir },
  );
  assert.equal(status, 2);
  assert.equal(stderr, '', 'the failure is reported through the JSON envelope, not stderr');

  const result = JSON.parse(stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.resolution.status, 'unresolved');
  assert.equal(result.verdict, 'unresolved');
  assert.ok(!('routes' in result), 'an unresolved query returns no route set');
});
