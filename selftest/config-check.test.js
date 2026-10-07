/**
 * `scripts/config-check.mjs` keeps the shipped configuration example in step with the
 * loader the CLI runs and with the document describing it. Each failure below is one way
 * the example can go stale while the repository still looks green: a shape the loader
 * rejects, a key no reader is told about, a file that is not there and a file that cannot
 * be read. The command names the example and permits exactly one repair in each case.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './helpers.js';

const CHECK = join(REPO_ROOT, 'scripts', 'config-check.mjs');
const EXAMPLE = join(REPO_ROOT, 'flowtrace.config.example.json');

function configCheck(path) {
  const args = path ? [path] : [];
  const result = spawnSync(process.execPath, [CHECK, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Writes an example into a disposable directory and returns its path. */
function example(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-config-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'flowtrace.config.example.json');
  writeFileSync(path, text);
  return path;
}

test('the example this repository ships is accepted', () => {
  const result = configCheck();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^config-check: ok — flowtrace\.config\.example\.json loads and every key is documented$/m);
});

test('a shape the loader rejects is reported with the loader’s own reason', (t) => {
  const path = example(t, JSON.stringify({ repos: [{ id: 'api', kind: 'backend', root: 'api' }] }));
  const result = configCheck(path);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config-check: failed/);
  assert.match(result.stderr, /is rejected by the loader: config .+: "out" must be a non-empty string/);
});

test('a repository kind that does not exist is reported', (t) => {
  const path = example(t, JSON.stringify({ out: 'out', repos: [{ id: 'api', kind: 'server', root: 'api' }] }));
  const result = configCheck(path);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kind/);
});

test('a key the documentation never names is reported with both permitted repairs', (t) => {
  const shipped = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  const path = example(t, JSON.stringify({ ...shipped, telemetry: { endpoint: 'http://localhost' } }));
  const result = configCheck(path);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sets "telemetry" and docs\/configuration\.md never mentions it; document the key or drop it from the example/);
});

test('an example that is not there is reported, not passed', () => {
  const result = configCheck(join(REPO_ROOT, 'flowtrace.config.absent.json'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /flowtrace\.config\.absent\.json is missing; restore it or drop it from the "files" list in package\.json/);
});

test('an example that is not JSON is reported rather than compared', (t) => {
  const path = example(t, '{"out": "out",}\n');
  const result = configCheck(path);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not valid JSON \(.+\); fix the syntax/);
});

test('an example that cannot be read is reported by name', (t) => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    t.skip('a permission failure needs a non-root account on a POSIX system');
    return;
  }
  const path = example(t, '{"out": "out", "repos": []}\n');
  chmodSync(path, 0o000);
  t.after(() => {
    if (existsSync(path)) chmodSync(path, 0o600);
  });
  const result = configCheck(path);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be read \(.+\); restore it or fix its permissions/);
});
