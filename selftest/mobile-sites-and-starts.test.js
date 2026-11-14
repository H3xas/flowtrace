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
