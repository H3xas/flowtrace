/**
 * How the C# backend extractor reads attributes, route arguments, calls, decisions and
 * response statuses, over the invented `ferry-tickets` corpus (two backend repositories and
 * one web client). Each test runs the CLI the way a user does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mergeBranchFacts } from '../lib/trace.js';
import { captureBranchPoints, pinnedFacts, readBaseline } from './branch-point-baseline.js';
import { copyFixture, runCli } from './helpers.js';

test('CSharp reading AC-10: the facts of the existing decision kinds stay as the baseline pins them', () => {
  const baseline = readBaseline();
  assert.ok(baseline.corpora.length > 0);
  for (const entry of baseline.corpora) {
    const now = captureBranchPoints(entry);
    assert.deepEqual(Object.keys(now).sort(), Object.keys(entry.repos).sort(), `${entry.corpus} ${entry.config}: repositories`);
    for (const [repo, pinned] of Object.entries(entry.repos)) {
      assert.deepEqual(pinnedFacts(now[repo]), pinned.facts, `${entry.corpus} ${entry.config} ${repo}`);
    }
  }
});

test('CSharp reading AC-10: an expression decision between an if and its error return keeps them one branch', () => {
  const at = (line, kind, text) => ({ repo: 'api', fact: { type: 'branch_point', file: 'a.cs', class: 'A', method: 'M', line, kind, text, endLine: line } });
  const merged = mergeBranchFacts([
    at(10, 'if', 'if (seat == null)'),
    at(11, 'ternary', 'late'),
    at(12, 'error_return', 'throw new SeatException();'),
  ]);
  assert.deepEqual(merged.map((entry) => [entry.fact.line, entry.fact.kind, entry.fact.returnLine ?? null]), [
    [10, 'error_return', 12],
    [11, 'ternary', null],
  ]);
});

const FERRY = 'ferry-tickets';
const CONFIG = ['--config', 'ferry.config.json'];

function extracted(t) {
  const dir = copyFixture(t, FERRY);
  const run = runCli(['extract', ...CONFIG], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  return { dir, stderr: run.stderr };
}

function facts(dir, repo) {
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
}

function route(dir, controller, action) {
  const found = facts(dir, 'api').filter((f) => f.type === 'route' && f.controller === controller && f.action === action);
  assert.equal(found.length, 1, `one route for ${controller}.${action}`);
  return found[0];
}

function cli(dir, ...args) {
  return runCli([...args, ...CONFIG], { cwd: dir });
}

/** Makes `dir` a Git checkout with one commit, `out/` ignored, so a diff can be read. Returns
 * a function that commits the working tree and gives the new revision. */
function gitCheckout(dir) {
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  commit('initial');
  return commit;
}

/** The 1-based line of `file` (under `dir`) that holds `needle`. */
function lineOf(dir, file, needle) {
  const index = readFileSync(join(dir, file), 'utf8').split('\n').findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, needle);
  return index + 1;
}

test('CSharp reading AC-1: an attribute over several lines is read as one attribute and keeps the verb before it', (t) => {
  const { dir } = extracted(t);
  assert.deepEqual(route(dir, 'SailingsController', 'GetSailing'), {
    type: 'route',
    file: 'src/Controllers/SailingsController.cs',
    line: 16,
    controller: 'SailingsController',
    action: 'GetSailing',
    verb: 'GET',
    template: 'sailings/{id}',
  });
  assert.deepEqual(route(dir, 'SailingsController', 'GetStops'), {
    type: 'route',
    file: 'src/Controllers/SailingsController.cs',
    line: 25,
    controller: 'SailingsController',
    action: 'GetStops',
    verb: 'GET',
    template: 'sailings/{id}/stops',
  });
  assert.equal(route(dir, 'BoardModel', 'OnGet').template, 'harbor/departures');
  const checkIn = route(dir, 'CheckInEndpoint', 'HandleAsync');
  assert.deepEqual([checkIn.template, checkIn.line], ['api/v2/check-in/{ticket}', 19]);

  assert.equal(cli(dir, 'join').status, 0);
  const reached = cli(dir, 'routes-of', 'Timetable.Stops', '--json');
  assert.equal(reached.status, 0, reached.stderr);
  assert.deepEqual(JSON.parse(reached.stdout).routes.map((r) => r.key), ['GET sailings/*/stops']);
});

