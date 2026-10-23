/**
 * Title collection runs the one `@playwright/test` that Node resolution finds from the suite's
 * configured root: under the root itself, else in a parent directory. The packages here are
 * stand-ins written to a temporary directory, and the runner is a recording stand-in for the
 * child process, so no package is installed and no Playwright runs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectTitles } from '../lib/extract/pw-titles.js';

// A copy above the temporary directory would let the case with no copy pass for the wrong reason.
test('Playwright resolution AC-33: the temporary directory resolves no copy of its own', () => {
  const probe = createRequire(join(realpathSync(tmpdir()), 'probe.js'));
  assert.throws(() => probe.resolve('@playwright/test/package.json'), /Cannot find module/, 'a global copy is in the way');
});

function workspace(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flowtrace-pw-resolution-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'packages', 'suite');
  mkdirSync(root, { recursive: true });
  return { dir, root };
}

function installAt(dir, marker) {
  const pkg = join(dir, 'node_modules', '@playwright', 'test');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '0.0.0', bin: { playwright: 'cli.js' } }));
  writeFileSync(join(pkg, 'cli.js'), `// ${marker}\nprocess.stdout.write('{"suites":[]}');\n`);
  return join(pkg, 'cli.js');
}

function recordingRun(root) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return { status: 0, stdout: JSON.stringify({ config: { rootDir: root }, suites: [] }), stderr: '' };
  };
  return { calls, spawn };
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

function collect(t, root, dir) {
  const run = recordingRun(root);
  const before = listFiles(dir);
  const preloadDir = mkdtempSync(join(tmpdir(), 'flowtrace-pw-preload-'));
  t.after(() => rmSync(preloadDir, { recursive: true, force: true }));
  const result = collectTitles(root, { preloadDir, spawn: run.spawn, env: {}, isSingleExecutable: () => false });
  assert.deepEqual(listFiles(dir), before, 'nothing is written into the suite or its parents');
  return { result, calls: run.calls };
}

test('Playwright resolution AC-33: a package installed only under the configured root lists titles', (t) => {
  const { dir, root } = workspace(t);
  const cli = installAt(root, 'root copy');
  const { result, calls } = collect(t, root, dir);
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 1, 'one run, and no install step');
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(2), [cli, 'test', '--list', '--reporter=json']);
  assert.equal(calls[0].cwd, root);
});

test('Playwright resolution AC-33: a package installed only in a parent directory lists titles as before', (t) => {
  const { dir, root } = workspace(t);
  const cli = installAt(dir, 'parent copy');
  const { result, calls } = collect(t, root, dir);
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((call) => call.args[2]), [cli]);
});

test('Playwright resolution AC-33: with a copy at the root and in a parent, the root copy runs', (t) => {
  const { dir, root } = workspace(t);
  installAt(dir, 'parent copy');
  const cli = installAt(root, 'root copy');
  const { calls } = collect(t, root, dir);
  assert.deepEqual(calls.map((call) => call.args[2]), [cli]);
});

test('Playwright resolution AC-33: with no copy the existing reason is reported and nothing runs', (t) => {
  const { dir, root } = workspace(t);
  const { result, calls } = collect(t, root, dir);
  assert.deepEqual(result, { status: 'failed', reason: '@playwright/test not resolvable from the repository root' });
  assert.equal(calls.length, 0);
});
