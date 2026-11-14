import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFacts } from '../lib/facts.js';
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