test('CSharp reading AC-2: an attribute line that ends with a comment still reads as the attribute', (t) => {
  const { dir } = extracted(t);
  const upload = route(dir, 'SailingsController', 'Upload');
  assert.deepEqual([upload.verb, upload.template, upload.line], ['POST', 'sailings/upload', 37]);
  const file = route(dir, 'ManifestsController', 'UploadFile');
  assert.deepEqual([file.verb, file.template, file.line], ['POST', 'api/v2/manifests/files', 16]);
  const checkIn = route(dir, 'CheckInEndpoint', 'HandleAsync');
  assert.deepEqual([checkIn.verb, checkIn.template], ['POST', 'api/v2/check-in/{ticket}']);
});

test('CSharp reading AC-3: constant route arguments resolve, and prefix-only controllers give one key each', (t) => {
  const { dir } = extracted(t);
  assert.equal(route(dir, 'OrdersController', 'PlaceOrder').template, 'api/v2/orders');
  assert.equal(route(dir, 'ManifestsController', 'Stamp').template, 'api/v2/manifests/Stamp');
  assert.equal(route(dir, 'UpperDeckController', 'Seats').template, 'upper/seats');
  assert.equal(route(dir, 'LowerDeckController', 'Seats').template, 'lower/seats');
  assert.equal(route(dir, 'CarDeckController', 'Seats').template, 'car/seats');
  assert.deepEqual(
    facts(dir, 'ops').filter((f) => f.type === 'route').map((f) => [f.verb, f.template, f.unresolvedArgument]),
    [['GET', 'ops/ping', undefined]],
  );

  for (const key of ['GET upper/seats', 'GET lower/seats', 'GET car/seats', 'POST api/v2/orders']) {
    const run = cli(dir, 'trace', key);
    assert.equal(run.status, 0, `${key}: ${run.stderr}`);
    assert.ok(run.stdout.startsWith(`start: ${key} (route, api `), run.stdout.split('\n')[0]);
    assert.doesNotMatch(run.stdout + run.stderr, /ambiguous/);
  }
  const cover = cli(dir, 'cover', '--area', 'ferry.area.txt');
  assert.equal(cover.status, 0, cover.stderr);
  assert.match(cover.stdout, /GET upper\/seats  1 seed/);
  assert.doesNotMatch(cover.stdout, /ambiguous start/);

  assert.equal(cli(dir, 'join').status, 0);
  const edges = JSON.parse(readFileSync(join(dir, 'out', 'flow.json'), 'utf8')).edges.filter((e) => e.kind === 'calls');
  assert.deepEqual(edges.map((e) => [e.from.ref, e.to.ref, e.key]).sort(), [
    ['httpClient.carSeats', 'CarDeckController.Seats', 'GET car/seats'],
    ['httpClient.placeOrder', 'OrdersController.PlaceOrder', 'POST api/v2/orders'],
    ['httpClient.upperSeats', 'UpperDeckController.Seats', 'GET upper/seats'],
  ]);
});

