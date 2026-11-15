import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateFacts } from '../lib/facts.js';
import { REPO_ROOT, copyFixture, extract } from './helpers.js';
import {
  HOP_LIMIT,
  REGION_FAILURES,
  REGION_ROW_REASONS,
  REGION_STATES,
  TRACE_LIMIT,
  TRACE_REASONS,
  TRACE_STEPS,
  angularRegion,
  clientFacts,
  collectReads,
  jsxRegion,
  parseExpression,
} from '../lib/extract/client-conditions.js';

function reads(text, pipes = true) {
  const parsed = parseExpression(text, { pipes });
  assert.equal(parsed.error, undefined, `${text} parses`);
  return collectReads(parsed.ast).map((read) => ({
    root: read.root,
    segs: read.segs.map((seg) => seg.name ?? seg.key),
    stop: read.stop,
    negated: read.negated,
    nested: read.nested,
    pipes: read.pipes,
  }));
}

function angular(code, html, extra = {}) {
  const open = code.indexOf('{', code.indexOf('class '));
  return angularRegion({
    component: extra.component || 'BoardComponent',
    classFile: 'src/board.component.ts',
    code,
    bodyStart: open + 1,
    bodyEnd: code.lastIndexOf('}'),
    injected: extra.injected || [],
    template: { file: 'src/board.component.html', text: html },
  });
}

function jsx(code, name = 'Panel') {
  const at = code.indexOf(`function ${name}`);
  const parenOpen = code.indexOf('(', at);
  const parenClose = code.indexOf(')', parenOpen);
  const bodyOpen = code.indexOf('{', parenClose);
  return jsxRegion({
    component: name,
    file: `src/${name}.tsx`,
    code,
    offset: at + 9,
    fn: { bodyStart: bodyOpen + 1, bodyEnd: code.lastIndexOf('}'), block: true, paramStart: parenOpen + 1, paramEnd: parenClose },
  });
}

function only(facts, type, predicate = () => true) {
  const found = facts.filter((entry) => entry.type === type && predicate(entry));
  assert.equal(found.length, 1, `one ${type}`);
  return found[0];
}

test('Client conditions AC-1: the grammar reads member chains, negation and pipes', () => {
  assert.deepEqual(reads('a && !b.c'), [
    { root: 'a', segs: [], stop: null, negated: false, nested: false, pipes: [] },
    { root: 'b', segs: ['c'], stop: null, negated: true, nested: false, pipes: [] },
  ]);
  assert.deepEqual(reads('!!this.x?.y!.z')[0], { root: 'x', segs: ['y', 'z'], stop: null, negated: false, nested: false, pipes: [] });
  assert.deepEqual(reads('!(a || !b)').map((read) => read.negated), [true, false]);
  const piped = reads('when | date:short | upper');
  assert.deepEqual(piped.map((read) => [read.root, read.nested, read.pipes]), [
    ['when', false, ['upper', 'date']],
    ['short', true, []],
  ]);
  assert.equal(parseExpression('a | b').error, 'unsupported-syntax', 'a pipe outside a template is outside the grammar');
  for (const text of ['a + b', 'x => x', 'typeof a', '`${a}`', 'a = b', '', 'f(']) {
    assert.equal(parseExpression(text, { pipes: true }).error, 'unsupported-syntax', text);
  }
});

test('Client conditions AC-5: keys and calls stop a read at the named reason', () => {
  assert.deepEqual(reads('flags[key]').map((read) => [read.root, read.segs, read.stop, read.nested]), [
    ['flags', [], 'dynamic-key', false],
    ['key', [], null, true],
  ]);
  assert.deepEqual(reads("flags['flagA']")[0].segs, ['flagA']);
  assert.deepEqual(reads('helper(a.b)').map((read) => [read.root, read.stop, read.nested]), [
    ['helper', 'call', false],
    ['a', null, true],
  ]);
});

