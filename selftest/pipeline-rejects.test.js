/**
 * The refusals a pipeline step, a sentinel return or a framework filter causes, each listed as
 * its own outcome with its status and site, over two invented corpora: `bakery-orders`
 * (pipelines and sentinels) and `bakery-gates` (authorization and action filters). Each test
 * runs the CLI the way a user does and reads `trace --seeds --json`, `cover --json`, `cover`
 * text and the `span` page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { copyFixture, runCli } from './helpers.js';
import { GOLDEN_CORPORA, captureSeedGoldens, readSeedGolden } from './seed-goldens.js';

const CONFIG = 'bakery.config.json';

function corpus(t, name) {
  const dir = copyFixture(t, name);
  const cli = (args) => runCli([...args, '--config', CONFIG], { cwd: dir });
  const extracted = cli(['extract']);
  assert.equal(extracted.status, 0, extracted.stderr);
  return { dir, cli };
}

function traceJson(env, key, extra = []) {
  const result = env.cli(['trace', key, '--seeds', '--json', ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function traceText(env, key, extra = []) {
  const result = env.cli(['trace', key, '--seeds', ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function coverRun(env, keys, extra = []) {
  writeFileSync(join(env.dir, 'area.txt'), `${keys.join('\n')}\n`);
  const json = env.cli(['cover', '--area', 'area.txt', '--json', ...extra]);
  assert.equal(json.status, 0, json.stderr);
  const text = env.cli(['cover', '--area', 'area.txt', ...extra]);
  assert.equal(text.status, 0, text.stderr);
  return { report: JSON.parse(json.stdout), text: text.stdout };
}

function spanRun(env, key, extra = []) {
  const result = env.cli(['span', key, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  const reconcile = /reconciles with cover: (\d+)\/(\d+) seeds/.exec(output);
  const target = /-> (\S+\.html)/.exec(output);
  assert.ok(reconcile && target, output);
  return {
    ledgerRows: Number(reconcile[1]),
    coverSeeds: Number(reconcile[2]),
    page: readFileSync(join(env.dir, target[1]), 'utf8'),
  };
}

const deciding = (seed) => seed.dispositions[seed.dispositions.length - 1];
const rejectsOf = (walked) => walked.seeds.filter((seed) => seed.kind !== 'effect');
const site = (entry) => `${entry.file}:${entry.line}`;

function sourceLine(dir, file, pattern) {
  const lines = readFileSync(join(dir, 'backend', file), 'utf8').split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  assert.ok(index >= 0, `${pattern} not found in ${file}`);
  return index + 1;
}

test('Pipeline rejects AC-1: a registered pipeline lists one more outcome per step that can reject, in step order', (t) => {
  const env = corpus(t, 'bakery-orders');
  const placed = traceJson(env, 'POST bakery/v1/orders');
  const control = traceJson(env, 'POST bakery/v1/orders/draft');
  assert.equal(placed.seeds.length, control.seeds.length + 2);

  const flagLine = sourceLine(env.dir, 'src/Steps/OrderSteps.cs', /order\.Valid = false;/);
  const throwLine = sourceLine(env.dir, 'src/Steps/OrderSteps.cs', /throw new OvenBusyException/);
  const flag = placed.seeds.find((seed) => deciding(seed).rejectForm === 'flag-write');
  const thrown = placed.seeds.find((seed) => deciding(seed).kind === 'error_return' && deciding(seed).disposition === 'taken');
  assert.ok(flag && thrown, JSON.stringify(placed.seeds.map(deciding)));
  assert.equal(site(deciding(flag)), `src/Steps/OrderSteps.cs:${flagLine}`);
  assert.equal(deciding(flag).class, 'CheckFlourStep');
  assert.equal(flag.response, '400 BadRequest');
  assert.equal(site(deciding(thrown)), `src/Steps/OrderSteps.cs:${throwLine}`);
  assert.equal(deciding(thrown).class, 'ReserveOvenStep');
  assert.match(thrown.response, /OvenBusyException/);

  const steps = placed.seeds.flatMap((seed) => seed.dispositions.map((entry) => entry.class));
  assert.ok(!steps.includes('StampTicketStep'), 'a step that cannot reject adds no seed and no decision');
  assert.deepEqual(
    flag.dispositions.map((entry) => entry.class),
    ['CheckFlourStep'],
    'a reject in the first step carries no disposition of a later step',
  );

  const { report } = coverRun(env, ['POST bakery/v1/orders']);
  assert.deepEqual(
    report.routes[0].seeds.map((seed) => seed.key),
    placed.seeds.map((seed) => seed.key),
  );
  const page = spanRun(env, 'POST bakery/v1/orders');
  assert.equal(page.ledgerRows, page.coverSeeds);
  assert.equal(page.coverSeeds, placed.seeds.length);
  assert.ok(page.page.includes(`src/Steps/OrderSteps.cs:${flagLine}`), 'the span page names the flag write');
  assert.ok(page.page.includes(`src/Steps/OrderSteps.cs:${throwLine}`), 'the span page names the throw');
});

test('Pipeline rejects AC-2: a sentinel answers the status the action gives it, or is listed unmapped', (t) => {
  const env = corpus(t, 'bakery-orders');
  const mapLine = sourceLine(env.dir, 'src/Controllers/OrdersController.cs', /placed is not null \? Ok\(placed\) : BadRequest\(\)/);
  const placed = traceJson(env, 'POST bakery/v1/orders');
  const flag = placed.seeds.find((seed) => deciding(seed).rejectForm === 'flag-write');
  assert.equal(flag.response, '400 BadRequest');
  assert.deepEqual(flag.statusVia, { file: 'src/Controllers/OrdersController.cs', line: mapLine });

  const approved = traceJson(env, 'POST bakery/v1/tastings');
  const sentinel = rejectsOf(approved);
  assert.equal(sentinel.length, 1);
  assert.equal(deciding(sentinel[0]).rejectForm, 'sentinel');
  assert.equal(sentinel[0].response, '403 Forbidden');

  const preview = traceJson(env, 'POST bakery/v1/tastings/preview');
  const unmapped = rejectsOf(preview);
  assert.equal(unmapped.length, 1, 'an outcome the action answers outside the envelope is still listed');
  assert.equal(unmapped[0].response, null);
  assert.equal(unmapped[0].statusReason, 'status-unmapped');
  const { report } = coverRun(env, ['POST bakery/v1/tastings/preview']);
  assert.equal(report.routes[0].seeds.find((seed) => seed.key === unmapped[0].key).statusReason, 'status-unmapped');
  assert.match(spanRun(env, 'POST bakery/v1/tastings/preview').page, /status-unmapped/);
});

test('Pipeline rejects AC-3: first-allow, step-result and check-before loops give their own outcomes', (t) => {
  const env = corpus(t, 'bakery-orders');
  const cancel = traceJson(env, 'DELETE bakery/v1/orders/*');
  const grants = rejectsOf(cancel);
  assert.equal(grants.length, 1, 'one outcome: no step grants access');
  assert.equal(deciding(grants[0]).rejectForm, 'no-grant');
  assert.equal(deciding(grants[0]).class, 'GrantPipeline');
  assert.equal(grants[0].response, '403 Forbidden');

  const checked = traceJson(env, 'POST bakery/v1/orders/check');
  const falses = rejectsOf(checked);
  assert.deepEqual(
    falses.map((seed) => [deciding(seed).class, deciding(seed).rejectForm, seed.response]),
    [
      ['FlourCheck', 'bool-false', '400 BadRequest'],
      ['SugarCheck', 'bool-false', '400 BadRequest'],
    ],
  );

  const outcomes = (walked) => rejectsOf(walked).map((seed) => [deciding(seed).class, deciding(seed).kind, seed.response]);
  assert.deepEqual(outcomes(traceJson(env, 'POST bakery/v1/orders/precheck')), outcomes(traceJson(env, 'POST bakery/v1/orders')));
});

test('Pipeline rejects AC-4: typeof lists, injected enumerables and long resolved lists walk in source order', (t) => {
  const env = corpus(t, 'bakery-orders');
  const glazed = traceJson(env, 'POST bakery/v1/glazes');
  assert.deepEqual(rejectsOf(glazed).map((seed) => deciding(seed).class), ['ZestStep', 'AlmondStep']);
  const glazeList = glazed.nodes.find((node) => node.composition);
  assert.equal(glazeList.composition.source, 'typeof-list');

  const sprinkled = traceJson(env, 'POST bakery/v1/glazes/sprinkles');
  assert.deepEqual(rejectsOf(sprinkled).map((seed) => deciding(seed).class), ['WalnutStep', 'CocoaStep']);
  assert.equal(sprinkled.nodes.find((node) => node.composition).composition.source, 'enumerable');

  const layered = traceJson(env, 'POST bakery/v1/orders/layers');
  assert.equal(layered.nodes.find((node) => node.composition).composition.steps.length, 17);
  assert.deepEqual(rejectsOf(layered).map((seed) => deciding(seed).class), ['CakeLayer17Step']);
});

test('Pipeline rejects AC-5: a composition the walk cannot read is reported unresolved, with its reason, everywhere', (t) => {
  const env = corpus(t, 'bakery-orders');
  const cases = [
    { key: 'POST bakery/v1/glazes/frostings', reason: 'step-expression', extra: [] },
    { key: 'POST bakery/v1/glazes/crumbs', reason: 'registration-order', extra: [] },
    { key: 'POST bakery/v1/orders/layers', reason: 'node-budget', extra: ['--max-nodes', '20'] },
  ];
  for (const { key, reason, extra } of cases) {
    const walked = traceJson(env, key, extra);
    assert.deepEqual(walked.stats.pipelines.unresolved.map((entry) => entry.reason), [reason], key);
    assert.equal(rejectsOf(walked).length, 0, `${key}: an unresolved pipeline adds no step seed`);
    assert.ok(walked.nodes.some((node) => node.composition && node.composition.reason === reason), key);
    assert.ok(walked.edges.some((edge) => edge.via === 'interface_fanout'), `${key}: the tree keeps the fan-out`);
    assert.match(traceText(env, key, extra), new RegExp(`unresolved: ${reason}`), key);
    const { report, text } = coverRun(env, [key], extra);
    assert.equal(report.routes[0].pipelines.unresolved[0].reason, reason, key);
    assert.equal(report.totals.unresolvedPipelines, 1, key);
    assert.match(text, new RegExp(`unresolved: ${reason}`), key);
    assert.match(spanRun(env, key, extra).page, new RegExp(reason), key);
  }
  const crumbs = traceJson(env, 'POST bakery/v1/glazes/crumbs');
  assert.deepEqual(
    crumbs.nodes.filter((node) => node.via === 'interface_fanout').map((node) => node.ref),
    ['ButterCrumbStep', 'OatCrumbStep'],
    'an unresolved pipeline keeps the name-sorted fan-out',
  );
});

test('Pipeline rejects AC-6: a step with two overloads contributes only the one its loop calls', (t) => {
  const env = corpus(t, 'bakery-orders');
  const filled = traceJson(env, 'POST bakery/v1/glazes/fillings');
  const fillLine = sourceLine(env.dir, 'src/Steps/GlazeSteps.cs', /order\.Flavour == "empty"/);
  assert.deepEqual(rejectsOf(filled).map((seed) => site(deciding(seed))), [`src/Steps/GlazeSteps.cs:${fillLine}`]);
  assert.ok(
    !filled.seeds.some((seed) => /CrustCrackedException/.test(seed.response || '')),
    'the other overload\'s throw is not read',
  );

  const topped = traceJson(env, 'POST bakery/v1/glazes/toppings');
  assert.deepEqual(topped.stats.pipelines.unresolved.map((entry) => [entry.reason, entry.step]), [['overload', 'GlazeAndFillStep']]);
  assert.equal(rejectsOf(topped).length, 0);
});

test('Pipeline rejects AC-7: authorization and action filters give one outcome per result they set', (t) => {
  const env = corpus(t, 'bakery-gates');
  const unauthorized = sourceLine(env.dir, 'src/Filters/KitchenAccessFilter.cs', /Status401Unauthorized/);
  const forbidden = sourceLine(env.dir, 'src/Filters/KitchenAccessFilter.cs', /new ForbidResult/);
  const crust = sourceLine(env.dir, 'src/Filters/CrustCheckAttribute.cs', /BadRequestObjectResult/);
  const gated = (walked) =>
    walked.seeds.filter((seed) => seed.gate).map((seed) => [seed.gate.filter, seed.gate.scope, site(deciding(seed)), seed.response]);
  const kitchen = [
    ['KitchenAccessFilter', 'global', `src/Filters/KitchenAccessFilter.cs:${unauthorized}`, '401 Unauthorized'],
    ['KitchenAccessFilter', 'global', `src/Filters/KitchenAccessFilter.cs:${forbidden}`, '403 Forbidden'],
  ];
  const crustOn = (scope) => ['CrustCheck', scope, `src/Filters/CrustCheckAttribute.cs:${crust}`, '400 BadRequest'];
  assert.deepEqual(gated(traceJson(env, 'POST pies/v1/bake')), [...kitchen, crustOn('action')]);
  assert.deepEqual(gated(traceJson(env, 'POST tarts/v1/bake')), [...kitchen, crustOn('controller')]);
  assert.deepEqual(gated(traceJson(env, 'POST eclairs/v1/bake')), [...kitchen, crustOn('controller')]);

  const menu = traceJson(env, 'GET pies/v1/menu');
  assert.deepEqual(gated(menu), [], 'an action that carries the exemption attribute gets no outcome from that filter');
  assert.equal(menu.stats.gates[0].exempt, 'OpenKitchen');
  for (const key of ['POST pies/v1/bake', 'GET pies/v1/menu', 'POST tarts/v1/bake', 'POST eclairs/v1/bake']) {
    assert.ok(
      !traceJson(env, key).seeds.some((seed) => seed.dispositions.some((entry) => entry.class === 'OvenFaultFilter')),
      `${key}: an exception filter is never read as a reject`,
    );
  }
});

test('Pipeline rejects AC-8: shared-gate seeds are marked and counted apart, and never multiply the route', (t) => {
  const env = corpus(t, 'bakery-gates');
  const key = 'POST pies/v1/bake';
  const walked = traceJson(env, key);
  const shared = walked.seeds.filter((seed) => seed.gate && seed.gate.shared);
  assert.equal(shared.length, 2);
  assert.match(traceText(env, key), /\[shared gate KitchenAccessFilter\]/);

  const { report, text } = coverRun(env, [key, 'POST tarts/v1/bake']);
  const record = report.routes[0];
  assert.deepEqual(record.seeds.filter((seed) => seed.gate && seed.gate.shared).map((seed) => seed.key), shared.map((seed) => seed.key));
  assert.equal(record.sharedGateSeeds, 2);
  assert.equal(report.totals.sharedGateSeeds, 4);
  assert.match(report.headline, /4 shared-gate/);
  assert.match(text, /4 shared-gate/);
  const page = spanRun(env, key);
  assert.equal(page.ledgerRows, page.coverSeeds);
  assert.match(page.page, /shared gate · KitchenAccessFilter/);

  const ungated = copyFixture(t, 'bakery-gates');
  const startup = join(ungated, 'backend', 'src', 'Startup.cs');
  writeFileSync(startup, readFileSync(startup, 'utf8').replace(/^.*typeof\(KitchenAccessFilter\).*\n/m, ''));
  const plain = { dir: ungated, cli: (args) => runCli([...args, '--config', CONFIG], { cwd: ungated }) };
  assert.equal(plain.cli(['extract']).status, 0);
  const own = (seeds) => seeds.filter((seed) => !seed.gate || !seed.gate.shared).map((seed) => seed.key);
  assert.deepEqual(own(walked.seeds), own(traceJson(plain, key).seeds), 'the global filter\'s toggle leaves the route\'s own seeds alone');
});

test('Pipeline rejects AC-9: every existing corpus keeps its seed keys, and one with no new shape its bytes', () => {
  for (const corpusEntry of GOLDEN_CORPORA) {
    const golden = readSeedGolden(corpusEntry.name);
    const now = captureSeedGoldens(corpusEntry);
    assert.deepEqual(now.keys, golden.keys, corpusEntry.name);
    for (const key of golden.keys) {
      const printed = new Set(JSON.parse(now.trace[key]).seeds.map((seed) => seed.key));
      for (const seed of JSON.parse(golden.trace[key]).seeds) {
        assert.ok(printed.has(seed.key), `${corpusEntry.name} ${key}: seed ${seed.key} is still printed`);
      }
    }
    const coverKeys = (text) => JSON.parse(text).routes.flatMap((route) => route.seeds.map((seed) => `${route.key}#${seed.key}`));
    const printedCover = new Set(coverKeys(now.cover));
    for (const seed of coverKeys(golden.cover)) assert.ok(printedCover.has(seed), `${corpusEntry.name} cover: ${seed}`);
    if (corpusEntry.name === 'demo-shop') continue;
    for (const key of golden.keys) assert.equal(now.trace[key], golden.trace[key], `${corpusEntry.name} ${key}: byte-identical`);
    assert.equal(now.cover, golden.cover, `${corpusEntry.name} cover: byte-identical`);
  }
});
