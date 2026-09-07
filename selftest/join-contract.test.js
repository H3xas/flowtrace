/**
 * The `join --against` skip gate and the `join --export-edges` completeness guarantee —
 * both argument-parser and exit-code surface, so per selftest/README.md they belong here
 * rather than in the private suite alone.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import test from 'node:test';
import { runCli } from './helpers.js';
import { copyCorpus, extract } from './helpers.js';

test('--allow-skipped without --against is a usage error exiting 2', () => {
  const { status, stdout, stderr } = runCli(['join', '--allow-skipped']);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /--json, --fail-on and --allow-skipped are join --against options/);
});

test('--allow-skipped on a command other than join is a usage error exiting 2', () => {
  const { status, stderr } = runCli(['trace', 'POST does/not/matter', '--allow-skipped']);
  assert.equal(status, 2);
  assert.match(stderr, /--allow-skipped is a join option/);
});

/** A caller whose code end has neither file nor line — an incomplete fact a factsProvider
 * or a future extractor could plausibly emit, exactly the shape join-export.js must
 * refuse rather than coerce to null. */
function writeIncompleteEdgeWorkspace(dir) {
  const factsDir = joinPath(dir, 'out', 'facts');
  mkdirSync(factsDir, { recursive: true });
  writeFileSync(
    joinPath(factsDir, 'routes.json'),
    `${JSON.stringify(
      {
        repo: 'routes',
        kind: 'backend',
        facts: [
          {
            type: 'route',
            file: 'src/Controllers/GizmoController.cs',
            line: 10,
            controller: 'GizmoController',
            action: 'Activate',
            verb: 'POST',
            template: 'gizmos/v1/activate',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    joinPath(factsDir, 'caller.json'),
    `${JSON.stringify(
      {
        repo: 'caller',
        kind: 'mobile',
        facts: [
          {
            type: 'gateway_call',
            file: null,
            line: null,
            service: 'GizmoClient',
            method: 'activate',
            verb: 'POST',
            template: 'gizmos/v1/activate',
            resolved: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

test('join --export-edges refuses a joined edge whose code end lacks file or line, and writes nothing', (t) => {
  const dir = copyCorpus(t);
  writeIncompleteEdgeWorkspace(dir);
  const target = joinPath(dir, 'edges.json');

  const first = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'edges.json'], { cwd: dir });
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /flowtrace: .*refusing calls POST gizmos\/v1\/activate.*from.*missing repo, file or line/);
  assert.equal(existsSync(target), false, 'a refused export must write nothing');

  // A file already at the target path is left exactly as it was, not truncated or replaced.
  writeFileSync(target, 'sentinel\n');
  const second = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'edges.json'], { cwd: dir });
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'sentinel\n', 'an existing file at the target path must be untouched');
  rmSync(target);
});

test('join --export-edges still exports once every code end is complete', (t) => {
  const dir = copyCorpus(t);
  extract(dir);
  const result = runCli(['join', '--config', 'gizmo.config.json', '--export-edges', 'edges.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const exported = JSON.parse(readFileSync(joinPath(dir, 'edges.json'), 'utf8'));
  assert.equal(exported.format, 'flowtrace-edges');
  assert.equal(exported.schemaVersion, 1);
  assert.ok(Array.isArray(exported.edges));
});
