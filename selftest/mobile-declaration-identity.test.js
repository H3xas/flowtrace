/**
 * Declaration identity for mobile traversal: a dependency or template owner names one
 * declaration file, a same-named twin in another file never stands in for it, and a site
 * the facts cannot prove states one visible refusal instead of guessing.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'selftest', 'corpus', 'orchard-mobile');
const REFUSAL = 'mobile-declaration-unresolved';
const CURRENT = 'src/app/features/weather/current-weather.service.ts';
const LEGACY = 'src/app/features/weather/legacy-weather.service.ts';
const WEATHER_PAGE = 'src/app/features/weather/weather.page.ts';
const WEATHER_TEMPLATE = 'src/app/features/weather/weather.page.html';

let pack = '';
let config = '';

function extractAndJoin(dir) {
  const configPath = join(dir, 'orchard.config.json');
  const extracted = runCli(['extract', '--config', configPath], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = runCli(['join', '--config', configPath], { cwd: dir });
  assert.equal(joined.status, 0, joined.stderr);
  return configPath;
}

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-declaration-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return { dir, config: extractAndJoin(dir) };
}

before(() => {
  pack = mkdtempSync(join(tmpdir(), 'flowtrace-declaration-main-'));
  cpSync(FIXTURE, pack, { recursive: true });
  config = extractAndJoin(pack);
});

after(() => {
  rmSync(pack, { recursive: true, force: true });
});

function mobileFacts() {
  return JSON.parse(readFileSync(join(pack, 'out', 'facts', 'mobile.json'), 'utf8')).facts;
}

function factsPath(dir) {
  return join(dir, 'out', 'facts', 'mobile.json');
}

function withFacts(mutate, run, dir = pack) {
  const path = factsPath(dir);
  const original = readFileSync(path, 'utf8');
  const document = JSON.parse(original);
  mutate(document.facts);
  writeFileSync(path, JSON.stringify(document));
  try {
    return run();
  } finally {
    writeFileSync(path, original);
  }
}

function traceRun(start, extra = [], configPath = config, dir = pack) {
  return runCli(['trace', start, '--json', '--config', configPath, ...extra], { cwd: dir });
}

function traceJson(start, extra = [], configPath = config, dir = pack) {
  const run = traceRun(start, extra, configPath, dir);
  return { ...run, model: run.status === 0 ? JSON.parse(run.stdout) : null };
}

function spanRun(name, extra = [], configPath = config, dir = pack) {
  return runCli(['span', '--from-component', name, '--json', '--config', configPath, ...extra], { cwd: dir });
}

function spanJson(name, extra = [], configPath = config, dir = pack) {
  const run = spanRun(name, extra, configPath, dir);
  return { ...run, model: run.status === 0 ? JSON.parse(run.stdout) : null };
}

function routesOf(model) {
  return model.routes.map((route) => route.key).sort();
}

function entriesOf(model) {
  return model.entries
    .map((view) => ({ handler: view.identity.handler, routes: [...view.routes].sort(), arms: view.arms }))
    .sort((a, b) => String(a.handler).localeCompare(String(b.handler)));
}

function refusalsOf(model) {
  return model.unresolved.filter((arm) => arm.reason === REFUSAL);
}

function traceNodes(model, predicate) {
  return model.nodes.filter(predicate);
}

function injectFact(facts, from, to) {
  return facts.find((fact) => fact.type === 'injects' && fact.from === from && fact.to === to);
}

function callFacts(facts, className, methodName, field) {
  return facts.filter(
    (fact) =>
      fact.type === 'method_call' &&
      fact.class === className &&
      fact.method === methodName &&
      (field === undefined || fact.field === field),
  );
}

function componentFact(facts, file) {
  return facts.find((fact) => fact.type === 'component' && fact.file === file);
}

test('Mobile declaration identity AC-1: constructor and field injection record the written specifier and imported export', () => {
  const facts = mobileFacts();
  const archive = injectFact(facts, 'WeatherPage', 'Archive');
  const current = injectFact(facts, 'WeatherPage', 'Current');
  const metrics = injectFact(facts, 'WeatherPage', 'MetricsApi');
  assert.deepEqual(
    [archive.source, archive.imported, archive.to],
    ['./legacy-weather.service', 'CurrentWeatherService', 'Archive'],
  );
  assert.deepEqual(
    [current.source, current.imported, current.to],
    ['./current-weather.service', 'CurrentWeatherService', 'Current'],
  );
  assert.deepEqual(
    [metrics.source, metrics.imported, metrics.to],
    ['./metrics.service', 'MetricsApi', 'MetricsApi'],
  );
  const refreshCurrent = callFacts(facts, 'WeatherPage', 'refresh', 'Current')[0];
  const refreshArchive = callFacts(facts, 'WeatherPage', 'refresh', 'Archive')[0];
  assert.deepEqual(
    [refreshCurrent.source, refreshCurrent.imported, refreshCurrent.field],
    ['./current-weather.service', 'CurrentWeatherService', 'Current'],
  );
  assert.deepEqual(
    [refreshArchive.source, refreshArchive.imported, refreshArchive.field],
    ['./legacy-weather.service', 'CurrentWeatherService', 'Archive'],
  );
});

test('Mobile declaration identity AC-1: component facts state their named value exports', () => {
  const facts = mobileFacts();
  assert.deepEqual(componentFact(facts, CURRENT).exports, ['CurrentWeatherService']);
  assert.deepEqual(componentFact(facts, 'src/app/features/weather/metrics.service.ts').exports, ['MetricsApi']);
  assert.deepEqual(componentFact(facts, 'src/app/features/weather/private-probe.service.ts').exports, []);
  assert.deepEqual(componentFact(facts, 'src/app/features/weather/ledger/index.ts').exports, ['LedgerService']);
});

test('Mobile declaration identity AC-1: template facts keep the template site and name the owning declaration file', () => {
  const facts = mobileFacts();
  const handlers = facts.filter((fact) => fact.type === 'template_handler' && fact.component === 'WeatherPage');
  assert.equal(handlers.length, 4);
  for (const fact of handlers) {
    assert.equal(fact.file, WEATHER_TEMPLATE);
    assert.equal(fact.componentFile, WEATHER_PAGE);
  }
  const rendered = facts.find((fact) => fact.type === 'renders' && fact.from === 'WeatherPage');
  assert.deepEqual([rendered.to, rendered.file, rendered.componentFile], [
    'app-weather-badge',
    WEATHER_TEMPLATE,
    WEATHER_PAGE,
  ]);
});

test('Mobile declaration identity AC-2: both injection forms and an aliased import reach the intended request and exclude the twin', () => {
  const run = spanJson('WeatherPage');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(entriesOf(run.model), [
    { handler: 'ledger', routes: ['GET orchard/v1/ledger/*'], arms: 1 },
    { handler: 'measure', routes: ['GET orchard/v1/metrics/*'], arms: 1 },
    {
      handler: 'refresh',
      routes: ['GET orchard/v1/weather/current/*', 'GET orchard/v1/weather/legacy/*'],
      arms: 2,
    },
    { handler: 'summary', routes: ['GET orchard/v1/weather/current/*/summary'], arms: 1 },
  ]);
  assert.deepEqual(routesOf(run.model), [
    'GET orchard/v1/ledger/*',
    'GET orchard/v1/metrics/*',
    'GET orchard/v1/weather/current/*',
    'GET orchard/v1/weather/current/*/summary',
    'GET orchard/v1/weather/legacy/*',
  ]);
  assert.equal(refusalsOf(run.model).length, 0);
});