test('CSharp reading AC-4: a route argument with no single value keeps its fact, warns once and matches no URL', (t) => {
  const { dir, stderr } = extracted(t);
  const warnings = stderr.split('\n').filter((line) => line.includes('unresolved route argument'));
  assert.deepEqual(warnings, [
    'flowtrace: extract api: src/Controllers/FaresController.cs:16: unresolved route argument FareRoutes.Missing',
    'flowtrace: extract api: src/Controllers/FaresController.cs:22: unresolved route argument LoopRoutes.First',
    'flowtrace: extract api: src/Controllers/FaresController.cs:28: unresolved route argument Twin.Key',
    'flowtrace: extract api: src/Controllers/FaresController.cs:34: unresolved route argument FareRoutes.Window + RouteText.Build()',
    'flowtrace: extract api: src/Controllers/FaresController.cs:40: unresolved route argument OpsRoutes.Ping',
    'flowtrace: extract api: src/Pages/Harbor/Lost.cshtml.cs:3: unresolved route argument HarborRoutes.LostProperty',
  ]);
  assert.deepEqual(route(dir, 'FaresController', 'Quote'), {
    type: 'route',
    file: 'src/Controllers/FaresController.cs',
    line: 16,
    controller: 'FaresController',
    action: 'Quote',
    verb: 'GET',
    template: 'fares',
    unresolvedArgument: { text: 'FareRoutes.Missing', line: 16 },
  });
  assert.equal(route(dir, 'LostModel', 'OnGet').unresolvedArgument.text, 'HarborRoutes.LostProperty');
  const named = route(dir, 'FaresController', 'Named');
  assert.deepEqual([named.template, named.unresolvedArgument], ['fares/window', undefined]);

  const byKey = cli(dir, 'trace', 'GET fares');
  assert.equal(byKey.status, 2);
  assert.match(byKey.stdout + byKey.stderr, /reason: no-declaration/);
  const bySelector = cli(dir, 'trace', 'FaresController.Quote');
  assert.equal(bySelector.status, 0, bySelector.stderr);
  assert.ok(bySelector.stdout.startsWith('start: FaresController.Quote (action, api src/Controllers/FaresController.cs:16)'));

  assert.equal(cli(dir, 'join', '--snapshot', 'before.json').status, 0);
  const flow = JSON.parse(readFileSync(join(dir, 'out', 'flow.json'), 'utf8'));
  assert.deepEqual(flow.edges.filter((e) => e.key === 'GET fares'), []);
  assert.deepEqual(flow.unjoined.mobile_calls_without_route.map((u) => u.key), ['GET fares']);
  assert.ok(!flow.unjoined.routes_without_caller.some((u) => u.fact.unresolvedArgument));

  const reached = cli(dir, 'routes-of', 'FareDesk.Quote', '--json');
  assert.equal(reached.status, 0, reached.stderr);
  assert.deepEqual(JSON.parse(reached.stdout).routes, []);

  writeFileSync(join(dir, 'fares.area.txt'), 'GET fares\n');
  const cover = cli(dir, 'cover', '--area', 'fares.area.txt');
  assert.doesNotMatch(cover.stdout, /GET fares  [1-9]\d* seed/);

  // The route with its argument made readable joins the waiting call, so the snapshot taken
  // before held no joined path for the unresolved route.
  const controller = join(dir, 'api', 'src', 'Controllers', 'FaresController.cs');
  writeFileSync(controller, readFileSync(controller, 'utf8').replace('[HttpGet(FareRoutes.Missing)]', '[HttpGet("")]'));
  assert.equal(cli(dir, 'extract', '--repo', 'api').status, 0);
  const drift = cli(dir, 'join', '--against', 'before.json', '--json');
  assert.equal(drift.status, 0, drift.stderr);
  assert.match(drift.stdout, /GET fares/);
});

test('CSharp reading AC-4: affected never counts an unresolved route as a known route key', (t) => {
  const { dir } = extracted(t);
  assert.equal(cli(dir, 'join').status, 0);
  gitCheckout(dir);
  const services = join(dir, 'api', 'src', 'Services', 'Services.cs');
  writeFileSync(services, readFileSync(services, 'utf8').replace('public Fare Quote() => Fare.None;', 'public Fare Quote() => Fare.Some;'));
  const run = cli(dir, 'affected', '--all-routes', '--json');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const declared = ['api', 'ops'].flatMap((repo) => facts(dir, repo)).filter((f) => f.type === 'route');
  assert.equal(report.universe.routes, declared.filter((f) => !f.unresolvedArgument).length);
  assert.ok(report.routes.length > 0);
  assert.doesNotMatch(JSON.stringify(report.routes), /"GET fares"/);
});

const PASSENGERS = 'src/Passengers/PassengerService.cs';

/** The calls one `PassengerService` method makes, as `[line, field, calledMethod, receiverType]`. */
function callsOf(dir, method) {
  return facts(dir, 'api')
    .filter((f) => f.type === 'method_call' && f.file === PASSENGERS && f.method === method)
    .map((f) => [f.line, f.field, f.calledMethod, f.receiverType ?? null])
    .sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]));
}

