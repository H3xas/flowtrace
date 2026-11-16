/**
 * Caller gates, read from the `lock-keeper` corpus: the gates a web or mobile call site
 * carries on its hop, the caller cases a walk derives from them, and the readers that stay as
 * they were.
 *
 * A comparison runs two copies of the corpus: one as extracted, and one with each
 * `caller_gate` record removed. The walk's status identity hashes the facts it read, so it
 * differs between the two by design.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { copyFixture, runCli } from './helpers.js';
import { BASELINE_FILE, captureBaseline, compareBaselines } from './caller-gate-baseline.js';
import { withoutGateFields, withoutGateLines } from './gate-output.js';
import { buildCallerCases } from '../lib/trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = 'lock.config.json';
const SAVE = 'POST lock/v1/passages';
const LOAD = 'GET lock/v1/passages/{passageId}';
// A caller reaches the load route through a template, which the walk names with a wildcard.
const LOAD_REACHED = 'GET lock/v1/passages/*';
const WEB_DESK = 'src/passages/PassageDesk.ts';
const MOBILE_DESK = 'src/app/features/passages/passage-desk.service.ts';
const PANEL = 'src/passages/PassagePanel.tsx';
const KEEPER = 'src/passages/KeeperPanel.tsx';
const HARBOR = 'src/passages/HarborPanel.tsx';
const BARGE = 'src/passages/BargePanel.tsx';

const SIDES = [
  { repo: 'web', file: WEB_DESK, start: 'PassageDesk', call: 'api.' },
  { repo: 'mobile', file: MOBILE_DESK, start: 'PassageDeskService', call: 'this.api.' },
];

function extract(t, mutate) {
  const dir = copyFixture(t, 'lock-keeper');
  const run = (args) => runCli([...args, '--config', CONFIG], { cwd: dir });
  const extracted = run(['extract']);
  assert.equal(extracted.status, 0, extracted.stderr);
  const factsFile = (repo) => join(dir, 'out', 'facts', `${repo}.json`);
  const read = (repo) => JSON.parse(readFileSync(factsFile(repo), 'utf8'));
  const write = (repo, set) => writeFileSync(factsFile(repo), JSON.stringify(set, null, 2));
  if (mutate) mutate({ read, write });
  const lines = (repo, file) => readFileSync(join(dir, repo, file), 'utf8').split('\n');
  const ok = (args) => {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  return { dir, run, ok, read, lines, json: (args) => JSON.parse(ok([...args, '--json']).stdout) };
}

const withoutGates = ({ read, write }) => {
  for (const repo of ['web', 'mobile']) {
    const set = read(repo);
    set.facts = set.facts.filter((item) => item.type !== 'caller_gate');
    write(repo, set);
  }
};

/** Line lookups in one source file: a line by its text, the nth line after a method header. */
function locate(lines) {
  const lineOf = (text, from = 1) => {
    const at = lines.findIndex((line, i) => i + 1 >= from && line.includes(text));
    assert.notEqual(at, -1, `the source holds ${text}`);
    return at + 1;
  };
  const inMethod = (method, text) => lineOf(text, lineOf(`  ${method}(`));
  return { lineOf, inMethod };
}

/** Every call site listed on some hop of a `trace --json` walk, once each. */
function listedSites(doc) {
  const out = new Map();
  for (const node of doc.nodes) {
    for (const site of node.callerGates || []) out.set(JSON.stringify(site), site);
  }
  return [...out.values()];
}

/** The same sites by `line:column`, for a side where no two sites share both. */
function gatedSites(doc) {
  return new Map(listedSites(doc).map((site) => [`${site.line}:${site.column}`, site]));
}

const shape = (gate) => [gate.text, gate.kind, gate.arm, gate.outcomes, gate.status, gate.reason ?? null];

const SENDS_TRUE = { true: 'sends', false: 'skips' };
const SKIPS_TRUE = { true: 'skips', false: 'sends' };
const UNKNOWN = { true: 'unknown', false: 'unknown' };

/**
 * The gates of each call in the shared desk body: the method, the call text, the gate text
 * the walk names, and the shape the gate takes. An empty list is a call no decision gates.
 */
