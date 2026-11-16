/**
 * Source forms the caller decision scanner reads, extracted from the `quill-forms` corpus
 * through the web and the mobile extractor, and the facts every other corpus keeps.
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
  return { lineOf, of };
}

test('Caller decision scanner AC-1: a regex literal after a control head is no decision', (t) => {
  const env = corpus(t);
  for (const side of SIDES) {
    const { lineOf, of } = sideOf(env, side);
    assert.deepEqual(of('regexIf'), [
      [lineOf('/a?b/.test'), lineOf('/a?b/.test'), 'if', 'if (ok)'],
      [lineOf('/a?b:c/'), lineOf('/a?b:c/'), 'if', 'if (ok)'],
    ], side.repo);
    assert.deepEqual(of('regexWhile'), [], `${side.repo} while`);
    assert.deepEqual(of('regexFor'), [], `${side.repo} for`);
    assert.deepEqual(of('regexWith'), [], `${side.repo} with`);
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
  assert.deepEqual(decisions, [
    [open, lineOf(': null', open), 'ternary', 'cond ? <Badge x="1" /> : null'],
    [shut, lineOf('/>;', shut), 'logical', 'cond && <Badge y="2" />'],
    [wrapped, wrapped + 2, 'ternary', 'cond ? ( <Badge x="1" /> ) : null'],
    [joined, joined + 2, 'logical', 'cond && ( <Badge y="2" /> )'],
  ]);
});

test('Caller decision scanner AC-3: the bracket around a `?` tells an optional method from a ternary', (t) => {
  const env = corpus(t);
  for (const side of SIDES) {
    const { lineOf, of } = sideOf(env, side);
    for (const method of ['annotated', 'typeLiteral', 'localInterface', 'localClass', 'typeArgument', 'genericInterface', 'genericClass', 'genericHeritage', 'constrainedGeneric', 'mixinHeritage']) {
      assert.deepEqual(of(method), [], `${side.repo} ${method}`);
    }
    const tight = lineOf('a?(run()):stop();');
    assert.deepEqual(of('tightTernary'), [[tight, tight, 'ternary', 'a?(run()):stop()']], side.repo);
    const spelled = (method, text) => {
      const line = lineOf(text);
      const rows = of(method);
      assert.equal(rows.length, 1, `${side.repo} ${method}`);
      const [row] = rows;
      assert.deepEqual([row[0] - line, row[1] - line, row[2]], [0, 0, 'ternary'], `${side.repo} ${method}`);
    };
    spelled('spacedTernary', 'a ? (run()) : stop();');
    spelled('halfTernary', 'a?(run()) : stop();');
  }
});

test('Caller decision scanner AC-4: an unbraced nested else binds once, to the nearest if', (t) => {
  const env = corpus(t);
  for (const side of SIDES) {
    const { lineOf, of } = sideOf(env, side);
    const outer = lineOf('    if (a)');
    const inner = lineOf('if (b) run();');
    const stop = lineOf('else stop();');
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