test('Mobile declaration identity AC-2: an export alias enters the actual class name and file', () => {
  const run = traceJson('WeatherPage');
  assert.equal(run.status, 0, run.stderr);
  const measured = traceNodes(run.model, (node) => node.ref === 'MetricsService.loadMetrics');
  assert.equal(measured.length, 1);
  assert.equal(measured[0].file, 'src/app/features/weather/metrics.service.ts');
  assert.equal(
    traceNodes(run.model, (node) => node.ref === 'MetricsApi.loadMetrics' || node.class === 'MetricsApi').length,
    0,
  );
});

test('Mobile declaration identity AC-2: an explicitly named index.ts that declares the value resolves', () => {
  const run = spanJson('WeatherPage', ['--entry', 'ledger']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.model.selectedEntry.handler, 'ledger');
  const route = run.model.routes.find((entry) => entry.key === 'GET orchard/v1/ledger/*');
  assert.ok(route);
  const trace = traceJson('WeatherPage');
  const ledger = traceNodes(trace.model, (node) => node.ref === 'LedgerService.loadLedger');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].file, 'src/app/features/weather/ledger/index.ts');
});

test('Mobile declaration identity AC-2: a saved fact snapshot resolves after the source changes', () => {
  const variant = freshCopy();
  try {
    const before = spanJson('WeatherPage', [], variant.config, variant.dir);
    assert.equal(before.status, 0, before.stderr);
    assert.ok(routesOf(before.model).includes('GET orchard/v1/weather/current/*'));
    const source = join(variant.dir, 'mobile', CURRENT);
    writeFileSync(source, readFileSync(source, 'utf8').replace(/weather\/current/g, 'weather/renamed'));
    const after = spanJson('WeatherPage', [], variant.config, variant.dir);
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(after.model.routes.map((entry) => entry.key).sort(), routesOf(before.model));
    assert.ok(!after.model.routes.some((entry) => entry.key.includes('renamed')));
  } finally {
    rmSync(variant.dir, { recursive: true, force: true });
  }
});

