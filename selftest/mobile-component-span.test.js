/**
 * Mobile component span: `span --from-component` over an Ionic page. Each template call
 * binding and each listed lifecycle hook is an entry with its own arms, a request no entry
 * reaches prints once without one, and mobile `trace` output stays as the goldens beside
 * the fixture record it.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';

const FIXTURE = join(REPO_ROOT, 'selftest', 'corpus', 'nursery-mobile');
const PAGE_TS = 'src/app/features/plots/plot-detail.page.ts';
const SERVICE_TS = 'src/app/features/plots/plot.service.ts';
const BASE_REASONS = new Set([
  'no-route-match',
  'template-not-resolved',
  'no-effect',
  'walk-limit',
  'entry-unresolved',
  'component-ambiguous',
  'component-unresolved',
]);
let pack = '';
let config = '';
let base = null;

before(() => {
  pack = mkdtempSync(join(tmpdir(), 'flowtrace-mobile-span-'));
  cpSync(FIXTURE, pack, { recursive: true });
  config = join(pack, 'nursery.config.json');
  const extracted = runCli(['extract', '--config', config], { cwd: pack });
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = runCli(['join', '--config', config], { cwd: pack });
  assert.equal(joined.status, 0, joined.stderr);
  base = spanJson('PlotDetailPage').model;
});

after(() => {
  rmSync(pack, { recursive: true, force: true });
});

function mobileFacts() {
  return JSON.parse(readFileSync(join(pack, 'out', 'facts', 'mobile.json'), 'utf8')).facts;
}

function spanJson(name, extra = [], configPath = config) {
  const result = runCli(['span', '--from-component', name, '--json', '--config', configPath, ...extra], { cwd: pack });
  return { ...result, model: result.status === 0 ? JSON.parse(result.stdout) : null };
}

function expectedCounts() {
  const readme = readFileSync(join(FIXTURE, 'README.md'), 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(readme);
  assert.ok(block, 'the fixture README holds one json block of header counts');
  return JSON.parse(block[1]);
}

function entryNamed(model, handlerOrTrigger) {
  const found = model.entries.filter(
    (view) => view.identity.handler === handlerOrTrigger || view.identity.trigger === handlerOrTrigger,
  );
  assert.equal(found.length, 1, `exactly one entry is ${handlerOrTrigger}`);
  return found[0];
}

function allArms(model) {
  return [...model.routes.flatMap((route) => route.arms.map((arm) => ({ ...arm, key: route.key }))), ...model.unresolved];
}

test('Mobile component span AC-1: a mobile page start exits 0 and names its repository, kind, file and line', () => {
  const run = spanJson('PlotDetailPage');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.model.component, { name: 'PlotDetailPage', repo: 'mobile', kind: 'page', file: PAGE_TS, line: 6 });
  assert.doesNotMatch(run.stderr, /refused|web kind only/i);
});

test('Mobile component span AC-1: a rendered child and an injected service start as a component and a service', () => {
  const child = spanJson('SeedlingBadgeComponent');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.model.component.kind, 'component');
  assert.equal(child.model.component.file, 'src/app/features/plots/seedling-badge.component.ts');
  const service = spanJson('PlotService');
  assert.equal(service.status, 0, service.stderr);
  assert.equal(service.model.component.kind, 'service');
  assert.equal(service.model.component.file, SERVICE_TS);
});

test('Mobile component span AC-1: without --json the page is written, worded for template bindings and hooks', () => {
  const out = join(pack, 'pages', 'plot-detail.html');
  const run = runCli(['span', '--from-component', 'PlotDetailPage', '--out', out, '--config', config], { cwd: pack });
  assert.equal(run.status, 0, run.stderr);
  const page = readFileSync(out, 'utf8');
  assert.match(page, /<h2>Entries \(13\)<\/h2>/);
  assert.match(page, /template event binding/);
  assert.doesNotMatch(page, /JSX/);
});

test('Mobile component span AC-1: a start in a repository that is neither web nor mobile exits 2 naming both kinds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-mobile-span-other-'));
  try {
    cpSync(pack, dir, { recursive: true });
    const otherConfig = join(dir, 'nursery.config.json');
    const parsed = JSON.parse(readFileSync(otherConfig, 'utf8'));
    parsed.repos.push({ id: 'shapes', kind: 'contracts', root: 'shapes' });
    writeFileSync(otherConfig, JSON.stringify(parsed, null, 2));
    mkdirSync(join(dir, 'shapes'));
    const { facts, ...header } = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'mobile.json'), 'utf8'));
    const shapes = [{ type: 'component', file: 'src/tray.ts', line: 1, name: 'TrayPanel', selector: '', role: 'component' }];
    writeFileSync(
      join(dir, 'out', 'facts', 'shapes.json'),
      JSON.stringify({ ...header, repo: 'shapes', kind: 'contracts', facts: shapes }),
    );
    const run = runCli(['span', '--from-component', 'TrayPanel', '--json', '--config', otherConfig], { cwd: dir });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /"contracts"-kind repository, not web or mobile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Mobile component span AC-2: each template call binding is one event entry spelled as a web event entry', () => {
  const bindings = mobileFacts().filter((fact) => fact.type === 'template_handler' && fact.component === 'PlotDetailPage');
  const calls = bindings.filter((fact) => fact.kind === 'call');
  const events = base.entries.map((view) => view.identity).filter((identity) => identity.component === 'PlotDetailPage' && identity.kind === 'event');
  assert.deepEqual(
    events.map((identity) => identity.id).sort(),
    calls.map((fact) => `PlotDetailPage:event:${fact.event}:${fact.handler}:@${fact.file}:${fact.line}`).sort(),
  );
  for (const identity of events) {
    const fact = calls.find((candidate) => candidate.handler === identity.handler);
    assert.deepEqual(identity, {
      id: identity.id,
      component: 'PlotDetailPage',
      kind: 'event',
      trigger: fact.event,
      handler: fact.handler,
      guards: [],
      file: fact.file,
      line: fact.line,
    });
  }
  assert.ok(bindings.some((fact) => fact.kind === 'assign'), 'the fixture states an assign binding');
  assert.ok(!base.entries.some((view) => view.identity.handler === 'draft'), 'an assign binding is no entry');
});

test('Mobile component span AC-2: three handlers calling three methods of one service each keep their own arms', () => {
  assert.deepEqual(entryNamed(base, 'onRefresh').routes, ['GET nursery/v1/plots/*/seedlings']);
  assert.deepEqual(entryNamed(base, 'onWater').routes, ['POST nursery/v1/plots/*/water']);
  assert.deepEqual(entryNamed(base, 'onRelabel').routes, ['PUT nursery/v1/plots/*/label']);
  for (const handler of ['onRefresh', 'onWater', 'onRelabel']) assert.equal(entryNamed(base, handler).arms, 1);
});