test('Client conditions AC-5: a chain longer than the hop limit ends with depth-limit', () => {
  const aliases = [];
  for (let k = 1; k <= HOP_LIMIT + 1; k += 1) aliases.push(`  const a${k} = ${k === 1 ? 'props.root' : `a${k - 1}`};`);
  const code = `export function Panel(props) {\n${aliases.join('\n')}\n  return a${HOP_LIMIT + 1} && (<span>x</span>);\n}\n`;
  const facts = clientFacts([jsx(code)]);
  const read = only(facts, 'client_read', (entry) => entry.context === 'condition');
  assert.equal(read.traces.length, 1);
  assert.equal(read.traces[0].hops.length, HOP_LIMIT);
  assert.deepEqual(read.traces[0].end, { unresolved: 'depth-limit' });
  assert.equal(read.unresolved, 'depth-limit');
  assert.ok(read.traces[0].hops.every((hop) => hop.step === 'alias'));
});

test('Client conditions AC-5: more branches than the trace limit end the last trace with trace-limit', () => {
  const sets = [];
  for (let k = 0; k <= TRACE_LIMIT; k += 1) sets.push(`    this.flag = ${k};`);
  const code = `class BoardComponent {\n  flag: number;\n  ngOnInit() {\n${sets.join('\n')}\n  }\n}\n`;
  const facts = clientFacts([angular(code, '<p *ngIf="flag">x</p>')]);
  const read = only(facts, 'client_read', (entry) => entry.context === 'condition');
  assert.equal(read.traces.length, TRACE_LIMIT);
  assert.ok(read.traces.slice(0, -1).every((trace) => trace.end.origin === 'literal'));
  assert.deepEqual(read.traces[TRACE_LIMIT - 1].end, { unresolved: 'trace-limit' });
  assert.equal(read.unresolved, 'trace-limit');
});

test('Client conditions AC-6: an internal error is a partial region, never a lost one', () => {
  const region = angularRegion({
    component: 'BrokenComponent',
    classFile: 'src/broken.component.ts',
    code: null,
    bodyStart: 0,
    bodyEnd: 0,
    template: { text: '<p></p>', start: 0, propertyOffset: 0 },
  });
  const [scan] = clientFacts([region]);
  assert.equal(scan.type, 'client_scan');
  assert.equal(scan.status, 'partial');
  assert.deepEqual(scan.unsupported.map((entry) => [entry.reason, entry.internal]), [['unsupported-syntax', true]]);
});

test('Client conditions AC-8: the five types are registered with their required fields', () => {
  const site = { file: 'src/a.ts', line: 1 };
  const valid = [
    { type: 'display_condition', ...site, component: 'A', form: 'ngIf', shows: false, text: 'x' },
    { type: 'client_transfer', ...site, component: 'A', target: 'b-c', name: 'x', text: 'y' },
    { type: 'client_assignment', ...site, component: 'A', target: 'x', text: 'y' },
    { type: 'client_read', ...site, component: 'A', path: 'x', context: 'condition' },
    { type: 'client_scan', ...site, component: 'A', region: 'template', status: 'complete' },
  ];
  assert.equal(validateFacts(valid), valid.length);
  for (const entry of valid) {
    for (const key of Object.keys(entry)) {
      if (key === 'type') continue;
      const { [key]: dropped, ...rest } = entry;
      assert.throws(() => validateFacts([rest]), new RegExp(key), `${entry.type} without ${key}`);
    }
  }
});

test('Client conditions AC-8: the closed lists are frozen and the reader keeps to them', () => {
  for (const list of [TRACE_STEPS, TRACE_REASONS, REGION_ROW_REASONS, REGION_FAILURES, REGION_STATES]) {
    assert.ok(Object.isFrozen(list));
  }
  assert.deepEqual([...TRACE_REASONS], [
    'dynamic-key', 'store-selector', 'call', 'external-root', 'unsupported-local',
    'no-binding', 'spread-props',
    'ambiguous', 'cycle', 'depth-limit', 'trace-limit',
    'unsupported-syntax', 'unsupported-form',
  ]);
  const code = 'class BoardComponent {\n  @Input() on: boolean;\n  ready = true;\n  get both() { return this.ready && this.on; }\n}\n';
  const html = '<div *ngIf="both; else other" [hidden]="!ready"></div><div *ngFor="let item of items"></div>';
  const first = clientFacts([angular(code, html)]);
  const second = clientFacts([angular(code, html)]);
  assert.deepEqual(first, second);
  for (const entry of first.filter((fact) => fact.type === 'client_read')) {
    for (const trace of entry.traces) {
      assert.ok(trace.hops.every((hop) => TRACE_STEPS.includes(hop.step)));
      assert.ok(trace.end.origin === 'literal' || TRACE_REASONS.includes(trace.end.unresolved));
    }
  }
});