test('Mobile declaration identity AC-3: each same-named declaration owns its own method bodies and requests', () => {
  const run = traceJson('WeatherPage');
  assert.equal(run.status, 0, run.stderr);
  const methods = traceNodes(run.model, (node) => node.ref === 'CurrentWeatherService.loadWeather' && node.kind === 'method');
  assert.equal(methods.length, 2);
  assert.deepEqual(methods.map((node) => node.file).sort(), [CURRENT, LEGACY]);
  const routes = new Set(traceNodes(run.model, (node) => node.kind === 'route').map((node) => node.ref));
  assert.ok(routes.has('GET orchard/v1/weather/current/*'));
  assert.ok(routes.has('GET orchard/v1/weather/legacy/*'));
});

test('Mobile declaration identity AC-3: an unqualified duplicate start lists sorted candidate files', () => {
  const run = spanJson('ForecastPage');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /is declared in 2 files/);
  const archiveAt = run.stderr.indexOf('src/app/features/forecast/archive-forecast.page.ts:4');
  const liveAt = run.stderr.indexOf('src/app/features/forecast/live-forecast.page.ts:4');
  assert.ok(archiveAt > 0 && liveAt > archiveAt, run.stderr);
});

test('Mobile declaration identity AC-3: --file selects one declaration and walks only its own template entries', () => {
  const live = spanJson('ForecastPage', ['--file', 'live']);
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.model.component.file, 'src/app/features/forecast/live-forecast.page.ts');
  assert.deepEqual(entriesOf(live.model), [
    { handler: 'onLive', routes: ['GET orchard/v1/weather/current/*/forecast'], arms: 1 },
    { handler: 'onSummary', routes: ['GET orchard/v1/weather/current/*/summary'], arms: 1 },
  ]);
  const archive = spanJson('ForecastPage', ['--file', 'archive']);
  assert.equal(archive.status, 0, archive.stderr);
  assert.equal(archive.model.component.file, 'src/app/features/forecast/archive-forecast.page.ts');
  assert.deepEqual(entriesOf(archive.model), [
    { handler: 'onArchive', routes: ['GET orchard/v1/weather/legacy/*/archive'], arms: 1 },
  ]);
});

test('Mobile declaration identity AC-3: a --file substring that matches no declaration keeps the refusal', () => {
  const run = spanJson('ForecastPage', ['--file', 'nowhere']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--file "nowhere" matches 0 of 2 declarations/);
  assert.match(run.stderr, /archive-forecast\.page\.ts:4/);
  assert.match(run.stderr, /live-forecast\.page\.ts:4/);
});

test('Mobile declaration identity AC-3: a rendered child keeps its own declaration file', () => {
  const run = traceJson('WeatherPage', ['--expand']);
  assert.equal(run.status, 0, run.stderr);
  const badge = traceNodes(run.model, (node) => node.ref === 'WeatherBadgeComponent');
  assert.equal(badge.length, 1);
  assert.equal(badge[0].file, 'src/app/features/weather/weather-badge.component.ts');
});

test('Mobile declaration identity AC-4: a type-only import used as a runtime value refuses and keeps the independent arm', () => {
  const run = spanJson('ProbePage');
  assert.equal(run.status, 0, run.stderr);
  const refusals = refusalsOf(run.model);
  assert.ok(refusals.length > 0);
  assert.ok(refusals.every((arm) => arm.attempted === 'GhostService'));
  assert.ok(refusals.every((arm) => arm.file === 'src/app/features/weather/probe.page.ts'));
  assert.deepEqual(
    entriesOf(run.model).find((entry) => entry.handler === 'ok'),
    { handler: 'ok', routes: ['GET orchard/v1/weather/current/*'], arms: 1 },
  );
  assert.ok(!run.model.routes.some((route) => route.key.includes('ghost')));
});

