#!/usr/bin/env node
/**
 * The one command that decides whether this repository is verified.
 *
 *   npm run verify                                the whole inventory
 *   node scripts/verify.mjs --only suite,docs     one or more stages while working
 *   node scripts/verify.mjs --commit-range <rev-range>
 *
 * Everything a green pull request stands for lives here and nowhere else: CI runs this
 * command and adds no step of its own, so the inventory a contributor reads in
 * CONTRIBUTING.md and the inventory CI enforces cannot drift apart. Each stage prints one
 * line naming what it proved; the run stops at the first stage that fails and prints that
 * stage's command, its output and the repair it permits, so a failure says what to change
 * rather than only that something went wrong.
 *
 * The commit-artifact stages read commit objects over a revision range. CI passes the range
 * under review; without one, the range is `merge-base <base> HEAD..HEAD` against the first
 * base branch that resolves, and a checkout with no base branch fails naming the flag that
 * supplies one, rather than reporting commits it never read.
 *
 * A linked worktree is a first-class checkout: every stage reads tracked content through
 * git or an explicit exclusion, so the `.git` pointer file a worktree carries is never
 * mistaken for product content. `--only` narrows the stages a developer runs; CI and the
 * documented command run the default inventory.
 *
 * Zero dependencies: Node built-ins, and the same interpreter each repository script needs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'examples', 'demo-shop');
const HYGIENE = join('.claude', 'hooks', 'comment-hygiene.py');
const PYTHON = 'python3';
const BASE_BRANCHES = ['origin/HEAD', 'origin/main', 'main'];

/** Files the published package must carry, whatever else it lists. */
export const PACKAGE_REQUIRED_FILES = Object.freeze([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE-MIT',
  'LICENSE-APACHE',
  'NOTICE',
  'bin/flowtrace.js',
  'flowtrace.config.example.json',
]);

/** Directories the published package must carry at least one file from. */
export const PACKAGE_REQUIRED_PREFIXES = Object.freeze([
  'lib/',
  'docs/',
  'areas/',
  'examples/demo-shop/',
]);

/** Paths that belong to the checkout, never to the tarball a reader installs. */
export const PACKAGE_FORBIDDEN = Object.freeze([
  /^selftest\//,
  /^scripts\//,
  /^bench\//,
  /^\.github\//,
  /^\.claude\//,
  /^\.git/,
  /\/out\//,
  /^out\//,
  /^dist\//,
  /\.tgz$/,
  /^AGENTS\.md$/,
  /^CONTRIBUTING\.md$/,
  /^CODE_OF_CONDUCT\.md$/,
  /^GOVERNANCE\.md$/,
  /^MAINTAINERS\.md$/,
  /^RELEASING\.md$/,
  /^ROADMAP\.md$/,
  /^SECURITY\.md$/,
]);

class StageFailure extends Error {
  constructor({ command, status, output, repair }) {
    super(`stage failed: ${command}`);
    this.command = command;
    this.status = status;
    this.output = output ?? '';
    this.repair = repair;
  }
}

function shell(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? `'${part}'` : part)).join(' ');
}

function run(command, args, { cwd = ROOT } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    command: shell(command, args),
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error ? result.error.message : '',
  };
}

function ok(step, repair) {
  if (step.spawnError) {
    throw new StageFailure({
      command: step.command,
      status: null,
      output: step.spawnError,
      repair,
    });
  }
  if (step.status !== 0) {
    throw new StageFailure({
      command: step.command,
      status: step.status,
      output: [step.stdout, step.stderr].filter(Boolean).join('\n'),
      repair,
    });
  }
  return step;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The suite is only the suite when it is the whole suite: an unlisted test file passes
 * silently, and an unskipped run is the only run whose green means anything.
 */
export function suiteProblems(listed, present) {
  const listedSet = new Set(listed);
  const presentSet = new Set(present);
  return [
    ...present
      .filter((file) => !listedSet.has(file))
      .map((file) => `${file} exists and the "test" script in package.json never runs it; add it there`),
    ...listed
      .filter((file) => !presentSet.has(file))
      .map((file) => `package.json runs ${file}, which does not exist; restore the file or drop the entry`),
  ];
}

/** The counts node's TAP reporter prints at the end of a run. */
export function tapSummary(output) {
  const counts = {};
  for (const line of output.split('\n')) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line.trim());
    if (match) counts[match[1]] = Number(match[2]);
  }
  return counts;
}