const ARM_GATES = [
  ['submit', 'save(x)', [['if (form.valid)', 'if', 'then', SENDS_TRUE, 'known', null]]],
  ['elseArm', 'load(x.id)', [['if (ready)', 'if', 'then', SENDS_TRUE, 'known', null]]],
  ['elseArm', 'save(x)', [['if (ready)', 'if', 'else', SKIPS_TRUE, 'known', null]]],
  ['elseIf', 'save(x)', [
    ['if (first)', 'if', 'else', SKIPS_TRUE, 'known', null],
    ['if (second)', 'if', 'then', SENDS_TRUE, 'known', null],
  ]],
  ['clause', 'save(x)', [["case 'new':", 'case', 'case', { match: 'sends', other: 'skips' }, 'known', null]]],
  ['clause', 'load(x.id)', [["case 'kept':", 'case', 'case', { match: 'sends', other: 'unknown' }, 'unknown', 'fall-through']]],
  ['andRight', 'save(x)', [['open && $save(x)', 'logical', 'right', SENDS_TRUE, 'known', null]]],
  ['orRight', 'save(x)', [['cached || $save(x)', 'logical', 'right', SKIPS_TRUE, 'known', null]]],
  ['coalesceRight', 'save(x)', [['held ?? $save(x)', 'coalesce', 'right', { nullish: 'sends', set: 'skips' }, 'known', null]]],
  ['ranked', 'save(x)', [['first && second || $save(x)', 'logical', 'right', SKIPS_TRUE, 'known', null]]],
  ['mixed', 'save(x)', [['first || second && $save(x)', 'logical', 'right', UNKNOWN, 'unknown', 'mixed-operators']]],
  ['groupedAnd', 'save(x)', [['(open && $save(x)) || held', 'logical', 'right', UNKNOWN, 'unknown', 'mixed-operators']]],
  ['groupedCoalesce', 'save(x)', [['(held ?? $save(x)) ?? kept', 'coalesce', 'right', { nullish: 'unknown', set: 'unknown' }, 'unknown', 'mixed-operators']]],
  ['argumentAnd', 'save(x)', []],
  ['commaAnd', 'save(x)', []],
  ['ternaryAnd', 'save(x)', [['open ? held && kept : $save(x)', 'ternary', 'alternate', SKIPS_TRUE, 'known', null]]],
  ['display', 'save({', []],
  ['inCondition', 'load(x.id)', []],
];

/** The gates an early exit before the call gives it, in the same shape. */
const EXIT_GATES = [
  ['returnExit', 'save(x)', [['if (form.invalid)', 'if', 'exit', SKIPS_TRUE, 'known', null]]],
  ['throwExit', 'save(x)', [['if (form.invalid)', 'if', 'exit', SKIPS_TRUE, 'known', null]]],
  ['blockExit', 'save(x)', [
    ['if (form.ready)', 'if', 'then', SENDS_TRUE, 'known', null],
    ['if (form.invalid)', 'if', 'exit', SKIPS_TRUE, 'known', null],
  ]],
  ['callbackExit', 'save(x)', []],
  ['otherMethodExit', 'save(x)', []],
  ['partialExit', 'save(x)', [['if (form.ready)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-one-arm']]],
  ['oneArmExit', 'save(x)', [['if (form.valid)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-one-arm']]],
  ['breakExit', 'save(row)', [['if (row.invalid)', 'if', 'exit', UNKNOWN, 'unknown', 'loop-exit']]],
  ['continueExit', 'save(row)', [['if (row.invalid)', 'if', 'exit', UNKNOWN, 'unknown', 'loop-exit']]],
  ['elseBlockExit', 'save(x)', [
    ['if (form.invalid)', 'if', 'exit', SKIPS_TRUE, 'known', null],
    ['if (form.stale)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-one-arm'],
  ]],
  ['helperExit', 'save(x)', []],
  ['classExit', 'save(x)', []],
  ['typedHelperExit', 'save(x)', []],
  ['bareBlockExit', 'save(x)', [['if (form.invalid)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-one-arm']]],
  ['staticBlockExit', 'save(x)', [['if (form.invalid)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-one-arm']]],
  ['tryExit', 'save(x)', [['if (form.invalid)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-try']]],
  ['catchExit', 'save(x)', [['if (form.strict)', 'if', 'exit', UNKNOWN, 'unknown', 'exit-in-try']]],
];

const DESK_GATES = [...ARM_GATES, ...EXIT_GATES];

/** The call sites of one desk body, by method and call text, and the gate lines they name. */
function deskSites(env, side) {
  const lines = env.lines(side.repo, side.file);
  const { lineOf, inMethod } = locate(lines);
  const doc = env.json(['trace', side.start]);
  const sites = gatedSites(doc);
  const siteAt = (method, call) => {
    const line = inMethod(method, `${side.call}${call}`);
    const column = side.repo === 'web' ? lines[line - 1].indexOf(`${side.call}${call}`) + 1 : null;
    return { line, column, site: sites.get(`${line}:${column}`) };
  };
  return { doc, lineOf, inMethod, siteAt, sites, all: listedSites(doc) };
}

