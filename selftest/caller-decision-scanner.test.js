/**
 * Source forms the caller decision scanner reads, extracted from the `quill-forms` corpus
 * through the web and the mobile extractor, and the facts every other corpus keeps.
 *
 * A table row names the facts expected now and, as `released`, the facts that the scanner of
 * the release line gave for the same text before these rules. The two differ only in a row
 * whose form an acceptance rule of the scanner names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { copyFixture, runCli } from './helpers.js';
import { BASELINE_FILE, captureBaseline, compareBaselines } from './caller-gate-baseline.js';

const WEB_FORMS = 'src/forms/ScannerForms.ts';
const MOBILE_FORMS = 'src/app/features/forms/scanner-forms.service.ts';
const BADGES = 'src/forms/BadgeRow.tsx';

function corpus(t) {
  const dir = copyFixture(t, 'quill-forms');
  const extracted = runCli(['extract', '--config', 'quill.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const facts = (repo) => JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
  const source = (repo, file) => readFileSync(join(dir, repo, file), 'utf8').split('\n');
  return { facts, source };
}

/** Both extractors, each with the file that holds the shared class body. */
const SIDES = [
  { repo: 'web', file: WEB_FORMS },
  { repo: 'mobile', file: MOBILE_FORMS },
];

function sideOf(env, side) {
  const lines = env.source(side.repo, side.file);
  const lineOf = (text) => {
    const at = lines.findIndex((line) => line.includes(text));
    assert.notEqual(at, -1, `${side.file} holds ${text}`);
    return at + 1;
  };
  const decisions = env.facts(side.repo).filter((item) => item.type === 'branch_point' && item.file === side.file);
  const of = (method) =>
    decisions.filter((item) => item.method === method).map((item) => [item.line, item.endLine, item.kind, item.text]);
  // The lines of a method member, up to the next member header, so a local function's own
  // span counts toward the member that holds it.
  const linesOf = (method) => {
    const first = lineOf(`  ${method}(`);
    let last = first;
    while (last < lines.length && !/^ {2}[\w$]+\(/.test(lines[last])) last += 1;
    return [first, last];
  };
  const kinds = (method) => {
    const [first, last] = linesOf(method);
    return decisions.filter((item) => item.line >= first && item.line <= last).map((item) => [item.kind, item.text]);
  };
  return { lineOf, of, kinds };
}

/** Runs each `[method, expected, released]` row through both extractors as `[kind, text]` facts. */
function expectRows(env, rows) {
  for (const side of SIDES) {
    const { kinds } = sideOf(env, side);
    for (const [method, expected, released] of rows) {
      assert.deepEqual(kinds(method), expected, `${side.repo} ${method} (released: ${JSON.stringify(released)})`);
    }
  }
}

const REGEX_ROWS = [
  ['regexIf', [['if', 'if (ok)'], ['if', 'if (ok)']], [['if', 'if (ok)'], ['if', 'if (ok)'], ['ternary', '/a?b:c/.test(s)']]],
  ['regexWhile', [], [['logical', '/c||d/.exec(s)']]],
  ['regexFor', [], [['coalesce', '/e??f/.test(x)']]],
  ['regexWith', [], [['ternary', '/g?h:i/.test(s)']]],
  ['division', [['ternary', '(a) / b ? d : d / e']], [['ternary', '(a) / b ? d : d / e']]],
];

test('Caller decision scanner AC-1: a regex literal after a control head is no decision', (t) => {
  const env = corpus(t);
  expectRows(env, REGEX_ROWS);
  for (const side of SIDES) {
    const { lineOf, of } = sideOf(env, side);
    assert.deepEqual(of('regexIf'), [
      [lineOf('/a?b/.test'), lineOf('/a?b/.test'), 'if', 'if (ok)'],
      [lineOf('/a?b:c/'), lineOf('/a?b:c/'), 'if', 'if (ok)'],
    ], side.repo);
    const division = lineOf('return (a) / b');
    assert.deepEqual(of('division'), [[division, division, 'ternary', '(a) / b ? d : d / e']], `${side.repo} division`);
  }
});

test('Caller decision scanner AC-2: an unparenthesized JSX element over lines is one operand', (t) => {
  const env = corpus(t);
  const lines = env.source('web', BADGES);
  const lineOf = (text, from = 0) => lines.findIndex((line, i) => i >= from && line.includes(text)) + 1;
  const decisions = env
    .facts('web')
    .filter((item) => item.type === 'branch_point' && item.file === BADGES)
    .map((item) => [item.line, item.endLine, item.kind, item.text]);
  const open = lineOf('const open');
  const shut = lineOf('const shut');
  const wrapped = lineOf('const wrapped');
  const joined = lineOf('const joined');
  // Released: no fact for `open`, and a `logical` fact `cond && <Badge` on the line of `shut`
  // alone. The two parenthesized rows are the same as released.
  assert.deepEqual(decisions, [
    [open, lineOf(': null', open), 'ternary', 'cond ? <Badge x="1" /> : null'],
    [shut, lineOf('/>;', shut), 'logical', 'cond && <Badge y="2" />'],
    [wrapped, wrapped + 2, 'ternary', 'cond ? ( <Badge x="1" /> ) : null'],
    [joined, joined + 2, 'logical', 'cond && ( <Badge y="2" /> )'],
  ]);
});

const SIZE_SPACED = ['ternary', 'size? (): number'];

/**
 * An optional member in a listed type brace gives no fact in any spelling. Outside a type
 * brace, a `?` whose group holds a call is a ternary in each spelling, and every other `?`
 * gives what it gave before.
 */
const OPTIONAL_ROWS = [
  ['annotated', [], [['ternary', 'size? () : number']]],
  ['typeLiteral', [], [['ternary', 'size ? () : number']]],
  ['localInterface', [], []],
  ['localClass', [], []],
  ['typeArgument', [], []],
  ['genericInterface', [], []],
  ['genericClass', [], []],
  ['genericHeritage', [], []],
  ['constrainedGeneric', [], []],
  ['mixinHeritage', [], []],
  ['asType', [], [SIZE_SPACED]],
  ['satisfiesType', [], [SIZE_SPACED]],
  ['keyofType', [], [SIZE_SPACED]],
  ['readonlyType', [], [SIZE_SPACED]],
  ['predicateType', [], [SIZE_SPACED]],
  ['tightTernary', [['ternary', 'a?(run()):stop()']], []],
  ['spacedTernary', [['ternary', 'a ? (run()) : stop()']], [['ternary', 'a ? (run()) : stop()']]],
  ['halfTernary', [['ternary', 'a?(run()) : stop()']], [['ternary', 'a?(run()) : stop()']]],
  ['arrowReturnType', [], []],
  ['tupleType', [], []],
  ['angleAssertion', [], []],
  ['angleSpaced', [SIZE_SPACED], [SIZE_SPACED]],
  ['typeParamDefault', [], []],
  ['plainGroup', [], []],
  ['nameBeforeBlock', [['ternary', 'x ? a() : b()'], ['ternary', 'x ? c() : d()']], [['ternary', 'x ? a() : b()'], ['ternary', 'x ? c() : d()']]],
  ['callGroups', [['ternary', 'a?(fs[0]()):b']], []],
];

test('Caller decision scanner AC-3: the bracket around a `?` tells an optional method from a ternary', (t) => {
  const env = corpus(t);
  expectRows(env, OPTIONAL_ROWS);
  for (const side of SIDES) {
    const { lineOf, of } = sideOf(env, side);
    const tight = lineOf('a?(run()):stop();');
    assert.deepEqual(of('tightTernary'), [[tight, tight, 'ternary', 'a?(run()):stop()']], side.repo);
  }
});

const ELSE_ROWS = [
  ['nestedElse', [['if', 'if (a)'], ['if', 'if (b)'], ['else', 'else']], [['if', 'if (a)'], ['if', 'if (b)'], ['else', 'else'], ['else', 'else']]],
  ['elseChain',
    [['if', 'if (a)'], ['if', 'if (b)'], ['else', 'else if (c)'], ['if', 'if (c)'], ['else', 'else']],
    [['if', 'if (a)'], ['if', 'if (b)'], ['else', 'else if (c)'], ['else', 'else if (c)'], ['if', 'if (c)'], ['else', 'else']]],
  ['hiddenElse', [['if', 'if (a)']], [['if', 'if (a)']]],
];

test('Caller decision scanner AC-4: an unbraced nested else binds once, to the nearest if', (t) => {
  const env = corpus(t);
  expectRows(env, ELSE_ROWS);
  for (const side of SIDES) {
    const { lineOf, of } = sideOf(env, side);
    const outer = lineOf('    if (a)');
    const inner = lineOf('if (b) run();');
    const stop = lineOf('else stop();');
    // Released: the outer `if` ended on the line of `if (b) run();`.
    assert.deepEqual(of('nestedElse'), [
      [outer, stop, 'if', 'if (a)'],
      [inner, inner, 'if', 'if (b)'],
      [stop, stop, 'else', 'else'],
    ], side.repo);
    const chain = lineOf('if (a) if (b) x();');
    assert.deepEqual(of('elseChain'), [
      [chain, chain, 'if', 'if (a)'],
      [chain, chain, 'if', 'if (b)'],
      [chain, chain, 'else', 'else if (c)'],
      [chain, chain, 'if', 'if (c)'],
      [chain, chain, 'else', 'else'],
    ], side.repo);
  }
});

test('Caller decision scanner AC-5: every recorded corpus keeps its facts', () => {
  const problems = compareBaselines(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')), captureBaseline());
  assert.deepEqual(problems, []);
});
