/**
 * Backend starts with no route in front of them (hubs, actors, configured entry points),
 * routes reached through a global filter, and the walk edges for mapper calls, queued work,
 * keyed dispatch, pipelines and gateway routes. Each test copies an invented corpus, runs
 * the CLI the way a user does and reads its JSON or text output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { copyFixture, runCli } from './helpers.js';

function corpus(t, name, config) {
  const dir = copyFixture(t, name);
  const cli = (args) => runCli([...args, '--config', config], { cwd: dir });
  const env = { dir, cli, extract: () => {
    const extracted = cli(['extract']);
    assert.equal(extracted.status, 0, extracted.stderr);
    return env;
  } };
  return env;
}

function facts(env, repo) {
  return JSON.parse(readFileSync(join(env.dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
}

function routesOf(env, point, extra = []) {
  const result = env.cli(['routes-of', point, '--symbol', '--json', ...extra]);
  return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
}

function traceJson(env, key) {
  const result = env.cli(['trace', key, '--seeds', '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function traceText(env, key) {
  const result = env.cli(['trace', key, '--seeds']);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function editFile(env, relPath, from, to) {
  const path = join(env.dir, relPath);
  const before = readFileSync(path, 'utf8');
  assert.ok(before.includes(from), `${relPath} holds ${from}`);
  writeFileSync(path, before.replace(from, to));
}

const LOOM = ['loom-gates', 'loom.config.json'];
const SPIN = 'POST looms/v1/spin';
const PATTERN = 'GET looms/v1/pattern';

test('Backend entries AC-1: routes-of answers the routes a global filter gates, its exemption respected', (t) => {
  const env = corpus(t, ...LOOM).extract();
  for (const point of ['LoomGuardFilter.OnAuthorizationAsync', 'ThreadLedger.Append']) {
    const { status, report } = routesOf(env, point);
    assert.equal(status, 0);
    assert.equal(report.verdict, 'routes');
    assert.deepEqual(report.routes.map((route) => route.key), [SPIN]);
    const hops = report.routes[0].witness.hops;
    assert.equal(hops[0].kind, 'route');
    assert.equal(hops[1].via, 'gate');
    assert.equal(hops[1].ref, 'LoomGuardFilter.OnAuthorizationAsync');
    assert.equal(hops[hops.length - 1].ref, point);
  }

  writeFileSync(join(env.dir, 'area.txt'), `${PATTERN}\n${SPIN}\n`);
  const covered = env.cli(['cover', '--area', 'area.txt', '--json']);
  assert.equal(covered.status, 0, covered.stderr);
  const gated = JSON.parse(covered.stdout).routes
    .filter((route) => route.seeds.some((seed) => seed.gate && seed.gate.filter === 'LoomGuardFilter' && seed.gate.shared))
    .map((route) => route.key);
  assert.deepEqual(gated, [SPIN]);

  for (const key of [SPIN, PATTERN]) {
    assert.ok(traceJson(env, key).edges.every((edge) => edge.via !== 'gate'), key);
  }

  const stopped = routesOf(env, 'ThreadLedger.Append', ['--max-nodes', '6']);
  assert.equal(stopped.status, 4);
  assert.equal(stopped.report.verdict, 'incomplete');
  assert.ok(stopped.report.completeness.reasons.some((reason) => reason.key === SPIN && /LoomGuardFilter/.test(reason.reason)));
});

test('Backend entries AC-2: every global filter registration form gives one global filter_use', (t) => {
  const forms = [
    'options.Filters.Add(typeof(LoomGuardFilter));',
    'options.Filters.Add<LoomGuardFilter>();',
    'options.Filters.Add(new LoomGuardFilter(null));',
    'options.Filters.AddService(typeof(LoomGuardFilter));',
    'options.Filters.AddService<LoomGuardFilter>();',
  ];
  for (const form of forms) {
    const env = corpus(t, ...LOOM);
    editFile(env, 'backend/src/Startup.cs', forms[0], form);
    env.extract();
    const uses = facts(env, 'loom').filter((item) => item.type === 'filter_use' && item.scope === 'global');
    assert.deepEqual(uses.map((item) => [item.filter, item.position]), [['LoomGuardFilter', 0]], form);
    const { report } = routesOf(env, 'ThreadLedger.Append');
    assert.deepEqual(report.routes.map((route) => route.key), [SPIN], form);
  }

  const env = corpus(t, ...LOOM);
  editFile(env, 'backend/src/Startup.cs', forms[0], `${forms[0]}\n                options.Filters.Add<ShedGuardFilter>();`);
  writeFileSync(
    join(env.dir, 'backend/src/ShedGuardFilter.cs'),
    [
      'using System.Threading.Tasks;',
      'using Microsoft.AspNetCore.Mvc.Filters;',
      'namespace Loom.Gates.Filters',
      '{',
      '    public class ShedGuardFilter : IAsyncAuthorizationFilter',
      '    {',
      '        public Task OnAuthorizationAsync(AuthorizationFilterContext context)',
      '        {',
      '            return Task.CompletedTask;',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  env.extract();
  const uses = facts(env, 'loom').filter((item) => item.type === 'filter_use' && item.scope === 'global');
  assert.deepEqual(uses.map((item) => [item.filter, item.position]), [['LoomGuardFilter', 0], ['ShedGuardFilter', 1]]);
});

const HARBOR = ['harbor-signals', 'harbor.config.json'];
const HARBOR_ENTRIES = ['harbor-signals', 'harbor-entries.config.json'];

function entryFacts(env) {
  return facts(env, 'harbor')
    .filter((item) => item.type === 'entry')
    .map((item) => `${item.kind} ${item.class}.${item.method}${item.declaringClass ? ` <${item.declaringClass}` : ''}${item.message ? ` (${item.message})` : ''}`)
    .sort();
}

function onlyEntry(report) {
  assert.equal(report.verdict, 'entries');
  assert.equal(report.routeCount, 0);
  assert.equal(report.entryCount, 1);
  return report.entries[0];
}

test('Backend entries AC-3: hub methods, inherited methods and connection events are hub entries', (t) => {
  const env = corpus(t, ...HARBOR).extract();
  const hubs = entryFacts(env).filter((line) => line.startsWith('hub '));
  assert.deepEqual(hubs, [
    'hub DockHub.Moor',
    'hub DockHub.OnConnectedAsync',
    'hub DockHub.OnDisconnectedAsync',
    'hub DockHub.Ping <DockHubBase',
  ]);
  const { status, report } = routesOf(env, 'BerthLedger.Moor');
  assert.equal(status, 0);
  const entry = onlyEntry(report);
  assert.deepEqual([entry.kind, entry.class, entry.method], ['hub', 'DockHub', 'Moor']);
  assert.equal(entry.witness.hops[entry.witness.hops.length - 1].ref, 'BerthLedger.Moor');
  assert.equal(routesOf(env, 'BerthLedger.Sweep').report.verdict, 'empty');
});

test('Backend entries AC-4: actor receive handlers are actor entries, method group and lambda', (t) => {
  const env = corpus(t, ...HARBOR).extract();
  assert.deepEqual(entryFacts(env).filter((line) => line.startsWith('actor ')), [
    'actor TideActor.OnRose (TideRose)',
    'actor TideActor.ReceiveAsync<TideFell> (TideFell)',
  ]);
  const group = onlyEntry(routesOf(env, 'TideGauge.Raise').report);
  assert.deepEqual([group.kind, group.method], ['actor', 'OnRose']);
  const lambda = onlyEntry(routesOf(env, 'TideGauge.Lower').report);
  assert.deepEqual([lambda.kind, lambda.method], ['actor', 'ReceiveAsync<TideFell>']);
  const ctorCalls = facts(env, 'harbor').filter((item) => item.type === 'method_call' && item.class === 'TideActor' && item.method === 'TideActor');
  assert.deepEqual(ctorCalls, []);
});

test('Backend entries AC-5: configured entry points give entries of their own kind', (t) => {
  const configured = corpus(t, ...HARBOR_ENTRIES).extract();
  const lines = entryFacts(configured);
  assert.ok(lines.includes('change-feed CargoAuditHandler.Handle'));
  assert.ok(lines.includes('relay SignalRelay.Transform'));
  const feed = onlyEntry(routesOf(configured, 'ManifestLog.Write').report);
  assert.deepEqual([feed.kind, feed.class, feed.method], ['change-feed', 'CargoAuditHandler', 'Handle']);
  const relay = onlyEntry(routesOf(configured, 'SignalWire.Forward').report);
  assert.deepEqual([relay.kind, relay.class, relay.method], ['relay', 'SignalRelay', 'Transform']);

  const plain = corpus(t, ...HARBOR).extract();
  assert.ok(entryFacts(plain).every((line) => !line.startsWith('change-feed') && !line.startsWith('relay')));
  assert.equal(routesOf(plain, 'ManifestLog.Write').report.verdict, 'empty');
});

test('Backend entries AC-6: a malformed entryPoints or backgroundCalls value is one refusal', (t) => {
  const env = corpus(t, ...HARBOR);
  const base = JSON.parse(readFileSync(join(env.dir, 'harbor.config.json'), 'utf8'));
  const run = (patch) => {
    writeFileSync(join(env.dir, 'bad.config.json'), JSON.stringify({ ...base, ...patch }));
    return runCli(['extract', '--config', 'bad.config.json'], { cwd: env.dir });
  };
  const reference = run({ workerPatterns: { consumerEntryMethods: ['Not a name'] } });
  assert.notEqual(reference.status, 0);
  const malformed = [
    {},
    'hub',
    [{ kind: 'hub', bases: ['Hub'], methods: ['Ping'] }],
    [{ kind: 'route', bases: ['X'], methods: ['Y'] }],
    [{ kind: 'actor', bases: ['X'], methods: ['Y'] }],
    [{ kind: 'Upper', bases: ['X'], methods: ['Y'] }],
    [{ kind: 'feed', bases: [], methods: ['Y'] }],
    [{ kind: 'feed', bases: ['X'], methods: [] }],
    [{ kind: 'feed', bases: ['X.Y<T>'], methods: ['Y'] }],
    [{ kind: 'feed', bases: ['X'], methods: ['Y'], extra: true }],
    [{ kind: 'feed', bases: ['X'] }],
    [null],
  ];
  for (const value of malformed) {
    const result = run({ entryPoints: value });
    assert.equal(result.status, reference.status, JSON.stringify(value));
    assert.equal(result.stderr.split('\n').filter((line) => line.includes('"entryPoints"')).length, 1, JSON.stringify(value));
  }
  assert.equal(run({ entryPoints: [{ kind: 'feed-2', bases: ['IFeed'], methods: ['Handle'] }] }).status, 0);
  assert.equal(run({ entryPoints: [] }).status, 0);

  const badQueue = run({ workerPatterns: { backgroundCalls: ['Not a name'] } });
  assert.equal(badQueue.status, reference.status);
  assert.match(badQueue.stderr, /"workerPatterns\.backgroundCalls" entry "Not a name" is not a method name/);
  assert.equal(run({ workerPatterns: { backgroundCalls: ['QueueWork'] } }).status, 0);
});

test('Backend entries AC-7: routes-of reports entries beside routes under schema version 2', (t) => {
  const env = corpus(t, ...HARBOR).extract();
  const both = routesOf(env, 'Lamp.Flash');
  assert.equal(both.status, 0);
  assert.equal(both.report.schemaVersion, 2);
  assert.equal(both.report.verdict, 'routes');
  assert.deepEqual(both.report.routes.map((route) => route.key), ['POST lamps/v1/flash']);
  assert.equal(both.report.entryCount, 1);
  const [entry] = both.report.entries;
  assert.deepEqual(Object.keys(entry).sort(), ['class', 'file', 'kind', 'line', 'method', 'repo', 'witness']);
  assert.deepEqual([entry.kind, entry.class, entry.method, entry.repo], ['hub', 'DockHub', 'Ping', 'harbor']);
  assert.deepEqual(Object.keys(entry.witness).sort(), ['additionalPaths', 'hops']);
  assert.equal(both.report.completeness.entriesWalked, 6);

  const only = routesOf(env, 'BerthLedger.Greet');
  assert.equal(only.status, 0);
  assert.equal(only.report.verdict, 'entries');
  assert.deepEqual(only.report.routes, []);

  const none = routesOf(env, 'BerthLedger.Sweep');
  assert.equal(none.report.verdict, 'empty');
  assert.deepEqual(none.report.entries, []);
  assert.equal(none.report.entryCount, 0);

  const stopped = routesOf(env, 'BerthLedger.Moor', ['--max-nodes', '2']);
  assert.equal(stopped.status, 4);
  assert.equal(stopped.report.verdict, 'incomplete');
  assert.ok(stopped.report.completeness.reasons.some((reason) => reason.key === 'hub DockHub.Moor'));

  const text = env.cli(['routes-of', 'Lamp.Flash', '--symbol']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^entries: 1 \(complete across 6 entries\)$/m);
  assert.match(text.stdout, /^hub entry DockHub\.Ping — harbor:src\/Hubs\/DockHub\.cs:\d+$/m);
});