test('Mobile declaration identity AC-4: a missing target, a forwarded re-export and a private declaration each refuse', () => {
  const cases = [
    ['MissingPage', 'GoneService'],
    ['BarrelPage', 'CurrentWeatherService'],
    ['PrivatePage', 'HiddenProbeService'],
  ];
  for (const [name, attempted] of cases) {
    const run = spanJson(name);
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    const refusals = refusalsOf(run.model);
    assert.ok(refusals.length > 0, `${name} states a refusal`);
    assert.ok(refusals.every((arm) => arm.attempted === attempted), `${name}: ${attempted}`);
  }
  const privateRun = spanJson('PrivatePage', ['--entry', 'measure']);
  assert.equal(privateRun.status, 0, privateRun.stderr);
  assert.deepEqual(privateRun.model.routes.map((entry) => entry.key), ['GET orchard/v1/metrics/*']);
});

test('Mobile declaration identity AC-4: a specifier that escapes the repository refuses', () => {
  const run = spanJson('EscapePage');
  assert.equal(run.status, 0, run.stderr);
  const refusals = refusalsOf(run.model);
  assert.ok(refusals.length > 0);
  assert.ok(refusals.every((arm) => arm.attempted === 'OutsideService'));
  assert.ok(
    entriesOf(run.model).find((entry) => entry.handler === 'ok').routes.includes('GET orchard/v1/weather/current/*'),
  );
});

test('Mobile declaration identity AC-4: malformed provenance is a site refusal, not legacy absence', () => {
  const variants = [
    {
      label: 'null source',
      legacyReached: false,
      mutate: (facts) => {
        injectFact(facts, 'WeatherPage', 'Archive').source = null;
        for (const fact of callFacts(facts, 'WeatherPage', 'refresh', 'Archive')) fact.source = null;
      },
    },
    {
      label: 'partial import',
      legacyReached: false,
      mutate: (facts) => {
        delete injectFact(facts, 'WeatherPage', 'Archive').imported;
        for (const fact of callFacts(facts, 'WeatherPage', 'refresh', 'Archive')) delete fact.imported;
      },
    },
    {
      label: 'wrong imported type',
      legacyReached: false,
      mutate: (facts) => {
        injectFact(facts, 'WeatherPage', 'Archive').imported = 42;
        for (const fact of callFacts(facts, 'WeatherPage', 'refresh', 'Archive')) fact.imported = 42;
      },
    },
    {
      label: 'contradictory binding',
      legacyReached: true,
      mutate: (facts) => {
        for (const fact of callFacts(facts, 'WeatherPage', 'refresh', 'Archive')) fact.field = 'Current';
      },
    },
    {
      label: 'malformed exports',
      legacyReached: false,
      mutate: (facts) => {
        componentFact(facts, LEGACY).exports = 'CurrentWeatherService';
      },
    },
    {
      label: 'malformed componentFile',
      legacyReached: true,
      mutate: (facts) => {
        const handler = facts.find(
          (fact) => fact.type === 'template_handler' && fact.component === 'WeatherPage' && fact.handler === 'refresh',
        );
        handler.componentFile = 7;
      },
    },
  ];
  for (const { label, legacyReached, mutate } of variants) {
    const run = withFacts(mutate, () => spanJson('WeatherPage'));
    assert.equal(run.status, 0, `${label}: ${run.stderr}`);
    assert.ok(refusalsOf(run.model).length > 0, `${label} states a refusal`);
    const routes = routesOf(run.model);
    assert.ok(routes.includes('GET orchard/v1/weather/current/*'), `${label} keeps the good arm`);
    assert.equal(routes.includes('GET orchard/v1/weather/legacy/*'), legacyReached, label);
  }
});

test('Mobile declaration identity AC-4: trace JSON, trace text and the span page agree on the refusal', () => {
  const run = traceJson('ProbePage');
  assert.equal(run.status, 0, run.stderr);
  const detail = run.model.status.frontier.filter((entry) => entry.detail === REFUSAL);
  assert.ok(detail.length > 0);
  assert.ok(detail.every((entry) => entry.callSite && entry.callSite.file === 'src/app/features/weather/probe.page.ts'));
  const text = runCli(['trace', 'ProbePage', '--config', config], { cwd: pack });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`detail ${REFUSAL}`));
  assert.match(text.stdout, /GhostService/);
  const out = join(pack, 'pages', 'probe.html');
  const page = runCli(['span', '--from-component', 'ProbePage', '--out', out, '--config', config], { cwd: pack });
  assert.equal(page.status, 0, page.stderr);
  const html = readFileSync(out, 'utf8');
  assert.match(html, new RegExp(REFUSAL));
  assert.match(html, /does not prove one declaration file/);
});