test('CSharp reading AC-5: an expression-bodied method gets the calls a block body with the same expression gets', (t) => {
  const { dir } = extracted(t);
  assert.deepEqual(
    callsOf(dir, 'Lookup').map(([, ...call]) => call),
    callsOf(dir, 'LookupBlock').map(([, ...call]) => call),
  );
  assert.deepEqual(callsOf(dir, 'Lookup'), [[14, '_voyages', 'Load', null]]);
  assert.deepEqual(callsOf(dir, 'Label'), [
    [21, 'this', 'Format', null],
    [21, 'this', 'Shorten', null],
  ]);
  assert.deepEqual(callsOf(dir, 'Price'), [
    [23, '_provider', 'GetRequiredService', null],
    [23, 'IFareTable', 'PriceFor', 'IFareTable'],
  ]);
  assert.deepEqual(callsOf(dir, 'Badge'), [
    [25, 'Profile', 'ToBadge', 'Profile'],
    [25, 'Passenger', 'ToProfile', 'PassengerExtensions'],
  ]);
});

test('CSharp reading AC-6: a call inside an object or collection initializer gives its call fact', (t) => {
  const { dir } = extracted(t);
  assert.deepEqual(callsOf(dir, 'Receipt'), [
    [35, '_voyages', 'Total', null],
    [36, '_voyages', 'Line', null],
  ]);
  assert.deepEqual(callsOf(dir, 'Ticket'), [
    [29, 'Passenger', 'ToHolder', 'PassengerExtensions'],
    [30, '_voyages', 'Load', null],
  ]);
});

test('CSharp reading AC-7: a chain link resolves only through a known receiver type and one target', (t) => {
  const { dir } = extracted(t);
  assert.deepEqual(callsOf(dir, 'Summarize'), [
    [40, '_voyages', 'LoadAsync', null],
    [40, 'Voyage', 'ToSummary', 'Voyage'],
  ]);
  // `thing` has no known type, so the method name `Describe`, unique in the repository, does
  // not resolve it; `port` reaches `Moor` through two interfaces, so it has no one target.
  assert.deepEqual(callsOf(dir, 'Board'), [
    [44, '_voyages', 'Load', null],
    [45, 'Voyage', 'Close', 'Voyage'],
    [47, 'Cabin', 'Lock', 'Cabin'],
  ]);
  const duplicates = facts(dir, 'api')
    .filter((f) => f.type === 'method_call')
    .map((f) => JSON.stringify([f.file, f.line, f.class, f.method, f.calledMethod, f.receiverType ?? f.field]));
  assert.equal(new Set(duplicates).size, duplicates.length);
});

