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
 * under review; without one, the range runs from the first base branch this checkout is
 * genuinely ahead of to HEAD. A base that resolves to HEAD is passed over while a candidate
 * behind it exists, because a clone records the branch it was made from in `origin/HEAD` and a
 * comparison against that branch's own tip reads no commit. A default range that reads no
 * commit -- no base resolves, or every base it resolves sits at HEAD -- is refused, naming the
 * bases it tried and the flag that supplies the range, rather than reporting commits it never
 * read.
 *
 * A linked worktree is a first-class checkout: every stage reads tracked content through
 * git or an explicit exclusion, so the `.git` pointer file a worktree carries is never
 * mistaken for product content. `--only` narrows the stages a developer runs; CI and the
 * documented command run the default inventory.
 *
 * Zero dependencies: Node built-ins, and the same interpreter each repository script needs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/**
 * What a stage reads for itself. An input that is missing, unreadable or not the shape the
 * stage needs is that stage's own failure, named where it can be repaired: an error escaping
 * from here would leave the run with a stack trace where a stage report belongs.
 */
function readInput(path, repair, encoding = 'utf8') {
  try {
    return readFileSync(path, encoding);
  } catch (error) {
    throw new StageFailure({ command: `read ${relative(ROOT, path)}`, status: null, output: error.message, repair });
  }
}

function readJsonInput(path, repair) {
  const text = readInput(path, repair);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StageFailure({
      command: `read ${relative(ROOT, path)}`,
      status: null,
      output: `${relative(ROOT, path)} is not valid JSON (${error.message})`,
      repair,
    });
  }
}