test('Mobile component span AC-2: a gateway call inside pipe(mergeMap(...)) resolves to its route with a span section', () => {
  const refresh = entryNamed(base, 'onRefresh').identity;
  const route = base.routes.find((entry) => entry.key === 'GET nursery/v1/plots/*/seedlings');
  assert.ok(route, 'the seedlings route is resolved');
  assert.deepEqual(
    route.arms.map((arm) => [arm.entry, arm.file, arm.line]),
    [[refresh.id, SERVICE_TS, 11]],
  );
  const out = join(pack, 'pages', 'plot-detail-refresh.html');
  const run = runCli(['span', '--from-component', 'PlotDetailPage', '--out', out, '--config', config], { cwd: pack });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(out, 'utf8'), /<span class="route-key">GET nursery\/v1\/plots\/\*\/seedlings<\/span>/);
});

test('Mobile component span AC-2: a handler reaching two methods of one service lists both requests', () => {
  const tend = entryNamed(base, 'onTend');
  assert.deepEqual(tend.routes, ['POST nursery/v1/plots/*/water', 'PUT nursery/v1/plots/*/label']);
  assert.equal(tend.arms, 2);
});

test("Mobile component span AC-2: a rendered child's entries carry the child's own name", () => {
  const mark = entryNamed(base, 'onMark');
  assert.equal(mark.identity.component, 'SeedlingBadgeComponent');
  assert.equal(mark.identity.id, 'SeedlingBadgeComponent:event:click:onMark:@src/app/features/plots/seedling-badge.component.html:1');
  assert.deepEqual(mark.routes, ['POST nursery/v1/plots/*/health']);
});

