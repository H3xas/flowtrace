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

/** Makes `dir` a Git checkout with one commit, `out/` ignored, so a diff can be read. */
function gitCheckout(dir) {
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'flowtrace selftest');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
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
