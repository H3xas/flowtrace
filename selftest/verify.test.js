/**
 * `scripts/verify.mjs` is the one command CI runs, so what it promises is narrow enough to
 * test directly: the suite it runs is the whole suite, the package it describes is the
 * package a reader installs, and a failure names the stage, the command and the repair
 * rather than only the fact that something went wrong.
 *
 * The pure functions are imported; the command itself is spawned, because what a
 * contributor runs is the process, not the module. The pull-request workflow is read as
 * text for the same reason: the inventory lives in the command, and a second checklist
 * beside it is the failure this guards against.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  PACKAGE_REQUIRED_FILES,
  STAGES,
  packageProblems,
  reportFailure,
  suiteProblems,
  tapNames,
  tapSummary,
} from '../scripts/verify.mjs';
import { REPO_ROOT } from './helpers.js';

const SCRIPT = join(REPO_ROOT, 'scripts', 'verify.mjs');

function verify(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('a test file the suite list omits is named, with the list as the repair', () => {
  const problems = suiteProblems(['selftest/affected.test.js'], ['selftest/affected.test.js', 'selftest/new.test.js']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /selftest\/new\.test\.js exists and the "test" script in package\.json never runs it/);
});

test('a suite entry with no file behind it is named', () => {
  const problems = suiteProblems(['selftest/gone.test.js'], []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package\.json runs selftest\/gone\.test\.js, which does not exist/);
});

test('the TAP summary is read from the lines node prints', () => {
  const counts = tapSummary(['1..3', '# tests 3', '# pass 2', '# fail 1', '# skipped 0', '# duration_ms 12'].join('\n'));
  assert.deepEqual(counts, { tests: 3, pass: 2, fail: 1, skipped: 0 });
  assert.deepEqual(tapSummary('no summary here'), {});
});

test('failing and skipped tests are named, and a subtest is not counted twice', () => {
  const failure = ['not ok 1 - a contract holds', '  not ok 2 - a contract holds', '# fail 1'].join('\n');
  assert.deepEqual(tapNames(failure, 'fail'), ['a contract holds']);
  const skipped = ['ok 1 - an unsettled check # SKIP waiting on a fixture', '# skipped 1'].join('\n');
  assert.deepEqual(tapNames(skipped, 'skip'), ['an unsettled check']);
});

test('a package missing what it must carry, or carrying what it must not, is named', () => {
  const present = [...PACKAGE_REQUIRED_FILES, 'lib/trace.js', 'docs/cli.md', 'areas/checkout.txt', 'examples/demo-shop/flowtrace.config.json'];
  assert.deepEqual(packageProblems(present), []);

  const incomplete = packageProblems(present.filter((file) => file !== 'bin/flowtrace.js'));
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0], /bin\/flowtrace\.js is not in the package/);

  const leaked = packageProblems([...present, 'selftest/verify.test.js', 'scripts/verify.mjs', 'examples/demo-shop/out/facts.json']);
  assert.equal(leaked.length, 3);
  for (const problem of leaked) assert.match(problem, /must not ship; exclude it in the "files" list/);
});

test('a failure report names the stage, the command, the output and the repair', () => {
  const home = ['', 'Users', 'selftest-user'].join('/');
  const report = reportFailure(
    { id: 'machine-paths', title: 'no machine paths in the tree' },
    { command: 'bash scripts/path-check.sh', status: 1, output: `./notes.md:3: built in ${home}/src`, repair: 'rewrite the hit' },
    [{ id: 'suite' }],
  );
  assert.match(report, /^verify: FAILED at machine-paths — no machine paths in the tree$/m);
  assert.match(report, /^ {2}command: bash scripts\/path-check\.sh$/m);
  assert.match(report, /^ {2}exit: 1$/m);
  assert.match(report, new RegExp(`^ {4}\\| \\.\\/notes\\.md:3: built in ${home}/src$`, 'm'));
  assert.match(report, /^ {2}repair: rewrite the hit$/m);
  assert.match(report, /^verify: failed — 1 of 2 stages ran \(ok: suite\)$/m);
});

test('the command names every stage it can run', () => {
  const listed = verify(['--list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    listed.stdout.trim().split('\n').map((line) => line.split('\t')[0]),
    STAGES.map((stage) => stage.id),
  );
});

test('an unknown stage stops the run and names the ones that exist', () => {
  const result = verify(['--only', 'suit']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown stage: suit; stages are suite, cli-smoke, /);
});

test('a revision range git cannot read fails the stage that reads commits, with the repair', () => {
  const result = verify(['--only', 'public-text', '--commit-range', 'no-such-base..HEAD']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verify: FAILED at public-text/);
  assert.match(result.stderr, /no-such-base\.\.HEAD is not a revision range git can read/);
  assert.match(result.stderr, /pass a range that resolves, for example --commit-range origin\/main\.\.HEAD/);
});

test('the inventory CI runs adds no checklist of its own beside the command', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const steps = workflow.split(/\n\s+- name: /).slice(1);
  const running = steps.filter((step) => /\n\s+run:/.test(step));
  assert.equal(running.length, 2, 'the workflow grew a third step that runs something');
  assert.match(running[0], /VERIFY_COMMIT_RANGE/, 'the first running step must be the range the commits are read over');
  const commands = running[1]
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(commands, ['run: npm run verify']);
});

test('the contributor document names every stage the command runs', () => {
  const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
  for (const stage of STAGES) {
    assert.match(contributing, new RegExp(`\`${stage.id}\``), `${stage.id} is not named in CONTRIBUTING.md`);
  }
});

test('every stage that needs no suite run passes in this checkout', () => {
  const result = verify(['--only', 'cli-smoke,machine-paths,public-text,commit-signoff,docs,config,package']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^verify: package ok — \d+ files, \d+ kB unpacked, .+\.tgz$/m);
  assert.match(result.stdout, /^verify: ok — 7 stages — \d+ files in .+\.tgz$/m);
});
