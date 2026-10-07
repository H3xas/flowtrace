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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PACKAGE_REQUIRED_FILES,
  STAGES,
  packageProblems,
  pickRange,
  reportFailure,
  stageFailure,
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

function gitIn(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.invalid',
  GIT_COMMITTER_NAME: 'Selftest',
  GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
};

/** The command under test, copied into a fixture so it reads the file being edited. */
function installScript(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(dir, 'scripts', 'verify.mjs'));
}

/**
 * A single-branch clone: the only remote ref it fetches is the branch it was made from, so
 * `origin/HEAD` points at the checkout's own head and no base branch sits behind it. The tip is
 * an unsigned commit, so a range that read it would name it.
 */
function singleBranchClone(t) {
  const source = mkdtempSync(join(tmpdir(), 'flowtrace-verify-single-source-'));
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-verify-single-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  gitIn(tmpdir(), ['clone', '--no-hardlinks', '--local', REPO_ROOT, source]);
  const tip = gitIn(source, ['rev-parse', 'HEAD']);
  const unsigned = gitIn(source, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'test: an unsigned commit'], IDENTITY);
  gitIn(source, ['symbolic-ref', 'HEAD', 'refs/heads/selftest-single']);
  gitIn(source, ['update-ref', 'refs/heads/selftest-single', unsigned]);
  gitIn(tmpdir(), ['clone', '--single-branch', '--branch', 'selftest-single', '--no-hardlinks', '--local', source, dir]);
  installScript(dir);
  return { dir, unsigned };
}

/** A clone checked out on `main`, standing on `origin/main`: no base sits behind its head. */
function cloneOfMain(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-verify-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  gitIn(tmpdir(), ['clone', '--single-branch', '--branch', 'main', '--no-hardlinks', '--local', REPO_ROOT, dir]);
  installScript(dir);
  return dir;
}

/** A checkout with no remote and no base branch: nothing to compare this head against. */
function checkoutWithNoBase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-verify-baseless-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, ['init', '-q']);
  gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/work']);
  writeFileSync(join(dir, 'README.md'), 'a checkout with no base branch\n');
  gitIn(dir, ['add', 'README.md']);
  gitIn(dir, ['commit', '-q', '-m', 'docs: start a checkout with no base branch'], IDENTITY);
  installScript(dir);
  return dir;
}

/** The command run inside a fixture checkout, with its own output. */
function verifyIn(dir, args) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'verify.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * A disposable clone whose default base resolves to its own branch, with an unsigned commit at
 * that branch's tip and a base one commit behind. A clone records the branch it was made from
 * as `origin/HEAD`, so a clone taken after that commit existed has exactly these refs. The
 * command under test is copied in, so the fixture reads the file being edited rather than the
 * one in the last commit.
 */
function clonePointingAtItself(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-verify-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  gitIn(tmpdir(), ['clone', '--no-hardlinks', '--local', REPO_ROOT, dir]);
  installScript(dir);
  const tip = gitIn(dir, ['rev-parse', 'HEAD']);
  const unsigned = gitIn(dir, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'test: an unsigned commit'], IDENTITY);
  gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/selftest-clone']);
  gitIn(dir, ['update-ref', 'refs/heads/selftest-clone', unsigned]);
  gitIn(dir, ['update-ref', 'refs/remotes/origin/selftest-clone', unsigned]);
  gitIn(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/selftest-clone']);
  gitIn(dir, ['update-ref', 'refs/remotes/origin/main', tip]);
  return { dir, unsigned };
}

