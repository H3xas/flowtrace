/**
 * A configured case-id call can name a test's case in two places: wrapped around the title,
 * `test(caseRef(9001, 'refunds a sale'), fn)`, or called inside the body. Both read the first
 * argument as the case id; a wrapper's second argument is its title. An id argument that no
 * reader can resolve is stated as an `unresolved` record rather than dropped or guessed, and
 * title text is never read as an id.
 *
 * The wrapper adds text to the title the runner reports, so title collection holds a wrapped
 * title to containment — every title at its site must hold the title argument — where a plain
 * string title is still held to equality.
 *
 * `corpus/widget-till/` holds the specs, three configurations (both callees, the body call
 * alone, and none) and `pw-list.json`, a listing whose positions sit three lines below the
 * source and whose wrapped titles carry the text the wrapper adds. Like the other title tests,
 * this imports `lib/` directly for the runner half, because a real Playwright install is off
 * the table for a public fixture; the declarations come from a real `flowtrace extract` run.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fact, validateFacts } from '../lib/facts.js';
import { echoedTitle, refusalReason, titleFacts, titlesByLine } from '../lib/extract/pw-titles.js';
import { span } from '../lib/span.js';
import { copyFixture, extract } from './helpers.js';

const CALLS = ['caseRef', 'caseRef.id'];
const ROUTE = 'POST till/v1/refunds';

function extractTill(t, config = 'till.config.json', prepare = () => {}) {
  const dir = copyFixture(t, 'widget-till');
  prepare(dir);
  extract(dir, config);
  const sets = readdirSync(join(dir, 'out', 'facts'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const parsed = JSON.parse(readFileSync(join(dir, 'out', 'facts', name), 'utf8'));
      return { repo: parsed.repo, kind: parsed.kind, facts: parsed.facts };
    });
  const e2e = sets.find((set) => set.repo === 'e2e');
  return { dir, sets, facts: e2e.facts };
}

function loadListing(dir, mutate = () => {}) {
  const repoRoot = join(dir, 'e2e');
  const listing = JSON.parse(readFileSync(join(dir, 'pw-list.json'), 'utf8'));
  listing.config.rootDir = repoRoot;
  mutate(listing);
  return titlesByLine(listing, repoRoot);
}

function specsOf(listing, file) {
  return listing.suites.find((suite) => suite.file === file).suites[0].specs;
}

function caseFactsAt(facts, spec, line) {
  return facts
    .filter((candidate) => candidate.type === 'case_id' && candidate.spec === spec && candidate.line === line)
    .map(({ ids, source, expression }) => (expression === undefined ? { ids, source } : { ids, source, expression }));
}

function declarationsOf(facts, spec) {
  return facts.filter((candidate) => candidate.type === 'pw_test' && candidate.spec === spec);
}

function refusalsFor(facts, sitesBySpec, calls) {
  const refusals = [];
  titleFacts(facts, sitesBySpec, refusals, calls);
  return refusals;
}

/**
 * The first argument of every configured call in one source text, read with a scanner of its
 * own so the check does not lean on the reader it checks.
 */
function firstArguments(source) {
  const out = [];
  const callRe = /caseRef(?:\.id)?\s*\(/g;
  let m;
  while ((m = callRe.exec(source))) {
    let depth = 0;
    let quote = null;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if ('([{'.includes(ch)) depth += 1;
      else if (depth > 0 && ')]}'.includes(ch)) depth -= 1;
      else if (depth === 0 && (ch === ',' || ch === ')')) break;
    }
    out.push(source.slice(start, i).trim());
  }
  return out;
}