test('Caller gates AC-8: a web component call carries the gate of its if on its hop', (t) => {
  const env = extract(t);
  const lines = env.lines('web', PANEL);
  const { lineOf } = locate(lines);
  const ifLine = lineOf('if (form.valid)');
  const callLine = lineOf('api.save(x);');
  const doc = env.json(['trace', 'PassagePanel']);
  const hops = doc.nodes.filter((node) => node.callerGates);
  assert.deepEqual(hops.map((node) => node.ref), ['Api.save']);
  assert.deepEqual(hops[0].callerGates, [{
    file: PANEL,
    line: callLine,
    column: lines[callLine - 1].indexOf('api.save') + 1,
    gates: [{
      decision: `web:${PANEL}:${ifLine}:if`,
      kind: 'if',
      text: 'if (form.valid)',
      file: PANEL,
      line: ifLine,
      endLine: ifLine + 2,
      arm: 'then',
      outcomes: SENDS_TRUE,
      status: 'known',
    }],
  }]);
  const load = doc.nodes.find((node) => node.ref === 'Api.load');
  assert.ok(load, 'the call inside a condition is walked');
  assert.equal(load.callerGates, undefined, 'a call inside a condition is not gated by it');
  assert.ok(
    env.read('web').facts.some((item) => item.type === 'branch_point' && item.text.includes("'Open'")),
    'the display ternary is a caller decision',
  );

  const tree = env.ok(['trace', 'PassagePanel']).stdout;
  const gateLines = tree.split('\n').filter((line) => line.includes('◇'));
  assert.equal(gateLines.length, 1);
  assert.match(gateLines[0], new RegExp(`◇ gate if \\(form\\.valid\\)  if/then: true sends, false skips  ${PANEL}:${ifLine}  #web:${PANEL}:${ifLine}:if$`));
  const at = tree.split('\n').indexOf(gateLines[0]);
  assert.match(tree.split('\n')[at - 1], /Api\.save  web  src\/api\.ts:3/, 'the gate line sits under its hop');

  env.ok(['trace', 'PassagePanel', '--html', 'trace.html']);
  const html = readFileSync(join(env.dir, 'trace.html'), 'utf8');
  assert.ok(html.includes(`gate if (form.valid)  if/then: true sends, false skips  ${PANEL}:${ifLine}`), 'the page prints the same gate line');
});

test('Caller gates AC-9: the same forms in a mobile class give the same gates', (t) => {
  const env = extract(t);
  const web = deskSites(env, SIDES[0]);
  const mobile = deskSites(env, SIDES[1]);
  const callLine = mobile.inMethod('submit', 'this.api.save(x)');
  const ifLine = mobile.inMethod('submit', 'if (form.valid)');
  const record = env.read('mobile').facts.find((item) => item.type === 'caller_gate' && item.line === callLine);
  assert.deepEqual(
    [record.call, record.file, record.column, record.class, record.method, record.ordinal],
    ['method_call', MOBILE_DESK, null, 'PassageDeskService', 'submit', 0],
  );
  const span = env.read('mobile').facts.find(
    (item) => item.type === 'method_span' && item.class === record.class && item.method === record.method,
  );
  assert.ok(span && span.line <= callLine && callLine <= span.endLine, 'the record names the class and method of its mobile span');

  const site = mobile.siteAt('submit', 'save(x)').site;
  assert.deepEqual(site.gates, [{
    decision: `mobile:${MOBILE_DESK}:${ifLine}:if`,
    kind: 'if',
    text: 'if (form.valid)',
    file: MOBILE_DESK,
    line: ifLine,
    endLine: ifLine + 2,
    arm: 'then',
    outcomes: SENDS_TRUE,
    status: 'known',
  }]);
  const hop = mobile.doc.nodes.find((node) => (node.callerGates || []).includes(site));
  assert.equal(hop.ref, 'PassageApiService.save');

  for (const [method, call] of DESK_GATES) {
    const left = web.siteAt(method, call).site;
    const right = mobile.siteAt(method, call).site;
    assert.deepEqual(
      (right ? right.gates : []).map((gate) => shape(gate).slice(1)),
      (left ? left.gates : []).map((gate) => shape(gate).slice(1)),
      `${method} ${call}`,
    );
  }
});

test('Caller gates AC-9: a static call of a plain class carries its gate on its hop', (t) => {
  const env = extract(t);
  const clerk = 'src/app/features/passages/passage-clerk.service.ts';
  const { lineOf } = locate(env.lines('mobile', clerk));
  const ifLine = lineOf('if (ready)');
  const callLine = lineOf('PassageLedger.record(x);');
  const record = env.read('mobile').facts.find((item) => item.type === 'caller_gate' && item.file === clerk);
  assert.deepEqual([record.call, record.line, record.class, record.method], ['method_call', callLine, 'PassageClerkService', 'file']);
  const doc = env.json(['trace', 'PassageClerkService.file', '--expand']);
  const hops = doc.nodes.filter((node) => node.callerGates);
  assert.deepEqual(hops.map((node) => node.ref), ['PassageLedger.record']);
  assert.deepEqual(hops[0].callerGates.map((site) => [site.line, site.gates.map((gate) => [gate.decision, gate.arm, gate.outcomes])]), [
    [callLine, [[`mobile:${clerk}:${ifLine}:if`, 'then', SENDS_TRUE]]],
  ]);
});

function expectGates(env, table) {
  for (const side of SIDES) {
    const desk = deskSites(env, side);
    for (const [method, call, expected] of table) {
      const { site } = desk.siteAt(method, call);
      const named = expected.map(([text, ...rest]) => [text.replace('$', side.call), ...rest]);
      assert.deepEqual(site ? site.gates.map(shape) : [], named, `${side.repo} ${method} ${call}`);
      for (const gate of site ? site.gates : []) {
        assert.equal(gate.line, desk.inMethod(method, gate.text), `${side.repo} ${method} ${gate.text}`);
        assert.equal(gate.decision, `${side.repo}:${side.file}:${gate.line}:${gate.kind}`, `${side.repo} ${method} ${gate.text}`);
      }
    }
  }
}