const CLIENT_TYPES = new Set(['display_condition', 'client_transfer', 'client_assignment', 'client_read', 'client_scan']);

function corpusFacts(t, name, repo, prepare = () => {}) {
  const dir = copyFixture(t, name);
  prepare(dir);
  extract(dir, `${name}.config.json`);
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
}

const mobileFacts = (t, prepare) => corpusFacts(t, 'tidepool-mobile', 'mobile', prepare);
const webFacts = (t, prepare) => corpusFacts(t, 'tidepool-web', 'web', prepare);

function of(facts, type, fields) {
  return facts.filter((entry) => entry.type === type && Object.entries(fields).every(([key, value]) => entry[key] === value));
}

function one(facts, type, fields) {
  const found = of(facts, type, fields);
  assert.equal(found.length, 1, `one ${type} ${JSON.stringify(fields)}`);
  return found[0];
}

const steps = (trace) => trace.hops.map((hop) => hop.step);
const ends = (read) => read.traces.map((trace) => trace.end.unresolved || 'literal');

test('Client conditions AC-1: Angular display conditions and their reads', (t) => {
  const facts = mobileFacts(t);
  const harbor = of(facts, 'display_condition', { component: 'HarborPanelComponent' });
  assert.deepEqual(harbor.map((entry) => [entry.form, entry.shows, entry.text, entry.line]), [
    ['ngIf', true, 'showDock', 2],
    ['ngIf', true, '!quiet', 3],
    ['ngIf', true, 'ready && (open || !locked); else waiting', 4],
    ['ngIf', true, '(tide$ | async) as tide', 6],
    ['hidden', false, '!ready', 7],
  ]);
  for (const entry of harbor) {
    assert.equal(entry.file, 'src/app/features/harbor/harbor-panel.component.html');
    assert.equal(entry.componentFile, 'src/app/features/harbor/harbor-panel.component.ts');
  }
  const conditionReads = of(facts, 'client_read', { component: 'HarborPanelComponent', context: 'condition' });
  assert.deepEqual(conditionReads.map((entry) => [entry.path, entry.negated, entry.site.line]), [
    ['showDock', false, 2],
    ['quiet', true, 3],
    ['ready', false, 4],
    ['open', false, 4],
    ['locked', true, 4],
    ['tide$', false, 6],
    ['ready', true, 7],
  ]);
  const tide = one(facts, 'client_read', { component: 'HarborPanelComponent', path: 'tide.level' });
  assert.deepEqual(steps(tide.traces[0]), ['alias', 'async', 'member']);
  const inline = of(facts, 'display_condition', { component: 'BuoyComponent' });
  assert.equal(inline.length, 3);
  for (const entry of inline) {
    assert.equal(entry.file, 'src/app/features/harbor/buoy.component.ts');
    assert.equal(entry.line, 5);
    assert.equal(entry.componentFile, undefined);
  }
  assert.deepEqual(inline.map((entry) => entry.column), [20, 51, 77]);
});

test('Client conditions AC-2: JSX display conditions and their reads', (t) => {
  const facts = webFacts(t);
  const forms = of(facts, 'display_condition', {}).map((entry) => [entry.component, entry.form, entry.shows, entry.text]);
  assert.deepEqual(forms, [
    ['Deck', 'early-return', false, 'loading'],
    ['Deck', 'early-return', false, '!ready || m'],
    ['Deck', 'and', true, 'flags.flagA'],
    ['Deck', 'and', true, 'ready'],
    ['Deck', 'ternary', 'both', 'm'],
    ['Deck', 'ternary', 'both', 'inner'],
    ['Pier', 'early-return', false, '!spare'],
    ['Pier', 'return-and', true, 'childFlag'],
    ['Skiff', 'return-and', true, 'sail'],
    ['Jetty', 'early-return', false, 'open'],
    ['Jetty', 'return-and', true, 'props.visible'],
    ['Mooring', 'and', true, 'this.props.showRope'],
    ['Mooring', 'and', true, 'this.state.coiled'],
    ['Quay', 'and', true, 'latch'],
    ['Quay', 'ternary', 'both', 'level'],
    ['Shoal', 'and', true, 'picked'],
    ['Shoal', 'and', true, 'captured'],
    ['Shoal', 'and', true, 'twin'],
  ]);
  const compound = of(facts, 'client_read', { component: 'Deck', context: 'condition' }).filter((entry) => entry.site.line === 7);
  assert.deepEqual(compound.map((entry) => [entry.path, entry.negated]), [['ready', true], ['m', false]]);
});