test('Title wrapper case ids AC-1: a title wrapper gives its ids for every declaration form', (t) => {
  const focused = "import { test } from '@playwright/test';\nimport { caseRef } from '../support/case-ref';\n\ntest.only(caseRef(9008, 'refunds a focused sale'), async () => {});\n";
  const { facts } = extractTill(t, 'till.config.json', (dir) => {
    writeFileSync(join(dir, 'e2e', 'tests', 'focused.spec.ts'), focused);
  });
  const spec = 'tests/positions.spec.ts';
  assert.deepEqual(caseFactsAt(facts, spec, 6), [{ ids: [9001], source: 'literal' }], 'test(');
  assert.deepEqual(caseFactsAt(facts, spec, 11), [{ ids: [9002], source: 'literal' }], 'test.skip(');
  assert.deepEqual(caseFactsAt(facts, spec, 16), [{ ids: [9005], source: 'literal' }], 'test.fixme(');
  assert.deepEqual(caseFactsAt(facts, spec, 21), [{ ids: [9003, 9004], source: 'literal' }], 'an array id with an options object');
  assert.deepEqual(caseFactsAt(facts, spec, 26), [{ ids: ['TC-3'], source: 'literal' }], 'a quoted string id');
  assert.deepEqual(caseFactsAt(facts, 'tests/focused.spec.ts', 4), [{ ids: [9008], source: 'literal' }], 'test.only(');
  const declarations = declarationsOf(facts, spec);
  assert.deepEqual(
    declarations.map((candidate) => [candidate.line, candidate.skipped]),
    [[6, false], [11, true], [16, true], [21, false], [26, false], [31, false], [42, false]],
  );
});

test('Title wrapper case ids AC-2: a wrapper over several lines gives its fact at the test( line', (t) => {
  const { dir, facts } = extractTill(t);
  const spec = 'tests/positions.spec.ts';
  const lines = readFileSync(join(dir, 'e2e', spec), 'utf8').split('\n');
  assert.equal(lines[30].trim(), 'test(', 'the declaration opens on line 31');
  assert.equal(lines[32].trim(), '9006,', 'its id sits two lines further down');
  const declaration = declarationsOf(facts, spec).find((candidate) => candidate.test.includes('several lines'));
  assert.equal(declaration.line, 31);
  assert.deepEqual(caseFactsAt(facts, spec, declaration.line), [{ ids: [9006], source: 'literal' }]);
  assert.deepEqual(caseFactsAt(facts, spec, 33), []);
  assert.deepEqual(caseFactsAt(facts, spec, 42), [{ ids: [9007], source: 'literal' }], 'a body passed by reference still has a title');
});

test('Title wrapper case ids AC-3: a table row in title position gives one fact per row in table order', (t) => {
  const { facts } = extractTill(t);
  const spec = 'tests/table.spec.ts';
  assert.deepEqual(caseFactsAt(facts, spec, 13), [
    { ids: [9020], source: 'table' },
    { ids: [9021], source: 'table' },
  ]);
  assert.deepEqual(
    caseFactsAt(facts, spec, 19),
    [{ ids: [], source: 'unresolved', expression: 'row.id' }],
    'a table with a row that is not a plain integer resolves no row',
  );
});

test('Title wrapper case ids AC-4: body calls read their first argument and follow the title fact', (t) => {
  const { facts } = extractTill(t);
  const spec = 'tests/body.spec.ts';
  assert.deepEqual(caseFactsAt(facts, spec, 6), [{ ids: [9010], source: 'literal' }], 'a one-argument body call');
  assert.deepEqual(caseFactsAt(facts, spec, 12), [{ ids: [9011], source: 'literal' }], 'a two-argument body call');
  assert.deepEqual(
    caseFactsAt(facts, spec, 18),
    [
      { ids: [9012], source: 'literal' },
      { ids: [9013], source: 'literal' },
    ],
    'the title fact comes first, then the body fact, with no merge',
  );
  assert.deepEqual(caseFactsAt(facts, spec, 24), [{ ids: [9014], source: 'annotation' }]);
  assert.deepEqual(caseFactsAt(facts, spec, 30), [], 'a body call with no argument');
});

test('Title wrapper case ids AC-5: title text and a subscript index are never read as an id', (t) => {
  const { dir, facts } = extractTill(t);
  const caseFacts = facts.filter((candidate) => candidate.type === 'case_id');
  const emitted = caseFacts.flatMap((candidate) => candidate.ids);
  assert.ok(!emitted.includes(4012), 'the number at the start of a title is title text');
  assert.ok(!emitted.includes(0), 'the index of a subscript is not an id');
  assert.deepEqual(caseFactsAt(facts, 'tests/text.spec.ts', 10), [{ ids: [], source: 'unresolved', expression: 'caseId' }]);
  assert.deepEqual(caseFactsAt(facts, 'tests/text.spec.ts', 12), [{ ids: [], source: 'unresolved', expression: 'rows[0].id' }]);

  const unwritten = [];
  for (const candidate of caseFacts) {
    if (candidate.source === 'annotation' || candidate.source === 'unresolved') continue;
    const source = readFileSync(join(dir, 'e2e', candidate.spec), 'utf8');
    const args = firstArguments(source);
    for (const id of candidate.ids) {
      const written =
        candidate.source === 'table'
          ? args.includes('row.id') && new RegExp(`\\bid:\\s*${id}\\b`).test(source)
          : typeof id === 'number'
            ? args.some((arg) => new RegExp(`(^|[^\\d])${id}([^\\d]|$)`).test(arg))
            : args.some((arg) => arg.includes(`'${id}'`) || arg.includes(`"${id}"`));
      if (!written) unwritten.push({ spec: candidate.spec, line: candidate.line, id });
    }
  }
  assert.deepEqual(unwritten, [], 'every emitted id is written in the first argument of a configured call');
});