/** The branch patterns one workflow event filters on, read out of the workflow's `on:` block. */
function triggerBranches(workflow, event) {
  const block = new RegExp(`^ {2}${event}:\\n((?: {4,}\\S.*\\n?)*)`, 'm').exec(workflow);
  assert.ok(block, `${event} is not a trigger of this workflow`);
  const filter = /branches:\s*\[([^\]]*)\]/.exec(block[1]);
  assert.ok(filter, `${event} carries no branch filter`);
  return filter[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
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

test('the default comparison passes over a base that resolves to this checkout own head', () => {
  const head = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  const resolve = (base) => ({ 'origin/HEAD': head, 'origin/main': main, main })[base] ?? null;
  assert.deepEqual(pickRange(head, ['origin/HEAD', 'origin/main', 'main'], resolve), {
    base: 'origin/main',
    range: `${main}..HEAD`,
  });
  const selfOnly = pickRange(head, ['origin/HEAD', 'origin/main'], (base) => (base === 'origin/HEAD' ? head : null));
  assert.equal(selfOnly, null, 'a base at this checkout own head leaves no range to read');
  assert.equal(pickRange(head, ['origin/HEAD'], () => null), null);
  assert.equal(pickRange(null, ['origin/HEAD'], () => head), null);
});

test('a caller range that names no commit is refused rather than read as a clean scan', () => {
  const result = verify(['--only', 'commit-signoff', '--commit-range', 'HEAD..HEAD']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HEAD\.\.HEAD names no commit/);
  assert.match(result.stderr, /repair: name the commits to read/);
});

test('a caller range that is a git option is refused rather than read as a range', () => {
  const result = verify(['--only', 'commit-signoff', '--commit-range', '--all']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--all names a git option, not a range of commits/);
  assert.match(result.stderr, /repair: pass the commits to read/);
});

test('verify AC-8: a default range that reads no commit fails both commit stages and names the flag', (t) => {
  const { dir, unsigned } = singleBranchClone(t);
  assert.equal(gitIn(dir, ['rev-parse', 'HEAD']), unsigned, 'the fixture head is the unsigned tip');
  for (const stage of ['public-text', 'commit-signoff']) {
    const result = verifyIn(dir, ['--only', stage]);
    assert.equal(result.status, 1, `${stage} must not read as a clean scan: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`^verify: FAILED at ${stage} `, 'm'));
    assert.match(result.stderr, /tried origin\/HEAD, origin\/main, main/);
    assert.match(result.stderr, /--commit-range/);
  }
});

test('verify AC-8: a checkout standing on its base branch reads no commit and fails closed', (t) => {
  const dir = cloneOfMain(t);
  const result = verifyIn(dir, ['--only', 'commit-signoff']);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^verify: FAILED at commit-signoff /m);
  assert.match(result.stderr, /tried origin\/HEAD, origin\/main, main/);
});

test('verify AC-8: a checkout with no base branch at all reads no commit and fails closed', (t) => {
  const dir = checkoutWithNoBase(t);
  const result = verifyIn(dir, ['--only', 'public-text']);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^verify: FAILED at public-text /m);
  assert.match(result.stderr, /tried origin\/HEAD, origin\/main, main/);
  assert.match(result.stderr, /--commit-range/);
});

test('verify AC-5: a single-branch clone with an unsigned tip never passes the commit stage', (t) => {
  const { dir, unsigned } = singleBranchClone(t);
  const defaulted = verifyIn(dir, ['--only', 'commit-signoff']);
  assert.equal(defaulted.status, 1, 'a self-pointing default base must not vouch for the tip');
  const named = verifyIn(dir, ['--only', 'commit-signoff', '--commit-range', 'HEAD~1..HEAD']);
  assert.equal(named.status, 1);
  assert.match(named.stderr, new RegExp(`${unsigned.slice(0, 12)}: missing Signed-off-by trailer`));
});

test('a clone whose default base is its own branch still reads the commits under review', (t) => {
  const { dir, unsigned } = clonePointingAtItself(t);
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'verify.mjs'), '--only', 'commit-signoff'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `an unsigned commit must not read as clean: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /verify: FAILED at commit-signoff/);
  assert.match(result.stderr, new RegExp(`${unsigned.slice(0, 12)}: missing Signed-off-by trailer`));
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

test('the workflow runs for every branch a change is integrated through', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
  for (const event of ['push', 'pull_request']) {
    const patterns = triggerBranches(workflow, event);
    assert.ok(patterns.includes('main'), `${event} must cover main`);
    assert.ok(
      patterns.some((pattern) => pattern.startsWith('release/')),
      `${event} must cover the release branches a change is integrated into`,
    );
    for (const pattern of patterns) {
      assert.ok(contributing.includes(pattern), `CONTRIBUTING.md never says CI runs for ${pattern}`);
    }
  }
});

test('a stage whose own input is missing is named rather than left as a stack trace', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-verify-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  cpSync(SCRIPT, join(dir, 'scripts', 'verify.mjs'));
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'verify.mjs'), '--only', 'suite'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^verify: FAILED at suite — the public contract suite$/m);
  assert.match(result.stderr, /package\.json/);
  assert.match(result.stderr, /^ {2}repair: .+$/m);
  assert.doesNotMatch(result.stderr, /^\s+at .+:\d+:\d+$/m, 'a stage report is not a stack trace');
});

test('the command still runs when the path to it is a symlinked spelling of the same file', (t) => {
  if (process.platform === 'win32') {
    t.skip('creating a symbolic link needs a POSIX system or elevated rights');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-verify-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  mkdirSync(join(dir, 'scripts'));
  cpSync(SCRIPT, join(dir, 'scripts', 'verify.mjs'));
  const result = spawnSync(process.execPath, [join(link, 'scripts', 'verify.mjs'), '--only', 'suite'], {
    cwd: link,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `a check that never ran must not read as a pass: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^verify: FAILED at suite/m);
});

test('an unexpected failure inside a stage is still reported as that stage', () => {
  const stage = { id: 'suite', title: 'the public contract suite' };
  const report = reportFailure(stage, stageFailure(stage, new TypeError('boom')), []);
  assert.match(report, /^verify: FAILED at suite — the public contract suite$/m);
  assert.match(report, /^ {2}exit: did not run$/m);
  assert.match(report, /^ {4}\| boom$/m);
  assert.match(report, /^ {2}repair: .+$/m);
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
