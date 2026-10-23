/**
 * The result status one walk states: how complete its traversal is, whether its facts
 * still match the code, how strong its evidence is, and every place it stopped.
 *
 * Most cases run the CLI as a subprocess over the invented `quarry-dispatch` corpus. The
 * code-index case calls `trace` in process with an `outbound` stub, as
 * `graph-hop.test.js` does, because the public corpus ships no code index.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyFixture, runCli, writeJsonFile } from './helpers.js';
import { trace } from '../lib/trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'corpus', 'quarry-dispatch');
const CONFIG = 'quarry.config.json';
const REPOS = [
  { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
  { id: 'web', kind: 'web', root: 'web' },
];
const PLAN = 'POST dispatch/v1/plans';
const ROUTE = 'POST dispatch/v1/route';
const CHECK = 'POST dispatch/v1/check';
const SURVEY = 'POST dispatch/v1/survey';
const QUIET = 'GET dispatch/v1/quiet';
const AREA = 'quarry.area.txt';

function corpus(t) {
  const dir = copyFixture(t, 'quarry-dispatch');
  const result = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return dir;
}

/** The same corpus as a git checkout, so its facts carry a revision witness. */
function gitCorpus(t) {
  const dir = corpus(t);
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const again = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(again.status, 0, again.stderr);
  return dir;
}

function traceJson(dir, start, ...flags) {
  const result = runCli(['trace', start, '--config', CONFIG, '--json', ...flags], { cwd: dir });
  assert.ok(result.stdout, result.stderr);
  return { ...result, body: JSON.parse(result.stdout) };
}

function writeArea(dir) {
  writeFileSync(join(dir, AREA), `${PLAN}\n${ROUTE}\n${CHECK}\n${SURVEY}\n${QUIET}\n`);
}