test('Client conditions AC-3: aliases, assignments and destructuring give one trace per branch', (t) => {
  const mobile = mobileFacts(t);
  const dock = one(mobile, 'client_read', { component: 'HarborPanelComponent', path: 'showDock', context: 'condition' });
  assert.equal(dock.traces.length, 2);
  assert.deepEqual(steps(dock.traces[0]), ['member']);
  assert.deepEqual(dock.traces[0].end, { origin: 'literal', text: 'false' });
  assert.deepEqual(steps(dock.traces[1]), ['assignment', 'input']);
  assert.equal(dock.traces[1].hops[1].path, 'config.dock.open');
  for (const hop of dock.traces.flatMap((trace) => trace.hops)) {
    assert.equal(hop.file, 'src/app/features/harbor/harbor-panel.component.ts');
    assert.ok(Number.isInteger(hop.line) && Number.isInteger(hop.column));
  }
  assert.deepEqual(of(mobile, 'client_assignment', { component: 'HarborPanelComponent', target: 'showDock' }).map((entry) => [entry.step, entry.text, entry.line]), [
    ['member', 'false', 12],
    ['assignment', 'this.config?.dock.open', 22],
  ]);
  const quiet = one(mobile, 'client_read', { component: 'HarborPanelComponent', path: 'quiet' });
  assert.deepEqual(steps(quiet.traces[0]), ['getter', 'member']);
  one(mobile, 'client_assignment', { component: 'HarborPanelComponent', target: 'quiet', step: 'getter' });

  const web = webFacts(t);
  const pathsOf = (component, path) => one(web, 'client_read', { component, path, context: 'condition' }).traces.map((trace) => [steps(trace), trace.hops.at(-1).path]);
  assert.deepEqual(pathsOf('Jetty', 'open'), [[['alias', 'prop'], 'props.harbor.open']]);
  assert.deepEqual(pathsOf('Quay', 'latch'), [[['destructure', 'prop'], 'props.gate.latch']]);
  assert.deepEqual(pathsOf('Quay', 'level'), [[['destructure', 'prop'], 'props.tide']]);
  assert.deepEqual(pathsOf('Deck', 'inner'), [[['destructure', 'prop'], 'props.nested.inner']]);
  assert.deepEqual(pathsOf('Mooring', 'props.showRope'), [[['prop'], 'props.showRope']]);
  one(web, 'client_assignment', { component: 'Jetty', target: 'open', step: 'alias', text: 'props.harbor.open' });
  one(web, 'client_assignment', { component: 'Quay', target: 'latch', step: 'destructure' });
});

test('Client conditions AC-4: transfers cross to each parent site', (t) => {
  const mobile = mobileFacts(t);
  const transfer = one(mobile, 'client_transfer', { component: 'HarborPanelComponent', name: 'childFlag' });
  assert.deepEqual([transfer.target, transfer.text, transfer.form, transfer.targetComponent], ['tp-buoy', 'item.flags.flagA', 'property', 'BuoyComponent']);
  one(mobile, 'client_read', { component: 'HarborPanelComponent', path: 'item.flags.flagA', context: 'transfer' });
  const child = one(mobile, 'client_read', { component: 'BuoyComponent', path: 'childFlag' });
  assert.equal(child.traces.length, 2);
  assert.deepEqual(steps(child.traces[0]), ['input', 'transfer', 'iteration', 'member']);
  assert.equal(child.traces[0].hops[1].path, 'item.flags.flagA');
  assert.equal(child.traces[0].hops[3].path, 'items[].flags.flagA');
  assert.equal(child.traces[1].hops[1].path, 'flags.flagB');
  assert.deepEqual(ends(one(mobile, 'client_read', { component: 'BuoyComponent', path: 'drift' })), ['no-binding', 'no-binding']);
  assert.deepEqual(ends(one(mobile, 'client_read', { component: 'BuoyComponent', path: 'spare' })), ['no-binding', 'unsupported-form']);

  const web = webFacts(t);
  assert.equal(of(web, 'client_transfer', { component: 'Deck', name: 'childFlag', targetComponent: 'Pier' }).length, 5);
  const pier = one(web, 'client_read', { component: 'Pier', path: 'childFlag' });
  assert.deepEqual(pier.traces[0].hops.slice(2, 3).map((hop) => [hop.step, hop.path]), [['transfer', 'flags.flagA']]);
  const mapped = pier.traces.find((trace) => trace.hops.some((hop) => hop.step === 'iteration'));
  assert.equal(mapped.hops.find((hop) => hop.step === 'transfer').path, 'boat.flags.flagA');
  assert.deepEqual(ends(pier).slice(-2), ['unsupported-form', 'unsupported-form']);
  assert.deepEqual(ends(one(web, 'client_read', { component: 'Skiff', path: 'sail' })), ['spread-props']);
});