test('Title wrapper case ids AC-6: an argument no reader resolves gives one unresolved record', (t) => {
  const { facts } = extractTill(t);
  const spec = 'tests/unresolved.spec.ts';
  const shapes = ['someId', 'ids[1]', "caseIdOf('drawer')", '`${base}43`', 'flag ? 9044 : 9045'];
  const titleLines = [15, 17, 19, 21, 23];
  titleLines.forEach((line, i) => {
    assert.deepEqual(caseFactsAt(facts, spec, line), [{ ids: [], source: 'unresolved', expression: shapes[i] }], `title position: ${shapes[i]}`);
  });
  const body = caseFactsAt(facts, spec, 25);
  assert.deepEqual(
    body.slice(0, 5),
    shapes.map((expression) => ({ ids: [], source: 'unresolved', expression })),
    'the same shapes in a test body',
  );
  assert.equal(body.length, 6);
  const long = body[5].expression;
  assert.equal(long.length, 160, 'a long argument is cut at 160 characters');
  assert.ok(!/\s{2}|\n/.test(long), 'its white space is collapsed');
  assert.ok(long.startsWith("caseIdOf('a long reference name that keeps going') + caseIdOf('a second"));
  assert.deepEqual(caseFactsAt(facts, spec, 38), [], 'a TODO placeholder, in title position and in the body');
  assert.deepEqual(caseFactsAt(facts, spec, 42), [], 'a wrapper with one argument holds a title and no id');
  assert.equal(declarationsOf(facts, spec).length, 8, 'no declaration of the file is lost');
});

test('Title wrapper case ids AC-7: the schema accepts the unresolved record and refuses a malformed one', () => {
  const base = { type: 'case_id', file: 'tests/one.spec.ts', line: 3, spec: 'tests/one.spec.ts' };
  assert.equal(validateFacts([{ ...base, ids: [], source: 'unresolved', expression: 'row.id' }]), 1);
  assert.throws(
    () => validateFacts([{ ...base, ids: [7], source: 'unresolved', expression: 'row.id' }]),
    /Fact #0 \(case_id\): field "ids" must be empty when "source" is "unresolved"/,
  );
  for (const expression of [undefined, '', '   ', 7]) {
    const candidate = { ...base, ids: [], source: 'unresolved' };
    if (expression !== undefined) candidate.expression = expression;
    assert.throws(
      () => validateFacts([candidate]),
      /field "expression" must be a non-empty string when "source" is "unresolved"/,
      `expression ${JSON.stringify(expression)}`,
    );
    assert.throws(() => fact('case_id', { ...candidate, type: undefined }), /field "expression" must be a non-empty string/);
  }
  assert.equal(
    validateFacts([
      { ...base, ids: [9001], source: 'literal' },
      { ...base, ids: [9002], source: 'table' },
      { ...base, ids: ['TC-3'], source: 'annotation' },
      { ...base, ids: [9003], source: 'literal', expression: 'ignored' },
    ]),
    4,
  );
});

function declaration(expression) {
  return { type: 'pw_test', spec: 'tests/one.spec.ts', test: expression };
}

function site(titles) {
  return { titles };
}