function corpusFacts(t) {
  const dir = corpus(t);
  const sets = ['api', 'web'].map((repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')));
  return { dir, sets };
}

test('Partial result AC-1: one status separates traversal, freshness and evidence', (t) => {
  const dir = gitCorpus(t);
  const complete = traceJson(dir, ROUTE);
  const status = complete.body.status;
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.traversal, 'complete');
  assert.equal(status.freshness, 'matching');
  assert.ok(status.evidence.inferred > 0, 'a chosen DI binding is inferred, however complete the walk');
  assert.equal(status.evidence.runtime, 'not supplied');
  assert.equal(complete.body.stats.budgetHit, false);

  const stopped = traceJson(dir, PLAN, '--max-nodes', '20');
  assert.equal(stopped.body.status.traversal, 'partial');
  assert.equal(stopped.body.status.freshness, 'matching', 'fresh facts do not make a stopped walk complete');
});

test('Partial result AC-2: each stop is a frontier entry naming where and why', (t) => {
  const dir = corpus(t);
  const reasons = new Map();
  const collect = (start, ...flags) => {
    const { body } = traceJson(dir, start, ...flags);
    for (const entry of body.status.frontier) {
      if (!reasons.has(entry.reason)) reasons.set(entry.reason, entry);
    }
    return body;
  };

  const deep = collect(PLAN, '--depth', '2');
  assert.equal(deep.stats.budgetHit, false, 'a depth stop sets no budget flag');
  assert.ok(reasons.has('depth'));

  collect(PLAN, '--max-nodes', '20');
  assert.equal(reasons.get('node-budget').raisedBy, '--max-nodes');

  collect(CHECK, '--seeds');
  const seedCap = reasons.get('seed-cap');
  assert.equal(seedCap.raisedBy, null, 'no flag raises the seed cap');
  assert.ok(seedCap.remaining > 0);

  collect(SURVEY);
  const fanOut = reasons.get('fan-out-cap');
  assert.equal(fanOut.detail, 'interface');
  assert.equal(fanOut.remaining, 1);

  collect('DispatchBoard');
  assert.ok(reasons.has('unresolved-target'));
  assert.ok(reasons.has('unresolved-pipeline'), 'a composition the facts cannot read is stated');

  const quiet = collect(QUIET);
  const unavailable = quiet.status.frontier.find((entry) => entry.reason === 'provider-unavailable');
  assert.equal(unavailable.target, 'DispatchController.Quiet');

  for (const [reason, entry] of reasons) {
    assert.ok(Number.isInteger(entry.remaining) || entry.remaining === null, `${reason}: remaining is a count or null`);
    assert.ok(entry.repo, `${reason}: names its repository`);
  }
  assert.equal(reasons.get('unresolved-pipeline').remaining, null, 'uncounted work is null, never 0');

  const inventory = traceJson(dir, 'DispatchBoard').body;
  assert.notEqual(inventory.status.traversal, 'complete', 'a stopped component walk is never an empty complete inventory');
});

test('Partial result AC-2: an unknown edge kind is a discovery stop', (t) => {
  const { sets } = corpusFacts(t);
  const result = trace(sets, QUIET, {
    repos: REPOS,
    outbound: () => [{ kind: 'annotates', target: 'backend/src/Services/SurveyChain.cs', file: 'backend/src/Services/SurveyChain.cs', line: 1 }],
  });
  const entry = result.status.frontier.find((candidate) => candidate.reason === 'unknown-edge-kind');
  assert.ok(entry, JSON.stringify(result.status.stops));
  assert.equal(entry.target, 'annotates');
  assert.equal(result.status.traversal, 'unknown');
});

test('Partial result AC-3: the header names scope, limits and stops before the tree', (t) => {
  const dir = corpus(t);
  const terminal = runCli(['trace', PLAN, '--config', CONFIG, '--max-nodes', '20'], { cwd: dir });
  assert.equal(terminal.status, 0, terminal.stderr);
  const lines = terminal.stdout.split('\n');
  assert.match(lines[0], /^start: POST dispatch\/v1\/plans \(route, api src\/Controllers\/DispatchController\.cs:\d+\)$/);
  assert.equal(lines[1], 'scope: full');
  assert.match(lines[2], /^limits: depth 6, node budget 20, seed cap 64, interface fan-out 16, graph fan-out 8$/);
  assert.match(lines[3], /^status: traversal partial, freshness (unknown|matching|mismatched)$/);
  assert.match(lines[4], /^evidence: \d+ source-supported, \d+ inferred, runtime not supplied$/);
  assert.match(lines[5], /^stops: .*; frontier \d+$/);
  assert.ok(lines.some((line) => /^\S.*\[start\]$/.test(line)), 'the tree follows the header');

  const html = join(dir, 'trace.html');
  const page = runCli(['trace', PLAN, '--config', CONFIG, '--max-nodes', '20', '--html', html], { cwd: dir });
  assert.equal(page.status, 0, page.stderr);
  assert.match(readFileSync(html, 'utf8'), /start: POST dispatch\/v1\/plans/);

  const spanPage = join(dir, 'span.html');
  const span = runCli(['span', PLAN, '--config', CONFIG, '--max-nodes', '20', '--out', spanPage], { cwd: dir });
  assert.equal(span.status, 0, span.stderr);
  assert.match(readFileSync(spanPage, 'utf8'), /Result status/);

  const componentPage = join(dir, 'component.html');
  const component = runCli(
    ['span', '--from-component', 'DispatchBoard', '--config', CONFIG, '--out', componentPage],
    { cwd: dir },
  );
  assert.equal(component.status, 0, component.stderr);
  assert.match(readFileSync(componentPage, 'utf8'), /Result status/);
});

test('Partial result AC-4: the level schedule enters a later sibling call, and changes nothing below the limit', (t) => {
  const dir = corpus(t);
  const small = traceJson(dir, PLAN, '--max-nodes', '20').body;
  assert.equal(small.status.schedule.order, 'level');
  assert.ok(small.nodes.some((node) => node.ref === 'DispatchLedger.Record'), 'the later sibling call is entered');
  assert.ok(
    small.nodes.some((node) => node.kind === 'db' && node.sink === true),
    'the entered call reaches its write',
  );

  const again = runCli(['trace', PLAN, '--config', CONFIG, '--json', '--max-nodes', '20'], { cwd: dir });
  const first = traceJson(dir, PLAN, '--max-nodes', '20');
  assert.equal(again.stdout, first.stdout, 'two runs over the same facts and limits give the same bytes');

  const large = traceJson(dir, PLAN, '--max-nodes', '100000', '--seeds').body;
  assert.equal(large.status.schedule.order, 'depth-first');
  const smallSeeds = traceJson(dir, PLAN, '--max-nodes', '100000', '--seeds').body;
  assert.equal(large.stats.sinks, smallSeeds.stats.sinks);
  assert.deepEqual(large.seeds.map((seed) => seed.key), smallSeeds.seeds.map((seed) => seed.key));
});

test('Partial result AC-4: the pack run names the place the budget stopped it', (t) => {
  const dir = copyExample(t, join(HERE, 'corpus', 'greenhouse-alerts'), 'greenhouse.config.json');
  const run = runCli(
    ['trace', 'HarvestPlanController.CommitPlan', '--config', 'greenhouse.config.json', '--json', '--max-nodes', '24'],
    { cwd: dir },
  );
  assert.equal(run.status, 0, run.stderr);
  const body = JSON.parse(run.stdout);
  assert.equal(body.status.schedule.order, 'level');
  const stopped = body.status.frontier.find(
    (entry) => entry.reason === 'node-budget' && entry.target === 'HarvestPlanWriter.SavePlan',
  );
  assert.ok(stopped, JSON.stringify(body.status.frontier));
  assert.deepEqual(stopped.callSite, { file: 'src/Services/HarvestPlanner.cs', line: 71 });
});

test('Partial result AC-4: no limit means no change', (t) => {
  const dir = corpus(t);
  const walk = traceJson(dir, ROUTE, '--seeds').body;
  assert.equal(walk.status.schedule.order, 'depth-first');
  assert.equal(walk.stats.budgetHit, false);
  for (const field of ['root', 'nodes', 'edges', 'sinks', 'branches', 'seeds', 'seedsTruncated', 'stats']) {
    assert.ok(field in walk, field);
  }
  assert.equal(walk.stats.nodes, walk.nodes.length);
  assert.equal(walk.stats.edges, walk.edges.length);
});

test('Partial result AC-5: a stopped walk never says reads only', (t) => {
  const dir = corpus(t);
  writeArea(dir);
  const out = join(dir, 'cases');
  const result = runCli(
    ['cases', '--config', CONFIG, '--area', AREA, '--out', out, '--max-nodes', '20'],
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  const sheet = readFileSync(join(out, 'post-dispatch-v1-survey.md'), 'utf8');
  assert.match(sheet, /observed reads; other effects unknown/);
  assert.doesNotMatch(sheet, /reads only|no observable write|no writes/);

  const cover = runCli(
    ['cover', '--config', CONFIG, '--area', AREA, '--json', '--max-nodes', '20'],
    { cwd: dir },
  );
  assert.equal(cover.status, 0, cover.stderr);
  const report = JSON.parse(cover.stdout);
  const stopped = report.routes.find((route) => route.key === SURVEY);
  assert.equal(stopped.walk.traversal, 'partial');
  assert.ok(stopped.walk.stops['node-budget'] > 0);

  const check = runCli(
    ['check', '--config', CONFIG, '--area', AREA, '--write-baseline', '--max-nodes', '20'],
    { cwd: dir },
  );
  assert.equal(check.status, 0, check.stderr);
});

test('Partial result AC-6: --require-complete writes output, names reasons and exits 4', (t) => {
  const dir = gitCorpus(t);
  const complete = runCli(['trace', ROUTE, '--config', CONFIG, '--require-complete'], { cwd: dir });
  assert.equal(complete.status, 0, complete.stderr);

  const failed = runCli(['trace', PLAN, '--config', CONFIG, '--require-complete', '--max-nodes', '20'], { cwd: dir });
  assert.equal(failed.status, 4);
  assert.match(failed.stdout, /\[start\]/, 'the normal output is written first');
  assert.match(failed.stderr, /^flowtrace: not complete: node-budget \d+ \(raise --max-nodes\)$/m);

  const usageValue = runCli(['trace', ROUTE, '--config', CONFIG, '--require-complete=yes'], { cwd: dir });
  assert.equal(usageValue.status, 2);
  assert.equal(usageValue.stdout, '', 'a value on the flag writes no output');

  const unknownStart = runCli(['trace', 'POST dispatch/v1/nowhere', '--config', CONFIG, '--require-complete'], { cwd: dir });
  assert.equal(unknownStart.status, 2, 'a start failure keeps exit 2');

  writeArea(dir);
  writeFileSync(join(dir, 'mixed.txt'), `${ROUTE}\n${PLAN}\n`);
  const area = runCli(['trace', '--area', 'mixed.txt', '--config', CONFIG, '--require-complete', '--max-nodes', '20'], { cwd: dir });
  assert.equal(area.status, 4);
  const records = JSON.parse(area.stdout);
  assert.equal(records.length, 2, 'every key keeps its record');
  assert.ok(records.every((record) => record.key && record.status));

  assert.match(readFileSync(join(HERE, '..', 'docs', 'cli.md'), 'utf8'), /--require-complete/);
});

test('Partial result AC-6: span and span --from-component take the flag', (t) => {
  const dir = gitCorpus(t);
  const spanOut = join(dir, 'span.html');
  const stopped = runCli(
    ['span', PLAN, '--config', CONFIG, '--require-complete', '--max-nodes', '20', '--out', spanOut],
    { cwd: dir },
  );
  assert.equal(stopped.status, 4);
  assert.ok(readFileSync(spanOut, 'utf8').includes('Result status'));

  const componentOut = join(dir, 'component.html');
  const component = runCli(
    ['span', '--from-component', 'DispatchBoard', '--config', CONFIG, '--require-complete', '--out', componentOut],
    { cwd: dir },
  );
  assert.equal(component.status, 4, 'an unresolved component walk fails the run');
  assert.match(component.stderr, /not complete: unresolved-target/);
});

test('Partial result AC-7: identity covers the inputs, not the printers', (t) => {
  const dir = corpus(t);
  const first = traceJson(dir, ROUTE).body.status.identity;
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(traceJson(dir, ROUTE).body.status.identity, first);
  assert.notEqual(traceJson(dir, ROUTE, '--depth', '3').body.status.identity, first);
  assert.notEqual(traceJson(dir, ROUTE, '--max-nodes', '40').body.status.identity, first);
  assert.equal(traceJson(dir, ROUTE, '--no-fold').body.status.identity, first);
  assert.equal(traceJson(dir, ROUTE, '--expand-infra').body.status.identity, first);

  const mermaid = runCli(['trace', ROUTE, '--config', CONFIG, '--mermaid'], { cwd: dir });
  assert.match(mermaid.stdout, new RegExp(`%% status: traversal complete, freshness`));
  assert.equal(mermaid.status, 0, mermaid.stderr);

  const depthEntry = traceJson(dir, PLAN, '--depth', '2').body.status.frontier.find((entry) => entry.reason === 'depth');
  assert.equal(depthEntry.raisedBy, '--depth');
});

test('Partial result AC-8: every output reads the one status', (t) => {
  const dir = corpus(t);
  const partial = traceJson(dir, PLAN, '--max-nodes', '20').body.status;
  const complete = traceJson(dir, ROUTE).body.status;

  const mermaid = runCli(['trace', PLAN, '--config', CONFIG, '--max-nodes', '20', '--mermaid'], { cwd: dir });
  assert.match(mermaid.stdout, new RegExp(`%% status: traversal ${partial.traversal}`));
  assert.match(mermaid.stdout, new RegExp(`%% stops: .*frontier ${partial.frontier.length}`));

  const graph = runCli(['trace', PLAN, '--config', CONFIG, '--max-nodes', '20', '--graph'], { cwd: dir });
  const graphJson = runCli(['trace', PLAN, '--config', CONFIG, '--max-nodes', '20', '--graph', '--json'], { cwd: dir });
  const graphBody = JSON.parse(graph.stdout);
  const graphJsonBody = JSON.parse(graphJson.stdout);
  assert.deepEqual(graphBody.status, graphJsonBody.status, 'the graph printer and --graph --json read one walk');
  assert.equal(graphBody.status.traversal, partial.traversal);

  const html = join(dir, 'partial.html');
  runCli(['trace', PLAN, '--config', CONFIG, '--max-nodes', '20', '--html', html], { cwd: dir });
  const page = readFileSync(html, 'utf8');
  assert.match(page, new RegExp(`traversal ${partial.traversal}`));

  const component = runCli(
    ['span', '--from-component', 'DispatchBoard', '--config', CONFIG, '--json'],
    { cwd: dir },
  );
  const componentBody = JSON.parse(component.stdout);
  assert.equal(componentBody.status.traversal, traceJson(dir, 'DispatchBoard').body.status.traversal);
  assert.equal(complete.traversal, 'complete');
});

test('Partial result AC-9: the fixture set pins each source of uncertainty', (t) => {
  const dir = corpus(t);
  const codes = traceJson(dir, QUIET).body;
  assert.ok(codes.status.frontier.some((entry) => entry.reason === 'provider-unavailable'));
  assert.equal(codes.edges.length, 1, 'an unavailable index adds no edge for the hop it could not make');

  const survey = traceJson(dir, SURVEY).body;
  assert.ok(survey.status.frontier.some((entry) => entry.reason === 'fan-out-cap'));

  const check = traceJson(dir, CHECK, '--seeds').body;
  assert.ok(check.seedsTruncated > 0);

  const noWitness = traceJson(dir, ROUTE).body.status;
  assert.equal(noWitness.freshness, 'unknown', 'facts with no revision witness are unknown, never matching');

  const component = runCli(['span', '--from-component', 'DispatchBoard', '--config', CONFIG, '--json'], { cwd: dir });
  const model = JSON.parse(component.stdout);
  assert.ok(model.unresolved.some((arm) => arm.reason === 'template-not-resolved'), 'a resolved:false gateway stays unresolved');

  const large = traceJson(dir, CHECK, '--max-nodes', '100000').body;
  assert.equal(large.stats.budgetHit, false);
  assert.ok(large.status.frontier.some((entry) => entry.reason === 'provider-unavailable'));
  assert.equal(large.status.traversal, 'unknown', 'a cleared budget never promotes a walk with an unresolved target');
});

test('Partial result AC-9: facts behind the repository head are mismatched', (t) => {
  const dir = gitCorpus(t);
  writeFileSync(join(dir, 'backend', 'src', 'Models', 'DispatchRequests.cs'), '\n// changed after extraction\n');
  const status = traceJson(dir, ROUTE).body.status;
  assert.equal(status.freshness, 'mismatched');
  const run = runCli(['trace', ROUTE, '--config', CONFIG, '--require-complete'], { cwd: dir });
  assert.equal(run.status, 4, 'mismatched facts fail the strict run');
  assert.match(run.stderr, /not complete: freshness mismatched/);
});

/** A copy of a corpus outside `selftest/corpus`, extracted in place. */
function copyExample(t, source, config) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-partial-'));
  spawnSync('cp', ['-R', source, dir], { encoding: 'utf8' });
  const nested = join(dir, source.split('/').pop());
  const result = runCli(['extract', '--config', config], { cwd: nested });
  assert.equal(result.status, 0, result.stderr);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return nested;
}

function noticeOf(result, label) {
  const lines = result.stderr.split('\n').filter((line) => line.includes('walks did not complete'));
  assert.equal(lines.length, 1, `${label}: one notice, got: ${result.stderr}`);
  assert.match(
    lines[0],
    new RegExp(
      `^flowtrace: ${label}: \\d+ of \\d+ walks did not complete \\(.*\\); its answer can miss what they did not reach$`,
    ),
  );
}

test('Partial result AC-10: the eight reading commands print one notice and change nothing else', (t) => {
  const dir = corpus(t);
  writeArea(dir);
  for (const [label, args] of [
    ['check', ['check', '--area', AREA, '--write-baseline']],
    ['scope', ['scope', '--area', AREA, '--json']],
    ['surface', ['surface', PLAN]],
    ['skeleton', ['skeleton', PLAN]],
  ]) {
    noticeOf(runCli([...args, '--config', CONFIG, '--max-nodes', '20'], { cwd: dir }), label);
  }

  const check = runCli(['check', '--config', CONFIG, '--area', AREA, '--json', '--max-nodes', '20'], { cwd: dir });
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.ok(Array.isArray(report.regressions), 'the JSON stays the report it was');

  // `packets` writes only for a route with a candidate test.
  const demo = copyExample(t, join(HERE, '..', 'examples', 'demo-shop'), 'flowtrace.config.json');
  writeFileSync(join(demo, 'demo.area.txt'), 'POST orders/v1/cart/items\nPOST orders/v1/checkout\n');
  noticeOf(
    runCli(
      [
        'cover',
        '--config',
        'flowtrace.config.json',
        '--area',
        'demo.area.txt',
        '--packets',
        'pk',
        '--json',
        '--max-nodes',
        '3',
      ],
      { cwd: demo },
    ),
    'packets',
  );

  // `readiness` joins mobile components only, and nursery-mobile carries them.
  const nursery = copyExample(t, join(HERE, 'corpus', 'nursery-mobile'), 'nursery.config.json');
  writeFileSync(join(nursery, 'nursery.areas.txt'), 'plot,src/**\n');
  noticeOf(
    runCli(
      ['readiness', '--config', 'nursery.config.json', '--areas', 'nursery.areas.txt', '--max-nodes', '3'],
      { cwd: nursery },
    ),
    'readiness',
  );

  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const extracted = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  // A diff with no path in it walks nothing, so the notice has no run to report.
  appendFileSync(join(dir, 'backend', 'src', 'Services', 'SurveyChain.cs'), '\n// changed\n');
  noticeOf(
    runCli(['affected', '--config', CONFIG, '--area', AREA, '--diff', 'HEAD', '--max-nodes', '20'], { cwd: dir }),
    'affected',
  );

  const snapshot = join(dir, 'snapshot.json');
  runCli(['join', '--config', CONFIG, '--snapshot', snapshot], { cwd: dir });
  noticeOf(
    runCli(['join', '--config', CONFIG, '--against', snapshot, '--max-nodes', '20'], { cwd: dir }),
    'join --against',
  );

});

test('Partial result AC-11: docs carry the contract', () => {
  const text = readFileSync(join(HERE, '..', 'docs', 'cli.md'), 'utf8');
  for (const phrase of [
    'schemaVersion',
    'traversal',
    'freshness',
    'node-budget',
    'seed-cap',
    '--require-complete',
    'exits 4',
    'stderr notice',
  ]) {
    assert.ok(text.includes(phrase), `docs/cli.md names ${phrase}`);
  }
});
