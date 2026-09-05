/**
 * `extract` -> `join` -> `trace --json` over the synthetic "gizmo-shop" corpus
 * (selftest/corpus/gizmo-shop, invented vocabulary, not real code). Checks the shapes the
 * public pipeline promises, not the extraction heuristics themselves — the private
 * regression suite (see CONTRIBUTING.md#tests) covers those against real corpora.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copyCorpus, extract, runCli } from './helpers.js';

test('extract writes a fact set with the expected route', (t) => {
  const dir = copyCorpus(t);
  const { stdout } = extract(dir);
  assert.match(stdout, /^extract api \(backend\): \d+ facts -> out\/facts\/api\.json$/m);

  const factSet = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'api.json'), 'utf8'));
  assert.ok(Array.isArray(factSet.facts));
  assert.ok(
    factSet.facts.some((f) => f.type === 'route' && f.template === 'gizmos/v1/activate'),
    'expected a route fact for gizmos/v1/activate',
  );
});

test('join accepts a single-repo fact set and writes an edges/unjoined graph', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const { status, stderr } = runCli(['join', '--config', 'gizmo.config.json'], { cwd: dir });
  assert.equal(status, 0, stderr);

  const flow = JSON.parse(readFileSync(join(dir, 'out', 'flow.json'), 'utf8'));
  assert.ok(Array.isArray(flow.edges));
  assert.ok(flow.unjoined && typeof flow.unjoined === 'object');
});

test('trace --json on a known route is well-shaped and deterministic', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const args = ['trace', 'POST gizmos/v1/activate', '--config', 'gizmo.config.json', '--json'];

  const first = runCli(args, { cwd: dir });
  assert.equal(first.status, 0, first.stderr);

  const result = JSON.parse(first.stdout);
  assert.equal(result.root.kind, 'route');
  assert.equal(result.root.ref, 'POST gizmos/v1/activate');
  assert.ok(Array.isArray(result.nodes));
  assert.ok(result.nodes.length >= 2, 'expected at least the route and its action node');
  assert.ok(result.nodes.some((n) => n.kind === 'branch'), 'expected the validation branch');

  const second = runCli(args, { cwd: dir });
  assert.equal(second.stdout, first.stdout, 'the same facts must trace to byte-identical JSON');
});

test('trace on a route the facts do not have refuses rather than fabricating a tree', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const { status, stdout, stderr } = runCli(
    ['trace', 'POST gizmos/v1/does-not-exist', '--config', 'gizmo.config.json', '--json'],
    { cwd: dir },
  );
  assert.notEqual(status, 0);
  assert.equal(stdout, '', 'a refused trace must print no partial JSON');
  assert.match(stderr, /^flowtrace: /);
});