test('Client conditions AC-5: each stop names its reason', (t) => {
  const mobile = mobileFacts(t);
  const reef = Object.fromEntries(of(mobile, 'client_read', { component: 'ReefBoardComponent', context: 'condition' }).map((entry) => [entry.path, entry.unresolved || null]));
  assert.deepEqual(reef, {
    flags: 'dynamic-key',
    key: null,
    'flags.flagA': null,
    'pick$': 'store-selector',
    isOpen: 'call',
    'session.active': 'external-root',
    depth: 'external-root',
    'probe.value': 'unsupported-local',
    'row.on': 'unsupported-local',
    i: 'unsupported-local',
    first: 'cycle',
    orphan: 'unsupported-syntax',
    mirror: 'unsupported-syntax',
  });
  const loop = one(mobile, 'client_read', { component: 'ReefBoardComponent', path: 'first', context: 'condition' });
  assert.deepEqual(steps(loop.traces[0]), ['member', 'member']);
  const tide = one(mobile, 'client_read', { component: 'HarborPanelComponent', path: 'tide$' });
  assert.equal(tide.unresolved, 'store-selector');
  for (const component of ['TwinAComponent', 'TwinBComponent']) {
    assert.equal(one(mobile, 'client_read', { component, path: 'shown' }).unresolved, 'ambiguous');
  }
  const web = webFacts(t);
  const shoal = Object.fromEntries(of(web, 'client_read', { component: 'Shoal', context: 'condition' }).map((entry) => [entry.path, ends(entry)]));
  assert.deepEqual(shoal, { picked: ['store-selector'], captured: ['literal', 'unsupported-syntax'], twin: ['ambiguous'] });
  assert.equal(one(web, 'client_read', { component: 'Mooring', path: 'state.coiled' }).unresolved, 'unsupported-syntax');
  for (const entry of [...mobile, ...web].filter((fact) => fact.type === 'client_read')) {
    assert.equal(entry.unresolved, entry.traces.find((trace) => trace.end.unresolved)?.end.unresolved);
    for (const trace of entry.traces) assert.ok(trace.end.origin === 'literal' || TRACE_REASONS.includes(trace.end.unresolved));
  }
});

test('Client conditions AC-6: each region states whether the reader read all of it', (t) => {
  const mobile = mobileFacts(t);
  const web = webFacts(t);
  const scans = Object.fromEntries([...mobile, ...web].filter((entry) => entry.type === 'client_scan').map((entry) => [entry.component, entry]));
  for (const name of ['CalmNoteComponent', 'Calm']) {
    assert.equal(scans[name].status, 'complete');
    assert.equal(scans[name].counts.reads, 0);
  }
  assert.equal(scans.HarborPanelComponent.status, 'complete');
  assert.equal(scans.HarborPanelComponent.line, 1);
  assert.equal(scans.BuoyComponent.line, 5);
  assert.equal(scans.Deck.line, 5);
  assert.equal(scans.ReefBoardComponent.status, 'partial');
  assert.deepEqual(scans.ReefBoardComponent.unsupported.map((row) => [row.line, row.reason]), [
    [15, 'unsupported-syntax'],
    [16, 'unsupported-form'],
    [17, 'unsupported-form'],
  ]);
  assert.deepEqual(scans.Shoal.unsupported.map((row) => [row.reason, row.text]), [['unsupported-form', 'mode || <span>fallback</span>']]);
  assert.deepEqual(['DriftNoteComponent', 'EddyNoteComponent', 'SwellNoteComponent'].map((name) => [scans[name].status, scans[name].reason, scans[name].line]), [
    ['failed', 'template-url-unresolved', 5],
    ['failed', 'template-url-non-literal', 7],
    ['failed', 'inline-template-substitution', 7],
  ]);
  for (const scan of Object.values(scans)) {
    assert.ok(REGION_STATES.includes(scan.status));
    for (const row of scan.unsupported || []) {
      assert.ok(REGION_ROW_REASONS.includes(row.reason));
      assert.equal(row.internal, undefined);
    }
    if (scan.reason) assert.ok(REGION_FAILURES.includes(scan.reason));
  }
});