function listDirectory(path, repair) {
  try {
    return readdirSync(path);
  } catch (error) {
    throw new StageFailure({ command: `list ${relative(ROOT, path)}`, status: null, output: error.message, repair });
  }
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
  const pkg = readJsonInput(
    join(ROOT, 'package.json'),
    'the suite is the file list in package.json; restore the file or the repository cannot state what its suite is',
  );
  const listed = String(pkg.scripts?.test ?? '')
    .split(/\s+/)
    .filter((token) => token.endsWith('.test.js'));
  const present = listDirectory(
    join(ROOT, 'selftest'),
    'the public suite lives in selftest/; restore the directory or the repository has no suite to run',
  )
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

/**
 * The calibration README promises that its golden packets are, byte for byte, what the worked
 * example writes for the checkout area. Bytes and not parsed JSON, because a reader is handed
 * the file and a key order or a final newline is part of what it reads. Golden entries may
 * share a route (a refusal copies a reading), so each one is compared on its own. A packet the
 * comparison cannot pair -- unreadable, not JSON, no route, or a route two written packets
 * claim -- is a problem in itself: skipping it would let the set shrink without a failure.
 */
export function goldenPacketProblems(golden, written) {
  const problems = [];
  const routeOf = (entry) => {
    if (!Buffer.isBuffer(entry.bytes)) return null;
    let parsed;
    try {
      parsed = JSON.parse(entry.bytes.toString('utf8'));
    } catch {
      return null;
    }
    const route = parsed?.route;
    return typeof route === 'string' && route.length > 0 ? route : null;
  };
  const paired = (entries) =>
    entries.flatMap((entry) => {
      const route = routeOf(entry);
      if (route !== null) return [{ ...entry, route }];
      problems.push(`${entry.name} is not a packet: it cannot be read, is not JSON or has no non-empty string route`);
      return [];
    });

  const goldenPackets = paired(golden);
  const writtenPackets = paired(written);
  if (golden.length === 0) problems.push('there is no golden packet to compare the run with');
  if (written.length === 0) problems.push('the run wrote no packet to compare with the golden set');

  const byRoute = new Map();
  for (const entry of writtenPackets) byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
  for (const [route, entries] of byRoute) {
    if (entries.length > 1) {
      const uncompared = goldenPackets.filter((entry) => entry.route === route).map((entry) => entry.name);
      problems.push(
        `${entries.map((entry) => entry.name).join(' and ')} share the route ${route}; a run writes one packet per route` +
          (uncompared.length > 0 ? `, so ${uncompared.join(' and ')} cannot be compared` : ''),
      );
    }
  }

  const goldenRoutes = new Set(goldenPackets.map((entry) => entry.route));
  for (const entry of goldenPackets) {
    const matches = byRoute.get(entry.route);
    if (!matches) {
      problems.push(`${entry.name} holds ${entry.route}, and the run wrote no packet for that route`);
      continue;
    }
    if (matches.length > 1) continue;
    const [fresh] = matches;
    if (!entry.bytes.equals(fresh.bytes)) {
      let at = 0;
      while (at < entry.bytes.length && at < fresh.bytes.length && entry.bytes[at] === fresh.bytes[at]) at += 1;
      problems.push(
        `${entry.name} differs from ${fresh.name}, the fresh packet for ${entry.route} ` +
          `(${entry.bytes.length} and ${fresh.bytes.length} bytes, first difference at byte ${at})`,
      );
    }
  }
  for (const entry of writtenPackets) {
    if (!goldenRoutes.has(entry.route)) {
      problems.push(`${entry.name} holds ${entry.route}, and no golden packet holds that route`);
    }
  }
  return problems;
}

export const EXAMPLE_STEPS = Object.freeze([
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
  {
    label: 'write the checkout packets',
    cli: ['cover', '--config', 'flowtrace.config.json', '--area', 'checkout', '--packets', 'out/checkout-packets'],
    empty: 'out/checkout-packets',
  },
  { label: 'compare the packets with the golden set', golden: { golden: 'calibration', written: 'out/checkout-packets' } },
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

function packetFiles(dir, keep) {
  const listed = listDirectory(
    join(EXAMPLE, dir),
    'the golden set and the packets the run writes both live in examples/demo-shop; rerun the worked example from its own directory',
  );
  return listed
    .filter(keep)
    .sort()
    .map((name) => {
      const path = join(EXAMPLE, dir, name);
      let bytes = null;
      try {
        bytes = readFileSync(path);
      } catch {
        // An unreadable packet stays in the set, where the comparison names it.
      }
      return { name: relative(ROOT, path), bytes };
    });
}

function goldenComparison({ golden, written }) {
  const goldenPackets = packetFiles(golden, (name) => name.endsWith('.packet.json'));
  const writtenPackets = packetFiles(written, () => true);
  const problems = goldenPacketProblems(goldenPackets, writtenPackets);
  if (problems.length > 0) {
    throw new StageFailure({
      command: `compare examples/demo-shop/${written} with examples/demo-shop/${golden}`,
      status: 1,
      output: problems.join('\n'),
      repair:
        'a golden packet is a fresh run of the worked example: if the change that moved it is intended, ' +
        `copy the packet from examples/demo-shop/${written} over the golden file byte for byte, ` +
        'then reread its verdict and note and rerun calibrate; otherwise fix the change',
    });
  }
}

function workedExampleStage() {
  const exampleRepair =
    'the worked example is the change a reviewer can see: fix the change or extend examples/demo-shop with the idiom it recognises';
  for (const step of EXAMPLE_STEPS) {
    if (step.compare) {
      const [first, second] = step.compare.map((path) => join(EXAMPLE, path));
      const written = 'both exports are written by the steps above; rerun the worked example from its own directory';
      const left = readInput(first, written, null);
      const right = readInput(second, written, null);
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
    if (step.golden) {
      goldenComparison(step.golden);
      continue;
    }
    if (step.empty) {
      const dir = join(EXAMPLE, step.empty);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
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

/**
 * The comparison the default reads from. `origin/HEAD` records the branch a clone was made from,
 * so a clone of a feature branch points it at that branch's own tip: comparing against it reads
 * no commit while looking exactly like a clean scan. A candidate that resolves to HEAD is
 * therefore passed over while one this checkout is genuinely ahead of exists. When no candidate
 * is ahead, the comparison would read nothing, so there is no range and `null` says so rather
 * than naming the empty one: a stage that vouched for zero commit messages would vouch for a
 * tree it never inspected.
 */
export function pickRange(head, candidates, resolve) {
  if (head === null) return null;
  for (const base of candidates) {
    const mergeBase = resolve(base);
    if (mergeBase === null || mergeBase === head) continue;
    return { base, range: `${mergeBase}..HEAD` };
  }
  return null;
}

function defaultRange() {
  return pickRange(git(['rev-parse', 'HEAD']), BASE_BRANCHES, (base) => git(['merge-base', base, 'HEAD']));
}

function resolvedRange(explicit) {
  if (explicit.startsWith('-')) {
    throw new StageFailure({
      command: `--commit-range ${explicit}`,
      status: null,
      output: `${explicit} names a git option, not a range of commits`,
      repair: 'pass the commits to read: --commit-range origin/main..HEAD',
    });
  }
  const picked = explicit ? { range: explicit } : defaultRange();
  if (picked === null) {
    throw new StageFailure({
      command: 'git merge-base <base> HEAD',
      status: null,
      output: `no commit to read: no base branch this checkout is ahead of (tried ${BASE_BRANCHES.join(', ')})`,
      repair: 'pass the commits to read: node scripts/verify.mjs --commit-range <base>..HEAD',
    });
  }
  const { range } = picked;
  const count = git(['rev-list', '--count', range]);
  if (count === null) {
    throw new StageFailure({
      command: shell('git', ['rev-list', '--count', range]),
      status: null,
      output: `${range} is not a revision range git can read`,
      repair: 'pass a range that resolves, for example --commit-range origin/main..HEAD',
    });
  }
  const commits = Number(count);
  if (commits === 0) {
    throw new StageFailure({
      command: shell('git', ['rev-list', '--count', range]),
      status: null,
      output: explicit
        ? `${range} names no commit, so the stages that read commits would vouch for none`
        : `${range} names no commit: no base branch this checkout is ahead of (tried ${BASE_BRANCHES.join(', ')})`,
      repair: explicit
        ? 'name the commits to read, for example --commit-range origin/main..HEAD'
        : 'pass the commits to read: node scripts/verify.mjs --commit-range <base>..HEAD',
    });
  }
  return { range, commits };
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

/**
 * A stage that stops for any reason other than a StageFailure still reports as that stage.
 * Anything else would print a stack trace where the stage, its command and its repair go,
 * and a reader could not tell which check stopped the run.
 */
export function stageFailure(stage, error) {
  if (error instanceof StageFailure) return error;
  return new StageFailure({
    command: `node scripts/verify.mjs --only ${stage.id}`,
    status: null,
    output: error instanceof Error ? error.message : String(error),
    repair: `nothing here shows ${stage.id} passed: rerun that stage alone and fix what it names`,
  });
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
      console.error(reportFailure(stage, stageFailure(stage, error), ran));
      return 1;
    }
  }

  const summary = [];
  if (totals.tests !== undefined) summary.push(`${totals.tests} tests pass, ${totals.skipped ?? 0} skipped`);
  if (totals.packageFiles !== undefined) summary.push(`${totals.packageFiles} files in ${totals.packageFile}`);
  console.log(`verify: ok — ${stages.length} stages${summary.length ? ` — ${summary.join('; ')}` : ''}`);
  return 0;
}

/**
 * Whether this file was invoked as the process's entry point, however the path to it was
 * spelled. A checkout reached through a symlinked directory spells that path differently
 * from the module's own resolved location, and a guard that compares the two spellings
 * would run nothing and exit zero, which reads exactly like a passing run.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const physical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return physical(resolve(process.argv[1])) === physical(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  // An exit while a large report is still draining into a pipe cuts the report off
  process.exitCode = main(process.argv.slice(2));
}

export { main };