test('Caller gates AC-10: each arm and right operand gives its gate, or unknown', (t) => {
  expectGates(extract(t), ARM_GATES);
});

test('Caller gates AC-11: an early exit before the call gates it, or reads unknown', (t) => {
  expectGates(extract(t), EXIT_GATES);
});

test('Caller gates AC-12: one caller case per distinct gate, with its prerequisites and skipped routes', (t) => {
  const env = extract(t);
  const keeper = locate(env.lines('web', KEEPER));
  const outer = keeper.lineOf('if (form.valid)');
  const inner = keeper.lineOf('if (user.signedIn)');
  const call = keeper.lineOf('api.save(x);');
  const column = env.lines('web', KEEPER)[call - 1].indexOf('api.save') + 1;
  const skipped = [{ file: KEEPER, line: call, column, routes: [SAVE] }];
  const doc = env.json(['trace', 'KeeperPanel', '--seeds']);
  assert.deepEqual(doc.callerCases, [
    {
      id: 'C1',
      gate: { decision: `web:${KEEPER}:${outer}:if`, kind: 'if', text: 'if (form.valid)', file: KEEPER, line: outer, arm: 'then' },
      when: 'false',
      outcome: 'skips',
      prerequisites: [[]],
      notEvaluated: [{ decision: `web:${KEEPER}:${inner}:if`, text: 'if (user.signedIn)' }],
      skipped,
    },
    {
      id: 'C2',
      gate: { decision: `web:${KEEPER}:${inner}:if`, kind: 'if', text: 'if (user.signedIn)', file: KEEPER, line: inner, arm: 'then' },
      when: 'false',
      outcome: 'skips',
      prerequisites: [[{ decision: `web:${KEEPER}:${outer}:if`, text: 'if (form.valid)', when: 'true' }]],
      notEvaluated: [],
      skipped,
    },
  ]);
  assert.equal(env.json(['trace', 'KeeperPanel']).callerCases, undefined, 'cases come only with --seeds');

  const text = env.ok(['trace', 'KeeperPanel', '--seeds']).stdout.split('\n');
  const block = text.slice(text.indexOf('caller cases (2):'));
  assert.deepEqual(block.slice(0, 8), [
    'caller cases (2):',
    `C1  if (form.valid) = false  → skips ${KEEPER}:${call}:${column}`,
    `    gate web:${KEEPER}:${outer}:if then`,
    '    not evaluated: if (user.signedIn)',
    `    call ${KEEPER}:${call}:${column}: ${SAVE}`,
    `C2  if (user.signedIn) = false  → skips ${KEEPER}:${call}:${column}`,
    `    gate web:${KEEPER}:${inner}:if then`,
    '    after: if (form.valid) = true',
  ]);
  assert.ok(text.indexOf('caller cases (2):') > text.findIndex((line) => line.startsWith('use-case seeds')), 'the cases follow the seeds');

  env.ok(['trace', 'KeeperPanel', '--seeds', '--html', 'keeper.html']);
  const page = readFileSync(join(env.dir, 'keeper.html'), 'utf8');
  const caseBlock = block.slice(0, block.indexOf(''));
  assert.equal(caseBlock.length, 9);
  for (const line of caseBlock) assert.ok(page.includes(line), `the page prints ${line}`);
  env.ok(['trace', 'KeeperPanel', '--html', 'plain.html']);
  assert.ok(!readFileSync(join(env.dir, 'plain.html'), 'utf8').includes('caller cases'), 'the page lists cases only with --seeds');

  const harbor = locate(env.lines('web', HARBOR));
  const ready = harbor.lineOf('if (this.props.ready)');
  const fresh = harbor.lineOf('if (x.fresh)');
  // The inventory walk folds the second way into `store` and then drops it, since a folded
  // stub reaches no route; only the full walk keeps both paths.
  const cases = env.json(['trace', 'HarborPanel', '--seeds', '--expand']).callerCases;
  assert.deepEqual(cases.map((entry) => [entry.id, entry.gate.text, entry.when, entry.outcome]), [
    ['C1', 'if (this.props.ready)', 'false', 'skips'],
    ['C2', 'if (x.fresh)', 'false', 'skips'],
    ['C3', 'first || second && api.load(x.id)', null, 'unknown'],
  ]);
  assert.deepEqual(cases[1].prerequisites, [
    [{ decision: `web:${HARBOR}:${ready}:if`, text: 'if (this.props.ready)', when: 'true' }],
    [],
  ], 'a gate reached on two paths lists the prerequisites of each, a caller method gate among them');
  assert.equal(cases[1].gate.line, fresh);
  assert.equal(cases[2].reason, 'mixed-operators');
  assert.deepEqual(cases[2].skipped.map((site) => site.routes), [[LOAD_REACHED]]);
});

