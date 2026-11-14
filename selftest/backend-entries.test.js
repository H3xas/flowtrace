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

const QUILL = ['quill-works', 'quill.config.json'];
const QUILL_QUEUE = ['quill-works', 'quill-queue.config.json'];

function viaEdges(report, via) {
  const byId = new Map(report.nodes.map((node) => [node.id, node]));
  return report.edges.filter((edge) => edge.via === via).map((edge) => ({ edge, from: byId.get(edge.from), to: byId.get(edge.to) }));
}

test('Backend entries AC-8: a mapper call reaches the converters, resolvers and actions its map names', (t) => {
  const env = corpus(t, ...QUILL).extract();
  const label = viaEdges(traceJson(env, 'POST inks/v1/label'), 'mapper').map((hop) => hop.to.ref);
  assert.deepEqual(label, ['BatchCodeConverter.Convert', 'TintResolver.Resolve', 'LabelStamp.Process']);
  const receipt = viaEdges(traceJson(env, 'POST inks/v1/receipt'), 'mapper').map((hop) => hop.to.ref);
  assert.deepEqual(receipt, ['InkReceiptConverter.Convert']);
  assert.deepEqual(viaEdges(traceJson(env, 'POST inks/v1/note'), 'mapper'), []);
  assert.ok(!facts(env, 'quill').some((item) => item.type === 'mapper_map' && item.target === 'NoteConverter'));

  const { status, report } = routesOf(env, 'InkReceiptConverter.Convert');
  assert.equal(status, 0);
  assert.equal(report.verdict, 'routes');
  assert.deepEqual(report.routes.map((route) => route.key), ['POST inks/v1/receipt']);
  assert.equal(report.routes[0].witness.hops.at(-1).via, 'mapper');
  assert.equal(routesOf(env, 'NoteConverter.Convert').report.verdict, 'empty');
});

test('Backend entries AC-9: work handed to a queue by its delegate shape hangs under one queue node', (t) => {
  const env = corpus(t, ...QUILL).extract();
  const expected = { fire: 'GlazeStore.Fire', cool: 'GlazeStore.Cool', seal: 'GlazeStore.Seal' };
  for (const [path, effect] of Object.entries(expected)) {
    const key = `POST glazes/v1/${path}`;
    const report = traceJson(env, key);
    const queues = report.nodes.filter((node) => node.kind === 'queue');
    assert.equal(queues.length, 1, key);
    assert.equal(queues[0].ref, 'IKilnQueue.QueueWork');
    const queued = viaEdges(report, 'queued');
    assert.ok(queued.length > 0 && queued.every((hop) => hop.from.kind === 'queue'), key);
    assert.ok(report.nodes.some((node) => node.ref === effect), key);
    assert.ok(!report.nodes.some((node) => node.ref === 'KilnQueue.QueueWork' || node.ref === 'KilnWorker.ExecuteAsync'), key);
    assert.ok(!report.status.frontier.some((entry) => entry.reason === 'provider-unavailable' && entry.target.endsWith('QueueWork')), key);
    assert.match(traceText(env, key), /IKilnQueue\.QueueWork .*\n.*\[queued\]/);
  }
  const { status, report } = routesOf(env, 'GlazeController.SealLater');
  assert.equal(status, 0);
  assert.deepEqual(report.routes.map((route) => route.key), ['POST glazes/v1/seal']);
  assert.ok(report.routes[0].witness.hops.some((hop) => hop.via === 'queued'));
});

test('Backend entries AC-10: a configured background call is a queue call, and without the key an ordinary call', (t) => {
  const configured = corpus(t, ...QUILL_QUEUE).extract();
  const report = traceJson(configured, 'POST glazes/v1/polish');
  assert.deepEqual(report.nodes.filter((node) => node.kind === 'queue').map((node) => node.ref), ['IGlazeScheduler.Schedule']);
  assert.ok(viaEdges(report, 'queued').some((hop) => hop.from.kind === 'queue'));
  assert.ok(facts(configured, 'quill').some((item) => item.type === 'queue_call' && item.calledMethod === 'Schedule' && item.rule === 'config'));

  const plain = corpus(t, ...QUILL).extract();
  const ordinary = traceJson(plain, 'POST glazes/v1/polish');
  assert.equal(ordinary.nodes.filter((node) => node.kind === 'queue').length, 0);
  assert.deepEqual(viaEdges(ordinary, 'queued'), []);
  assert.ok(facts(plain, 'quill').some((item) => item.type === 'method_call' && item.calledMethod === 'Schedule'));
});