test('Title wrapper case ids AC-8: a wrapped title is found inside the runner title', (t) => {
  const wrapped = declaration("caseRef(9001, 'refunds a sale')");
  assert.equal(refusalReason([wrapped], [site(['refunds a sale (Case 9001)'])], CALLS), null);
  assert.equal(refusalReason([wrapped], [site(['[9001] refunds a sale'])], CALLS), null);
  assert.equal(
    refusalReason([wrapped], [site(['voids a sale (Case 9001)'])], CALLS),
    'declaration 1 reads "refunds a sale", the listing resolves ["voids a sale (Case 9001)"] there',
  );
  const stringId = declaration("caseRef('TC-3', 'refunds a sale')");
  assert.equal(echoedTitle(stringId.test, CALLS), 'refunds a sale', 'the second argument is the title');
  assert.equal(
    refusalReason([stringId], [site(['TC-3'])], CALLS),
    'declaration 1 reads "refunds a sale", the listing resolves ["TC-3"] there',
  );
  for (const expression of ['caseRef(9001, title)', 'caseRef(9001, `refunds a ${kind}`)', 'caseRef(9001, row.title)']) {
    assert.equal(echoedTitle(expression, CALLS), null, expression);
    assert.equal(refusalReason([declaration(expression)], [site(['anything at all'])], CALLS), null, expression);
  }

  const { dir, facts } = extractTill(t);
  const extra = titleFacts(facts, loadListing(dir), [], CALLS);
  const at = (spec, line) => extra.find((candidate) => candidate.spec === spec && candidate.line === line).titles;
  assert.deepEqual(at('tests/positions.spec.ts', 6), ['refunds a sale (Case 9001)']);
  assert.deepEqual(at('tests/positions.spec.ts', 11), ['[9002] refunds a voided sale']);
});

test('Title wrapper case ids AC-9: case_id, pw_test and pw_title share one key, and span joins the ids', (t) => {
  const { dir, sets, facts } = extractTill(t);
  const refusals = [];
  const titles = titleFacts(facts, loadListing(dir), refusals, CALLS);
  assert.deepEqual(refusals, []);
  facts.push(...titles);

  const wrapped = facts.filter((candidate) => candidate.type === 'pw_test' && candidate.test.startsWith('caseRef('));
  const resolvedIds = new Map();
  for (const declared of wrapped) {
    const caseFacts = facts.filter((candidate) => candidate.type === 'case_id' && candidate.spec === declared.spec && candidate.line === declared.line);
    const titleFact = titles.find((candidate) => candidate.spec === declared.spec && candidate.line === declared.line);
    assert.ok(titleFact, `${declared.spec}:${declared.line} has a pw_title fact at its own key`);
    for (const caseFact of caseFacts) assert.equal(caseFact.file, declared.file);
    resolvedIds.set(`${declared.spec}::${declared.test}`, {
      ids: caseFacts.flatMap((candidate) => candidate.ids),
      titles: titleFact.titles,
    });
  }

  const model = span(sets, ROUTE);
  assert.equal(model.error, undefined);
  const joined = model.evidence.verifying.filter((entry) => resolvedIds.has(`${entry.spec}::${entry.raw}`));
  assert.deepEqual(
    joined.map((entry) => entry.raw).sort(),
    [
      "caseRef( 9006, 'refunds a sale over several lines', )",
      "caseRef('TC-3', 'refunds a gift card')",
      "caseRef(9001, 'refunds a sale')",
      "caseRef(9012, 'refunds a voucher')",
      "caseRef([9003, 9004], 'refunds two lines')",
      "caseRef(row.id, 'refunds a pending row')",
      "caseRef(row.id, 'refunds by tender')",
    ],
    'every wrapped declaration whose own body requests the route and asserts its status',
  );
  for (const entry of joined) {
    const expected = resolvedIds.get(`${entry.spec}::${entry.raw}`);
    assert.deepEqual({ caseIds: entry.caseIds, titles: entry.titles }, { caseIds: expected.ids, titles: expected.titles }, entry.raw);
  }
  const byRaw = new Map(joined.map((entry) => [entry.raw, entry.caseIds]));
  assert.deepEqual(byRaw.get("caseRef(9001, 'refunds a sale')"), [9001]);
  assert.deepEqual(byRaw.get("caseRef(row.id, 'refunds by tender')"), [9020, 9021]);
  assert.deepEqual(byRaw.get("caseRef(9012, 'refunds a voucher')"), [9012, 9013]);
  assert.deepEqual(byRaw.get("caseRef(row.id, 'refunds a pending row')"), [], 'an unresolved record joins as no ids');
});