const forkGate = (name) => ({
  decision: `web:src/Fork.ts:${name}:if`, kind: 'if', text: `if (${name})`, file: 'src/Fork.ts',
  line: 1, arm: 'then', status: 'known', outcomes: { true: 'sends', false: 'skips' },
});
const forkSite = (column, ...names) => ({ file: 'src/Fork.ts', line: 1, column, gates: names.map(forkGate) });
const passed = (name) => ({ decision: `web:src/Fork.ts:${name}:if`, text: `if (${name})`, when: 'true' });
const END = 'POST fork/v1/end';
const forkCase = (cases, name) => cases.find((item) => item.gate.text === `if (${name})`);

/** A chain of `depth` hops of `width` gated sites each, above one hop gated by `if (end)`. */
function forkChain(depth, width) {
  const callerGates = new Map([['last', [forkSite(1, 'end')]]]);
  let top = { id: 'last', kind: 'route', ref: END, children: [] };
  for (let level = depth; level >= 1; level -= 1) {
    const id = `h${level}`;
    callerGates.set(id, Array.from({ length: width }, (_, k) => forkSite(k + 1, `s${level}x${k}`)));
    top = { id, kind: 'method', children: [top] };
  }
  return { root: { id: 'root', kind: 'component', children: [top] }, callerGates };
}

test('Caller gates AC-12: the call sites of one hop are one step of a path', () => {
  for (const depth of [6, 12]) {
    const { root, callerGates } = forkChain(depth, 4);
    const started = process.hrtime.bigint();
    const cases = buildCallerCases(root, callerGates);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const last = forkCase(cases, 'end');
    const steps = Array.from({ length: depth }, (_, k) => ({
      anyOf: [0, 1, 2, 3].map((n) => [passed(`s${k + 1}x${n}`)]),
    }));
    assert.deepEqual(last.prerequisites, [steps], `${depth} hops of 4 sites give one walk path`);
    assert.equal(last.pathsTruncated, undefined, `${depth} hops`);
    assert.deepEqual(last.skipped.map((item) => item.routes), [[END]]);
    assert.ok(ms < 1000, `${depth} hops of 4 sites take ${ms} ms`);
  }
});

test('Caller gates AC-12: a case lists at most 32 walk paths and counts the rest exactly', () => {
  const callerGates = new Map();
  const callers = [];
  for (let k = 0; k < 45; k += 1) {
    const below = { id: `t${k}`, kind: 'route', ref: END, children: [] };
    callerGates.set(below.id, [forkSite(1, 'end')]);
    // The first five callers reach the gated method under no gate of their own.
    if (k >= 5) callerGates.set(`c${k}`, [forkSite(1, `c${k}`)]);
    callers.push({ id: `c${k}`, kind: 'method', children: [below] });
  }
  const cases = buildCallerCases({ id: 'root', kind: 'component', children: callers }, callerGates);
  const last = forkCase(cases, 'end');
  assert.equal(last.prerequisites.length, 32);
  assert.equal(last.pathsTruncated, 9, '40 gated paths and one ungated path, less the 32 listed');
  assert.deepEqual(last.prerequisites.filter((path) => path.length === 0), [[]], 'the ungated callers give one entry');
  assert.deepEqual(last.prerequisites[1], [passed('c5')]);
  assert.equal(forkCase(cases, 'c5').pathsTruncated, undefined);
});

test('Caller gates AC-12: one gate list stays flat, more lists give anyOf', () => {
  const below = (sites) => {
    const callerGates = new Map([['h', sites], ['last', [forkSite(1, 'end')]]]);
    const last = { id: 'last', kind: 'route', ref: END, children: [] };
    return buildCallerCases({ id: 'root', kind: 'component', children: [{ id: 'h', kind: 'method', children: [last] }] }, callerGates);
  };
  assert.deepEqual(forkCase(below([forkSite(1, 'a'), forkSite(9, 'a')]), 'end').prerequisites, [[passed('a')]], 'two sites, one gate list');
  assert.deepEqual(forkCase(below([forkSite(1, 'a'), forkSite(9)]), 'end').prerequisites, [[{ anyOf: [[passed('a')], []] }]], 'a gated and an ungated site');
  assert.deepEqual(forkCase(below([forkSite(1, 'a', 'b'), forkSite(9, 'c', 'd')]), 'end').prerequisites, [[{ anyOf: [[passed('a'), passed('b')], [passed('c'), passed('d')]] }]], 'two lists of two gates');

  const held = below([forkSite(1, 'p', 'e'), forkSite(9, 'q', 'e')]);
  assert.deepEqual(forkCase(held, 'e').prerequisites, [[{ anyOf: [[passed('p')], [passed('q')]] }]], 'two sites hold the case gate after different gates');
  assert.deepEqual(forkCase(held, 'p').prerequisites, [[]]);
  assert.deepEqual(forkCase(held, 'e').skipped.map((item) => item.column), [1, 9]);
  assert.deepEqual(forkCase(below([forkSite(1, 'p', 'e'), forkSite(9, 'p', 'e')]), 'e').prerequisites, [[passed('p')]], 'the same earlier gates stay flat');
});

