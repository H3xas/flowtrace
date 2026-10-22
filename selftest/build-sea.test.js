/**
 * `scripts/build-sea.mjs` flattens the CLI into the one CommonJS file a standalone binary
 * runs. The binary has no sibling files and no Node module loader to fall back on, so a
 * bundle that names an export its module never declares crashes every command at startup,
 * and nothing short of running the bundle shows it. Each bundle here is written to a
 * disposable directory outside the checkout, as the binary itself runs, and run with Node;
 * no SEA blob is made and postject is never fetched.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { bundle, startCheck } from '../scripts/build-sea.mjs';
import { CLI, REPO_ROOT } from './helpers.js';

const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-sea.mjs');
const SHAPES = join(REPO_ROOT, 'selftest', 'corpus', 'bundle-shapes');

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `flowtrace-bundle-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function realExportNames(path) {
  return Object.keys(await import(pathToFileURL(path).href)).sort();
}

test('Standalone bundle AC-1: export and import text in comments, strings, templates and regex literals stays text', async (t) => {
  const out = join(scratch(t, 'shapes'), 'bundle.cjs');
  const { modules } = bundle(join(SHAPES, 'entry.js'), out);

  const shapes = modules.find((m) => m.path === join(SHAPES, 'shapes.js'));
  assert.ok(shapes, 'the fixture module is inlined');
  assert.deepEqual([...shapes.exports].sort(), await realExportNames(shapes.path));

  const bundled = runNode([out]);
  assert.equal(bundled.status, 0, bundled.stderr);
  const direct = runNode([join(SHAPES, 'entry.js')]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(bundled.stdout, direct.stdout);
});

test('Standalone bundle AC-2: the CLI bundle declares only the exports its modules declare, and it runs', async (t) => {
  const out = join(scratch(t, 'cli'), 'bundle.cjs');
  const { modules } = bundle(CLI, out);
  assert.ok(modules.length > 0);

  for (const { path, exports } of modules) {
    assert.deepEqual([...exports].sort(), await realExportNames(path), path);
  }

  const bundled = runNode([out, '--help']);
  assert.equal(bundled.status, 0, bundled.stderr);
  const direct = runNode([CLI, '--help']);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(bundled.stdout, direct.stdout);
});

const UNCLOSED = [
  ['block comment', 'export const a = 1;\n/* the rest of the file\nexport const b = 2;\n'],
  ['string', "export const a = 'no closing quote;\nexport const b = 2;\n"],
  ['template literal', 'export const a = `no closing backtick\nexport const b = 2;\n'],
  ['${…} expression', 'export const a = `${1 + \n'],
  ['regex literal', 'export const a = /no closing slash\nexport const b = 2;\n'],
];

for (const [kind, source] of UNCLOSED) {
  test(`Standalone bundle AC-3: an unclosed ${kind} is refused by name and writes no bundle`, (t) => {
    const dir = scratch(t, 'unclosed');
    writeFileSync(join(dir, 'entry.js'), "import { a } from './broken.js';\nconsole.log(a);\n");
    writeFileSync(join(dir, 'broken.js'), source);
    const out = join(dir, 'out', 'bundle.cjs');

    assert.throws(
      () => bundle(join(dir, 'entry.js'), out),
      (error) => {
        assert.match(error.message, /^Unreadable source .*broken\.js: /);
        assert.ok(error.message.includes(`: ${kind} opened at line `), error.message);
        assert.match(error.message, / is not closed$/);
        return true;
      },
    );
    assert.equal(existsSync(out), false);
  });
}

/** A stand-in executable: a shell script that does what the given body says. */
function standIn(t, body) {
  const path = join(scratch(t, 'stand-in'), 'flowtrace-stand-in');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const SHELL_STAND_INS = 'a stand-in executable is a POSIX shell script';

test('Standalone bundle AC-4: an executable that exits 0 on --help passes the start check', (t) => {
  if (process.platform === 'win32') {
    t.skip(SHELL_STAND_INS);
    return;
  }
  const path = standIn(t, '[ "$1" = "--help" ] || exit 9\necho "usage: flowtrace"');
  assert.doesNotThrow(() => startCheck(path, { timeoutMs: 10_000 }));
});

test('Standalone bundle AC-4: an executable that exits non-zero fails the start check with its stderr', (t) => {
  if (process.platform === 'win32') {
    t.skip(SHELL_STAND_INS);
    return;
  }
  const path = standIn(t, 'echo "ReferenceError: A is not defined" >&2\nexit 1');
  assert.throws(
    () => startCheck(path, { timeoutMs: 10_000 }),
    (error) => {
      assert.ok(error.message.includes(path), error.message);
      assert.match(error.message, /exited 1/);
      assert.match(error.message, /ReferenceError: A is not defined/);
      return true;
    },
  );
});

test('Standalone bundle AC-4: an executable that runs past the limit fails the start check', (t) => {
  if (process.platform === 'win32') {
    t.skip(SHELL_STAND_INS);
    return;
  }
  const path = standIn(t, 'exec sleep 30');
  assert.throws(
    () => startCheck(path, { timeoutMs: 300 }),
    (error) => {
      assert.ok(error.message.includes(path), error.message);
      assert.match(error.message, /ran past 0\.3 s/);
      return true;
    },
  );
});

test('Standalone bundle AC-4: an executable that cannot be run fails the start check', (t) => {
  const path = join(scratch(t, 'missing'), 'flowtrace-missing');
  assert.throws(
    () => startCheck(path, { timeoutMs: 10_000 }),
    (error) => {
      assert.ok(error.message.includes(path), error.message);
      assert.match(error.message, /could not be run/);
      return true;
    },
  );
});

/** Every entry under `dir` with its size and modification time, or null when it is absent. */
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { recursive: true })
    .sort()
    .map((name) => {
      const stats = statSync(join(dir, name));
      return `${name} ${stats.size} ${stats.mtimeMs}`;
    });
}

test('Standalone bundle AC-5: importing the build script builds nothing and starts no child process', (t) => {
  const dir = scratch(t, 'import');
  const preload = join(dir, 'no-child-process.cjs');
  writeFileSync(
    preload,
    [
      "const childProcess = require('node:child_process');",
      "for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {",
      '  childProcess[name] = () => { throw new Error(`child process started through ${name}`); };',
      '}',
      "require('node:module').syncBuiltinESMExports();",
    ].join('\n'),
  );
  const dist = snapshot(join(REPO_ROOT, 'dist'));
  const seaConfig = existsSync(join(REPO_ROOT, 'sea-config.json'));

  const result = runNode(
    [
      '--require',
      preload,
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(BUILD_SCRIPT).href)}); console.log(Object.keys(m).sort().join(','));`,
    ],
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'bundle,startCheck');
  assert.deepEqual(snapshot(join(REPO_ROOT, 'dist')), dist);
  assert.equal(existsSync(join(REPO_ROOT, 'sea-config.json')), seaConfig);
});