test('Title wrapper case ids AC-10: with no caseId key a wrapped title gives no fact and resolution does not change', (t) => {
  const { dir, facts } = extractTill(t, 'till-plain.config.json');
  const caseFacts = facts.filter((candidate) => candidate.type === 'case_id');
  assert.deepEqual(
    caseFacts.map(({ spec, line, ids, source }) => ({ spec, line, ids, source })),
    [{ spec: 'tests/body.spec.ts', line: 24, ids: [9014], source: 'annotation' }],
    'only the annotation push resolves without configuration',
  );
  const sitesBySpec = loadListing(dir);
  for (const declared of facts.filter((candidate) => candidate.type === 'pw_test' && candidate.test.startsWith('caseRef('))) {
    assert.equal(echoedTitle(declared.test, []), null, 'an unconfigured wrapper rests on its position');
  }
  assert.deepEqual(refusalsFor(facts, sitesBySpec, []), []);
  assert.deepEqual(refusalsFor(facts, sitesBySpec, ['caseRef.id']), []);
  assert.deepEqual(refusalsFor(facts, sitesBySpec, CALLS), []);

  const bodyOnly = extractTill(t, 'till-body-call.config.json').facts;
  assert.deepEqual(
    [6, 12, 18, 24, 30].map((line) => caseFactsAt(bodyOnly, 'tests/body.spec.ts', line)),
    [[{ ids: [9010], source: 'literal' }], [{ ids: [9011], source: 'literal' }], [{ ids: [9013], source: 'literal' }], [{ ids: [9014], source: 'annotation' }], []],
    'with the body call alone, the wrapped title gives no fact and the body calls still do',
  );
  assert.equal(caseFactsAt(bodyOnly, 'tests/positions.spec.ts', 6).length, 0);
});

test('Title wrapper case ids AC-14: a misaligned wrapped file refuses with the existing reason', (t) => {
  const { dir, facts } = extractTill(t);
  const spec = 'tests/misaligned.spec.ts';
  const reasonFor = (mutate) => {
    const refusals = refusalsFor(facts, loadListing(dir, mutate), CALLS);
    return refusals.filter((refusal) => refusal.spec === spec).map((refusal) => refusal.reason);
  };
  assert.deepEqual(reasonFor(() => {}), [], 'the aligned listing resolves');

  const swapped = reasonFor((listing) => {
    const specs = specsOf(listing, spec);
    [specs[0].title, specs[1].title] = [specs[1].title, specs[0].title];
  });
  assert.deepEqual(swapped, ['declaration 1 reads "opens the drawer", the listing resolves ["closes the till (Case 2)"] there']);

  const shifted = reasonFor((listing) => {
    const specs = specsOf(listing, spec);
    const titles = specs.map((entry) => entry.title);
    specs.forEach((entry, i) => {
      entry.title = titles[(i + 1) % titles.length];
    });
  });
  assert.equal(loadListing(dir).get(spec).length, declarationsOf(facts, spec).length, 'the count agrees, so the text check refuses');
  assert.deepEqual(shifted, ['declaration 1 reads "opens the drawer", the listing resolves ["closes the till (Case 2)"] there']);
});

test('Title wrapper case ids AC-15: a site with several runner titles passes only when each holds the title', (t) => {
  const { dir, facts } = extractTill(t);
  const spec = 'tests/table.spec.ts';
  const reasonFor = (mutate) =>
    refusalsFor(facts, loadListing(dir, mutate), CALLS)
      .filter((refusal) => refusal.spec === spec)
      .map((refusal) => refusal.reason);
  assert.deepEqual(reasonFor(() => {}), [], 'two row titles that both hold the title argument');
  assert.deepEqual(
    reasonFor((listing) => {
      specsOf(listing, spec)[1].title = 'refunds by card (Case 9021)';
    }),
    ['declaration 1 reads "refunds by tender", the listing resolves ["refunds by tender (Case 9020)","refunds by card (Case 9021)"] there'],
  );
  assert.equal(
    refusalReason([declaration('refunds a sale')], [site(['refunds a sale', 'refunds a sale again'])], CALLS),
    'declaration 1 reads "refunds a sale", the listing resolves ["refunds a sale","refunds a sale again"] there',
    'a plain literal keeps equality with exactly one title',
  );
});