test('Caller gates AC-12: two gates of one decision and arm with other outcomes are two cases', (t) => {
  const env = extract(t);
  for (const side of SIDES) {
    const { inMethod } = locate(env.lines(side.repo, side.file));
    const line = inMethod('rankedLoad', `open && ${side.call}save(x)`);
    const decision = `${side.repo}:${side.file}:${line}:logical`;
    const cases = env.json(['trace', side.start, '--seeds']).callerCases.filter((entry) => entry.gate.decision === decision);
    const read = cases.map((entry) => [entry.when, entry.outcome, entry.reason ?? null, entry.skipped.map((site) => site.routes.includes(SAVE))]);
    assert.deepEqual(read.sort((a, b) => a[1].localeCompare(b[1])), [
      ['true', 'skips', null, [false]],
      [null, 'unknown', 'mixed-operators', [true]],
    ], side.repo);
  }
});

test('Caller gates AC-12: a known and an unknown gate of one arm stay two cases in either order', () => {
  const known = forkGate('a');
  const unknown = { ...known, outcomes: { true: 'unknown', false: 'unknown' }, status: 'unknown', reason: 'mixed-operators' };
  const root = {
    id: 'root',
    children: [
      { id: 'first', kind: 'method', children: [{ id: 'end', kind: 'route', ref: END, children: [] }] },
      { id: 'second', kind: 'method', children: [{ id: 'other', kind: 'route', ref: 'POST fork/v1/other', children: [] }] },
    ],
  };
  for (const [one, two] of [[known, unknown], [unknown, known]]) {
    const cases = buildCallerCases(root, new Map([
      ['first', [{ file: 'src/Fork.ts', line: 1, column: 1, gates: [one] }]],
      ['second', [{ file: 'src/Fork.ts', line: 1, column: 9, gates: [two] }]],
    ]));
    const read = cases.map((entry) => [entry.outcome, entry.skipped.flatMap((site) => site.routes)]);
    assert.deepEqual(read.sort(), [
      ['skips', [one === known ? END : 'POST fork/v1/other']],
      ['unknown', [one === known ? 'POST fork/v1/other' : END]],
    ], one.status);
  }
});

test('Caller gates AC-12: a case whose gate is unknown has outcome unknown', () => {
  const gate = {
    ...forkGate('a'), arm: 'exit', outcomes: { true: 'unknown', false: 'skips' }, status: 'unknown', reason: 'exit-in-one-arm',
  };
  const root = { id: 'root', children: [{ id: 'hop', kind: 'method', children: [{ id: 'end', kind: 'route', ref: END, children: [] }] }] };
  const [only] = buildCallerCases(root, new Map([['hop', [{ file: 'src/Fork.ts', line: 1, column: 1, gates: [gate] }]]]));
  assert.deepEqual([only.when, only.outcome, only.reason], ['true', 'unknown', 'exit-in-one-arm']);
});

test('Caller gates AC-12: a hop with two gated sites lists them as alternatives', (t) => {
  const env = extract(t);
  const barge = locate(env.lines('web', BARGE));
  const high = barge.lineOf('if (tide.high)');
  const ready = barge.lineOf('if (crew.ready)');
  const moored = barge.lineOf('if (x.moored)');
  const call = barge.lineOf('api.save(x);');
  const column = env.lines('web', BARGE)[call - 1].indexOf('api.save') + 1;
  const doc = env.json(['trace', 'BargePanel', '--seeds']);
  const berth = doc.nodes.filter((node) => node.ref === 'BargePanel.berth');
  assert.equal(berth.length, 1, 'the walk groups the two calls of berth into one hop');
  assert.deepEqual(berth[0].callerGates.map((site) => site.gates.map((gate) => gate.text)), [['if (tide.high)'], ['if (crew.ready)']]);
  const prerequisite = (line, text) => ({ decision: `web:${BARGE}:${line}:if`, text, when: 'true' });
  assert.deepEqual(doc.callerCases.map((entry) => [entry.id, entry.gate.text, entry.prerequisites]), [
    ['C1', 'if (tide.high)', [[]]],
    ['C2', 'if (crew.ready)', [[]]],
    ['C3', 'if (x.moored)', [[{ anyOf: [[prerequisite(high, 'if (tide.high)')], [prerequisite(ready, 'if (crew.ready)')]] }]]],
  ]);
  assert.equal(doc.callerCases[2].gate.line, moored);
  assert.deepEqual(doc.callerCases[2].skipped, [{ file: BARGE, line: call, column, routes: [SAVE] }]);

  const text = env.ok(['trace', 'BargePanel', '--seeds']).stdout.split('\n');
  const block = text.slice(text.indexOf('caller cases (3):'));
  const at = block.findIndex((line) => line.startsWith('C3  '));
  assert.deepEqual(block.slice(at, at + 4), [
    `C3  if (x.moored) = false  → skips ${BARGE}:${call}:${column}`,
    `    gate web:${BARGE}:${moored}:if then`,
    '    after: one of (if (tide.high) = true | if (crew.ready) = true)',
    `    call ${BARGE}:${call}:${column}: ${SAVE}`,
  ]);
});