test('CSharp reading AC-8: routes-of reaches a callee of an expression body, an initializer and a chain link', (t) => {
  const { dir } = extracted(t);
  assert.equal(cli(dir, 'join').status, 0);
  const cases = [
    ['PassengerService.Format', `${PASSENGERS}:55`, ['GET passengers/*/label']],
    ['Profile.ToBadge', 'src/Passengers/Types.cs:60', ['GET passengers/*/badge']],
    ['PassengerExtensions.ToHolder', 'src/Passengers/Types.cs:67', ['GET passengers/*/ticket']],
    ['VoyageStore.Total', 'src/Passengers/Types.cs:23', ['GET passengers/*/receipt']],
    ['Voyage.ToSummary', 'src/Passengers/Types.cs:40', ['GET passengers/*/summary']],
    ['Cabin.Lock', 'src/Passengers/Types.cs:45', ['POST passengers/*/board']],
    ['FareTable.PriceFor', 'src/Passengers/Types.cs:77', ['GET passengers/*/price']],
  ];
  for (const [symbol, site, keys] of cases) {
    for (const args of [[symbol, '--symbol'], [site, '--repo', 'api']]) {
      const run = cli(dir, 'routes-of', ...args, '--json');
      assert.equal(run.status, 0, `${args[0]}: ${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout).routes.map((r) => r.key), keys, args[0]);
    }
  }
});

const GATES = 'src/Gates/GateRules.cs';
const GATES_CONTROLLER = 'src/Controllers/GatesController.cs';

/** The `branch_point` facts of one file, as `[line, method, kind, text]`. */
function decisionsIn(dir, file) {
  return facts(dir, 'api')
    .filter((f) => f.type === 'branch_point' && f.file === file)
    .map((f) => [f.line, f.method, f.kind, f.text])
    .sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]));
}

test('CSharp reading AC-9: conditional operators, coalesce choices and predicate lambdas are decisions', (t) => {
  const { dir } = extracted(t);
  const at = (needle) => lineOf(join(dir, 'api'), GATES, needle);
  assert.deepEqual(decisionsIn(dir, GATES), [
    [at('tickets.Where('), 'Boardable', 'predicate', 'late || t.Priority'],
    [at('ticket.Name ?? fallback'), 'Holder', 'coalesce', 'ticket.Name ?? fallback'],
    [at('ticket.Seat ?? throw'), 'Holder', 'error_return', 'var seat = ticket.Seat ?? throw new ArgumentException("seat");'],
    [at('ticket.Gate ?? throw'), 'Holder', 'guard', 'var gate = ticket.Gate ?? throw ticket.Missing;'],
    [at('return count > 0'), 'Holder', 'ternary', 'count > 0'],
    [at('public int Rank'), 'Rank', 'ternary', 'x > 2'],
    [at('public int Rank'), 'Rank', 'ternary', 'x > 3'],
    [at('tickets.Any('), 'Checks', 'predicate', 't.Late'],
    [at('tickets.Any('), 'Checks', 'predicate', 't.Paid'],
  ]);
  const controller = decisionsIn(dir, GATES_CONTROLLER);
  assert.deepEqual(controller, [
    [lineOf(join(dir, 'api'), GATES_CONTROLLER, 'return allowed ?'), 'Open', 'ternary', 'allowed'],
    [lineOf(join(dir, 'api'), GATES_CONTROLLER, 'return status =='), 'Status', 'ternary', 'status == GateStatus.Open'],
  ]);
});

test('CSharp reading AC-11: the new decisions are listed by decisions and cover and multiply no seed', (t) => {
  const { dir } = extracted(t);
  for (const key of ['GET gates/{id}/open', 'GET gates/{id}/status']) {
    const run = cli(dir, 'trace', key, '--seeds', '--json');
    assert.equal(run.status, 0, run.stderr);
    const walk = JSON.parse(run.stdout);
    assert.equal(walk.seeds.length, 1, key);
    const branches = walk.nodes.filter((node) => node.kind === 'branch' && node.file === GATES_CONTROLLER);
    assert.deepEqual(branches.map((node) => [node.branchKind, node.dispositions ?? null]), [['ternary', null]], key);
  }
  writeFileSync(join(dir, 'gates.area.txt'), 'GET gates/{id}/open\nGET gates/{id}/status\n');
  const cover = cli(dir, 'cover', '--area', 'gates.area.txt', '--json');
  assert.equal(cover.status, 0, cover.stderr);
  for (const route of JSON.parse(cover.stdout).routes) {
    assert.equal(route.seeds.length, 1, route.key);
    assert.equal(route.seeds[0].branchWeight, 0, route.key);
    assert.equal(route.seeds[0].dispositions, 'happy path', route.key);
  }

  const commit = gitCheckout(dir);
  const file = join(dir, 'api', GATES);
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('x > 3 ? 1', 'x > 4 ? 1')
      .replace('ticket.Name ?? fallback', 'ticket.Title ?? fallback')
      .replace('tickets.Any(t => t.Late)', 'tickets.Any(t => t.Early)'),
  );
  const revision = commit('change the gate rules');
  assert.equal(cli(dir, 'extract', '--repo', 'api').status, 0);
  const run = cli(dir, 'decisions', '--revs', revision, '--json');
  assert.equal(run.status, 0, run.stderr);
  const listed = JSON.parse(run.stdout).units.flatMap((unit) => unit.decisions.map((d) => [unit.method, d.id, d.kind]));
  const id = (needle, kind) => `api:${GATES}:${lineOf(join(dir, 'api'), GATES, needle)}:${kind}`;
  assert.deepEqual(listed, [
    ['Holder', id('ticket.Title ?? fallback', 'coalesce'), 'coalesce'],
    ['Rank', id('public int Rank', 'ternary'), 'ternary'],
    ['Rank', `${id('public int Rank', 'ternary')}#2`, 'ternary'],
    ['Checks', id('tickets.Any(', 'predicate'), 'predicate'],
    ['Checks', `${id('tickets.Any(', 'predicate')}#2`, 'predicate'],
  ]);
});