test('Backend entries AC-11: each keyed collection read form reaches every implementation for a run-time key', (t) => {
  const env = corpus(t, ...QUILL).extract();
  const forms = facts(env, 'quill').filter((item) => item.type === 'keyed_call').map((item) => item.form).sort();
  assert.deepEqual(forms, ['indexer', 'local', 'try-get']);
  for (const key of ['POST finishes/v1/{kind}', 'POST finishes/v1/maybe/{kind}']) {
    const report = traceJson(env, key);
    const keyed = viaEdges(report, 'keyed_dispatch');
    assert.deepEqual(keyed.map((hop) => hop.to.ref), ['GlossFinisher.Apply', 'MatteFinisher.Apply', 'TunedFinisher.Apply'], key);
    assert.ok(keyed.every((hop) => hop.edge.inferred === true && hop.edge.key === 'kind'), key);
    assert.ok(report.status.evidence.inferred >= 3, key);
    assert.match(traceText(env, key), /\[keyed_dispatch\] {2}keyed kind \(inferred\)/);
  }
  assert.ok(!facts(env, 'quill').some((item) => item.type === 'method_call' && item.elementAccess && item.field === '_finishers'));
  const { status, report } = routesOf(env, 'GlossFinisher.Apply');
  assert.equal(status, 0);
  assert.deepEqual(report.routes.map((route) => route.key), ['POST finishes/v1/*', 'POST finishes/v1/maybe/*']);
});

test('Backend entries AC-12: a constant key keeps only the matching and the unreadable implementations', (t) => {
  const env = corpus(t, ...QUILL).extract();
  const properties = facts(env, 'quill').filter((item) => item.type === 'key_property').map((item) => `${item.class}=${item.value}`).sort();
  assert.deepEqual(properties, ['GlossFinisher=FinishKind.Gloss', 'MatteFinisher=FinishKind.Matte']);
  const constant = viaEdges(traceJson(env, 'POST finishes/v1/matte'), 'keyed_dispatch');
  assert.deepEqual(constant.map((hop) => hop.to.ref), ['MatteFinisher.Apply', 'TunedFinisher.Apply']);
  assert.ok(constant.every((hop) => hop.edge.key === 'FinishKind.Matte'));
  assert.equal(viaEdges(traceJson(env, 'POST finishes/v1/{kind}'), 'keyed_dispatch').length, 3);
  assert.deepEqual(routesOf(env, 'GlossFinisher.Apply').report.routes.map((route) => route.key).includes('POST finishes/v1/matte'), false);
});

function stepEdges(report) {
  return viaEdges(report, 'step').map((hop) => ({ ref: hop.to.ref, step: hop.to.step, conditional: hop.edge.conditional === true }));
}

test('Backend entries AC-13: a block stop resolves and each step reject runs the statements before its jump', (t) => {
  const env = corpus(t, ...QUILL).extract();
  const stop = facts(env, 'quill').find((item) => item.type === 'loop_stop' && item.class === 'SealPipeline');
  assert.equal(stop.form, 'bool-return');
  assert.equal(typeof stop.rejectFrom, 'number');
  assert.equal(stop.rejectTo, stop.rejectFrom);

  const report = traceJson(env, 'POST seals/v1/press');
  assert.equal(report.stats.pipelines.resolved, 1);
  const rejects = report.seeds.filter((seed) => seed.kind === 'reject');
  assert.equal(rejects.length, 2);
  for (const seed of rejects) {
    assert.deepEqual(seed.outcomes.map((item) => `${item.ref}.${item.method}`), ['ISealLedgerRepository.SaveRejected'], seed.key);
  }
  const [effect] = report.seeds.filter((seed) => seed.kind === 'effect');
  assert.deepEqual(effect.outcomes.map((item) => `${item.ref}.${item.method}`), ['ISealLedgerRepository.SaveSealed']);

  const byId = new Map(report.nodes.map((node) => [node.id, node]));
  const parentOf = new Map(report.edges.map((edge) => [edge.to, byId.get(edge.from)]));
  const audits = report.nodes.filter((node) => node.ref === 'SealPipeline.Audit');
  assert.ok(audits.length > 0);
  for (const audit of audits) {
    const block = parentOf.get(audit.id);
    assert.equal(block.ref, 'SealPipeline.Run');
    assert.equal(parentOf.get(block.id).kind, 'branch');
  }
  assert.match(traceText(env, 'POST seals/v1/press'), /before the reject: ■ db ISealLedgerRepository\.SaveRejected/);
});