test('Caller gates AC-14: each call site keeps its own gates, and an unreadable record stays on its hop', (t) => {
  const env = extract(t);
  for (const side of SIDES) {
    const desk = deskSites(env, side);
    const plain = desk.inMethod('sameRoute', `${side.call}save(x);`);
    const gated = desk.lineOf(`${side.call}save(x);`, plain + 1);
    const hop = desk.doc.nodes.find((node) =>
      (node.callerGates || []).some((site) => site.line === gated));
    const sites = hop.callerGates.filter((site) => site.line === plain || site.line === gated);
    assert.deepEqual(sites.map((site) => [site.line, site.gates.map((gate) => gate.text)]), [
      [plain, []],
      [gated, ['if (open)']],
    ], `${side.repo} a gated and an ungated call to one route, grouped into one hop`);

    const oneLine = desk.inMethod('oneLine', `${side.call}save(x)`);
    const both = desk.all.filter((site) => site.line === oneLine);
    assert.deepEqual(both.map((site) => site.gates.map((gate) => gate.arm)), [['then'], ['else']], `${side.repo} two calls on one line`);
    const records = env.read(side.repo).facts.filter((item) => item.type === 'caller_gate' && item.line === oneLine);
    // A web site has a column; a mobile site has none, so its ordinal tells the two calls apart.
    const ordinals = side.repo === 'web' ? [0, 0] : [0, 1];
    assert.deepEqual(records.map((item) => item.ordinal), ordinals, `${side.repo} the records of one line`);

    const mix = desk.inMethod('lineMix', `${side.call}save(x)`);
    const onMix = desk.all.filter((site) => site.line === mix);
    assert.deepEqual(
      onMix.filter((site) => site.gates.length > 0).map((site) => site.gates.map((gate) => gate.text)),
      [['if (open)']],
      `${side.repo} the load on the same line has no gate`,
    );
  }

  const plainEnv = extract(t);
  const baseline = deskSites(plainEnv, SIDES[0]);
  const submit = baseline.siteAt('submit', 'save(x)');
  const elseArm = baseline.siteAt('elseArm', 'save(x)');
  const returnExit = baseline.siteAt('returnExit', 'save(x)');
  const andRight = baseline.siteAt('andRight', 'save(x)');
  const orRight = baseline.siteAt('orRight', 'save(x)');
  const clause = baseline.siteAt('clause', 'save(x)');
  const broken = extract(t, ({ read, write }) => {
    const set = read('web');
    const records = set.facts.filter((item) => item.type === 'caller_gate' && item.file === WEB_DESK);
    const at = (line) => records.find((item) => item.line === line);
    at(submit.line).gates = [{ line: 'six' }];
    set.facts.push({ ...at(elseArm.line) });
    at(returnExit.line).line = 0;
    at(andRight.line).gates[0].outcomes = { banana: 'sends' };
    at(orRight.line).gates[0] = { ...at(orRight.line).gates[0], outcomes: { true: 'unknown', false: 'skips' }, reason: 'loop-exit' };
    at(clause.line).gates[0].outcomes = { true: 'sends', false: 'skips' };
    set.facts.push({ ...at(elseArm.line), line: 9999 });
    write('web', set);
  });
  const desk = deskSites(broken, SIDES[0]);
  const unreadable = (site) => [{
    decision: null, kind: null, text: null, file: WEB_DESK, line: site.line, arm: null, outcomes: null,
    status: 'unknown', reason: 'gate-record-unreadable',
  }];
  assert.deepEqual(desk.siteAt('submit', 'save(x)').site.gates, unreadable(submit), 'a payload that does not parse');
  assert.deepEqual(desk.siteAt('elseArm', 'save(x)').site.gates, unreadable(elseArm), 'two records of one site');
  assert.equal(desk.siteAt('returnExit', 'save(x)').site, undefined, 'a site that does not parse attaches nothing');
  assert.deepEqual(desk.siteAt('andRight', 'save(x)').site.gates, unreadable(andRight), 'an outcome key the kind does not have');
  assert.deepEqual(desk.siteAt('orRight', 'save(x)').site.gates, unreadable(orRight), 'an unknown outcome beside a skips outcome');
  assert.deepEqual(desk.siteAt('clause', 'save(x)').site.gates, unreadable(clause), 'a case gate with the outcome keys of an if');
  for (const [key, site] of baseline.sites) {
    if ([submit, elseArm, returnExit, andRight, orRight, clause].some((entry) => `${entry.line}:${entry.column}` === key)) continue;
    assert.deepEqual(desk.sites.get(key), site, `site ${key} keeps its gates`);
  }
  assert.equal(desk.sites.size, baseline.sites.size - 1, 'a record that names no fact attaches to no hop');
});