// Each name keeps its length, so a renamed corpus keeps every line and column.
const RENAMED = [
  'showDock', 'locked', 'flagA', 'flagB', 'childFlag', 'spare', 'dock', 'quiet', 'orphan', 'mirror',
  'cells', 'cell', 'shown', 'inner', 'boats', 'boat', 'sail', 'latch', 'showRope', 'coiled', 'captured',
  'picked', 'visible', 'loading', 'flags', 'ready', 'mode', 'items', 'item', 'open', 'first', 'second',
  'depth', 'count', 'active', 'gate', 'rest',
];
const rot13 = (name) => name.replace(/[a-z]/gi, (ch) => {
  const base = ch <= 'Z' ? 65 : 97;
  return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
});
const renameText = (text) => text.replace(new RegExp(`\\b(${RENAMED.join('|')})\\b`, 'g'), (name) => rot13(name));

function renameTree(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) renameTree(path);
    else writeFileSync(path, renameText(readFileSync(path, 'utf8')));
  }
}

test('Client conditions AC-7: the facts do not depend on field names', (t) => {
  for (const [read, root] of [[mobileFacts, 'mobile'], [webFacts, 'web']]) {
    const plain = read(t).filter((entry) => CLIENT_TYPES.has(entry.type));
    const renamed = read(t, (dir) => renameTree(join(dir, root))).filter((entry) => CLIENT_TYPES.has(entry.type));
    assert.ok(plain.length > 20);
    assert.notDeepEqual(renamed, plain);
    assert.deepEqual(renamed, JSON.parse(renameText(JSON.stringify(plain))));
  }
});

function tableNames(doc, heading) {
  const at = doc.indexOf(heading);
  assert.ok(at >= 0, heading);
  const rows = [];
  for (const line of doc.slice(at + heading.length).split('\n').slice(1)) {
    if (rows.length > 0 && !line.startsWith('|')) break;
    const name = /^\| `([^`]+)` \|/.exec(line);
    if (name) rows.push(name[1]);
  }
  return rows;
}

test('Client conditions AC-8: the schema doc and the changelog fragment state the contract', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'fact-schema.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### Client display conditions'), doc.indexOf('### Control evidence'));
  assert.deepEqual(tableNames(section, '| type | fields | stated when |'), [...CLIENT_TYPES]);
  assert.deepEqual(tableNames(section, '| step | the hop goes to |'), [...TRACE_STEPS]);
  assert.deepEqual(tableNames(section, '| reason | the trace stops at |'), [...TRACE_REASONS]);
  assert.deepEqual(tableNames(section, '| reason | the template |'), [...REGION_FAILURES]);
  for (const word of [...REGION_STATES, ...REGION_ROW_REASONS, 'ngIf', 'hidden', 'early-return', 'return-and', 'ternary', 'property', 'two-way', 'spread']) {
    assert.ok(section.includes(`\`${word}\``), word);
  }
  const fragment = readFileSync(join(REPO_ROOT, 'changes', 'changelog', 'feat-client-display-conditions.md'), 'utf8');
  assert.match(fragment, /^### Extraction$/m);
  for (const text of [section, fragment].map((raw) => raw.replace(/\s+/g, ' '))) {
    assert.match(text, /a new facts `?digest/);
    assert.match(text, /status\.identity/);
    assert.match(text, /provenance\.id/);
    assert.match(text, /fact count of a set changes with its facts/);
    assert.match(text, /only facts are new facts is a file that the extractor read/);
  }
});

test('Client conditions AC-8: two extractions give the same facts in the same order', (t) => {
  assert.deepEqual(mobileFacts(t), mobileFacts(t));
  assert.deepEqual(webFacts(t), webFacts(t));
});