test('Mobile component span AC-3: each listed lifecycle hook the class declares is one entry at its method_span site', () => {
  const spans = mobileFacts().filter((fact) => fact.type === 'method_span' && fact.class === 'PlotDetailPage');
  const hooks = base.entries.map((view) => view.identity).filter((identity) => identity.kind !== 'event');
  const expected = [
    ['ngOnInit', 'mount'],
    ['ngOnChanges', 'update'],
    ['ngOnDestroy', 'unmount'],
  ].map(([trigger, kind]) => {
    const span = spans.find((fact) => fact.method === trigger);
    return {
      id: `PlotDetailPage:${kind}:${trigger}:@${span.file}:${span.line}`,
      component: 'PlotDetailPage',
      kind,
      trigger,
      handler: null,
      guards: [],
      file: span.file,
      line: span.line,
    };
  });
  assert.deepEqual(
    hooks.slice().sort((a, b) => a.line - b.line),
    expected.sort((a, b) => a.line - b.line),
  );
  assert.ok(spans.some((fact) => fact.method === 'ionViewCanLeave'), 'the fixture declares a hook outside the list');
  assert.ok(!base.entries.some((view) => view.identity.trigger === 'ionViewCanLeave'), 'a hook outside the list is no entry');
});

test('Mobile component span AC-3: a request only ngOnInit reaches is attributed to the ngOnInit entry alone', () => {
  const init = entryNamed(base, 'ngOnInit');
  const route = base.routes.find((entry) => entry.key === 'GET nursery/v1/plots/*/summary');
  assert.deepEqual(route.arms.map((arm) => arm.entry), [init.identity.id]);
  assert.deepEqual(init.routes, ['GET nursery/v1/plots/*/summary']);
  assert.ok(!base.orphans.routes.includes('GET nursery/v1/plots/*/summary'));
});

test('Mobile component span AC-4: a request no entry reaches prints once as an arm without entry', () => {
  const route = base.routes.find((entry) => entry.key === 'GET nursery/v1/plots/*/history');
  assert.deepEqual(route.arms.map((arm) => [arm.entry, arm.file, arm.line]), [[null, SERVICE_TS, 35]]);
  assert.deepEqual(base.orphans, { routes: ['GET nursery/v1/plots/*/history'], arms: 1 });
});

test('Mobile component span AC-4: a request an entry reaches is never counted again as an arm without entry', () => {
  const arms = allArms(base);
  const site = (arm) => (arm.reason ? `${arm.reason}|${arm.attempted}` : arm.key) + `|${arm.file}:${arm.line}`;
  const reached = new Set(arms.filter((arm) => arm.entry !== null).map(site));
  const orphans = arms.filter((arm) => arm.entry === null);
  assert.equal(orphans.length, 1);
  for (const arm of orphans) assert.ok(!reached.has(site(arm)), `${site(arm)} is reached by an entry`);
  const seedlings = base.routes.find((entry) => entry.key === 'GET nursery/v1/plots/*/seedlings');
  assert.equal(seedlings.arms.length, 1, 'reloadAll adds no second seedlings arm');
});

test('Mobile component span AC-4: the header counts equal the fixture README', () => {
  for (const [run, counts] of Object.entries(expectedCounts())) {
    const [name, ...flags] = run.split(' ');
    const result = spanJson(name, flags);
    assert.equal(result.status, 0, `${run}: ${result.stderr}`);
    assert.deepEqual(result.model.header, counts, run);
  }
});

test('Mobile component span AC-5: no-route-match, template-not-resolved and no-effect each print under their entry', () => {
  const byReason = new Map(base.unresolved.map((arm) => [arm.reason, arm]));
  assert.deepEqual([...byReason.keys()].sort(), ['no-effect', 'no-route-match', 'template-not-resolved']);
  assert.equal(byReason.get('no-route-match').entry, entryNamed(base, 'onExport').identity.id);
  assert.equal(byReason.get('no-route-match').attempted, 'GET nursery/v1/plots/*/export');
  assert.equal(byReason.get('template-not-resolved').entry, entryNamed(base, 'onShareWatchers').identity.id);
  assert.equal(byReason.get('no-effect').entry, entryNamed(base, 'onPin').identity.id);
  assert.equal(byReason.get('no-effect').attempted, 'pinPlot');
});

