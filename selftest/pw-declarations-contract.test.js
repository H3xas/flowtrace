/**
 * Two things decide whether a Playwright title resolves, and both are read off source text.
 *
 * The first is what counts as a declaration. `test.skip` names two unrelated constructs: a
 * skipped declaration, and a runtime guard written inside a body. A `test` that is a member of
 * something else — a regular expression, a matcher object — is not Playwright's `test` at all.
 * Counting either as a declaration inflates the source side, and the ordinal join then refuses
 * the whole file because the two sides no longer have the same length.
 *
 * The second is which titles the runner is obliged to echo back. A parsed title arrives with its
 * quotes already stripped, so a plain string and a table-supplied identifier look alike and only
 * their shape separates them. A title wrapped in a configured case-id call still carries its
 * string inside the wrapper, so unwrapping recovers a verbatim check that would otherwise be
 * given up.
 *
 * `corpus/widget-kiosk/` holds one spec carrying every one of those shapes, and a listing whose
 * positions sit four lines below the source so nothing can resolve by line.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { echoedTitle, refusalReason, titleFacts, titlesByLine } from '../lib/extract/pw-titles.js';
import { copyFixture, extract } from './helpers.js';

const CASE_ID_CALLS = ['tms.id'];

const EXPECTED = [
  { line: 10, expression: 'opens the kiosk drawer', titles: ['opens the kiosk drawer'] },
  { line: 16, expression: 'reprints a receipt', titles: ['reprints a receipt'] },
  { line: 21, expression: 'scans a label', titles: ['scans a label'] },
  { line: 26, expression: "tms.id(7, 'refunds a sale')", titles: ['refunds a sale'] },
  { line: 34, expression: 'row.summary', titles: ['prints a duplicate receipt'] },
];

function joinInputs(t) {
  const dir = copyFixture(t, 'widget-kiosk');
  extract(dir, 'widget.config.json');
  const repoRoot = join(dir, 'e2e');
  const set = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'e2e.json'), 'utf8'));
  const listing = JSON.parse(readFileSync(join(dir, 'pw-list-transformed.json'), 'utf8'));
  // Playwright reports spec files relative to `config.rootDir`; here that is the repo root.
  listing.config.rootDir = repoRoot;
  return { facts: set.facts, byLine: titlesByLine(listing, repoRoot) };
}

function site(titles) {
  return { titles };
}

function declaration(expression) {
  return { type: 'pw_test', spec: 'tests/one.spec.ts', test: expression };
}

test('a skip guard and a member call are not declarations', (t) => {
  const { facts } = joinInputs(t);
  const declarations = facts.filter((fact) => fact.type === 'pw_test');
  assert.deepEqual(
    declarations.map((fact) => fact.test),
    EXPECTED.map((row) => row.expression),
    'the spec declares five tests; the guards, the bare skip and the member `test` calls are not among them',
  );
});

test('a skipped declaration keeps its skipped flag and its three-argument form counts', (t) => {
  const { facts } = joinInputs(t);
  const byTitle = new Map(facts.filter((fact) => fact.type === 'pw_test').map((fact) => [fact.test, fact]));
  assert.equal(byTitle.get('reprints a receipt').skipped, true);
  assert.equal(byTitle.get('scans a label').skipped, false);
});

test('every declaration resolves its own title', (t) => {
  const { facts, byLine } = joinInputs(t);
  const refusals = [];
  const titles = titleFacts(facts, byLine, refusals, CASE_ID_CALLS);
  assert.deepEqual(refusals, [], 'no spec file may be refused');
  assert.deepEqual(
    titles.map((fact) => ({ line: fact.line, titles: fact.titles })),
    EXPECTED.map((row) => ({ line: row.line, titles: row.titles })),
  );
});

test('a wrapped title is held to the string inside the wrapper', () => {
  assert.equal(echoedTitle("tms.id(7, 'refunds a sale')", CASE_ID_CALLS), 'refunds a sale');
  assert.equal(
    refusalReason([declaration("tms.id(7, 'refunds a sale')")], [site(['voids a sale'])], CASE_ID_CALLS),
    'declaration 1 reads "refunds a sale", the listing resolves ["voids a sale"] there',
    'unwrapping must not become a way past the check',
  );
  assert.equal(refusalReason([declaration("tms.id(7, 'refunds a sale')")], [site(['refunds a sale'])], CASE_ID_CALLS), null);
});

test('an unconfigured call and a supplied identifier rest on their ordinal', () => {
  assert.equal(echoedTitle("elsewhere(7, 'refunds a sale')", CASE_ID_CALLS), null);
  assert.equal(echoedTitle('row.summary', CASE_ID_CALLS), null);
  assert.equal(refusalReason([declaration('row.summary')], [site(['anything at all'])], CASE_ID_CALLS), null);
  assert.equal(refusalReason([declaration("elsewhere(7, 'x')")], [site(['anything at all'])], CASE_ID_CALLS), null);
});

test('a plain string is still held to itself', () => {
  assert.equal(echoedTitle('opens the kiosk drawer', CASE_ID_CALLS), 'opens the kiosk drawer');
  assert.equal(
    refusalReason([declaration('opens the kiosk drawer')], [site(['closes the kiosk drawer'])], CASE_ID_CALLS),
    'declaration 1 reads "opens the kiosk drawer", the listing resolves ["closes the kiosk drawer"] there',
  );
});
