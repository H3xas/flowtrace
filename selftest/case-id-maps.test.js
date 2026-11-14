/**
 * A case id written as a same-file value: a map key built in nested loops, a literal or
 * ternary key, a block-local `const`, an array element, a destructured loop row. The bounded
 * reader gives one `evaluated` record for each loop instance the argument reads, with the
 * bindings it read as `instance`. Every other argument, and a site past the instance limit,
 * gives the unresolved record, so an id is either written in the file or not emitted.
 *
 * `corpus/widget-ledger/` holds the specs and `ledger.config.json`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { INSTANCE_LIMIT } from '../lib/extract/bounded-eval.js';
import { copyFixture, extract } from './helpers.js';

function extractLedger(t) {
  const dir = copyFixture(t, 'widget-ledger');
  extract(dir, 'ledger.config.json');
  return { dir, facts: JSON.parse(readFileSync(join(dir, 'out', 'facts', 'e2e.json'), 'utf8')).facts };
}

function caseFactsAt(facts, spec, line) {
  return facts
    .filter((candidate) => candidate.type === 'case_id' && candidate.spec === spec && candidate.line === line)
    .map(({ ids, source, expression, instance }) => ({
      ids,
      source,
      ...(expression === undefined ? {} : { expression }),
      ...(instance === undefined ? {} : { instance }),
    }));
}

const SIX = [
  [false, 'alpha', 9101],
  [false, 'beta', 9102],
  [false, 'gamma', 9103],
  [true, 'alpha', 9104],
  [true, 'beta', 9105],
  [true, 'gamma', 9106],
].map(([g, name, id]) => ({ ids: [id], source: 'evaluated', instance: { g, 'row.name': name } }));

test('Case id maps AC-24: a two-axis loop over a same-file map gives one record per instance, in loop order', (t) => {
  const { facts } = extractLedger(t);
  const spec = 'tests/maps.spec.ts';
  assert.deepEqual(caseFactsAt(facts, spec, 18), SIX, 'a body call');
  assert.deepEqual(caseFactsAt(facts, spec, 22), SIX, 'title position');
  assert.deepEqual(caseFactsAt(facts, spec, 28), SIX, 'a forEach outer loop');
});

test('Case id maps AC-25: literal keys, ternary keys, bounded locals, array elements and destructured rows', (t) => {
  const { facts } = extractLedger(t);
  const spec = 'tests/keys.spec.ts';
  const evaluated = (id, instance) => ({ ids: [id], source: 'evaluated', instance });
  assert.deepEqual(caseFactsAt(facts, spec, 14), [evaluated(9101, {})], 'a literal key');
  assert.deepEqual(caseFactsAt(facts, spec, 19), [evaluated(9104, { flag: false }), evaluated(9101, { flag: true })], 'a ternary key');
  assert.deepEqual(caseFactsAt(facts, spec, 23), [evaluated(9202, { flag: false }), evaluated(9201, { flag: true })], 'a block-local const');
  assert.deepEqual(caseFactsAt(facts, spec, 29), [evaluated(9212, {})], 'an element of a same-file array');
  assert.deepEqual(caseFactsAt(facts, spec, 34), [evaluated(9221, { id: 9221 }), evaluated(9222, { id: 9222 })], 'a destructured row');
});

test('Case id maps AC-26: refusals and the instance limit give the unresolved record, and every id is in the file', (t) => {
  const { dir, facts } = extractLedger(t);
  const spec = 'tests/refusals.spec.ts';
  const unresolved = (expression, instance) => ({ ids: [], source: 'unresolved', expression, ...(instance ? { instance } : {}) });
  const refused = [
    [23, "ids['z|none']", 'an absent key'],
    [27, 'n', 'a function parameter'],
    [32, "idOf('drawer')", 'a call result'],
    [36, 'process.env.CASE_ID', 'the environment'],
    [40, 'mutableId', 'a let binding'],
    [44, 'oldId', 'a var binding'],
    [48, "sharedIds['a|alpha']", 'an imported map'],
    [53, 'row.id', 'an imported loop array'],
    [61, '[a, b, c]', `a loop product past ${INSTANCE_LIMIT} instances`],
  ];
  for (const [line, expression, label] of refused) {
    assert.deepEqual(caseFactsAt(facts, spec, line), [unresolved(expression)], label);
  }
  const atLimit = caseFactsAt(facts, spec, 70);
  assert.equal(atLimit.length, INSTANCE_LIMIT, 'a product of exactly the limit expands');
  assert.ok(atLimit.every((entry) => entry.source === 'evaluated'));
  assert.deepEqual(
    caseFactsAt(facts, spec, 77),
    [{ ids: [9101], source: 'evaluated', instance: { 'row.name': 'alpha' } }, unresolved('ids[`a|${row.name}`]', { 'row.name': 'delta' })],
    'an absent key in one instance leaves the other its id',
  );

  const unwritten = [];
  for (const candidate of facts) {
    if (candidate.type !== 'case_id') continue;
    const source = readFileSync(join(dir, 'e2e', candidate.spec), 'utf8');
    for (const id of candidate.ids) {
      const written = typeof id === 'number' ? new RegExp(`(^|[^\\w.])${id}([^\\w.]|$)`).test(source) : source.includes(`'${id}'`);
      if (!written) unwritten.push({ spec: candidate.spec, line: candidate.line, id });
    }
  }
  assert.deepEqual(unwritten, [], 'every emitted id is written as a literal in its own file');
});