test('Mobile declaration identity AC-5: reversing the fact order preserves reached identities and candidates', () => {
  const before = spanJson('WeatherPage');
  const beforeAmbiguous = spanJson('ForecastPage');
  const reversed = withFacts((facts) => facts.reverse(), () => ({
    page: spanJson('WeatherPage'),
    ambiguous: spanJson('ForecastPage'),
  }));
  assert.equal(reversed.page.status, 0, reversed.page.stderr);
  assert.deepEqual(entriesOf(reversed.page.model), entriesOf(before.model));
  assert.deepEqual(routesOf(reversed.page.model), routesOf(before.model));
  assert.equal(reversed.ambiguous.status, 2);
  assert.deepEqual(
    reversed.ambiguous.stderr.split('\n').filter((line) => line.includes('.page.ts:')).sort(),
    beforeAmbiguous.stderr.split('\n').filter((line) => line.includes('.page.ts:')).sort(),
  );
});

test('Mobile declaration identity AC-5: a dependency cycle terminates and still reaches the independent request', () => {
  const run = traceJson('CycleAService.pingA', ['--expand']);
  assert.equal(run.status, 0, run.stderr);
  const routes = traceNodes(run.model, (node) => node.kind === 'route').map((node) => node.ref);
  assert.deepEqual([...new Set(routes)], ['GET orchard/v1/cycle/a/*']);
  assert.ok(run.model.nodes.some((node) => node.cycle === true && node.ref === 'CycleAService.pingA'));
  assert.ok(run.model.nodes.length < 30);
});

test('Mobile declaration identity AC-6: legacy facts without optional provenance keep a unique-name walk working', () => {
  const before = traceJson('CycleAService', ['--expand']);
  assert.equal(before.status, 0, before.stderr);
  const run = withFacts(
    (facts) => {
      for (const fact of facts) {
        delete fact.source;
        delete fact.imported;
        delete fact.unresolved;
        delete fact.componentFile;
        if (fact.type === 'component') delete fact.exports;
      }
    },
    () => traceJson('CycleAService', ['--expand']),
  );
  assert.equal(run.status, 0, run.stderr);
  const routeSet = (model) =>
    [...new Set(traceNodes(model, (node) => node.kind === 'route').map((node) => node.ref))].sort();
  assert.deepEqual(routeSet(run.model), routeSet(before.model));
});

test('Mobile declaration identity AC-6: absent provenance on a duplicate owner refuses instead of choosing a file', () => {
  const run = withFacts(
    (facts) => {
      const live = facts.find(
        (fact) => fact.type === 'injects' && fact.file === 'src/app/features/forecast/live-forecast.page.ts',
      );
      delete live.source;
      delete live.imported;
      for (const fact of facts) {
        if (fact.type !== 'method_call' || fact.file !== 'src/app/features/forecast/live-forecast.page.ts') continue;
        delete fact.source;
        delete fact.imported;
      }
    },
    () => spanJson('ForecastPage', ['--file', 'live']),
  );
  assert.equal(run.status, 0, run.stderr);
  const refusals = refusalsOf(run.model);
  assert.ok(refusals.length > 0);
  const candidates = new Set(refusals.flatMap((arm) => arm.candidates || []));
  assert.deepEqual([...candidates].sort(), [CURRENT, LEGACY].sort());
  assert.deepEqual(routesOf(run.model), []);
});

test('Mobile declaration identity AC-6: an explicit import to a metadata-free target cannot borrow the twin export', () => {
  const run = withFacts(
    (facts) => {
      delete componentFact(facts, LEGACY).exports;
    },
    () => spanJson('WeatherPage'),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(refusalsOf(run.model).some((arm) => arm.attempted === 'Archive'));
  assert.ok(routesOf(run.model).includes('GET orchard/v1/weather/current/*'));
  assert.ok(!routesOf(run.model).includes('GET orchard/v1/weather/legacy/*'));
});

test('Mobile declaration identity AC-4: a refused site reaches no request below it', () => {
  const run = spanJson('ProbePage');
  assert.equal(run.status, 0, run.stderr);
  const probe = run.model.entries.find((view) => view.identity.handler === 'probe').identity.id;
  const refusals = refusalsOf(run.model);
  assert.ok(refusals.some((arm) => arm.entry === probe));
  const reached = run.model.routes.flatMap((route) => route.arms).filter((arm) => arm.entry === probe);
  assert.deepEqual(reached, []);
  const ok = run.model.entries.find((view) => view.identity.handler === 'ok');
  assert.deepEqual(ok.routes, ['GET orchard/v1/weather/current/*']);
});