test('Mobile component span AC-5: a depth cut prints walk-limit at a store action and at a method node, under the entry', () => {
  const run = spanJson('PlotDetailPage', ['--depth', '2']);
  assert.equal(run.status, 0, run.stderr);
  const limits = run.model.unresolved.filter((arm) => arm.reason === 'walk-limit');
  const at = (attempted) => limits.find((arm) => arm.attempted === attempted && arm.entry !== null);
  const action = at('syncPlot');
  assert.ok(action, 'the syncPlot store action is a walk-limit arm');
  assert.equal(action.entry, entryNamed(run.model, 'onSync').identity.id);
  assert.equal(action.breadcrumb.at(-1).kind, 'store_action');
  const method = at('PlotService.waterPlot');
  assert.ok(method, 'the waterPlot method is a walk-limit arm');
  assert.equal(method.breadcrumb.at(-1).kind, 'method');
  assert.ok(
    [entryNamed(run.model, 'onWater').identity.id, entryNamed(run.model, 'onTend').identity.id].includes(method.entry),
  );
  for (const arm of run.model.unresolved) assert.ok(BASE_REASONS.has(arm.reason), arm.reason);
});

test('Mobile component span AC-5: a handler whose service method holds only a two-line gateway call reaches no route', () => {
  assert.ok(
    !mobileFacts().some((fact) => fact.type === 'gateway_call' && fact.method === 'addNote'),
    'the two-line call states no gateway_call fact',
  );
  const note = entryNamed(base, 'onNote');
  assert.deepEqual([note.routes, note.arms, note.unresolved], [[], 0, 0]);
  for (const arm of base.unresolved) assert.ok(BASE_REASONS.has(arm.reason), arm.reason);
});

test('Mobile component span AC-6: --entry narrows to one entry by handler, trigger, trigger@line or full id', () => {
  const water = entryNamed(base, 'onWater').identity;
  assert.equal(water.line, 6);
  const cases = [
    ['onTend', entryNamed(base, 'onTend').identity],
    ['ngOnInit', entryNamed(base, 'ngOnInit').identity],
    ['click@6', water],
    [entryNamed(base, 'onRefresh').identity.id, entryNamed(base, 'onRefresh').identity],
  ];
  for (const [selector, identity] of cases) {
    const run = spanJson('PlotDetailPage', ['--entry', selector]);
    assert.equal(run.status, 0, `${selector}: ${run.stderr}`);
    assert.deepEqual(run.model.selectedEntry, identity, selector);
    assert.deepEqual(run.model.entries.map((view) => view.identity.id), [identity.id], selector);
    for (const arm of allArms(run.model)) assert.equal(arm.entry, identity.id, selector);
  }
});

test('Mobile component span AC-6: --entry click matches several entries, exits 2 and lists every entry', () => {
  const run = spanJson('PlotDetailPage', ['--entry', 'click']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /"click" matches 10 entries, not exactly one/);
  for (const view of base.entries) assert.ok(run.stderr.includes(view.identity.id), view.identity.id);
});

test('Mobile component span AC-6: --file picks one of two mobile declarations of one name', () => {
  const ambiguous = spanJson('ArchiveListPage');
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /is declared in 2 files/);
  assert.match(ambiguous.stderr, /src\/app\/features\/archive\/archive-list\.page\.ts:3/);
  assert.match(ambiguous.stderr, /src\/app\/features\/legacy\/archive-list\.page\.ts:3/);
  const picked = spanJson('ArchiveListPage', ['--file', 'legacy']);
  assert.equal(picked.status, 0, picked.stderr);
  assert.equal(picked.model.component.file, 'src/app/features/legacy/archive-list.page.ts');
  assert.deepEqual(
    picked.model.entries.map((view) => view.identity.id),
    ['ArchiveListPage:unmount:ngOnDestroy:@src/app/features/legacy/archive-list.page.ts:8'],
  );
});

test('Mobile component span AC-7: mobile trace output equals the goldens captured before the change', () => {
  const golden = (file) => JSON.parse(readFileSync(join(FIXTURE, file), 'utf8'));
  const plain = runCli(['trace', 'PlotDetailPage', '--json', '--config', config], { cwd: pack });
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout), golden('trace-plot-detail.golden.json'));
  const handler = runCli(['trace', 'PlotDetailPage', '--from-handler', 'onSync', '--json', '--config', config], { cwd: pack });
  assert.equal(handler.status, 0, handler.stderr);
  assert.deepEqual(JSON.parse(handler.stdout), golden('trace-plot-detail-from-handler.golden.json'));
});