/** Test names TAP reported as failing or skipped, deduplicated and without their subtests. */
export function tapNames(output, kind) {
  const names = new Set();
  for (const line of output.split('\n')) {
    const match =
      kind === 'fail'
        ? /^\s*not ok \d+ - (.+?)\s*$/.exec(line)
        : /^\s*ok \d+ - (.+?) # SKIP(?: .*)?$/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

function suiteStage() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const listed = String(pkg.scripts?.test ?? '')
    .split(/\s+/)
    .filter((token) => token.endsWith('.test.js'));
  const present = readdirSync(join(ROOT, 'selftest'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `selftest/${name}`)
    .sort();
  const problems = suiteProblems(listed, present);
  if (problems.length > 0) {
    throw new StageFailure({
      command: shell('package.json', ['scripts.test']),
      status: 1,
      output: problems.join('\n'),
      repair: 'the public suite runs from that list; fix it before trusting a green run',
    });
  }

  const step = ok(
    run(process.execPath, ['--test', '--test-reporter=tap', ...listed]),
    'run `npm test` on its own for the full output; the failing test names the contract that moved',
  );
  const counts = tapSummary(`${step.stdout}\n${step.stderr}`);
  if (counts.tests === undefined || counts.pass === undefined) {
    throw new StageFailure({
      command: step.command,
      status: step.status,
      output: [step.stdout, step.stderr].join('\n'),
      repair: 'the suite printed no summary, so nothing here is known to have run; fix the runner output',
    });
  }
  const failed = tapNames(step.stdout, 'fail');
  const skipped = tapNames(step.stdout, 'skip');
  if (counts.fail > 0 || counts.cancelled > 0 || failed.length > 0) {
    throw new StageFailure({
      command: step.command,
      status: step.status || 1,
      output: failed.map((name) => `failing: ${name}`).join('\n'),
      repair: 'run `npm test` for the full output; fix the contract the named test checks',
    });
  }
  if (counts.skipped > 0 || skipped.length > 0) {
    throw new StageFailure({
      command: step.command,
      status: step.status || 1,
      output: skipped.map((name) => `skipped: ${name}`).join('\n'),
      repair: 'a skipped test is not a passing test: drop the skip or drop the test',
    });
  }
  return {
    line: `suite ok — ${counts.pass} tests pass, 0 fail, 0 skipped (${listed.length} files)`,
    totals: { tests: counts.pass, skipped: 0 },
  };
}

function cliSmokeStage() {
  const step = ok(
    run(process.execPath, [join('bin', 'flowtrace.js'), '--help']),
    'the entry point must answer --help from a checkout with no install step; fix bin/flowtrace.js',
  );
  if (step.stdout.trim().length === 0) {
    throw new StageFailure({
      command: step.command,
      status: step.status,
      output: 'no help text on stdout',
      repair: 'bin/flowtrace.js must print the flag reference on stdout; fix the entry point',
    });
  }
  return { line: 'cli-smoke ok — node bin/flowtrace.js --help' };
}

const EXAMPLE_STEPS = Object.freeze([
  { label: 'extract the worked example', cli: ['extract', '--config', 'flowtrace.config.json'] },
  {
    label: 'join and export the edges',
    cli: ['join', '--config', 'flowtrace.config.json', '--export-edges', 'out/flowtrace-edges.json'],
  },
  {
    label: 'compare the regenerated export with the pinned copy',
    script: 'scripts/check-pinned-export.mjs',
    args: ['out/flowtrace-edges.json', 'exports/flowtrace-edges.json'],
  },
  {
    label: 'export the edges a second time',
    cli: ['join', '--config', 'flowtrace.config.json', '--export-edges', 'out/flowtrace-edges-again.json'],
  },
  { label: 'compare the two exports byte for byte', compare: ['out/flowtrace-edges.json', 'out/flowtrace-edges-again.json'] },
  { label: 'cover the checkout area', cli: ['cover', '--config', 'flowtrace.config.json', '--area', '../../areas/checkout.txt'] },
  { label: 'span the checkout route', cli: ['span', '--config', 'flowtrace.config.json', 'POST orders/v1/checkout'] },
  { label: 'surface the checkout route', cli: ['surface', '--config', 'flowtrace.config.json', 'POST orders/v1/checkout'] },
  { label: 'skeleton the checkout route', cli: ['skeleton', '--config', 'flowtrace.config.json', 'POST orders/v1/checkout'] },
  {
    label: 'write a coverage baseline',
    cli: ['check', '--config', 'flowtrace.config.json', '--area', '../../areas/checkout.txt', '--baseline', 'out/checkout.baseline.json', '--write-baseline'],
  },
  {
    label: 're-read the coverage baseline',
    cli: ['check', '--config', 'flowtrace.config.json', '--area', '../../areas/checkout.txt', '--baseline', 'out/checkout.baseline.json'],
  },
  { label: 'calibrate against the golden verdicts', cli: ['calibrate', '--golden', 'calibration', '--verdicts', 'calibration/reference'] },
]);

function workedExampleStage() {
  const exampleRepair =
    'the worked example is the change a reviewer can see: fix the change or extend examples/demo-shop with the idiom it recognises';
  for (const step of EXAMPLE_STEPS) {
    if (step.compare) {
      const [first, second] = step.compare.map((path) => join(EXAMPLE, path));
      const left = readFileSync(first);
      const right = readFileSync(second);
      if (!left.equals(right)) {
        throw new StageFailure({
          command: `compare ${step.compare.join(' with ')}`,
          status: 1,
          output: `${step.compare[0]} and ${step.compare[1]} differ (${left.length} and ${right.length} bytes)`,
          repair: 'the export must be a pure function of the checkout: find the field that moved between two runs',
        });
      }
      continue;
    }
    const args = step.cli
      ? [join(ROOT, 'bin', 'flowtrace.js'), ...step.cli]
      : [join(ROOT, step.script), ...step.args];
    const result = run(process.execPath, args, { cwd: EXAMPLE });
    if (result.spawnError || result.status !== 0) {
      throw new StageFailure({
        command: result.command,
        status: result.status,
        output: [result.stdout, result.stderr, result.spawnError].filter(Boolean).join('\n'),
        repair: exampleRepair,
      });
    }
  }
  return { line: `worked-example ok — ${EXAMPLE_STEPS.length} commands in examples/demo-shop` };
}

function machinePathsStage() {
  ok(
    run('bash', [join('scripts', 'path-check.sh')]),
    'rewrite each hit with a neutral placeholder such as shop-api; a published tool never carries the machine it was written on',
  );
  return { line: 'machine-paths ok' };
}

function commitRange(explicit) {
  if (explicit) return explicit;
  for (const base of BASE_BRANCHES) {
    const mergeBase = git(['merge-base', base, 'HEAD']);
    if (mergeBase) return `${mergeBase}..HEAD`;
  }
  return '';
}

function resolvedRange(explicit) {
  const range = commitRange(explicit);
  if (!range) {
    throw new StageFailure({
      command: 'git merge-base <base> HEAD',
      status: null,
      output: `no base branch resolved (tried ${BASE_BRANCHES.join(', ')})`,
      repair: 'fetch the base branch, or pass the range to read: node scripts/verify.mjs --commit-range <base>..HEAD',
    });
  }
  const count = git(['rev-list', '--count', range]);
  if (count === null) {
    throw new StageFailure({
      command: shell('git', ['rev-list', '--count', range]),
      status: null,
      output: `${range} is not a revision range git can read`,
      repair: 'pass a range that resolves, for example --commit-range origin/main..HEAD',
    });
  }
  return { range, commits: Number(count) };
}

/**
 * The shared policy skips a file it cannot read and a tree it cannot enumerate, so a scan
 * that read nothing prints exactly what a clean scan prints. Both failures are caught here,
 * where they can be named, before the scan is allowed to answer for the tree at all.
 */
function readableTree() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (listed.status !== 0) {
    throw new StageFailure({
      command: shell('git', ['ls-files']),
      status: listed.status,
      output: [listed.stdout, listed.stderr].filter(Boolean).join('\n'),
      repair: 'fix the checkout so git can list its tracked files; an unlistable tree is not a clean tree',
    });
  }
  const files = listed.stdout.split('\0').filter(Boolean);
  const unreadable = [];
  for (const file of files) {
    try {
      readFileSync(join(ROOT, file));
    } catch (error) {
      unreadable.push(`${file}: ${error.message}`);
    }
  }
  if (unreadable.length > 0) {
    throw new StageFailure({
      command: shell('git', ['ls-files']) + ' | read each tracked file',
      status: null,
      output: unreadable.join('\n'),
      repair:
        'restore each file above, fix its permissions, or record its removal with git rm; ' +
        'a scan that could not read a file reports it clean',
    });
  }
  return files.length;
}

function publicTextStage(context) {
  const { range, commits } = resolvedRange(context.range);
  const tracked = readableTree();
  const steps = [
    { label: 'the scanner agrees with itself', args: ['--selfcheck'] },
    { label: 'tracked sources', args: ['--scan'] },
    { label: `commit messages in ${range}`, args: ['--scan-commits', range] },
  ];
  for (const step of steps) {
    const result = run(PYTHON, [HYGIENE, ...step.args]);
    if (result.spawnError || result.status !== 0) {
      throw new StageFailure({
        command: result.command,
        status: result.status,
        output: [result.stdout, result.stderr, result.spawnError].filter(Boolean).join('\n'),
        repair:
          'rewrite each flagged line so it carries the reason the code cannot; a hit names its class, ' +
          'and the file or commit it sits on',
      });
    }
  }
  return {
    line: `public-text ok — ${tracked} tracked files and ${commits} commit message${commits === 1 ? '' : 's'} clean`,
  };
}

function commitSignoffStage(context) {
  const { range, commits } = resolvedRange(context.range);
  const result = run(PYTHON, [HYGIENE, '--require-signoff', range]);
  if (result.spawnError || result.status !== 0) {
    throw new StageFailure({
      command: result.command,
      status: result.status,
      output: [result.stdout, result.stderr, result.spawnError].filter(Boolean).join('\n'),
      repair: 'each commit needs its Developer Certificate of Origin trailer: git commit --amend -s, or the rebase CONTRIBUTING.md gives for several commits',
    });
  }
  return { line: `commit-signoff ok — ${commits} commit${commits === 1 ? '' : 's'} in ${range} carry Signed-off-by` };
}

function docsStage() {
  ok(
    run(process.execPath, [join('scripts', 'docs-check.mjs')]),
    'run node scripts/docs-check.mjs --write when the help text moved, and fix or remove the link it names',
  );
  return { line: 'docs ok' };
}

function configStage() {
  ok(
    run(process.execPath, [join('scripts', 'config-check.mjs')]),
    'fix the example the message names; it is the configuration shape a reader copies',
  );
  return { line: 'config ok' };
}

/** What a published tarball must carry, and what it must never carry. */
export function packageProblems(files) {
  const problems = [];
  const present = new Set(files);
  for (const file of PACKAGE_REQUIRED_FILES) {
    if (!present.has(file)) problems.push(`${file} is not in the package; add it to the "files" list in package.json`);
  }
  for (const prefix of PACKAGE_REQUIRED_PREFIXES) {
    if (!files.some((file) => file.startsWith(prefix))) {
      problems.push(`no ${prefix}* file is in the package; add the directory to the "files" list in package.json`);
    }
  }
  for (const file of files) {
    const forbidden = PACKAGE_FORBIDDEN.find((pattern) => pattern.test(file));
    if (forbidden) {
      problems.push(`${file} is in the package and must not ship; exclude it in the "files" list in package.json`);
    }
  }
  return problems;
}

function packageStage() {
  const step = ok(
    run('npm', ['pack', '--dry-run', '--json']),
    'npm must be able to describe the tarball from a clean checkout; fix the failure it printed',
  );
  let packed;
  try {
    packed = JSON.parse(step.stdout)[0];
  } catch (error) {
    throw new StageFailure({
      command: step.command,
      status: step.status,
      output: step.stdout || step.stderr,
      repair: 'npm printed no tarball description, so package membership is unknown; fix the failure it printed',
    });
  }
  const files = packed.files.map((entry) => entry.path);
  const problems = packageProblems(files);
  if (problems.length > 0) {
    throw new StageFailure({
      command: step.command,
      status: 1,
      output: problems.join('\n'),
      repair: 'the package a reader installs is part of what this repository promises; fix the membership above',
    });
  }
  const kilobytes = Math.round(packed.unpackedSize / 1024);
  for (const file of files) {
    if (!existsSync(join(ROOT, file))) {
      throw new StageFailure({
        command: step.command,
        status: 1,
        output: `${file} is listed in the package and does not exist in the checkout`,
        repair: 'regenerate the listing; a package entry with no file behind it is a broken tarball',
      });
    }
  }
  return {
    line: `package ok — ${files.length} files, ${kilobytes} kB unpacked, ${packed.filename}`,
    totals: { packageFiles: files.length, packageFile: packed.filename },
  };
}

/**
 * The inventory, in the order it runs. An id is what `--only` selects, what a failure
 * report names and what CONTRIBUTING.md lists, so the three cannot describe different
 * sets of checks.
 */
export const STAGES = Object.freeze([
  { id: 'suite', title: 'the public contract suite', run: suiteStage },
  { id: 'cli-smoke', title: 'the CLI answers for itself', run: cliSmokeStage },
  { id: 'worked-example', title: 'the worked example, end to end', run: workedExampleStage },
  { id: 'machine-paths', title: 'no machine paths in the tree', run: machinePathsStage },
  { id: 'public-text', title: 'public text and commit messages', run: publicTextStage },
  { id: 'commit-signoff', title: 'every commit is signed off', run: commitSignoffStage },
  { id: 'docs', title: 'documentation matches the CLI and links resolve', run: docsStage },
  { id: 'config', title: 'the shipped configuration example is current', run: configStage },
  { id: 'package', title: 'the published package carries what it should', run: packageStage },
]);

function parseArguments(argv) {
  const options = { only: [], range: '', list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--only') {
      options.only = String(argv[index + 1] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      index += 1;
    } else if (flag === '--commit-range') {
      options.range = String(argv[index + 1] ?? '');
      index += 1;
    } else if (flag === '--list') {
      options.list = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!options.range) options.range = String(process.env.VERIFY_COMMIT_RANGE ?? '').trim();
  return options;
}

function selectedStages(only) {
  if (only.length === 0) return STAGES;
  const known = new Set(STAGES.map((stage) => stage.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown stage: ${unknown.join(', ')}; stages are ${STAGES.map((stage) => stage.id).join(', ')}`);
  }
  return STAGES.filter((stage) => only.includes(stage.id));
}

export function reportFailure(stage, failure, ran) {
  const lines = [`verify: FAILED at ${stage.id} — ${stage.title}`];
  lines.push(`  command: ${failure.command}`);
  lines.push(`  exit: ${failure.status === null ? 'did not run' : failure.status}`);
  const output = String(failure.output ?? '').trim();
  if (output) {
    lines.push('  output:');
    for (const line of output.split('\n')) lines.push(`    | ${line}`);
  }
  if (failure.repair) lines.push(`  repair: ${failure.repair}`);
  lines.push(
    `verify: failed — ${ran.length} of ${ran.length + 1} stages ran (ok: ${ran.map((entry) => entry.id).join(', ') || 'none'})`,
  );
  return lines.join('\n');
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`verify: ${error.message}`);
    console.error(`usage: node scripts/verify.mjs [--only ${STAGES.map((stage) => stage.id).join(',')}] [--commit-range <rev-range>] [--list]`);
    return 2;
  }
  if (options.list) {
    for (const stage of STAGES) console.log(`${stage.id}\t${stage.title}`);
    return 0;
  }

  let stages;
  try {
    stages = selectedStages(options.only);
  } catch (error) {
    console.error(`verify: ${error.message}`);
    return 2;
  }

  const context = { root: ROOT, range: options.range };
  const ran = [];
  const totals = {};
  for (const stage of stages) {
    try {
      const result = stage.run(context);
      Object.assign(totals, result.totals ?? {});
      console.log(`verify: ${result.line}`);
      ran.push(stage);
    } catch (error) {
      if (!(error instanceof StageFailure)) throw error;
      console.error(reportFailure(stage, error, ran));
      return 1;
    }
  }

  const summary = [];
  if (totals.tests !== undefined) summary.push(`${totals.tests} tests pass, ${totals.skipped ?? 0} skipped`);
  if (totals.packageFiles !== undefined) summary.push(`${totals.packageFiles} files in ${totals.packageFile}`);
  console.log(`verify: ok — ${stages.length} stages${summary.length ? ` — ${summary.join('; ')}` : ''}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
