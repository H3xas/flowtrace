/**
 * Mobile sites and starts: each template site of a handler is its own trace node and its own
 * `--from-handler` choice, a gateway call keeps its request when it is written over several
 * lines, undecorated and base classes are mobile declarations with static calls and inherited
 * lifecycle hooks, plain helpers are qualified starts, chains keep the declaration a template
 * owner proves, and the component span JSON is one contract for web and mobile.
 *
 * Every new source shape lives in a disposable copy of a committed corpus, so the committed
 * corpus outputs stay as they are.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';

const CORPUS = join(REPO_ROOT, 'selftest', 'corpus');
const made = [];

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A disposable copy of one corpus with files written, rewritten or removed, then extracted and
 * joined. `files` maps a path under the corpus to its new text, or to a function of the old.
 */
function pack(corpus, configName, files = {}, { remove = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-sites-starts-'));
  made.push(dir);
  cpSync(join(CORPUS, corpus), dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof text === 'function' ? text(readFileSync(target, 'utf8')) : text);
  }
  for (const file of remove) unlinkSync(join(dir, file));
  const config = join(dir, configName);
  for (const verb of ['extract', 'join']) {
    const result = runCli([verb, '--config', config], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
  }
  const cli = (args) => runCli([...args, '--config', config], { cwd: dir });
  const facts = (repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
  const json = (args) => {
    const result = cli([...args, '--json']);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { dir, config, cli, facts, json };
}

function nursery(files, options) {
  return pack('nursery-mobile', 'nursery.config.json', files, options);
}

const PLOT_SERVICE = 'mobile/src/app/features/plots/plot.service.ts';

function entryOf(model, handlerOrTrigger) {
  const found = model.entries.filter(
    (view) => view.identity.handler === handlerOrTrigger || view.identity.trigger === handlerOrTrigger,
  );
  assert.equal(found.length, 1, `exactly one entry is ${handlerOrTrigger}`);
  return found[0];
}

test('Mobile sites and starts AC-3: a gateway call split by spaces, line breaks, comments and type arguments states one fact at the line of this', () => {
  const split = [
    '  splitNote(plotId: string) {',
    '    return this /* shared */ .',
    '      gateway // the one gateway',
    '      .post<{ id: string }>(`nursery/v1/plots/${plotId}/notes`, {});',
    '  }',
    '',
    '  oneLineNote(plotId: string) {',
    '    return this.gateway.post<{ id: string }>(`nursery/v1/plots/${plotId}/notes`, {});',
    '  }',
    '',
    '  notGateway(plotId: string) {',
    '    return this.helper',
    '      .post(`nursery/v1/plots/${plotId}/notes`, {});',
    '  }',
    '',
  ].join('\n');
  const variant = nursery({
    [PLOT_SERVICE]: (text) =>
      text
        .replace('constructor(private gateway: GatewayService) {}', 'constructor(private gateway: GatewayService, private helper: NoteHelper) {}')
        .replace('  exportPlot(plotId: string) {', `${split}  exportPlot(plotId: string) {`),
  });
  const calls = variant.facts('mobile').filter((fact) => fact.type === 'gateway_call');
  const source = readFileSync(join(variant.dir, PLOT_SERVICE), 'utf8').split('\n');
  const lineOf = (text) => source.findIndex((line) => line.includes(text)) + 1;
  const of = (method) => calls.filter((fact) => fact.method === method);
  assert.equal(of('splitNote').length, 1);
  assert.equal(of('splitNote')[0].line, lineOf('return this /* shared */ .'));
  assert.equal(of('oneLineNote').length, 1);
  const shape = (fact) => [fact.verb, fact.template, fact.resolved];
  assert.deepEqual(shape(of('splitNote')[0]), shape(of('oneLineNote')[0]));
  assert.deepEqual(shape(of('splitNote')[0]), ['POST', 'nursery/v1/plots/${plotId}/notes', true]);
  assert.deepEqual(of('notGateway'), [], 'a call through a field that is not a GatewayService field states nothing');
  assert.deepEqual(
    of('addNote').map((fact) => [fact.line, ...shape(fact)]),
    [[source.findIndex((line) => line.trimEnd().endsWith('return this.gateway')) + 1, 'POST', 'nursery/v1/plots/${plotId}/notes', true]],
  );
});

test('Mobile sites and starts AC-3: the committed two-line addNote call reaches its route under the onNote entry', () => {
  const committed = nursery();
  const model = committed.json(['span', '--from-component', 'PlotDetailPage']);
  const note = entryOf(model, 'onNote');
  assert.deepEqual([note.routes, note.arms, note.unresolved], [['POST nursery/v1/plots/*/notes'], 1, 0]);
  const route = model.routes.find((entry) => entry.key === 'POST nursery/v1/plots/*/notes');
  assert.deepEqual(route.arms.map((arm) => arm.entry), [note.identity.id]);
  const help = runCli(['--help']).stdout;
  assert.doesNotMatch(help, /written over more than one line states no fact/);
  assert.doesNotMatch(readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8'), /written over more than one line states no fact/);
});

const PLOTS = 'mobile/src/app/features/plots';
const PAGE_TS = `${PLOTS}/plot-detail.page.ts`;
const PAGE_HTML = `${PLOTS}/plot-detail.page.html`;

/** Plain helper classes beside the nursery page, and a backend class that shares one name. */
const HELPER_FILES = {
  'backend/src/Services/BedRules.cs': [
    'namespace Nursery.Api.Services',
    '{',
    '    public class BedRules',
    '    {',
    '        private readonly ISoilStore _soil;',
    '',
    '        public BedRules(ISoilStore soil)',
    '        {',
    '            _soil = soil;',
    '        }',
    '',
    '        public bool Check(string plotId)',
    '        {',
    '            return _soil.Has(plotId);',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n'),
  [`${PLOTS}/bed-rules.ts`]: [
    "import { Store } from '@ngrx/store';",
    "import { GatewayService } from '../../core/gateway.service';",
    "import { PlotMath } from './plot-math';",
    "import { Tally } from './tally';",
    "import * as Geo from './geo';",
    "import { pinPlot } from './plot.actions';",
    '',
    'export class BedRules {',
    '  constructor(private gateway: GatewayService, private store: Store) {}',
    '',
    '  check(plotId: string) {',
    '    PlotMath.area(plotId);',
    '    return this.gateway.get(`nursery/v1/plots/${plotId}/summary`);',
    '  }',
    '',
    '  pin(plotId: string) {',
    '    this.store.dispatch(pinPlot({ plotId }));',
    '    this.check(plotId);',
    '    Geo.area(plotId);',
    '    Math.max(1, 2);',
    '    Local.size();',
    '  }',
    '',
    '  static audit(plotId: string) {',
    '    return Tally.count(plotId);',
    '  }',
    '}',
    '',
    'class Local {',
    '  static size() {',
    '    return 1;',
    '  }',
    '}',
    '',
    'declare class Ambient {',
    '  run(): void;',
    '}',
    '',
  ].join('\n'),
  [`${PLOTS}/plot-math.ts`]: ['export class PlotMath {', '  static area(plotId: string) {', '    return plotId.length;', '  }', '}', ''].join('\n'),
  [`${PLOTS}/tally.ts`]: ['export class Counter {', '  count() {', '    return 0;', '  }', '}', ''].join('\n'),
  'mobile/src/app/features/legacy/tally.ts': ['export class Tally {', '  static count(plotId: string) {', '    return plotId;', '  }', '}', ''].join('\n'),
  [`${PLOTS}/plot-detail.page.ts`]: (text) =>
    text
      .replace("import { PlotService } from './plot.service';", "import { PlotService } from './plot.service';\nimport { BedRules } from './bed-rules';\nimport { Ghost } from './ghost';")
      .replace('  onPin() {', '  onAudit() {\n    BedRules.audit(this.plotId);\n  }\n\n  onHaunt() {\n    Ghost.boo();\n  }\n\n  onPin() {'),
  [PAGE_HTML]: (text) =>
    text.replace(
      '  <ion-button (click)="onPin()">Pin</ion-button>',
      '  <ion-button (click)="onPin()">Pin</ion-button>\n  <ion-button (click)="onAudit()">Audit</ion-button>\n  <ion-button (click)="onHaunt()">Haunt</ion-button>',
    ),
};

/** Every `extends` form the extractor reads, and an ambient class it skips. */
const BASE_FILES = {
  [`${PLOTS}/bed-base.ts`]: ['export class BedBase {', '  ngOnInit() {', '    return 1;', '  }', '}', ''].join('\n'),
  [`${PLOTS}/bed-forms.ts`]: [
    "import { Component } from '@angular/core';",
    "import { BedBase } from './bed-base';",
    "import BaseTwo from './base-two';",
    "import { IonicThing } from '@ionic/angular';",
    "import type { Shape } from './shape';",
    "import * as ns from './ns';",
    '',
    'export class FromValue extends BedBase {}',
    'export class FromDefault extends BaseTwo {}',
    'class InFile {}',
    'export class FromInFile extends InFile {}',
    'export class FromPackage extends IonicThing {}',
    'export class FromTypeOnly extends Shape {}',
    'export class FromQualified extends ns.Base {}',
    'export class Generic<T> extends BedBase implements Iterable<T> {}',
    '',
    "@Component({ selector: 'app-bed-card', template: '<p></p>' })",
    'export class BedCardComponent extends BedBase {}',
    '',
  ].join('\n'),
};

let helperPackCache = null;
function helperPack() {
  if (!helperPackCache) helperPackCache = nursery({ ...HELPER_FILES, ...BASE_FILES });
  return helperPackCache;
}

test('Mobile sites and starts AC-4: an undecorated class states a class declaration with exports, members, calls, injections, gateway calls and dispatches', async () => {
  const { validateFacts } = await import('../lib/facts.js');
  const facts = helperPack().facts('mobile');
  const file = 'src/app/features/plots/bed-rules.ts';
  const inFile = facts.filter((fact) => fact.file === file);
  const declarations = inFile.filter((fact) => fact.type === 'component');
  assert.deepEqual(
    declarations.map((fact) => [fact.name, fact.role, fact.selector, fact.exports]),
    [
      ['BedRules', 'class', '', ['BedRules']],
      ['Local', 'class', '', []],
    ],
    'an ambient declare class states nothing',
  );
  const of = (type, method) => inFile.filter((fact) => fact.type === type && (!method || fact.method === method));
  assert.deepEqual(of('method_span').map((fact) => `${fact.class}.${fact.method}`).sort(), [
    'BedRules.audit',
    'BedRules.check',
    'BedRules.constructor',
    'BedRules.pin',
    'Local.size',
  ]);
  assert.deepEqual(of('injects').map((fact) => [fact.from, fact.to]), [
    ['BedRules', 'GatewayService'],
    ['BedRules', 'Store'],
  ]);
  assert.deepEqual(of('gateway_call').map((fact) => [fact.method, fact.verb, fact.template]), [
    ['check', 'GET', 'nursery/v1/plots/${plotId}/summary'],
  ]);
  assert.deepEqual(of('action_dispatch').map((fact) => [fact.method, fact.action]), [['pin', 'pinPlot']]);
  const calls = of('method_call').map(({ type, file: _file, line: _line, ...rest }) => rest);
  assert.deepEqual(calls, [
    { class: 'BedRules', method: 'check', field: 'PlotMath', calledMethod: 'area', static: true, source: './plot-math', imported: 'PlotMath' },
    { class: 'BedRules', method: 'pin', field: 'this', calledMethod: 'check' },
    { class: 'BedRules', method: 'pin', field: 'Local', calledMethod: 'size', static: true },
    { class: 'BedRules', method: 'audit', field: 'Tally', calledMethod: 'count', static: true, source: './tally', imported: 'Tally' },
  ], 'a namespace import and a global state no static call');
  const page = facts.filter((fact) => fact.type === 'method_call' && fact.class === 'PlotDetailPage' && fact.static === true);
  assert.deepEqual(page.map((fact) => [fact.method, fact.field, fact.calledMethod, fact.source, fact.imported]), [
    ['onAudit', 'BedRules', 'audit', './bed-rules', 'BedRules'],
    ['onHaunt', 'Ghost', 'boo', './ghost', 'Ghost'],
  ]);
  assert.equal(validateFacts(facts), facts.length);
  assert.ok(facts.every((fact) => fact.type !== 'component' || fact.name !== 'Ambient'));
});

test('Mobile sites and starts AC-4: a class with an extends clause states its base as written with the import provenance of injects', () => {
  const facts = helperPack().facts('mobile').filter((fact) => fact.type === 'component' && fact.file === 'src/app/features/plots/bed-forms.ts');
  const base = Object.fromEntries(
    facts.map((fact) => [fact.name, [fact.role, fact.extends ?? null, fact.extendsSource ?? null, fact.extendsImported ?? null]]),
  );
  assert.deepEqual(base, {
    FromValue: ['class', 'BedBase', './bed-base', 'BedBase'],
    FromDefault: ['class', 'BaseTwo', './base-two', null],
    InFile: ['class', null, null, null],
    FromInFile: ['class', 'InFile', null, null],
    FromPackage: ['class', 'IonicThing', '@ionic/angular', 'IonicThing'],
    FromTypeOnly: ['class', 'Shape', './shape', null],
    FromQualified: ['class', null, null, null],
    Generic: ['class', 'BedBase', './bed-base', 'BedBase'],
    BedCardComponent: ['component', 'BedBase', './bed-base', 'BedBase'],
  });
});

test('Mobile sites and starts AC-4: the fact schema doc and the validator name the class role and the new fields', async () => {
  const { validateFacts } = await import('../lib/facts.js');
  const schema = readFileSync(join(REPO_ROOT, 'docs', 'fact-schema.md'), 'utf8');
  for (const word of ['`class`', '`extends`', '`extendsSource`', '`extendsImported`', '`static: true`']) {
    assert.ok(schema.includes(word), word);
  }
  const ok = { type: 'component', file: 'a.ts', line: 1, name: 'A', selector: '', role: 'class', extends: 'B', extendsSource: './b', extendsImported: 'B' };
  assert.equal(validateFacts([ok]), 1);
  assert.throws(() => validateFacts([{ ...ok, extends: '' }]), /field "extends" must be a non-empty string/);
  assert.throws(() => validateFacts([{ ...ok, extendsSource: 3 }]), /field "extendsSource" must be a non-empty string/);
  const call = { type: 'method_call', file: 'a.ts', line: 1, class: 'A', method: 'm', field: 'B', calledMethod: 'n', static: true };
  assert.equal(validateFacts([call]), 1);
  assert.throws(() => validateFacts([{ ...call, static: false }]), /field "static" must be true when present/);
});

test('Mobile sites and starts AC-6: a backend helper and a plain mobile helper share a name: the bare start exits 2 and lists both', () => {
  const { cli } = helperPack();
  const bare = cli(['trace', 'BedRules']);
  assert.equal(bare.status, 2, bare.stderr);
  assert.match(bare.stderr, /BedRules backend src\/Services\/BedRules\.cs:\d+/);
  assert.match(bare.stderr, /BedRules mobile src\/app\/features\/plots\/bed-rules\.ts:8/);
});

test('Mobile sites and starts AC-6: each --repo start resolves, and the mobile walk goes through members, a static call and a gateway call', () => {
  const { json } = helperPack();
  const backend = json(['trace', 'BedRules', '--repo', 'backend']);
  assert.deepEqual([backend.root.kind, backend.root.repo, backend.root.file], ['class', 'backend', 'src/Services/BedRules.cs']);
  const mobile = json(['trace', 'BedRules', '--repo', 'mobile']);
  assert.deepEqual([mobile.root.kind, mobile.root.repo, mobile.root.file, mobile.root.line], ['class', 'mobile', 'src/app/features/plots/bed-rules.ts', 8]);
  const byId = new Map(mobile.nodes.map((node) => [node.id, node]));
  const kids = (node) => mobile.edges.filter((edge) => edge.from === node.id).map((edge) => byId.get(edge.to));
  assert.deepEqual(kids(mobile.root).map((node) => node.ref), ['BedRules.constructor', 'BedRules.check', 'BedRules.pin', 'BedRules.audit']);
  const check = kids(mobile.root).find((node) => node.ref === 'BedRules.check');
  const reached = kids(check);
  const math = reached.find((node) => node.ref === 'PlotMath');
  assert.ok(math, 'the static call enters the second plain helper');
  assert.deepEqual([math.kind, math.via, math.file], ['class', 'static', 'src/app/features/plots/plot-math.ts']);
  assert.deepEqual(kids(math).map((node) => node.ref), ['PlotMath.area']);
  const route = reached.find((node) => node.kind === 'route');
  assert.equal(route.ref, 'GET nursery/v1/plots/*/summary');
});

test('Mobile sites and starts AC-6: a static call from a page method is followed in trace and in span --from-component', () => {
  const { json } = helperPack();
  const walk = json(['trace', 'PlotDetailPage', '--expand', '--from-handler', 'onAudit']);
  const byId = new Map(walk.nodes.map((node) => [node.id, node]));
  const helper = walk.nodes.find((node) => node.ref === 'BedRules' && node.via === 'static');
  assert.ok(helper, 'the page handler enters the helper through its static call');
  assert.equal(helper.file, 'src/app/features/plots/bed-rules.ts');
  const audit = walk.edges.filter((edge) => edge.from === helper.id).map((edge) => byId.get(edge.to));
  assert.deepEqual(audit.map((node) => node.ref), ['BedRules.audit']);
  const model = json(['span', '--from-component', 'PlotDetailPage']);
  const entry = entryOf(model, 'onAudit');
  const arms = model.unresolved.filter((arm) => arm.entry === entry.identity.id);
  assert.equal(arms.length, 1);
  assert.equal(arms[0].reason, 'mobile-declaration-unresolved');
  assert.deepEqual(arms[0].breadcrumb.map((hop) => [hop.kind, hop.ref, hop.via]).slice(-3), [
    ['class', 'BedRules', 'static'],
    ['method', 'BedRules.audit', 'body'],
    ['class', 'Tally', 'static'],
  ]);
});

test('Mobile sites and starts AC-6: a static call to a relative module with no such class is one refusal arm that enters no same-named class', () => {
  const { json, cli } = helperPack();
  const walk = json(['trace', 'BedRules', '--repo', 'mobile']);
  const refused = walk.nodes.filter((node) => node.ref === 'Tally');
  assert.equal(refused.length, 1);
  assert.deepEqual([refused[0].unresolved, refused[0].file, refused[0].via], [
    'mobile-declaration-unresolved',
    'src/app/features/plots/bed-rules.ts',
    'static',
  ]);
  assert.ok(!walk.nodes.some((node) => node.file === 'src/app/features/legacy/tally.ts'), 'the same-named class in another folder is not entered');
  assert.equal(walk.edges.filter((edge) => edge.from === refused[0].id).length, 0);
  const ghost = cli(['trace', 'Ghost']);
  assert.equal(ghost.status, 2);
  assert.match(ghost.stderr, /no page, component, service, route, method or class matches "Ghost"/);
});

const BEDS = 'mobile/src/app/features/beds';
const GATEWAY_IMPORT = "import { GatewayService } from '../../core/gateway.service';";
const page = (name, selector, base, baseImport, body = []) => [
  "import { Component } from '@angular/core';",
  GATEWAY_IMPORT,
  baseImport,
  '',
  `@Component({ selector: '${selector}', template: '<p></p>' })`,
  `export class ${name} extends ${base} {`,
  ...body,
  '}',
  '',
].join('\n');

/** Pages that inherit lifecycle hooks through one, two and cyclic base levels. */
const INHERITED_FILES = {
  [`${BEDS}/bed-root.ts`]: [
    GATEWAY_IMPORT,
    '',
    'export class BedRoot {',
    "  plotId = 'p1';",
    '  constructor(private root: GatewayService) {}',
    '',
    '  ionViewWillEnter() {',
    '    return this.root.get(`nursery/v1/plots/${this.plotId}/forecast`);',
    '  }',
    '',
    '  ngOnDestroy() {',
    '    return this.root.get(`nursery/v1/plots/${this.plotId}/history`);',
    '  }',
    '}',
    '',
  ].join('\n'),
  [`${BEDS}/bed-base.page.ts`]: [
    GATEWAY_IMPORT,
    "import { BedRoot } from './bed-root';",
    '',
    'export class BedBasePage extends BedRoot {',
    '  constructor(private api: GatewayService) {',
    '    super(api);',
    '  }',
    '',
    '  ngOnInit() {',
    '    this.load();',
    '  }',
    '',
    '  load() {',
    '    return this.api.get(`nursery/v1/plots/${this.plotId}/sensors`);',
    '  }',
    '}',
    '',
  ].join('\n'),
  [`${BEDS}/bed-grid.page.ts`]: page('BedGridPage', 'app-bed-grid', 'BedBasePage', "import { BedBasePage } from './bed-base.page';"),
  [`${BEDS}/bed-list.page.ts`]: page('BedListPage', 'app-bed-list', 'BedBasePage', "import { BedBasePage } from './bed-base.page';", [
    '  constructor(private list: GatewayService) {',
    '    super(list);',
    '  }',
    '',
    '  ngOnDestroy() {',
    '    return this.list.get(`nursery/v1/plots/${this.plotId}/summary`);',
    '  }',
  ]),
  [`${BEDS}/loop-a.ts`]: ["import { LoopB } from './loop-b';", '', 'export class LoopA extends LoopB {}', ''].join('\n'),
  [`${BEDS}/loop-b.ts`]: [
    GATEWAY_IMPORT,
    "import { LoopA } from './loop-a';",
    '',
    'export class LoopB extends LoopA {',
    "  plotId = 'p1';",
    '  constructor(private loop: GatewayService) {',
    '    super();',
    '  }',
    '',
    '  ionViewDidEnter() {',
    '    return this.loop.get(`nursery/v1/plots/${this.plotId}/sensors`);',
    '  }',
    '}',
    '',
  ].join('\n'),
  [`${BEDS}/bed-loop.page.ts`]: page('BedLoopPage', 'app-bed-loop', 'LoopA', "import { LoopA } from './loop-a';"),
  [`${BEDS}/bed-orphan.page.ts`]: page('BedOrphanPage', 'app-bed-orphan', 'MissingBase', "import { MissingBase } from './missing-base';"),
  [`${BEDS}/bed-ionic.page.ts`]: page('BedIonicPage', 'app-bed-ionic', 'IonicBase', "import { IonicBase } from '@ionic/angular';"),
};

let inheritedCache = null;
function inheritedPack() {
  if (!inheritedCache) inheritedCache = nursery(INHERITED_FILES);
  return inheritedCache;
}

const entrySummary = (model) =>
  model.entries
    .map((view) => [view.identity.trigger, view.identity.kind, view.identity.component, view.identity.file, view.routes.slice().sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));

test('Mobile sites and starts AC-5: a page that declares no hook gets one entry for each hook its bases declare, through two levels', () => {
  const model = inheritedPack().json(['span', '--from-component', 'BedGridPage']);
  assert.deepEqual(entrySummary(model), [
    ['ionViewWillEnter', 'mount', 'BedGridPage', 'src/app/features/beds/bed-root.ts', ['GET nursery/v1/plots/*/forecast']],
    ['ngOnDestroy', 'unmount', 'BedGridPage', 'src/app/features/beds/bed-root.ts', ['GET nursery/v1/plots/*/history']],
    ['ngOnInit', 'mount', 'BedGridPage', 'src/app/features/beds/bed-base.page.ts', ['GET nursery/v1/plots/*/sensors']],
  ]);
  const facts = inheritedPack().facts('mobile');
  const spanLine = (cls, method) => facts.find((fact) => fact.type === 'method_span' && fact.class === cls && fact.method === method).line;
  assert.equal(entryOf(model, 'ngOnInit').identity.line, spanLine('BedBasePage', 'ngOnInit'), 'the entry site is the base hook');
  assert.deepEqual(model.unresolved, []);
  assert.deepEqual(model.orphans, { arms: 0, routes: [] });
});

test('Mobile sites and starts AC-5: a hook the page declares is the only entry for that trigger, and two pages on one base get two ids', () => {
  const list = inheritedPack().json(['span', '--from-component', 'BedListPage']);
  assert.deepEqual(entrySummary(list), [
    ['ionViewWillEnter', 'mount', 'BedListPage', 'src/app/features/beds/bed-root.ts', ['GET nursery/v1/plots/*/forecast']],
    ['ngOnDestroy', 'unmount', 'BedListPage', 'src/app/features/beds/bed-list.page.ts', ['GET nursery/v1/plots/*/summary']],
    ['ngOnInit', 'mount', 'BedListPage', 'src/app/features/beds/bed-base.page.ts', ['GET nursery/v1/plots/*/sensors']],
  ]);
  const grid = inheritedPack().json(['span', '--from-component', 'BedGridPage']);
  assert.notEqual(entryOf(list, 'ngOnInit').identity.id, entryOf(grid, 'ngOnInit').identity.id);
});

test('Mobile sites and starts AC-5: a base cycle ends, and the hook found before the cycle is an entry', () => {
  const model = inheritedPack().json(['span', '--from-component', 'BedLoopPage']);
  assert.deepEqual(entrySummary(model), [
    ['ionViewDidEnter', 'mount', 'BedLoopPage', 'src/app/features/beds/loop-b.ts', ['GET nursery/v1/plots/*/sensors']],
  ]);
});

test('Mobile sites and starts AC-5: an unresolved relative base is one arm at the extends site, and a package base gives nothing', () => {
  const { json, facts } = inheritedPack();
  const orphan = json(['span', '--from-component', 'BedOrphanPage']);
  assert.deepEqual(orphan.entries, []);
  const declaration = facts('mobile').find((fact) => fact.type === 'component' && fact.name === 'BedOrphanPage');
  const arms = orphan.unresolved;
  assert.equal(arms.length, 1, JSON.stringify(arms));
  assert.equal(arms[0].entry, null, 'no entry reaches the refused base');
  assert.deepEqual([arms[0].reason, arms[0].file, arms[0].line], ['mobile-declaration-unresolved', declaration.file, declaration.line]);
  const ionic = json(['span', '--from-component', 'BedIonicPage']);
  assert.deepEqual([ionic.entries, ionic.unresolved, ionic.orphans], [[], [], { arms: 0, routes: [] }]);
});

test('Mobile sites and starts AC-5: the lifecycle comment, the span help and the CLI doc describe inherited hooks as entries', async () => {
  const { MOBILE_LIFECYCLE_KINDS } = await import('../lib/trace.js');
  assert.ok(MOBILE_LIFECYCLE_KINDS.has('ngOnInit'));
  const source = readFileSync(join(REPO_ROOT, 'lib', 'trace.js'), 'utf8');
  assert.match(source, /A listed hook that the class inherits from a base class in the\n \* repository is an entry of the class too\./);
  const help = runCli(['span', '--help']).stdout.replace(/\s+/g, ' ');
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').replace(/\s+/g, ' ');
  for (const text of [help, doc]) {
    assert.match(text, /A listed hook the class inherits is an entry too, at the hook in the first base class up the extends chain that declares it\./);
    assert.match(text, /a relative base that resolves to no one declaration prints as one mobile-declaration-unresolved arm at the extends site/);
    assert.doesNotMatch(text, /each lifecycle hook the class itself declares/);
  }
});

const twin = (folder, extra = []) => [
  `export class BedHelper {`,
  '  tidy() {',
  '    this.sweep();',
  '  }',
  '',
  '  sweep() {',
  '    return 1;',
  '  }',
  ...extra,
  '}',
  '',
].join('\n');

/** One mobile class name that two files declare, each with the same method. */
const TWIN_FILES = {
  [`${BEDS}/east/bed-helper.ts`]: twin('east'),
  [`${BEDS}/west/bed-helper.ts`]: twin('west', ['', '  rake() {', '    this.sweep();', '  }']),
};

function reverseFacts(dir, repo) {
  const file = join(dir, 'out', 'facts', `${repo}.json`);
  const set = JSON.parse(readFileSync(file, 'utf8'));
  set.facts.reverse();
  writeFileSync(file, `${JSON.stringify(set, null, 2)}\n`);
}

test('Mobile sites and starts AC-9: a method start on a class name two files declare exits 2 and lists each file, in either fact order', () => {
  const twins = nursery(TWIN_FILES);
  const expected = [
    'BedHelper.tidy mobile src/app/features/beds/east/bed-helper.ts:3',
    'BedHelper.tidy mobile src/app/features/beds/west/bed-helper.ts:3',
  ];
  const listed = (result) => result.stderr.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('BedHelper.'));
  const normal = twins.cli(['trace', 'BedHelper.tidy']);
  assert.equal(normal.status, 2, normal.stderr);
  assert.deepEqual(listed(normal), expected);
  const classOnly = twins.cli(['trace', 'BedHelper']);
  assert.equal(classOnly.status, 2, classOnly.stderr);
  assert.match(classOnly.stderr, /east\/bed-helper\.ts/);
  assert.match(classOnly.stderr, /west\/bed-helper\.ts/);
  reverseFacts(twins.dir, 'mobile');
  const reversed = twins.cli(['trace', 'BedHelper.tidy']);
  assert.equal(reversed.status, 2, reversed.stderr);
  assert.deepEqual(listed(reversed), expected);
});

test('Mobile sites and starts AC-9: a method only one of the two files writes, a unique declaration and a route-backed start resolve as before', () => {
  const twins = nursery(TWIN_FILES);
  const rake = twins.json(['trace', 'BedHelper.rake']);
  assert.deepEqual([rake.root.kind, rake.root.file, rake.root.line], ['method', 'src/app/features/beds/west/bed-helper.ts', 11]);
  const unique = twins.json(['trace', 'SeedlingBadgeComponent.onMark']);
  assert.deepEqual([unique.root.kind, unique.root.repo, unique.root.file, unique.root.line], [
    'method',
    'mobile',
    'src/app/features/plots/seedling-badge.component.ts',
    12,
  ]);
  const routed = twins.json(['trace', 'PlotsController.Water']);
  assert.deepEqual([routed.root.kind, routed.root.repo], ['action', 'backend']);
});

const PAGE_HTML_FILE = 'src/app/features/plots/plot-detail.page.html';

/** The nursery page with `onSync` bound at a second template site. */
function twoSitePack() {
  return nursery({
    [PAGE_HTML]: (text) =>
      text.replace(
        '  <ion-button (click)="onPin()">Pin</ion-button>',
        '  <ion-button (click)="onPin()">Pin</ion-button>\n  <ion-button (click)="onSync()">Sync again</ion-button>',
      ),
  });
}

let twoSiteCache = null;
const twoSites = () => (twoSiteCache ||= twoSitePack());

test('Mobile sites and starts AC-1: one handler bound at two sites gives two handler nodes, each naming its site, each with its own subtree', () => {
  const walk = twoSites().json(['trace', 'PlotDetailPage']);
  const handlers = walk.nodes.filter((node) => node.ref === 'PlotDetailPage.onSync' && node.via === 'handler');
  assert.deepEqual(handlers.map((node) => node.site), [
    { file: PAGE_HTML_FILE, line: 12 },
    { file: PAGE_HTML_FILE, line: 14 },
  ]);
  const kids = (node) => walk.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to);
  assert.ok(kids(handlers[0]).length > 0 && kids(handlers[1]).length > 0, 'both sites keep a subtree');
  assert.deepEqual(new Set([...kids(handlers[0]), ...kids(handlers[1])]).size, kids(handlers[0]).length + kids(handlers[1]).length);
  assert.ok(
    walk.nodes.filter((node) => node.via === 'handler' && node.ref !== 'PlotDetailPage.onSync').every((node) => !('site' in node)),
    'a handler bound at one site prints no site',
  );
  const text = twoSites().cli(['trace', 'PlotDetailPage']).stdout;
  assert.match(text, /\(click\) onSync\(\) @src\/app\/features\/plots\/plot-detail\.page\.html:12/);
  assert.match(text, /\(click\) onSync\(\) @src\/app\/features\/plots\/plot-detail\.page\.html:14/);
  assert.doesNotMatch(text, /\(click\) onMark\(\) @/);
});

test('Mobile sites and starts AC-1: a handler bound at one site gives the same trace as the committed corpus', () => {
  const plain = nursery({});
  const golden = JSON.parse(readFileSync(join(CORPUS, 'nursery-mobile', 'trace-plot-detail.golden.json'), 'utf8'));
  const now = plain.json(['trace', 'PlotDetailPage']);
  assert.deepEqual(now.nodes, golden.nodes);
  assert.deepEqual(now.edges, golden.edges);
});

test('Mobile sites and starts AC-2: a mobile selector that matches two sites exits 2 with one candidate per site, and a site suffix selects one', () => {
  const { cli, json } = twoSites();
  const ambiguous = cli(['trace', 'PlotDetailPage', '--from-handler', 'onSync']);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.equal(
    ambiguous.stderr,
    [
      'flowtrace: "onSync" matches 2 handlers:',
      `  (click) onSync() PlotDetailPage.onSync mobile ${PAGE_HTML_FILE}:12`,
      `  (click) onSync() PlotDetailPage.onSync mobile ${PAGE_HTML_FILE}:14`,
      '',
    ].join('\n'),
  );
  for (const selector of ['onSync@14', 'click:onSync@14', '(click) onSync()@14', '(click) onSync() @ 14']) {
    const narrowed = json(['trace', 'PlotDetailPage', '--from-handler', selector]);
    assert.deepEqual([narrowed.root.ref, narrowed.root.site], ['PlotDetailPage.onSync', { file: PAGE_HTML_FILE, line: 14 }], selector);
  }
  const column = cli(['trace', 'PlotDetailPage', '--from-handler', 'onSync@14:3']);
  assert.equal(column.status, 2);
  assert.match(column.stderr, /no template handler matches "onSync@14:3"/);
});

test('Mobile sites and starts AC-2: a selector that matches one site gives the same output with or without its suffix', () => {
  const { json } = twoSites();
  const strip = (model) => ({ nodes: model.nodes, edges: model.edges, sinks: model.sinks, stats: model.stats });
  const bare = json(['trace', 'PlotDetailPage', '--from-handler', 'onMark']);
  const sited = json(['trace', 'PlotDetailPage', '--from-handler', 'onMark@1']);
  assert.deepEqual(strip(sited), strip(bare));
});

test('Mobile sites and starts AC-2: a web selector that matches two sites exits 2, and line or line:column selects one', () => {
  const kiln = pack('kiln-yard', 'kiln.config.json', {
    'web/src/kiln/KilnPanel.tsx': (text) =>
      text.replace('      <button onClick={refresh}>Load?</button>', '      <button onClick={refresh}>Load?</button>\n      <button onClick={refresh}>Again</button>'),
  });
  const ambiguous = kiln.cli(['trace', 'KilnPanel', '--from-handler', 'refresh']);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.equal(
    ambiguous.stderr,
    [
      'flowtrace: "refresh" matches 2 handlers:',
      '  (onClick) refresh() KilnPanel.refresh web src/kiln/KilnPanel.tsx:11:15',
      '  (onClick) refresh() KilnPanel.refresh web src/kiln/KilnPanel.tsx:12:15',
      '',
    ].join('\n'),
  );
  for (const [selector, line] of [['refresh@12', 12], ['onClick:refresh@11:15', 11], ['(onClick) refresh()@12:15', 12]]) {
    const narrowed = kiln.json(['trace', 'KilnPanel', '--from-handler', selector]);
    assert.deepEqual([narrowed.root.ref, narrowed.root.entry.line], ['KilnPanel.refresh', line], selector);
  }
  const miss = kiln.cli(['trace', 'KilnPanel', '--from-handler', 'refresh@11:3']);
  assert.equal(miss.status, 2);
  assert.match(miss.stderr, /no template handler matches/);
});

test('Mobile sites and starts AC-2: a malformed site suffix is one usage refusal, from the CLI and from the library', async () => {
  const { cli, dir } = twoSites();
  for (const selector of ['onSync@', 'onSync@x', 'onSync@0', 'onSync@12:', 'onSync@12:0', 'onSync@-3', 'onSync@12@13']) {
    const result = cli(['trace', 'PlotDetailPage', '--from-handler', selector]);
    assert.equal(result.status, 2, selector);
    assert.match(result.stderr, /^flowtrace: --from-handler site must be @<line> or @<line>:<column>\n/, selector);
  }
  const { trace, parseHandlerSelector } = await import('../lib/trace.js');
  assert.deepEqual(parseHandlerSelector('(click) onSync()@12:4'), { event: 'click', method: 'onSync', site: { line: 12, column: 4 } });
  const factSets = ['backend', 'mobile'].map((repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')));
  assert.equal(trace(factSets, 'PlotDetailPage', { fromHandler: 'onSync@x' }).fromHandlerError, '--from-handler site must be @<line> or @<line>:<column>');
});

test('Mobile sites and starts AC-2: the trace help and the CLI doc name the site suffix', () => {
  const help = runCli(['trace', '--help']).stdout.replace(/\s+/g, ' ');
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').replace(/\s+/g, ' ');
  for (const text of [help, doc]) {
    assert.match(text, /Each form takes an optional "@<line>" or "@<line>:<column>" suffix \("onLike@14"\)/);
    assert.match(text, /One handler bound at two or more sites is one node for each site, and each such node names its site\./);
  }
});

/**
 * A second page with the same class name, another selector and another feature folder that
 * sorts after the first, so the last same-named declaration in the facts is the wrong page.
 */
const ARCHIVE_FILES = {
  'mobile/src/app/features/yard/plot-detail.page.ts': [
    "import { Component } from '@angular/core';",
    '',
    '@Component({',
    "  selector: 'app-plot-archive',",
    "  templateUrl: './plot-detail.page.html',",
    '})',
    'export class PlotDetailPage {',
    '  onArchive() {',
    '    return 1;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'mobile/src/app/features/yard/plot-detail.page.html': '<ion-button (click)="onArchive()">Archive</ion-button>\n',
};

const chainPages = (model) =>
  model.chains
    .map((chain) => [chain.entry ? `${chain.entry.component}.${chain.entry.handler || chain.entry.trigger}` : null, chain.page ? chain.page.file : null, chain.gaps])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('Mobile sites and starts AC-8: with a same-named page elsewhere, a page event and its rendered chip each reach their own page with no gap, in either fact order', () => {
  const archive = nursery(ARCHIVE_FILES);
  const own = 'src/app/features/plots/plot-detail.page.ts';
  const water = archive.json(['chains', 'POST nursery/v1/plots/{plotId}/water']);
  const health = archive.json(['chains', 'POST nursery/v1/plots/{plotId}/health']);
  const waterPages = chainPages(water);
  const healthPages = chainPages(health);
  assert.ok(waterPages.length > 0 && healthPages.length > 0);
  for (const [, page, gaps] of [...waterPages, ...healthPages]) {
    assert.equal(page, own);
    assert.deepEqual(gaps, []);
  }
  assert.ok(healthPages.some(([entry]) => entry === 'SeedlingBadgeComponent.onMark'), 'the chip climbs through its render to the page');
  reverseFacts(archive.dir, 'mobile');
  assert.deepEqual(chainPages(archive.json(['chains', 'POST nursery/v1/plots/{plotId}/water'])), waterPages);
  assert.deepEqual(chainPages(archive.json(['chains', 'POST nursery/v1/plots/{plotId}/health'])), healthPages);
});

test('Mobile sites and starts AC-8: a template owner the facts do not prove is a component-ambiguous gap naming both files, and enters no page', () => {
  const archive = nursery(ARCHIVE_FILES);
  const file = join(archive.dir, 'out', 'facts', 'mobile.json');
  const set = JSON.parse(readFileSync(file, 'utf8'));
  for (const fact of set.facts) if (fact.type === 'template_handler' || fact.type === 'renders') delete fact.componentFile;
  writeFileSync(file, `${JSON.stringify(set, null, 2)}\n`);
  const candidates = ['src/app/features/plots/plot-detail.page.ts', 'src/app/features/yard/plot-detail.page.ts'];
  for (const route of ['POST nursery/v1/plots/{plotId}/water', 'POST nursery/v1/plots/{plotId}/health']) {
    const model = archive.json(['chains', route]);
    assert.ok(model.chains.length > 0, route);
    for (const chain of model.chains) {
      assert.deepEqual([chain.page, chain.gaps], [null, ['component-ambiguous']], route);
      assert.deepEqual(chain.hops.find((hop) => hop.kind === 'gap').candidates, candidates);
    }
  }
});

test('Mobile sites and starts AC-7: a walk-limit arm names the kind of the cut node in the page text and tag title, and its JSON reason stays walk-limit', () => {
  const { json, cli, dir } = nursery({});
  const model = json(['span', '--from-component', 'PlotDetailPage', '--depth', '2']);
  const limited = model.unresolved.filter((arm) => arm.reason === 'walk-limit');
  assert.ok(limited.length > 0);
  const kinds = new Set(limited.map((arm) => arm.breadcrumb[arm.breadcrumb.length - 1].kind));
  assert.ok(kinds.has('method') || kinds.has('service'), [...kinds].join(','));
  const out = join(dir, 'limit.html');
  assert.equal(cli(['span', '--from-component', 'PlotDetailPage', '--depth', '2', '--out', out]).status, 0);
  const html = readFileSync(out, 'utf8');
  for (const kind of kinds) {
    const word = { store_action: 'action' }[kind] || kind;
    const tail = `depth or node budget was spent before this ${word} could be explored further`;
    assert.ok(new RegExp(`title="the walk[^"]{1,8}s own ${tail}"`).test(html), `tag title names ${word}`);
    assert.ok(new RegExp(`<div class="plain">the walk[^<]{1,8}s own ${tail}`).test(html), `row text names ${word}`);
  }
  if (!kinds.has('store_action')) assert.ok(!html.includes('before this action could'), 'no cut method reads as an action');
});

test('Mobile sites and starts AC-7: each cut kind has its own word, an action keeps the present text, and the help names the rule', async () => {
  const { reasonText } = await import('../lib/component-span.js');
  const at = (kind) => reasonText('walk-limit', { breadcrumb: [{ kind: 'page' }, { kind }] });
  const text = (word) => `the walk's own depth or node budget was spent before this ${word} could be explored further`;
  assert.equal(at('store_action'), text('action'));
  assert.equal(reasonText('walk-limit'), text('action'));
  for (const kind of ['method', 'service', 'component', 'page', 'entry']) assert.equal(at(kind), text(kind));
  assert.equal(reasonText('no-effect', { breadcrumb: [{ kind: 'method' }] }), 'no effect_handler answers this action');
  const help = runCli(['span', '--help']).stdout.replace(/\s+/g, ' ');
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').replace(/\s+/g, ' ');
  for (const page of [help, doc]) {
    assert.match(page, /The text of a walk-limit arm names the kind of node that was cut: action, method, service, component, page or entry\. Its JSON reason stays walk-limit\./);
  }
});

const ROUTE_ARM_FIELDS = ['key', 'via', 'breadcrumb', 'entry', 'file', 'line', 'route'];
const UNRESOLVED_ARM_FIELDS = ['reason', 'attempted', 'caller', 'breadcrumb', 'entry', 'file', 'line'];
const UNRESOLVED_OPTIONAL = ['candidates', 'source', 'cause', 'continuedBy', 'outcome'];
const WEB_HOP_KINDS = ['page', 'component', 'entry', 'method', 'store_action', 'route'];
const MOBILE_HOP_KINDS = ['page', 'component', 'service', 'class', 'entry', 'method', 'store_action', 'route'];

/** The hop that stands for an entry in a breadcrumb: its handler, its prop or its trigger. */
function entryHopIndex(breadcrumb, identity) {
  return breadcrumb.findIndex((hop) =>
    identity.kind === 'event'
      ? (hop.via === 'handler' && hop.ref === `${identity.component}.${identity.handler}`) || (hop.via === 'props' && hop.ref === identity.handler)
      : hop.kind === 'entry' && hop.ref.startsWith(`${identity.component}.${identity.trigger}`),
  );
}

/** The contract checks every component span model passes, web or mobile. */
function checkSpanContract(model, start, hopKinds) {
  assert.deepEqual(Object.keys(model), ['schemaVersion', 'component', 'status', 'header', 'entries', 'selectedEntry', 'orphans', 'routes', 'unresolved', 'limits']);
  assert.equal(model.schemaVersion, 1);
  const identities = new Map(model.entries.map((view) => [view.identity.id, view.identity]));
  const arms = [];
  for (const route of model.routes) {
    assert.deepEqual(Object.keys(route), ['key', 'arms', 'status']);
    for (const arm of route.arms) {
      assert.deepEqual(Object.keys(arm), ROUTE_ARM_FIELDS);
      const last = arm.breadcrumb[arm.breadcrumb.length - 1];
      assert.deepEqual([last.kind, last.ref], ['route', arm.key], 'a reached breadcrumb ends at its request');
      arms.push(arm);
    }
  }
  for (const arm of model.unresolved) {
    assert.deepEqual(Object.keys(arm).filter((field) => !UNRESOLVED_OPTIONAL.includes(field)), UNRESOLVED_ARM_FIELDS);
    assert.equal(arm.breadcrumb[arm.breadcrumb.length - 1].ref, arm.attempted, 'an unresolved breadcrumb ends at the node that failed');
    arms.push(arm);
  }
  assert.ok(arms.length > 0);
  for (const arm of arms) {
    assert.deepEqual(arm.breadcrumb.map((hop) => Object.keys(hop)), arm.breadcrumb.map(() => ['kind', 'ref', 'via']));
    assert.deepEqual([arm.breadcrumb[0].ref, arm.breadcrumb[0].via], [start, 'start'], 'a breadcrumb starts at the start component');
    for (const hop of arm.breadcrumb) assert.ok(hopKinds.includes(hop.kind), `hop kind ${hop.kind}`);
    if (arm.entry === null) continue;
    const identity = identities.get(arm.entry);
    assert.ok(identity, `arm entry ${arm.entry} is a listed entry`);
    const at = entryHopIndex(arm.breadcrumb, identity);
    assert.ok(at > 0, `the breadcrumb passes through entry ${arm.entry}`);
    assert.ok(arm.breadcrumb.slice(1, at).every((hop) => hop.via === 'template'), 'only rendered components come before the entry');
  }
  const byEntry = new Map();
  for (const route of model.routes) {
    for (const arm of route.arms) {
      if (arm.entry === null) continue;
      const list = byEntry.get(arm.entry) || [];
      list.push(JSON.stringify(arm.breadcrumb));
      byEntry.set(arm.entry, list);
    }
  }
  for (const [entry, crumbs] of byEntry) assert.equal(new Set(crumbs).size, crumbs.length, `${entry}: each request its own breadcrumb`);
  return { identities, byEntry };
}

test('Mobile sites and starts AC-10: the nursery page span passes the contract, with ordered paths, branching, separate entries and unresolved paths', () => {
  const model = nursery({}).json(['span', '--from-component', 'PlotDetailPage']);
  const { byEntry } = checkSpanContract(model, 'PlotDetailPage', MOBILE_HOP_KINDS);
  const tend = entryOf(model, 'onTend');
  assert.equal(byEntry.get(tend.identity.id).length, 2, 'one click that reaches two endpoints is two arms under one entry');
  const init = entryOf(model, 'ngOnInit');
  const summary = model.routes.find((route) => route.key === 'GET nursery/v1/plots/*/summary');
  assert.deepEqual(summary.arms.map((arm) => arm.entry), [init.identity.id], 'the startup request is only under its hook');
  assert.deepEqual([summary.arms[0].breadcrumb[1].kind, summary.arms[0].breadcrumb[1].via], ['entry', 'entry']);
  assert.ok(model.unresolved.length >= 3 && model.unresolved.every((arm) => typeof arm.entry === 'string'));
});

test('Mobile sites and starts AC-10: a web component span passes the same contract with the same field names', () => {
  const model = pack('greenhouse-alerts', 'greenhouse.config.json').json(['span', '--from-component', 'ZoneRoutes']);
  checkSpanContract(model, 'ZoneRoutes', WEB_HOP_KINDS);
  const mount = model.entries.find((view) => view.identity.trigger === 'componentDidMount');
  const readings = model.routes.find((route) => route.key === 'GET glasshouse/v1/zones/*/readings');
  assert.deepEqual(readings.arms.map((arm) => arm.entry), [mount.identity.id]);
  assert.ok(model.unresolved.length > 0 && model.unresolved.every((arm) => typeof arm.entry === 'string'));
});

test('Mobile sites and starts AC-10: the span help and the CLI doc state one JSON contract for web and mobile', () => {
  const help = runCli(['span', '--help']).stdout.replace(/\s+/g, ' ');
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').replace(/\s+/g, ' ');
  for (const text of [help, doc]) {
    assert.match(text, /That model, schemaVersion 1, is one contract for web and mobile/);
    assert.match(text, /top-level fields are component, status, header, entries, selectedEntry, orphans, routes \(each with key, arms and status\), unresolved and limits/);
    assert.match(text, /A reached arm, under routes, has key, via, breadcrumb, entry, file, line and route\./);
    assert.match(text, /An unresolved arm has reason, attempted, caller, breadcrumb, entry, file and line, and it can also have candidates, source, cause, continuedBy and outcome\./);
    assert.match(text, new RegExp(`Web hop kinds are ${WEB_HOP_KINDS.slice(0, -1).join(', ')} and ${WEB_HOP_KINDS.at(-1)}\\.`));
    assert.match(text, new RegExp(`Mobile hop kinds are ${MOBILE_HOP_KINDS.slice(0, -1).join(', ')} and ${MOBILE_HOP_KINDS.at(-1)}\\.`));
  }
});

test('Mobile sites and starts AC-11: the committed mobile corpora extract no class role, no extends field and no static call, and the README names the golden cause', () => {
  const mobileCorpora = [
    ['nursery-mobile', 'nursery.config.json'],
    ['kite-club', 'kite.config.json'],
    ['orchard-mobile', 'orchard.config.json'],
    ['kiln-yard', 'kiln.config.json'],
  ];
  for (const [corpus, config] of mobileCorpora) {
    const facts = pack(corpus, config).facts('mobile');
    assert.ok(facts.length > 0, corpus);
    assert.deepEqual(facts.filter((fact) => fact.type === 'component' && fact.role === 'class'), [], `${corpus}: no class role`);
    assert.deepEqual(facts.filter((fact) => 'extends' in fact || 'extendsSource' in fact || 'extendsImported' in fact), [], `${corpus}: no extends`);
    assert.deepEqual(facts.filter((fact) => fact.static === true), [], `${corpus}: no static call`);
  }
  const readme = readFileSync(join(CORPUS, 'nursery-mobile', 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(readme, /The gateway call rule then read a call split over lines, so `PlotService\.addNote` states its `gateway_call`/);
  assert.match(readme, /Both goldens were captured again for that one cause\. Only `status\.identity` changed/);
});

test('Mobile sites and starts AC-11: the orchard archive chain names the same-named page whose declaration owns its entry template, in text and JSON', () => {
  const orchard = pack('orchard-mobile', 'orchard.config.json');
  const route = 'GET orchard/v1/weather/legacy/{plotId}/archive';
  const owner = 'src/app/features/forecast/archive-forecast.page.ts';
  const entryTemplate = 'src/app/features/forecast/archive-forecast.page.html';
  const other = 'src/app/features/forecast/live-forecast.page.ts';

  const model = orchard.json(['chains', route]);
  assert.equal(model.chains.length, 1);
  const [chain] = model.chains;
  assert.deepEqual(chain.gaps, []);
  assert.deepEqual([chain.page.component, chain.page.file], ['ForecastPage', owner]);
  assert.deepEqual([chain.hops[0].kind, chain.hops[0].file], ['page', owner]);
  assert.deepEqual([chain.entry.id, chain.entry.file], [`ForecastPage:event:click:onArchive:@${entryTemplate}:2`, entryTemplate]);
  assert.equal(JSON.stringify(chain).includes(other), false, 'no hop names the other ForecastPage declaration');

  const text = orchard.cli(['chains', route]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`chain 1 of 1: mobile page ForecastPage ${owner}:4\\n`));
  assert.match(text.stdout, new RegExp(`\\n  page +component +mobile +${owner}:4 +ForecastPage\\n`));
  assert.match(text.stdout, new RegExp(`\\n  entry +template_handler +mobile +${entryTemplate}:2 +ForecastPage\\.click@2\\n`));
  assert.equal(text.stdout.includes(other), false);
});

test('Mobile sites and starts AC-1: a handler each same-named page binds once prints no site on either page', async () => {
  const yard = nursery({
    ...ARCHIVE_FILES,
    'mobile/src/app/features/yard/plot-detail.page.ts': ARCHIVE_FILES['mobile/src/app/features/yard/plot-detail.page.ts'].replace(
      '  onArchive() {',
      '  onSync() {\n    return 2;\n  }\n\n  onArchive() {',
    ),
    'mobile/src/app/features/yard/plot-detail.page.html': '<ion-button (click)="onArchive()">Archive</ion-button>\n<ion-button (click)="onSync()">Sync</ion-button>\n',
  });
  const { trace } = await import('../lib/trace.js');
  const factSets = ['backend', 'mobile'].map((repo) => JSON.parse(readFileSync(join(yard.dir, 'out', 'facts', `${repo}.json`), 'utf8')));
  for (const file of ['src/app/features/plots/plot-detail.page.ts', 'src/app/features/yard/plot-detail.page.ts']) {
    const line = factSets[1].facts.find((fact) => fact.type === 'component' && fact.file === file).line;
    const startNode = { repo: 'mobile', kind: 'page', ref: 'PlotDetailPage', file, line };
    const walk = trace(factSets, 'PlotDetailPage', { startNode });
    const handlers = walk.nodes.filter((node) => node.via === 'handler' && node.ref === 'PlotDetailPage.onSync');
    assert.equal(handlers.length, 1, file);
    assert.ok(!('site' in handlers[0]), file);
  }
});

test('Mobile sites and starts AC-4: class and static call text inside a string or template literal states no fact', () => {
  const quoted = nursery({
    [`${PLOTS}/plot-notes.ts`]: [
      'export class PlotNotes {',
      '  render() {',
      '    const sample = `',
      'class GhostHelper {',
      '  run() {}',
      '}',
      '`;',
      "    const call = 'PlotNotes.render()';",
      '    const other = "PlotNotes.render(";',
      '    return `${sample} PlotNotes.render() ${call}${other}`;',
      '  }',
      '}',
      '',
    ].join('\n'),
  });
  const facts = quoted.facts('mobile').filter((fact) => fact.file === 'src/app/features/plots/plot-notes.ts');
  assert.deepEqual(facts.filter((fact) => fact.type === 'component').map((fact) => fact.name), ['PlotNotes']);
  assert.deepEqual(facts.filter((fact) => fact.static === true), []);
});