test('Backend entries AC-14: every step after the first is conditional unless the loop never stops', (t) => {
  const quill = corpus(t, ...QUILL).extract();
  const bakery = corpus(t, 'bakery-orders', 'bakery.config.json').extract();
  const stopping = [
    [quill, 'POST seals/v1/press', 'bool-return block'],
    [bakery, 'POST bakery/v1/orders', 'flag-return'],
    [bakery, 'POST bakery/v1/orders/check', 'bool-return'],
    [bakery, 'DELETE bakery/v1/orders/{id}', 'flag-break'],
  ];
  for (const [env, key, form] of stopping) {
    const steps = stepEdges(traceJson(env, key));
    assert.ok(steps.length >= 2, form);
    assert.deepEqual(steps.map((step) => step.conditional), steps.map((step) => step.step > 1), form);
    assert.match(traceText(env, key), /\[step\] {2}step 2 · conditional/, form);
  }
  const sweep = stepEdges(traceJson(quill, 'POST seals/v1/sweep'));
  assert.equal(sweep.length, 2);
  assert.ok(sweep.every((step) => !step.conditional));
  assert.doesNotMatch(traceText(quill, 'POST seals/v1/sweep'), /conditional/);
});

test('Backend entries AC-15: an unreadable stop rule walks the steps in registration order and stays unresolved', (t) => {
  const env = corpus(t, ...QUILL).extract();
  const report = traceJson(env, 'POST seals/v1/twin');
  assert.deepEqual(stepEdges(report), [
    { ref: 'StampStep', step: 1, conditional: false },
    { ref: 'WaxStep', step: 2, conditional: true },
  ]);
  assert.equal(report.stats.pipelines.resolved, 0);
  assert.deepEqual(report.stats.pipelines.unresolved.map((item) => item.reason), ['stop-rule']);
  assert.ok(report.status.frontier.some((entry) => entry.reason === 'unresolved-pipeline' && entry.detail === 'stop-rule'));
  const stepRejects = report.nodes.filter(
    (node) => node.kind === 'branch' && node.branchKind === 'reject' && /^(StampStep|WaxStep)\./.test(node.ref),
  );
  assert.deepEqual(stepRejects, []);
  assert.match(traceText(env, 'POST seals/v1/twin'), /pipeline unresolved: stop-rule/);
});

const FERRY = ['ferry-gateway', 'ferry.config.json'];

test('Backend entries AC-16: gateway tables, handlers and middleware become facts', (t) => {
  const env = corpus(t, ...FERRY).extract();
  const all = facts(env, 'ferry');
  const routes = all.filter((item) => item.type === 'gateway_route');
  assert.deepEqual(
    routes.map((item) => [item.verb, item.template, item.downstreamVerb, item.downstreamTemplate, item.hosts, item.handlers, item.file]),
    [
      ['GET', '/boats/{id}', 'GET', '/api/boats/{id}', ['boats-api:8080'], ['TicketHandler'], 'src/ocelot.json'],
      ['POST', '/Cargo', 'POST', '/api/cargo', ['cargo-api:80'], ['GhostHandler'], 'src/ocelot.json'],
      ['PUT', '/Cargo', 'POST', '/api/cargo', ['cargo-api:80'], ['GhostHandler'], 'src/ocelot.json'],
      ['GET', '/harbor', 'GET', '/api/harbor', ['harbor-api'], [], 'src/ocelot.json'],
    ],
  );
  const source = readFileSync(join(env.dir, 'backend', 'src', 'ocelot.json'), 'utf8').split('\n');
  for (const route of routes) assert.match(source[route.line - 1], /"UpstreamPathTemplate"/);
  const tables = all.filter((item) => item.type === 'gateway_table');
  assert.deepEqual(tables.map((item) => [item.file, item.state]), [['src/ocelot.staging.json', 'unreadable']]);
  assert.ok(tables[0].reason.length > 0);
  assert.ok(!all.some((item) => item.file === 'src/appsettings.json'));
  assert.deepEqual(
    all.filter((item) => item.type === 'gateway_handler').map((item) => [item.handler, item.global]),
    [['TicketHandler', false], ['AuditHandler', true]],
  );
  assert.deepEqual(
    all.filter((item) => item.type === 'gateway_middleware').map((item) => [item.middleware, item.position]),
    [['TraceMiddleware', 1], ['ClockMiddleware', 2]],
  );
});

