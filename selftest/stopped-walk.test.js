/**
 * A walk that stopped, read by the verbs that build an answer on top of route walks:
 * the mark each item carries, the negative claims a stopped walk must not back, the
 * `--require-complete` gate, the `affected` rung, the `check` and `join --against` walk
 * boundary, the selected component entry, the code index answers in the identity and the
 * external boundary of a zero-hit lookup.
 *
 * Most cases run the CLI over invented corpora: `quarry-dispatch` stops at depth, at the
 * fan-out cap and where no code index answers; `kiln-yard` walks complete; `willow-lending`
 * calls into classes of a package that no file declares. A case that needs a code index
 * names a stand-in binary through FLOWTRACE_SCOUT_BIN, or calls `trace` in process with an
 * `outbound` stub, because the public corpus ships no index.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CLI, copyFixture, runCli } from './helpers.js';
import { trace } from '../lib/trace.js';
import { createScout } from '../lib/scout.js';
import { packetHashOf } from '../lib/packets.js';
import { readiness, readInventory } from '../lib/readiness.js';
import { walkBoundary } from '../lib/result-status.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUARRY = 'quarry.config.json';
const AREA = 'quarry.area.txt';
const PLAN = 'POST dispatch/v1/plans';
const ROUTE = 'POST dispatch/v1/route';
const CHECK = 'POST dispatch/v1/check';
const SURVEY = 'POST dispatch/v1/survey';
const QUIET = 'GET dispatch/v1/quiet';
const PLAN_MARK = { traversal: 'partial', stops: { depth: 3 } };
const KILN = 'kiln.config.json';
const FIRINGS = 'GET kiln/v1/kilns/{kilnId}/firings';
const WILLOW = 'willow.config.json';
const SETTLE = 'POST lending/v1/loans/{loanId}/settle';
const LOAN = 'GET lending/v1/loans/{loanId}';
const NOTICE = /^flowtrace: [a-z -]+: \d+ of \d+ walks did not complete \(.*\); its answer can miss what they did not reach$/m;
const MARK = /walk (partial|unknown) \(/;

/** A named corpus as a git checkout with fresh facts and a join, so freshness reads matching. */
function gitFixture(t, name, configName) {
  const dir = copyFixture(t, name);
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  for (const verb of ['extract', 'join']) {
    const run = runCli([verb, '--config', configName], { cwd: dir });
    assert.equal(run.status, 0, run.stderr);
  }
  return dir;
}

function commitAll(dir, message) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

function quarry(t) {
  return gitFixture(t, 'quarry-dispatch', QUARRY);
}

function run(dir, args, config = QUARRY) {
  return runCli([...args, '--config', config], { cwd: dir });
}

function json(result) {
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

/** The CLI with extra environment, for the stand-in code index binary. */
function runWithEnv(dir, args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * A stand-in for the code index binary: `refs SettlementBook` answers with an empty outbound
 * section, and every other class is a zero-hit with the exit 3 the real binary gives.
 */
function fakeScout(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-fake-scout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'scout.mjs');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      'const [, , verb, name] = process.argv;',
      "if (verb !== 'refs') process.exit(2);",
      "if (name === 'SettlementBook') { process.stdout.write('outbound:\\n'); process.exit(0); }",
      "process.stdout.write(`no symbol matches '${name}'\\n`);",
      'process.exit(3);',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { FLOWTRACE_SCOUT_BIN: bin };
}

/**
 * A stand-in that answers in the form of the real `refs` reply: a symbol line, `def:`, an
 * `inbound:` section, an `outbound:` section only when `--out` is given, rows that carry
 * their source text after the target, and a `next:` line. `replies` maps a class to the
 * reply for it; a class it does not name is a zero-hit. Each call's arguments go to a log.
 */
function contractScout(t, replies) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-contract-scout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'scout.mjs');
  const log = join(dir, 'calls.log');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
      `const replies = ${JSON.stringify(replies)};`,
      'const [verb, name] = args;',
      "if (verb !== 'refs') process.exit(2);",
      'const reply = replies[name];',
      'if (!reply) { process.stdout.write(`no symbol matches "${name}"\\n`); process.exit(3); }',
      'if (reply.raw !== undefined) { process.stdout.write(reply.raw); process.exit(reply.status); }',
      'const rows = (kinds) => Object.entries(kinds).flatMap(([kind, list]) => [`  ${kind} (${list.length}):`, ...list.map((row) => `    ${row}`)]);',
      'const lines = [`Willow.Lending.Services.${name}  (class)  0 inbound (showing 0)`, `def: ${reply.def}`, \'inbound:\', ...rows({ inherits: [], \'uses-type\': [] })];',
      "if (args.includes('--out')) lines.push('outbound:', ...rows(reply.outbound));",
      'lines.push(`next: devscout tests Willow.Lending.Services.${name}`, \'\');',
      "process.stdout.write(lines.join('\\n'));",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { env: { FLOWTRACE_SCOUT_BIN: bin }, calls };
}

function willow(t) {
  const dir = gitFixture(t, 'willow-lending', WILLOW);
  return { dir, env: fakeScout(t) };
}

