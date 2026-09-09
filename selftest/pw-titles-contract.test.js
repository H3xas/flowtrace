/**
 * The Playwright title join must survive source transformation.
 *
 * A `pw_test` fact carries the line the *spec source* declares a test on. Recent Playwright
 * versions report list-mode positions in *transformed* source, so the runner's line and the
 * parser's line no longer describe the same position. Joining the two on a raw line number is
 * therefore not merely lossy — where a transformed line happens to land on some other
 * declaration's source line, the join succeeds and attaches that other test's title. A wrong
 * title is worse than a missing one, because nothing downstream can tell it is wrong.
 *
 * `corpus/widget-cart/` pins that. Its spec declares five tests, at source lines 6, 11, 16, 22
 * and 28; `pw-list-transformed.json` is a list-mode report of the same suite whose positions are
 * shifted five lines down by a transform preamble, so the runner reports 11, 16, 21, 27 and 33.
 * Two of those shifted lines collide with a real declaration line further down the file, and
 * the rest match nothing.
 *
 * Like `scout-contract.test.js`, this imports from `lib/` directly rather than driving the CLI
 * end to end: the CLI path would spawn the repository's own installed Playwright, and a real
 * Playwright install is off the table for a public fixture. The declarations still come from a
 * real `flowtrace extract` run, so only the runner half is synthetic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { titleFacts, titlesByLine } from '../lib/extract/pw-titles.js';
import { copyFixture, extract } from './helpers.js';

/** Source line -> the titles that declaration actually produces, per the same listing. */
const EXPECTED = [
  { line: 6, expression: 'adds an item to the cart', titles: ['adds an item to the cart'] },
  { line: 11, expression: 'removes an item from the cart', titles: ['removes an item from the cart'] },
  { line: 16, expression: 'renders a ${size} cart badge', titles: ['renders a small cart badge', 'renders a large cart badge'] },
  { line: 22, expression: 'rejects an unauthenticated add', titles: ['rejects an unauthenticated add'] },
  { line: 28, expression: 'empties the cart', titles: ['empties the cart'] },
];

/** Extracts the fixture and returns `{ testFacts, byLine }` ready to join. */
function joinInputs(t) {
  const dir = copyFixture(t, 'widget-cart');
  extract(dir, 'widget.config.json');
  const repoRoot = join(dir, 'e2e');
  const set = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'e2e.json'), 'utf8'));
  const testFacts = set.facts.filter((fact) => fact.type === 'pw_test');
  const listing = JSON.parse(readFileSync(join(dir, 'pw-list-transformed.json'), 'utf8'));
  // Playwright reports spec files relative to `config.rootDir`; here that is the repo root.
  listing.config.rootDir = repoRoot;
  return { testFacts, byLine: titlesByLine(listing, repoRoot) };
}

test('the fixture declares the five tests the listing reports, at their source lines', (t) => {
  const { testFacts } = joinInputs(t);
  assert.deepEqual(
    testFacts.map((fact) => ({ line: fact.line, expression: fact.test })),
    EXPECTED.map(({ line, expression }) => ({ line, expression })),
  );
});

test('every declaration resolves a title even when the runner reports transformed lines', (t) => {
  const { testFacts, byLine } = joinInputs(t);
  const resolved = titleFacts(testFacts, byLine);
  assert.deepEqual(
    resolved.map((fact) => fact.line),
    EXPECTED.map(({ line }) => line),
    'a declaration the listing covers must not be dropped because its reported line moved',
  );
});

test('no declaration is given another declaration\'s title', (t) => {
  const { testFacts, byLine } = joinInputs(t);
  const resolved = titleFacts(testFacts, byLine);
  const byDeclarationLine = new Map(resolved.map((fact) => [fact.line, fact.titles]));
  const misattributed = [];
  for (const { line, expression, titles } of EXPECTED) {
    const got = byDeclarationLine.get(line);
    if (got === undefined) continue; // absence is the other test's business
    try {
      assert.deepEqual(got, titles);
    } catch {
      misattributed.push({ line, declares: expression, got, want: titles });
    }
  }
  assert.deepEqual(misattributed, [], 'a title must belong to the declaration it is attached to');
});

test('a spec file the join cannot prove resolves nothing, not a shifted subset', (t) => {
  const dir = copyFixture(t, 'widget-cart');
  extract(dir, 'widget.config.json');
  const repoRoot = join(dir, 'e2e');
  const set = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'e2e.json'), 'utf8'));
  const testFacts = set.facts.filter((fact) => fact.type === 'pw_test');
  const spec = testFacts[0].spec;
  const raw = readFileSync(join(dir, 'pw-list-transformed.json'), 'utf8');
  const load = () => {
    const listing = JSON.parse(raw);
    listing.config.rootDir = repoRoot;
    return listing;
  };
  const specsOf = (listing) => listing.suites[0].suites[0].specs;

  // A declaration site the listing never reports: five declarations against four sites, so
  // the fourth and fifth ordinals name a different declaration on each side.
  const incomplete = load();
  const specs = specsOf(incomplete);
  specs.splice(specs.findIndex((entry) => entry.title === 'rejects an unauthenticated add'), 1);
  const incompleteRefusals = [];
  const fromIncomplete = titleFacts(testFacts, titlesByLine(incomplete, repoRoot), incompleteRefusals);
  assert.deepEqual(fromIncomplete, [], 'a listing that covers only some declarations must resolve none of them');
  assert.deepEqual(
    incompleteRefusals.map((refusal) => refusal.spec),
    [spec],
    'the file that cannot be joined is named once, with a reason',
  );
  assert.match(incompleteRefusals[0].reason, /4 declaration sites, the source declares 5/);

  // The counts agree, but a declaration written as a plain string is answered with another
  // title — evidence the two sequences are not the same sequence.
  const disagreeing = load();
  specsOf(disagreeing).find((entry) => entry.title === 'empties the cart').title = 'empties the basket';
  const disagreeingRefusals = [];
  const fromDisagreeing = titleFacts(testFacts, titlesByLine(disagreeing, repoRoot), disagreeingRefusals);
  assert.deepEqual(
    fromDisagreeing,
    [],
    'the four declarations that do agree are refused with the fifth: the refusal is per spec file, not per declaration',
  );
  assert.match(disagreeingRefusals[0].reason, /declaration 5 reads "empties the cart"/);
});