test('Backend entries AC-17: a stub route walks the gateway stages in order to the downstream call', (t) => {
  const env = corpus(t, ...FERRY).extract();
  const report = traceJson(env, 'GET boats/{boatId}');
  const [hop] = report.nodes.filter((node) => node.kind === 'gateway');
  assert.equal(hop.upstream, '/boats/{id}');
  assert.equal(hop.downstream, '/api/boats/{id}');
  const stages = report.edges.filter((edge) => edge.from === hop.id).map((edge) => report.nodes.find((node) => node.id === edge.to));
  assert.deepEqual(stages.map((node) => node.ref), [
    'TraceMiddleware.InvokeAsync',
    'ClockMiddleware.Invoke',
    'AuditHandler.SendAsync',
    'TicketHandler.SendAsync',
    'GET boats-api:8080/api/boats/*',
  ]);
  assert.equal(stages.at(-1).kind, 'http_out');
  assert.ok(report.seeds[0].outcomes.some((item) => item.kind === 'http_out'));
  assert.doesNotMatch(traceText(env, 'GET boats/{boatId}'), /no observable effect/);

  const cargo = traceJson(env, 'POST cargo');
  assert.ok(cargo.nodes.some((node) => node.ref === 'GhostHandler' && node.unresolved));
  assert.ok(cargo.status.frontier.some((entry) => entry.reason === 'unresolved-target' && entry.target === 'GhostHandler'));
  assert.notEqual(cargo.status.traversal, 'complete');

  const ping = traceJson(env, 'GET ping');
  assert.ok(!ping.nodes.some((node) => node.kind === 'gateway'));
  const harbor = env.cli(['trace', 'GET harbor', '--json']);
  assert.notEqual(harbor.status, 0);
});

const NEW_FACT_TYPES = new Set([
  'entry', 'mapper_map', 'mapper_call', 'queue_call', 'keyed_collection', 'keyed_call', 'key_property',
  'gateway_route', 'gateway_table', 'gateway_handler', 'gateway_middleware',
]);
const NEW_VIAS = new Set(['entry', 'mapper', 'queued', 'keyed_dispatch', 'gateway', 'gate']);

test('Backend entries AC-18: a corpus with none of the new shapes keeps its walk and answers under schema version 2', (t) => {
  const env = corpus(t, 'kiln-yard', 'kiln.config.json').extract();
  const backend = facts(env, 'backend');
  assert.ok(backend.length > 0);
  assert.deepEqual(backend.filter((item) => NEW_FACT_TYPES.has(item.type) || item.rejectFrom !== undefined), []);
  const report = traceJson(env, 'GET kiln/v1/kilns/{kilnId}/firings');
  assert.deepEqual(report.edges.filter((edge) => NEW_VIAS.has(edge.via) || edge.conditional || edge.inferred), []);
  assert.ok(!report.nodes.some((node) => node.kind === 'queue' || node.kind === 'gateway'));

  const answered = routesOf(env, 'FiringService.List');
  assert.equal(answered.status, 0);
  assert.equal(answered.report.schemaVersion, 2);
  assert.equal(answered.report.verdict, 'routes');
  assert.deepEqual(answered.report.routes.map((route) => route.key), ['GET kiln/v1/kilns/*/firings']);
  assert.deepEqual(answered.report.entries, []);
  assert.equal(answered.report.entryCount, 0);
  const empty = routesOf(env, 'Startup.AddKilnYard');
  assert.equal(empty.report.verdict, 'empty');
  assert.deepEqual(empty.report.entries, []);
});