function factSetsOf(dir, repos) {
  return repos.map((repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')));
}

function stderrLines(result) {
  return result.stderr.split('\n').filter((line) => line.startsWith('flowtrace: not complete: '));
}

test('Stopped walk AC-1: each reading verb marks an item from a stopped walk, in text and in --json', (t) => {
  const dir = quarry(t);
  const baseline = ['--area', AREA, '--baseline', 'out/quarry.baseline.json'];

  const written = run(dir, ['check', ...baseline, '--write-baseline']);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /POST dispatch\/v1\/plans: walk partial \(depth 3\)/);
  assert.match(written.stdout, /GET dispatch\/v1\/quiet: walk unknown \(provider-unavailable 1\)/);
  assert.match(written.stderr, NOTICE);
  const compared = run(dir, ['check', ...baseline]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.match(compared.stdout, /POST dispatch\/v1\/plans: walk partial \(depth 3\)/);
  const checkJson = json(run(dir, ['check', ...baseline, '--json']));
  assert.deepEqual(checkJson.walks.find((entry) => entry.key === PLAN).walk, PLAN_MARK);
  assert.equal(checkJson.walks.find((entry) => entry.key === ROUTE), undefined, 'a complete walk carries no mark');

  const scope = run(dir, ['scope', '--area', AREA]);
  assert.equal(scope.status, 0, scope.stderr);
  assert.match(scope.stdout, /^POST dispatch\/v1\/plans — .* — walk partial \(depth 3\)$/m);
  assert.match(scope.stdout, /^POST dispatch\/v1\/route — .* — server-gate: none$/m);
  assert.match(scope.stderr, NOTICE);
  const scopeJson = json(run(dir, ['scope', '--area', AREA, '--json']));
  assert.deepEqual(scopeJson.routes.find((route) => route.key === PLAN).walk, PLAN_MARK);
  assert.equal('walk' in scopeJson.routes.find((route) => route.key === ROUTE), false);

  const surface = run(dir, ['surface', PLAN]);
  assert.equal(surface.status, 0, surface.stderr);
  assert.match(surface.stdout.split('\n')[1], /^start: POST dispatch\/v1\/plans/);
  assert.match(surface.stdout, /^status: traversal partial/m);
  assert.match(surface.stderr, NOTICE);
  assert.deepEqual(json(run(dir, ['surface', PLAN, '--json'])).status.stops, { depth: 3 });

  const skeleton = run(dir, ['skeleton', PLAN, '--stub']);
  assert.equal(skeleton.status, 0, skeleton.stderr);
  assert.match(skeleton.stdout, /test\('walk stopped 1: depth SurveyD\.Probe'/);
  assert.match(skeleton.stdout, /^\/\/ walk partial \(depth 3\)$/m);
  assert.match(skeleton.stderr, NOTICE);
  const skeletonJson = json(run(dir, ['skeleton', PLAN, '--stub', '--json']));
  assert.equal(skeletonJson.plan.counts.stops, 3);
  assert.deepEqual(skeletonJson.plan.walk, PLAN_MARK);
  assert.match(skeletonJson.spec, /^\/\/ walk partial \(depth 3\)$/m);
  const skeletonOut = run(dir, ['skeleton', PLAN, '--stub', '--out', 'out/plans.spec.ts']);
  assert.equal(skeletonOut.status, 0, skeletonOut.stderr);
  assert.match(skeletonOut.stdout, / · walk partial \(depth 3\)$/m);

  const snapshot = run(dir, ['join', '--snapshot', 'out/snapshot.json']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const against = run(dir, ['join', '--against', 'out/snapshot.json']);
  assert.equal(against.status, 0, against.stderr);
  assert.match(against.stdout, /^walk POST dispatch\/v1\/plans: snapshot walk partial \(depth 3\) · current walk partial \(depth 3\)$/m);
  assert.match(against.stderr, NOTICE);
  const againstJson = json(run(dir, ['join', '--against', 'out/snapshot.json', '--json']));
  const planWalk = againstJson.walks.find((entry) => entry.route === PLAN);
  assert.deepEqual(planWalk.snapshot, PLAN_MARK);
  assert.deepEqual(planWalk.current, PLAN_MARK);

  appendFileSync(join(dir, 'backend', 'src', 'Services', 'SurveyChain.cs'), '\n// changed\n');
  const affected = run(dir, ['affected', '--area', AREA]);
  assert.match(affected.stdout, /walk partial \(depth 3\)/);
  assert.match(affected.stderr, NOTICE);
  const affectedJson = json(run(dir, ['affected', '--area', AREA, '--json']));
  assert.deepEqual(affectedJson.routes.find((route) => route.key === PLAN).walk, PLAN_MARK);
});

test('Stopped walk AC-1: a run in which no walk stopped carries no mark and no walk key', (t) => {
  const dir = gitFixture(t, 'kiln-yard', KILN);
  writeFileSync(join(dir, 'out', 'kiln.area.txt'), `${FIRINGS}\n`);
  const area = ['--area', 'out/kiln.area.txt'];
  const outputs = [
    run(dir, ['check', ...area, '--baseline', 'out/kiln.baseline.json', '--write-baseline'], KILN),
    run(dir, ['check', ...area, '--baseline', 'out/kiln.baseline.json', '--json'], KILN),
    run(dir, ['scope', ...area], KILN),
    run(dir, ['scope', ...area, '--json'], KILN),
    run(dir, ['surface', FIRINGS], KILN),
    run(dir, ['surface', FIRINGS, '--json'], KILN),
    run(dir, ['skeleton', FIRINGS, '--stub'], KILN),
    run(dir, ['skeleton', FIRINGS, '--stub', '--json'], KILN),
  ];
  run(dir, ['join', '--snapshot', 'out/snapshot.json'], KILN);
  outputs.push(run(dir, ['join', '--against', 'out/snapshot.json'], KILN));
  outputs.push(run(dir, ['join', '--against', 'out/snapshot.json', '--json'], KILN));
  for (const output of outputs) {
    assert.doesNotMatch(output.stdout, MARK);
    assert.doesNotMatch(output.stdout, /"walks?":/);
    assert.doesNotMatch(output.stdout, /walk stopped/);
    assert.doesNotMatch(output.stderr, NOTICE);
  }
  assert.equal(json(outputs[7]).plan.counts.stops, undefined);
});

test('Stopped walk AC-2: scope never prints no gate from a walk that stopped before a gate', (t) => {
  const dir = quarry(t);
  const config = JSON.parse(readFileSync(join(dir, QUARRY), 'utf8'));
  writeFileSync(join(dir, 'out', 'none.config.json'), JSON.stringify({ ...config, scope: { gatePatterns: [] } }));
  writeFileSync(join(dir, 'out', 'gate.config.json'), JSON.stringify({ ...config, scope: { gatePatterns: ['Gate'] } }));
  const copyConfig = (name) => {
    writeFileSync(join(dir, name), readFileSync(join(dir, 'out', name)));
    t.after(() => rmSync(join(dir, name), { force: true }));
  };
  copyConfig('none.config.json');
  copyConfig('gate.config.json');

  for (const name of [QUARRY, 'none.config.json']) {
    const text = run(dir, ['scope', '--area', AREA], name);
    assert.match(text.stdout, /^POST dispatch\/v1\/plans — .* — server-gate: unknown — walk partial \(depth 3\)$/m, name);
    const routes = json(run(dir, ['scope', '--area', AREA, '--json'], name)).routes;
    assert.equal(routes.find((route) => route.key === PLAN).serverGate, 'unknown', name);
    assert.equal(routes.find((route) => route.key === ROUTE).serverGate, null, `${name}: a complete walk keeps no gate`);
  }

  // At depth 2 the walk of ROUTE reaches the gate and then stops: the gate stays, marked.
  const gated = json(run(dir, ['scope', '--area', AREA, '--json', '--depth', '2'], 'gate.config.json')).routes;
  const route = gated.find((entry) => entry.key === ROUTE);
  assert.equal(route.serverGate, 'api:src/Controllers/DispatchController.cs:20');
  assert.equal(route.walk.traversal, 'partial');
});

test('Stopped walk AC-2: readiness keeps the counts of a stopped route and prints unknown for its empty sinks', (t) => {
  const dir = gitFixture(t, 'nursery-mobile', 'nursery.config.json');
  writeFileSync(join(dir, 'out', 'areas.txt'), 'plot,src/**\n');
  const md = run(dir, ['readiness', '--areas', 'out/areas.txt', '--md', 'out/readiness.md'], 'nursery.config.json');
  assert.equal(md.status, 0, md.stderr);
  const page = readFileSync(join(dir, 'out', 'readiness.md'), 'utf8');
  const row = page.split('\n').find((line) => line.startsWith('| POST nursery/v1/plots/*/water'));
  assert.ok(row, page);
  assert.match(row, /· walk unknown \(provider-unavailable 1\) \| 1 \| 0 \| 0 \| 0 \| unknown \|/);
  assert.doesNotMatch(row, /\| 0 \| n\/a \|$/, 'no sink cell reads 0');
  const report = json(run(dir, ['readiness', '--areas', 'out/areas.txt', '--json'], 'nursery.config.json'));
  const record = report.routes['POST nursery/v1/plots/*/water'];
  assert.deepEqual(record.seeds, { reachable: 1, edge: 0, unreachable: 0, unknown: 0 });
  assert.equal(record.sinks['db-write'], 0, 'the observed count stays');
  assert.deepEqual(record.unknownSinks, ['db-write', 'db-read', 'publish', 'worker', 'signalr', 'push-other', 'infra-only']);
});

test('Stopped walk AC-2: an Unreachable-only verdict over a stopped route walk reads unknown with its stops', (t) => {
  const dir = gitFixture(t, 'nursery-mobile', 'nursery.config.json');
  const sets = factSetsOf(dir, ['backend', 'mobile']);
  const rows = readInventory('plot,src/**\n');
  const gated = (stopped) => (factSets, key, options) => {
    const walked = trace(factSets, key, options);
    const seeds = [{ id: 'U1', key: 'gated', dispositions: [{ kind: 'error_return', disposition: 'taken' }], reachability: 'unreachable', outcomes: [] }];
    const status = stopped ? walked.status : { ...walked.status, traversal: 'complete', stops: {}, frontier: [] };
    return { ...walked, seeds, status };
  };

  // No code index is configured, so each route walk stops where it would ask one.
  const traceOptions = { outbound: createScout({ repos: [] }).outbound };
  const stopped = readiness(sets, { rows, traceOptions, trace: gated(true) });
  const area = stopped.areas[0];
  assert.deepEqual(area.unreachableOnly, []);
  assert.ok(area.unreachableOnlyUnknown.length > 0);
  for (const entry of area.unreachableOnlyUnknown) assert.equal(entry.walk.traversal, 'unknown', entry.name);
  assert.equal(stopped.estate.unreachableOnly, 0, 'the estate count leaves it out');

  const complete = readiness(sets, { rows, traceOptions, trace: gated(false) });
  assert.equal(complete.areas[0].unreachableOnlyUnknown, undefined);
  assert.equal(complete.areas[0].unreachableOnly.length, area.unreachableOnlyUnknown.length);
});

test('Stopped walk AC-3: --require-complete fails each reading verb after its normal output', (t) => {
  const dir = quarry(t);
  const label = (verb, key) => new RegExp(`^flowtrace: not complete: ${verb} ${key.replace(/[/*]/g, '\\$&')}: depth 3 \\(raise --depth\\)$`, 'm');
  run(dir, ['check', '--area', AREA, '--baseline', 'out/b.json', '--write-baseline']);
  run(dir, ['join', '--snapshot', 'out/snapshot.json']);
  const cases = [
    ['check', ['check', '--area', AREA, '--baseline', 'out/b.json']],
    ['scope', ['scope', '--area', AREA]],
    ['surface', ['surface', PLAN]],
    ['skeleton', ['skeleton', PLAN, '--stub']],
    ['join --against current', ['join', '--against', 'out/snapshot.json']],
  ];
  for (const [verb, args] of cases) {
    const plain = run(dir, args);
    const gated = run(dir, [...args, '--require-complete']);
    assert.equal(gated.status, 4, `${verb}: ${gated.stderr}`);
    assert.equal(gated.stdout, plain.stdout, `${verb}: the normal output comes first and stays`);
    assert.match(gated.stderr, label(verb, PLAN), verb);
  }

  // A skeleton refusal (3) and a join --against skip (5) give way to 4.
  const refused = run(dir, ['skeleton', PLAN, '--require-complete']);
  assert.equal(refused.status, 4, refused.stderr);
  assert.equal(run(dir, ['join', '--against', 'out/snapshot.json', '--fail-on', 'path']).status, 5);
  assert.equal(run(dir, ['join', '--against', 'out/snapshot.json', '--fail-on', 'path', '--require-complete']).status, 4);

  // A check regression (1) gives way to 4.
  const baseline = JSON.parse(readFileSync(join(dir, 'out', 'b.json'), 'utf8'));
  baseline.totals.seedsObserved = 1000;
  writeFileSync(join(dir, 'out', 'regressed.json'), JSON.stringify(baseline));
  assert.equal(run(dir, ['check', '--area', AREA, '--baseline', 'out/regressed.json']).status, 1);
  assert.equal(run(dir, ['check', '--area', AREA, '--baseline', 'out/regressed.json', '--require-complete']).status, 4);

  // The snapshot side is held to its traversal only; the current side reads its freshness.
  appendFileSync(join(dir, 'backend', 'src', 'Repositories', 'DispatchLedger.cs'), '\n// changed\n');
  const fresh = run(dir, ['join', '--against', 'out/snapshot.json', '--require-complete']);
  assert.match(fresh.stderr, /^flowtrace: not complete: join --against current .*: freshness mismatched/m);
  assert.doesNotMatch(fresh.stderr, /^flowtrace: not complete: join --against snapshot .*: freshness/m);
});

test('Stopped walk AC-3: the flag is refused where no walk is gated, and a usage error stays exit 2', (t) => {
  const dir = quarry(t);
  for (const args of [
    ['scope', '--area', AREA, '--require-complete=yes'],
    ['cover', '--area', AREA, '--require-complete'],
    ['join', '--require-complete'],
    ['routes-of', 'src/Controllers/DispatchController.cs:24', '--require-complete'],
  ]) {
    const refused = run(dir, args);
    assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stderr}`);
    assert.equal(refused.stdout, '', args.join(' '));
  }
  writeFileSync(join(dir, 'out', 'facts', 'api.json'), '{ not json');
  assert.equal(run(dir, ['scope', '--area', AREA, '--require-complete']).status, 1);
});

test('Stopped walk AC-3: check, scope and join --against walk at the --depth they are given', (t) => {
  const dir = quarry(t);
  const scope = json(run(dir, ['scope', '--area', AREA, '--json', '--depth', '1']));
  assert.deepEqual(scope.routes.find((route) => route.key === ROUTE).walk.stops, { depth: 1 });
  const check = json(run(dir, ['check', '--area', AREA, '--baseline', 'out/b.json', '--write-baseline', '--json', '--depth', '1']));
  assert.ok(check.walks.find((entry) => entry.key === ROUTE).walk.stops.depth > 0);
  run(dir, ['join', '--snapshot', 'out/snapshot.json']);
  const against = json(run(dir, ['join', '--against', 'out/snapshot.json', '--json', '--depth', '1']));
  const routeWalk = against.walks.find((entry) => entry.route === ROUTE);
  assert.deepEqual(routeWalk.snapshot.stops, { depth: 1 });
  assert.deepEqual(routeWalk.current.stops, { depth: 1 });
});

test('Stopped walk AC-3: without the flag, the exit codes stay as they were', (t) => {
  const dir = quarry(t);
  assert.equal(run(dir, ['scope', '--area', AREA]).status, 0);
  assert.equal(run(dir, ['surface', PLAN]).status, 0);
  assert.equal(run(dir, ['skeleton', PLAN]).status, 3);
  assert.equal(run(dir, ['skeleton', PLAN, '--stub']).status, 0);
  const nursery = gitFixture(t, 'nursery-mobile', 'nursery.config.json');
  writeFileSync(join(nursery, 'out', 'areas.txt'), 'plot,src/**\n');
  const ready = run(nursery, ['readiness', '--areas', 'out/areas.txt'], 'nursery.config.json');
  assert.equal(ready.status, 0, ready.stderr);
  const gated = run(nursery, ['readiness', '--areas', 'out/areas.txt', '--require-complete'], 'nursery.config.json');
  assert.equal(gated.status, 4);
  assert.match(gated.stderr, /^flowtrace: not complete: readiness .*: provider-unavailable 1$/m);
});

test('Stopped walk AC-4: affected selects a stopped route that reached no changed file', (t) => {
  const dir = quarry(t);
  appendFileSync(join(dir, 'backend', 'src', 'Repositories', 'DispatchLedger.cs'), '\n// changed\n');
  const plain = run(dir, ['affected', '--area', AREA, '--json']);
  assert.equal(plain.status, 4, plain.stderr);
  const report = JSON.parse(plain.stdout);
  const added = report.routes.filter((route) => route.reason === 'incomplete-walk');
  assert.ok(added.length > 0);
  for (const route of added) {
    assert.deepEqual(route.changed, [], route.key);
    assert.ok(['partial', 'unknown'].includes(route.walk.traversal), route.key);
  }
  assert.equal(report.incompleteWalk.rung, 'incomplete-walk');
  assert.deepEqual(report.incompleteWalk.routes, added.map((route) => route.key).sort());
  assert.ok(!added.some((route) => route.key === ROUTE), 'a complete walk that reached no change is not selected');

  const text = run(dir, ['affected', '--area', AREA]);
  assert.equal(text.status, 4);
  assert.match(text.stdout, /^incomplete-walk — /m);
  assert.match(text.stdout, /^ {2}POST dispatch\/v1\/plans {2}walk partial \(depth 3\)$/m);

  const playwright = run(dir, ['affected', '--area', AREA, '--playwright-args']);
  assert.equal(playwright.status, 4);
  assert.match(playwright.stderr, /^flowtrace: incomplete-walk: /m);

  const dotnet = run(dir, ['affected', '--area', AREA, '--dotnet-filter']);
  assert.match(dotnet.stderr, /^flowtrace: incomplete-walk: /m);
  const dotnetJson = json(run(dir, ['affected', '--area', AREA, '--dotnet-filter', '--json']));
  assert.equal(dotnet.status, dotnetJson.dotnetFilter.fallback ? 4 : 0, 'the exit is the dotnet answer');
  assert.match(dotnet.stderr, /^flowtrace: dotnet-filter \[api\]: /m);
  assert.equal(dotnetJson.incompleteWalk.rung, 'incomplete-walk');
  assert.ok(dotnetJson.routes.some((route) => route.reason === 'incomplete-walk'));
  for (const mode of [[], ['--json'], ['--playwright-args'], ['--dotnet-filter']]) {
    assert.equal(run(dir, ['affected', '--area', AREA, ...mode, '--require-complete']).status, 4, mode.join(' '));
  }
});

test('Stopped walk AC-4: a run that returns before its route walks is as before', (t) => {
  const dir = quarry(t);
  appendFileSync(join(dir, 'README.md'), '\nchanged\n');
  const result = run(dir, ['affected', '--area', AREA, '--json']);
  assert.doesNotMatch(result.stdout, /incomplete-walk/);
  assert.doesNotMatch(result.stderr, /incomplete-walk/);
});

test('Stopped walk AC-5: check records the walk boundary and fails closed when it changes', (t) => {
  const dir = quarry(t);
  const at = (file, ...flags) => ['check', '--area', AREA, '--baseline', `out/${file}`, ...flags];
  assert.equal(run(dir, at('b.json', '--write-baseline')).status, 0);
  const baseline = JSON.parse(readFileSync(join(dir, 'out', 'b.json'), 'utf8'));
  const plan = baseline.routes.find((route) => route.key === PLAN);
  assert.equal(plan.traversal, 'partial');
  assert.ok(plan.boundary.length > 0);
  for (const record of plan.boundary) {
    assert.deepEqual(Object.keys(record).sort(), ['caller', 'gate', 'reason', 'target']);
  }
  assert.deepEqual(baseline.routes.find((route) => route.key === ROUTE).boundary, []);

  const same = run(dir, at('b.json'));
  assert.equal(same.status, 0, same.stderr);
  assert.doesNotMatch(same.stdout, /walk boundary changed/);

  const lower = run(dir, at('b.json', '--depth', '2'));
  assert.equal(lower.status, 4, lower.stderr);
  assert.match(lower.stdout, /walk boundary changed on \d+ routes?/);
  assert.match(lower.stdout, /^ {4}\+ depth /m);
  const lowerJson = json(run(dir, at('b.json', '--depth', '2', '--json')));
  assert.ok(lowerJson.boundaryChanged.some((entry) => entry.added.length > 0));

  assert.equal(run(dir, at('shallow.json', '--write-baseline', '--depth', '2')).status, 0);
  const deeper = json(run(dir, at('shallow.json', '--json')));
  assert.equal(deeper.exit ?? 4, 4);
  assert.ok(deeper.boundaryChanged.some((entry) => entry.removed.length > 0), 'a stop that went away is a change too');
  assert.equal(run(dir, at('shallow.json')).status, 4);

  // A boundary change comes before a regression.
  baseline.totals.seedsObserved = 1000;
  writeFileSync(join(dir, 'out', 'regressed.json'), JSON.stringify(baseline));
  assert.equal(run(dir, at('regressed.json')).status, 1);
  assert.equal(run(dir, at('regressed.json', '--depth', '2')).status, 4);

  // An older baseline has no boundary on its routes; a new --write-baseline clears it.
  for (const route of baseline.routes) delete route.boundary;
  baseline.totals.seedsObserved = 0;
  writeFileSync(join(dir, 'out', 'old.json'), JSON.stringify(baseline));
  const old = run(dir, at('old.json'));
  assert.equal(old.status, 4);
  assert.equal(old.stderr.split('\n').filter((line) => line.includes('--write-baseline')).length, 1, old.stderr);
  assert.equal(run(dir, at('old.json', '--write-baseline')).status, 0);
  assert.equal(run(dir, at('old.json')).status, 0);

  rmSync(join(dir, 'out', 'refused.json'), { force: true });
  const refused = run(dir, at('refused.json', '--write-baseline', '--require-complete'));
  assert.equal(refused.status, 4);
  assert.equal(existsSync(join(dir, 'out', 'refused.json')), false, 'no baseline is written');
});

test('Stopped walk AC-5: two statuses that differ only in file and line give one boundary', () => {
  const entry = (file, line) => ({
    reason: 'depth',
    target: 'SurveyD.Probe',
    caller: { ref: 'SurveyC.Probe', file, line },
    callSite: { file, line },
  });
  const status = (file, line) => ({ traversal: 'partial', frontier: [entry(file, line)] });
  assert.deepEqual(walkBoundary(status('a.cs', 1)), walkBoundary(status('b.cs', 9)));
  assert.deepEqual(walkBoundary({ traversal: 'complete', frontier: [{ ...entry('a.cs', 1), reason: 'external-boundary' }] }), []);
});

test('Stopped walk AC-6: a packet from a stopped walk carries the mark and keeps its hash', (t) => {
  const dir = copyFixture(t, join('..', '..', 'examples', 'demo-shop'));
  assert.equal(runCli(['extract', '--config', 'flowtrace.config.json'], { cwd: dir }).status, 0);
  const result = runCli(['cover', '--config', 'flowtrace.config.json', '--area', 'checkout', '--packets', 'out/packets'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^packets checkout: 4 packets written, 1 from stopped walks, /m);
  const read = (name) => JSON.parse(readFileSync(join(dir, 'out', 'packets', `${name}.packet.json`), 'utf8'));
  const checkout = read('post-orders-v1-checkout');
  assert.deepEqual(Object.keys(checkout).at(-1), 'walk');
  assert.equal(checkout.walk.traversal, 'unknown');
  assert.equal(checkout.packetHash, packetHashOf(checkout.route, checkout.seeds));
  for (const name of ['get-catalog-v1-products', 'get-orders-v1-cart', 'post-orders-v1-cart-items']) {
    assert.equal('walk' in read(name), false, name);
  }
  const gated = runCli(
    ['cover', '--config', 'flowtrace.config.json', '--area', 'checkout', '--packets', 'out/gated', '--require-complete'],
    { cwd: dir },
  );
  assert.equal(gated.status, 4);
  assert.match(gated.stderr, /^flowtrace: not complete: cover --packets POST orders\/v1\/checkout: /m);
});

test('Stopped walk AC-7: readiness counts stopped routes per area and once across the estate', (t) => {
  const dir = gitFixture(t, 'nursery-mobile', 'nursery.config.json');
  // The page renders the badge, so both areas reach the route the badge calls.
  writeFileSync(
    join(dir, 'out', 'areas.txt'),
    'page,src/app/features/plots/plot-detail.page.ts\nbadge,src/app/features/plots/seedling-badge.component.ts\n',
  );
  const report = json(run(dir, ['readiness', '--areas', 'out/areas.txt', '--json'], 'nursery.config.json'));
  const total = Object.values(report.routes).filter((route) => route.walk).length;
  assert.ok(total > 0);
  for (const area of report.areas) assert.equal(area.stoppedWalks, area.stoppedRoutes.length, area.area);
  assert.ok(report.areas.reduce((sum, area) => sum + area.stoppedWalks, 0) > total, 'the areas share routes');
  assert.equal(report.estate.stoppedWalks, total);
  run(dir, ['readiness', '--areas', 'out/areas.txt', '--md', 'out/r.md'], 'nursery.config.json');
  const page = readFileSync(join(dir, 'out', 'r.md'), 'utf8');
  assert.match(page, /\| Coverage \| Stopped walks \|/);
  assert.match(page, new RegExp(`^\\| \\*\\*Estate\\*\\* .* ${total} \\|$`, 'm'));

  const kiln = gitFixture(t, 'kiln-yard', KILN);
  writeFileSync(join(kiln, 'out', 'areas.txt'), 'kiln,src/**\n');
  const complete = json(run(kiln, ['readiness', '--areas', 'out/areas.txt', '--json'], KILN));
  assert.equal(complete.estate.stoppedWalks, undefined, 'no walk stopped, no column');
});

test('Stopped walk AC-7: scope over stale facts marks its routes as over fresh facts, and only --require-complete fails it', (t) => {
  const dir = quarry(t);
  const fresh = json(run(dir, ['scope', '--area', AREA, '--json']));
  appendFileSync(join(dir, 'backend', 'src', 'Repositories', 'DispatchLedger.cs'), '\n// committed\n');
  commitAll(dir, 'move HEAD past the facts');
  const stale = run(dir, ['scope', '--area', AREA]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stderr, /facts for api/);
  assert.match(stale.stdout, MARK);
  const model = json(run(dir, ['scope', '--area', AREA, '--json']));
  assert.notEqual(model.freshness.value, 'matching');
  const rows = (report) => report.routes.map((route) => [route.key, route.serverGate, route.walk ?? null]);
  assert.deepEqual(rows(model), rows(fresh));
  assert.ok(model.routes.some((route) => route.walk && route.serverGate === 'unknown'));
  const gated = run(dir, ['scope', '--area', AREA, '--require-complete']);
  assert.equal(gated.status, 4, gated.stderr);
  assert.equal(gated.stdout, stale.stdout, 'the routes come first and stay');
  assert.match(gated.stderr, /facts for api/);
  assert.match(gated.stderr, /^flowtrace: not complete: scope /m);
});

test('Stopped walk AC-8: surface states the walk after its first line, and --out facts hold no status', (t) => {
  const dir = quarry(t);
  const text = run(dir, ['surface', PLAN]).stdout.split('\n');
  assert.match(text[0], /^surface POST dispatch\/v1\/plans: /);
  assert.match(text[1], /^start: /);
  assert.ok(text.includes('frontier: 3 stopped places'));
  assert.equal(text.filter((line) => /^ {2}depth {2}api {2}SurveyD\.Probe/.test(line)).length, 3);
  const model = json(run(dir, ['surface', PLAN, '--json']));
  assert.equal(model.status.traversal, 'partial');
  const saved = run(dir, ['surface', PLAN, '--out', 'out/surface.json']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.doesNotMatch(readFileSync(join(dir, 'out', 'surface.json'), 'utf8'), /"traversal"|"frontier"|"identity"/);
  const savedLines = saved.stdout.split('\n');
  assert.match(savedLines[0], /^surface POST dispatch\/v1\/plans: \d+ facts? -> /);
  assert.match(savedLines[1], /^start: /);
  assert.match(saved.stdout, /^status: traversal partial/m);
  assert.ok(savedLines.includes('frontier: 3 stopped places'), saved.stdout);
  assert.equal(savedLines.filter((line) => /^ {2}depth {2}api {2}SurveyD\.Probe/.test(line)).length, 3);

  const kiln = gitFixture(t, 'kiln-yard', KILN);
  const complete = run(kiln, ['surface', FIRINGS], KILN);
  assert.doesNotMatch(complete.stdout, /^start: |^status: /m);
  const completeSaved = run(kiln, ['surface', FIRINGS, '--out', 'out/surface.json'], KILN);
  assert.equal(completeSaved.stdout.trimEnd().split('\n').length, 1, completeSaved.stdout);
  assert.equal('status' in json(run(kiln, ['surface', FIRINGS, '--json'], KILN)), true, 'json states the status of a complete walk too');
});

test('Stopped walk AC-9: skeleton writes one parked block for each place the walk stopped', (t) => {
  const { dir, env } = willow(t);
  const args = (...more) => ['skeleton', LOAN, '--stub', '--config', WILLOW, ...more];
  const spec = runWithEnv(dir, args(), env);
  assert.equal(spec.status, 0, spec.stderr);
  const blocks = spec.stdout.split(/\n\n/).filter((block) => block.includes("test('walk stopped "));
  assert.equal(blocks.length, 3);
  assert.ok(blocks.some((block) => block.includes('external-boundary') && block.includes('NoticeSender')));
  assert.ok(blocks.some((block) => block.includes('unresolved-target') && block.includes('ILedgerClient')));
  for (const block of blocks) {
    assert.match(block, /test\.fixme\(true, /);
    assert.match(block, /\/\/ call site: src\/Services\/LoanService\.cs:\d+/);
    assert.doesNotMatch(block, /expect\(/);
  }
  const out = runWithEnv(dir, args('--out', 'out/loan.spec.ts'), env);
  assert.match(out.stdout, /, 3 stopped -> /);
  assert.equal(JSON.parse(runWithEnv(dir, args('--json'), env).stdout).plan.counts.stops, 3);
});

test('Stopped walk AC-10: join --against skips a route whose walk boundary moved', (t) => {
  const dir = quarry(t);
  assert.equal(run(dir, ['join', '--snapshot', 'out/snapshot.json']).status, 0);
  const chain = join(dir, 'backend', 'src', 'Services', 'SurveyChain.cs');
  writeFileSync(
    chain,
    readFileSync(chain, 'utf8').replace(
      /(public class SurveyC\b[\s\S]*?public Task Probe\(string serial\)\s*\{)[\s\S]*?(\n {8}\})/,
      '$1\n            return Task.CompletedTask;$2',
    ),
  );
  commitAll(dir, 'stop the chain at SurveyC');
  for (const verb of ['extract', 'join']) assert.equal(run(dir, [verb]).status, 0);

  const report = json(run(dir, ['join', '--against', 'out/snapshot.json', '--json']));
  const skipped = report.skipped.find((entry) => entry.route === PLAN);
  assert.ok(skipped, JSON.stringify(report.skipped));
  assert.match(JSON.stringify(skipped), /depth/);
  assert.ok(report.skipped.some((entry) => entry.route === CHECK && /seed/.test(JSON.stringify(entry))), 'the seed-cap skip stays');
  // A skipped route is still an item of the report, so its stopped walk keeps its mark.
  const marked = (report.walks || []).find((entry) => entry.route === PLAN);
  assert.ok(marked, JSON.stringify(report.walks));
  assert.ok([marked.snapshot, marked.current].some((side) => side && side.traversal === 'partial' && side.stops.depth > 0), JSON.stringify(marked));
  const text = run(dir, ['join', '--against', 'out/snapshot.json']);
  assert.match(text.stdout, new RegExp(`walk ${PLAN.replace(/[/*]/g, '\\$&')}: [^\\n]*walk partial \\([^)]*depth \\d+`));
  assert.doesNotMatch(text.stdout, /match the snapshot/, 'a route that was never compared backs no claim that it matches');
  assert.match(text.stdout, /not compared/);
  assert.equal(text.status, 0, 'without --fail-on, skipped is informational');
  assert.equal(run(dir, ['join', '--against', 'out/snapshot.json', '--fail-on', 'path']).status, 5);
  assert.notEqual(run(dir, ['join', '--against', 'out/snapshot.json', '--fail-on', 'path', '--allow-skipped']).status, 5);
});

test('Stopped walk AC-11: an empty --fail-on item is a usage error before any snapshot is read', (t) => {
  const dir = quarry(t);
  for (const value of [['--fail-on', ''], ['--fail-on='], ['--fail-on', ','], ['--fail-on', ' , '], ['--fail-on', 'path,']]) {
    const result = run(dir, ['join', '--against', 'out/missing-snapshot.json', ...value]);
    assert.equal(result.status, 2, `${value.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--fail-on: an empty finding selection gates nothing \(accepted: any, /);
    assert.doesNotMatch(result.stderr, /missing-snapshot/);
  }
  run(dir, ['join', '--snapshot', 'out/snapshot.json']);
  const parsed = run(dir, ['join', '--against', 'out/snapshot.json', '--fail-on', 'path,seed-added', '--allow-skipped']);
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('Stopped walk AC-12: a selected component entry owns its scope, its evidence and its identity', (t) => {
  for (const [corpus, configName, component, entries] of [
    ['greenhouse-alerts', 'greenhouse.config.json', 'ZoneOverviewPanel', ['acknowledgeAlarm', 'componentDidMount']],
    ['nursery-mobile', 'nursery.config.json', 'PlotDetailPage', ['onPin', 'onSync']],
  ]) {
    const dir = gitFixture(t, corpus, configName);
    const span = (...extra) => json(run(dir, ['span', '--from-component', component, '--json', ...extra], configName));
    const whole = span();
    assert.equal(whole.status.scope.entry, undefined, corpus);
    const selected = entries.map((entry) => span('--entry', entry));
    for (const model of selected) {
      assert.equal(model.status.scope.entry, model.selectedEntry.id, corpus);
      assert.notEqual(model.status.identity, whole.status.identity, corpus);
      assert.ok(model.status.evidence['source-supported'] <= whole.status.evidence['source-supported'], corpus);
    }
    assert.notEqual(selected[0].status.identity, selected[1].status.identity, corpus);
    assert.deepEqual(span('--entry', entries[0]).status.identity, selected[0].status.identity, `${corpus}: stable`);
    const page = run(dir, ['span', '--from-component', component, '--entry', entries[0], '--out', 'out/page.html'], configName);
    assert.equal(page.status === 0 || page.status === 4, true, page.stderr);
    assert.ok(readFileSync(join(dir, 'out', 'page.html'), 'utf8').includes(`entry ${selected[0].selectedEntry.id}`), corpus);
  }
});

test('Stopped walk AC-13: the identity binds every code index answer the walk read', (t) => {
  const dir = quarry(t);
  const repos = [
    { id: 'api', kind: 'backend', root: join(dir, 'backend'), role: ['api'] },
    { id: 'web', kind: 'web', root: join(dir, 'web') },
  ];
  // A new fact set array for each walk keeps the gate walk memo out of the comparison.
  const walk = (outbound) => trace(factSetsOf(dir, ['api', 'web']), QUIET, { repos, ...(outbound ? { outbound } : {}) }).status;
  const answer = (target) => () => [{ kind: 'uses-type', file: 'backend/src/Services/SurveyChain.cs', line: 1, target }];
  const none = walk(null);
  const first = walk(answer('backend/src/Services/SurveyChain.cs'));
  const again = walk(answer('backend/src/Services/SurveyChain.cs'));
  const other = walk(answer('backend/src/Services/DispatchLedger.cs'));
  assert.equal(first.identity, again.identity, 'the same answers give one identity');
  assert.notEqual(first.identity, other.identity, 'different answers give different identities');
  assert.notEqual(first.identity, none.identity);
  assert.equal(walk(null).identity, none.identity, 'a walk with no lookup keeps its identity');
  const unconfigured = walk(createScout({ repos }).outbound);
  assert.notEqual(unconfigured.identity, none.identity, 'the reason the index did not answer is a lookup result');
  assert.equal(walk(createScout({ repos }).outbound).identity, unconfigured.identity);
});

test('Stopped walk AC-13: the same edges in another order are another answer when the fan-out limit cuts them', (t) => {
  const dir = quarry(t);
  const repos = [
    { id: 'api', kind: 'backend', root: join(dir, 'backend'), role: ['api'] },
    { id: 'web', kind: 'web', root: join(dir, 'web') },
  ];
  const edges = Array.from({ length: 9 }, (_, n) => ({
    kind: 'uses-type',
    file: 'backend/src/Services/SurveyChain.cs',
    line: 1,
    target: `backend/src/Data/Repository${n}.cs`,
  }));
  const walk = (list) => trace(factSetsOf(dir, ['api', 'web']), QUIET, { repos, outbound: () => list.map((edge) => ({ ...edge })) });
  const reached = (result) => result.nodes.filter((node) => /^Repository\d$/.test(node.ref)).map((node) => node.ref).sort();
  const forward = walk(edges);
  const backward = walk([...edges].reverse());
  assert.notDeepEqual(reached(forward), reached(backward), 'the limit keeps other classes');
  assert.notEqual(forward.status.identity, backward.status.identity);
  assert.equal(walk(edges).status.identity, forward.status.identity);
});

test('Stopped walk AC-13: a lookup made inside a gate walk changes the route identity', (t) => {
  const dir = gitFixture(t, 'bakery-gates', 'bakery.config.json');
  const repos = [{ id: 'api', kind: 'backend', root: join(dir, 'backend'), role: ['api'] }];
  const key = 'POST eclairs/v1/bake';
  // Only the global filter's own gate walk asks the index about its class.
  const answering = (filterAnswer) => (_root, name) => {
    if (name !== 'KitchenAccessFilter') return [];
    const answer = [];
    if (filterAnswer === 'no-match') Object.defineProperty(answer, 'noMatch', { value: true });
    return answer;
  };
  const identity = (outbound, sets = factSetsOf(dir, ['api'])) =>
    trace(sets, key, { repos, outbound, graph: true, seeds: true }).status.identity;
  const empty = identity(answering('empty'));
  const shared = factSetsOf(dir, ['api']);
  const miss = identity(answering('no-match'), shared);
  assert.notEqual(miss, empty, 'on a memo miss');
  assert.equal(identity(answering('no-match'), shared), miss, 'on a memo hit');
});

test('Stopped walk AC-14: a route summary marks its own stopped walk, and the outer walk keeps its stops', (t) => {
  const dir = gitFixture(t, 'nursery-mobile', 'nursery.config.json');
  const config = 'nursery.config.json';
  const tree = run(dir, ['trace', 'PlotDetailPage'], config);
  assert.match(tree.stdout, /POST nursery\/v1\/plots\/\*\/health .* · walk unknown \(provider-unavailable 1\)$/m);
  const model = json(run(dir, ['trace', 'PlotDetailPage', '--json'], config));
  assert.equal(model.status.stops['provider-unavailable'], undefined, 'no reason only a summary walk had');
  const summaries = model.nodes.filter((node) => node.summaryWalk);
  assert.ok(summaries.length > 0);
  for (const node of summaries) assert.equal(node.summaryWalk.traversal, 'unknown');
  const regatta = gitFixture(t, 'regatta-desk', 'regatta.config.json');
  run(regatta, ['trace', 'RegattaHeader', '--html', 'out/tree.html'], 'regatta.config.json');
  assert.match(readFileSync(join(regatta, 'out', 'tree.html'), 'utf8'), /walk unknown \(provider-unavailable 1\)/);
  const flow = run(dir, ['trace', 'PlotDetailPage', '--view', 'source-flow', '--json'], config);
  assert.doesNotMatch(flow.stdout, /summaryWalk/);
  assert.doesNotMatch(run(dir, ['trace', 'PlotDetailPage', '--view', 'source-flow'], config).stdout, MARK);
});

test('Stopped walk AC-15: the scout wrapper reads exit 3 as an answer', () => {
  const scoutWith = (result) =>
    createScout({ bin: '/bin/scout', fileExists: () => true, repos: [{ root: '/repo', scout: true }], run: () => result });
  const zero = scoutWith({ status: 3, stdout: "no symbol matches 'NoticeSender'\n" }).outbound('/repo', 'NoticeSender');
  assert.equal(zero.noMatch, true);
  assert.equal(zero.unavailable, undefined);
  const edges = scoutWith({
    status: 3,
    stdout: 'outbound:\n  uses-type (1):\n    src/A.cs:3  uses-type  -> src/B.cs\n',
  }).outbound('/repo', 'A');
  assert.deepEqual([...edges], [{ kind: 'uses-type', file: 'src/A.cs', line: 3, target: 'src/B.cs' }]);
  const failed = scoutWith({ status: 1, stdout: '' }).outbound('/repo', 'A');
  assert.equal(failed.unavailable, true);
  assert.equal(failed.reason, 'indexer exited with an error');
});

test('Stopped walk AC-15: a killed or blank index reply is no answer, never a zero-hit', () => {
  const scoutWith = (result) =>
    createScout({ bin: '/bin/scout', fileExists: () => true, repos: [{ root: '/repo', scout: true }], run: () => result });
  for (const [label, result] of [
    ['killed', { status: null, signal: 'SIGTERM', stdout: '' }],
    ['killed after a zero-hit line', { status: null, signal: 'SIGKILL', stdout: "no symbol matches 'A'\n" }],
    ['blank exit 0', { status: 0, stdout: '' }],
    ['blank exit 3', { status: 3, stdout: '\n' }],
    ['blank with no status', { stdout: '' }],
  ]) {
    const reply = scoutWith(result).outbound('/repo', 'A');
    assert.equal(reply.noMatch, undefined, label);
    assert.equal(reply.unavailable, true, label);
  }
  for (const status of [0, 3]) {
    const zero = scoutWith({ status, stdout: "no symbol matches 'A'\n" }).outbound('/repo', 'A');
    assert.equal(zero.noMatch, true, `zero-hit exit ${status}`);
    assert.equal(zero.unavailable, undefined, `zero-hit exit ${status}`);
  }
});

test('Stopped walk AC-15: a zero-hit for a class no repository declares is an external boundary', (t) => {
  const { dir, env } = willow(t);
  const traced = (key, ...flags) => runWithEnv(dir, ['trace', key, '--seeds', '--config', WILLOW, ...flags], env);
  const settle = JSON.parse(traced(SETTLE, '--json').stdout);
  assert.equal(settle.status.traversal, 'complete');
  assert.deepEqual(settle.status.stops, { 'external-boundary': 1 });
  const entry = settle.status.frontier[0];
  assert.equal(entry.target, 'NoticeSender');
  assert.equal(entry.detail, 'not-declared');
  const gated = traced(SETTLE, '--require-complete');
  assert.equal(gated.status, 0, gated.stderr);
  assert.doesNotMatch(gated.stderr, NOTICE);

  const loan = JSON.parse(traced(LOAN, '--json').stdout);
  assert.equal(loan.status.traversal, 'unknown');
  assert.equal(loan.status.stops['external-boundary'], 2);
  assert.equal(loan.status.stops['unresolved-target'], 1);
  assert.equal(loan.status.stops['provider-unavailable'], undefined);

  writeFileSync(join(dir, 'out', 'willow.area.txt'), `${SETTLE}\n`);
  const baseline = runWithEnv(
    dir,
    ['check', '--area', 'out/willow.area.txt', '--baseline', 'out/b.json', '--write-baseline', '--config', WILLOW],
    env,
  );
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.doesNotMatch(baseline.stderr, NOTICE);
  const route = JSON.parse(readFileSync(join(dir, 'out', 'b.json'), 'utf8')).routes[0];
  assert.equal(route.traversal, 'complete');
  assert.deepEqual(route.boundary, []);

  appendFileSync(join(dir, 'backend', 'src', 'Services', 'SettlementBook.cs'), '\n// changed\n');
  const affected = runWithEnv(dir, ['affected', '--area', 'out/willow.area.txt', '--json', '--config', WILLOW], env);
  assert.doesNotMatch(affected.stderr, /provider-unavailable/);
  assert.equal(JSON.parse(affected.stdout).incompleteWalk, undefined);
});

test('Stopped walk AC-15: the walk asks the index for outbound references and reads them as the index prints them', (t) => {
  const dir = gitFixture(t, 'willow-lending', WILLOW);
  const scout = contractScout(t, {
    SettlementBook: {
      def: 'src/Services/SettlementBook.cs:3',
      outbound: {
        inherits: [],
        'uses-type': ['src/Services/SettlementBook.cs:5  uses-type  -> src/Services/SettlementLedger.cs  private readonly SettlementLedger _ledger;'],
      },
    },
  });
  const settle = JSON.parse(runWithEnv(dir, ['trace', SETTLE, '--seeds', '--json', '--config', WILLOW], scout.env).stdout);
  for (const args of scout.calls()) assert.ok(args.includes('--out'), JSON.stringify(args));
  const ledger = settle.nodes.filter((node) => node.ref === 'SettlementLedger');
  assert.equal(ledger.length, 1, JSON.stringify(settle.nodes.map((node) => node.ref)));
  assert.equal(ledger[0].file, 'src/Services/SettlementLedger.cs');
  assert.equal(settle.status.traversal, 'complete');
  assert.equal(settle.status.stops['provider-unavailable'], undefined);
});

test('Stopped walk AC-15: a reply that is not an answer leaves the walk unknown, in trace, its gate and affected', (t) => {
  for (const [label, reply] of [
    ['exit 0 with a message', { raw: 'index unavailable\n', status: 0 }],
    ['exit 3 with an error', { raw: 'error:\nindex unavailable\n', status: 3 }],
    ['inbound only', { raw: 'Willow.Lending.Services.SettlementBook  (class)  0 inbound (showing 0)\ndef: src/Services/SettlementBook.cs:3\ninbound:\n  uses-type (0):\n', status: 0 }],
    ['a row that does not read', { raw: 'outbound:\n  uses-type (1):\n    src/Services/SettlementBook.cs:5 uses-type SettlementLedger\n', status: 0 }],
  ]) {
    const dir = gitFixture(t, 'willow-lending', WILLOW);
    const { env } = contractScout(t, { SettlementBook: reply });
    const settle = JSON.parse(runWithEnv(dir, ['trace', SETTLE, '--seeds', '--json', '--config', WILLOW], env).stdout);
    assert.equal(settle.status.traversal, 'unknown', label);
    assert.equal(settle.status.stops['provider-unavailable'], 1, `${label}: ${JSON.stringify(settle.status.stops)}`);
    const gated = runWithEnv(dir, ['trace', SETTLE, '--seeds', '--require-complete', '--config', WILLOW], env);
    assert.equal(gated.status, 4, label);

    writeFileSync(join(dir, 'out', 'willow.area.txt'), `${SETTLE}\n`);
    appendFileSync(join(dir, 'backend', 'src', 'Startup.cs'), '\n// changed\n');
    const affected = runWithEnv(dir, ['affected', '--area', 'out/willow.area.txt', '--json', '--config', WILLOW], env);
    assert.equal(affected.status, 4, `${label}: ${affected.stderr}`);
    const report = JSON.parse(affected.stdout);
    assert.equal(report.incompleteWalk?.rung, 'incomplete-walk', `${label}: ${affected.stdout}`);
    assert.deepEqual(report.incompleteWalk.routes, [SETTLE], label);
  }
  const dir = gitFixture(t, 'willow-lending', WILLOW);
  const { env } = contractScout(t, { SettlementBook: { def: 'src/Services/SettlementBook.cs:3', outbound: { inherits: [], 'uses-type': [] } } });
  const empty = JSON.parse(runWithEnv(dir, ['trace', SETTLE, '--seeds', '--json', '--config', WILLOW], env).stdout);
  assert.equal(empty.status.traversal, 'complete', 'an outbound section with no rows is an empty answer');
});

test('Stopped walk AC-15: a class some fact declares is unresolved-target when the index finds no match', (t) => {
  const dir = gitFixture(t, 'willow-lending', WILLOW);
  const repos = [{ id: 'backend', kind: 'backend', root: join(dir, 'backend'), role: ['api'] }];
  const noMatch = () => {
    const none = [];
    Object.defineProperty(none, 'noMatch', { value: true });
    return none;
  };
  const stopsFor = (extra) => {
    const sets = factSetsOf(dir, ['backend']);
    sets[0].facts.push(...extra.map((fact) => ({ repo: 'backend', file: 'src/Services/LoanService.cs', line: 1, ...fact })));
    const result = trace(sets, SETTLE, { repos, outbound: noMatch });
    return Object.fromEntries(result.status.frontier.map((item) => [item.target.split('.')[0], `${item.reason} ${item.detail}`]));
  };
  const plain = stopsFor([]);
  assert.equal(plain.NoticeSender, 'external-boundary not-declared');
  assert.equal(plain.SettlementBook, 'unresolved-target index-no-match', JSON.stringify(plain));
  assert.equal(stopsFor([{ type: 'class_base', class: 'NoticeSender', base: 'SenderBase' }]).NoticeSender, 'unresolved-target index-no-match');
  assert.equal(stopsFor([{ type: 'iface_impl', class: 'NoticeSender', iface: 'INoticeSender' }]).NoticeSender, 'unresolved-target index-no-match');
  assert.equal(stopsFor([{ type: 'class_base', class: 'LocalSender', base: 'NoticeSender' }]).NoticeSender, 'external-boundary not-declared');
  assert.equal(stopsFor([{ type: 'iface_impl', class: 'LocalSender', iface: 'NoticeSender' }]).NoticeSender, 'external-boundary not-declared');

  const stats = trace(factSetsOf(dir, ['backend']), SETTLE, { repos, outbound: noMatch }).stats;
  assert.equal(stats.graphUnavailable, 0, 'a zero-hit is an answer, not an unavailable index');
});