/** Two copies of the corpus, one without gate records, and comparisons of their outputs. */
function pair(t) {
  const gated = extract(t);
  const plain = extract(t, withoutGates);
  const both = (args) => [gated.ok(args), plain.ok(args)];
  const stripped = (text) => {
    const doc = JSON.parse(text);
    const identities = [];
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === 'identity' && 'traversal' in value) {
          identities.push(item);
          continue;
        }
        out[key] = walk(item);
      }
      return out;
    };
    return { value: walk(doc), identities };
  };
  const sameJson = (args, { gates = false } = {}) => {
    const [left, right] = both(args).map((result) => stripped(result.stdout));
    assert.deepEqual(gates ? withoutGateFields(left.value) : left.value, right.value, args.join(' '));
    if (left.identities.length > 0) {
      assert.notDeepEqual(left.identities, right.identities, `${args.join(' ')}: the two runs read different facts`);
    }
    return left.value;
  };
  const sameText = (args, { gates = false } = {}) => {
    const [left, right] = both(args);
    assert.equal(gates ? withoutGateLines(left.stdout) : left.stdout, right.stdout, args.join(' '));
    return left.stdout;
  };
  return { gated, plain, both, stripped, sameJson, sameText };
}

test('Caller gates AC-7: chains read the same with and without gate records', (t) => {
  const { gated, sameJson, sameText } = pair(t);
  const chainArgs = ['chains', SAVE];
  sameText(chainArgs);
  const chains = sameJson([...chainArgs, '--json']);
  const records = ['web', 'mobile'].flatMap((repo) =>
    gated.read(repo).facts.filter((item) => item.type === 'caller_gate').map((item) => `${repo}:${item.file}:${item.line}`));
  const guarded = chains.chains.filter((chain) =>
    chain.hops.some((hop) => hop.kind === 'call' && records.includes(`${hop.repo}:${hop.file}:${hop.line}`)));
  assert.ok(guarded.length > 0, 'a caller decision guards a call of a listed chain');
});

test('Caller gates AC-13: seeds and every reader stay as they were', (t) => {
  const { gated, plain, both, stripped, sameJson, sameText } = pair(t);
  for (const start of ['PassagePanel', 'KeeperPanel', 'HarborPanel', 'PassageDesk', 'PassageDeskService']) {
    const seeds = sameJson(['trace', start, '--seeds', '--json'], { gates: true });
    sameText(['trace', start, '--seeds'], { gates: true });
    sameText(['trace', start, '--mermaid']);
    sameJson(['trace', start, '--graph']);
    sameText(['trace', start, '--view', 'source-flow']);
    sameJson(['trace', start, '--view', 'source-flow', '--json']);
    assert.ok(Array.isArray(seeds.seeds), `${start} lists its seeds`);
  }
  assert.ok(gated.json(['trace', 'KeeperPanel', '--seeds']).callerCases.length > 0);
  for (const route of [SAVE, LOAD]) {
    sameText(['trace', route, '--seeds']);
    sameJson(['trace', route, '--seeds', '--json']);
  }

  for (const env of [gated, plain]) writeFileSync(join(env.dir, 'area.txt'), `${SAVE}\n${LOAD}\n`);
  sameText(['cover', '--area', 'area.txt']);
  sameJson(['cover', '--area', 'area.txt', '--json']);
  sameText(['span', '--from-component', 'KeeperPanel']);
  const pages = both(['span', SAVE, '--out', 'span.html']);
  assert.equal(pages[0].stdout, pages[1].stdout);
  assert.equal(readFileSync(join(gated.dir, 'span.html'), 'utf8'), readFileSync(join(plain.dir, 'span.html'), 'utf8'));

  both(['scaffold', '--area', 'area.txt', '--out', 'scaffold']);
  both(['cases', '--area', 'area.txt', '--out', 'cases']);
  for (const folder of ['scaffold', 'cases']) {
    const files = readTree(join(gated.dir, folder));
    assert.ok(Object.keys(files).length > 0, `${folder} writes files`);
    assert.deepEqual(files, readTree(join(plain.dir, folder)), folder);
  }

  both(['check', '--area', 'area.txt', '--write-baseline']);
  sameJson(['check', '--area', 'area.txt', '--json']);

  for (const env of [gated, plain]) env.ok(['join', '--snapshot', 'snapshot.json']);
  const drift = (env) => {
    const doc = stripped(env.ok(['join', '--against', 'snapshot.json', '--json']).stdout).value;
    for (const side of ['snapshot', 'current']) {
      if (doc[side]) delete doc[side].factSets;
    }
    return doc;
  };
  assert.deepEqual(drift(gated), drift(plain), 'join --against, apart from the fact-set identities');
});

test('Caller gates AC-15: both extractors write gate records from the one shared module', (t) => {
  const env = extract(t);
  for (const repo of ['web', 'mobile']) {
    const records = env.read(repo).facts.filter((item) => item.type === 'caller_gate');
    assert.ok(records.length > 0, `${repo} carries gate records`);
    for (const record of records) {
      assert.deepEqual(Object.keys(record), ['type', 'call', 'file', 'line', 'column', 'class', 'method', 'ordinal', 'gates'], repo);
    }
  }
  const root = join(HERE, '..', 'lib', 'extract');
  for (const file of ['web.js', 'mobile.js']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.match(source, /import \{ callerDecisionReader, callerGateRecords \} from '\.\/caller-decisions\.js';/, file);
  }
  assert.deepEqual(compareBaselines(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')), captureBaseline()), []);
});

function readTree(dir) {
  const out = {};
  const walk = (folder, prefix) => {
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else out[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}
