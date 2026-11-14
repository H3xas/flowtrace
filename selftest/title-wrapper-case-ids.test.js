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

import { fact, factIdentity, validateFacts } from '../lib/facts.js';
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
    .map(({ ids, source, expression, instance }) => ({
      ids,
      source,
      ...(expression === undefined ? {} : { expression }),
      ...(instance === undefined ? {} : { instance }),
    }));
}

function declarationsOf(facts, spec) {
  return facts.filter((candidate) => candidate.type === 'pw_test' && candidate.spec === spec);
}

function refusalsFor(facts, sitesBySpec, calls, options = {}) {
  const refusals = [];
  titleFacts(facts, sitesBySpec, refusals, calls, options);
  return refusals;
}

/** The till corpus with extra spec files written into its suite, extracted with `config`. */
function extractWith(t, files, config = 'till.config.json', extraConfig = null) {
  return extractTill(t, config, (dir) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, 'e2e', path), text);
    if (extraConfig) writeFileSync(join(dir, config), JSON.stringify(extraConfig));
  });
}

/** One listing site per declaration of `spec`, holding the titles given for it in order. */
function sitesFor(spec, titlesPerSite) {
  return new Map([[spec, titlesPerSite.map((titles) => ({ titles }))]]);
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
    [
      { ids: [9022], source: 'evaluated', instance: { 'row.id': 9022 } },
      { ids: ['later'], source: 'evaluated', instance: { 'row.id': 'later' } },
    ],
    'a table with a string row is read row by row by the bounded reader',
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
  assert.deepEqual(caseFactsAt(facts, 'tests/text.spec.ts', 10), [{ ids: [9030], source: 'evaluated', instance: {} }]);
  assert.deepEqual(caseFactsAt(facts, 'tests/text.spec.ts', 12), [{ ids: [], source: 'unresolved', expression: 'rows[0].id' }]);

  const unwritten = [];
  for (const candidate of caseFacts) {
    if (candidate.source === 'annotation' || candidate.source === 'unresolved') continue;
    const source = readFileSync(join(dir, 'e2e', candidate.spec), 'utf8');
    const args = firstArguments(source);
    for (const id of candidate.ids) {
      const written =
        candidate.source === 'evaluated'
          ? typeof id === 'number'
            ? new RegExp(`(^|[^\\w.])${id}([^\\w.]|$)`).test(source)
            : source.includes(`'${id}'`) || source.includes(`"${id}"`)
          : candidate.source === 'table'
          ? args.includes('row.id') && new RegExp(`\\bid:\\s*${id}\\b`).test(source)
          : typeof id === 'number'
            ? args.some((arg) => new RegExp(`(^|[^\\d])${id}([^\\d]|$)`).test(arg))
            : args.some((arg) => arg.includes(`'${id}'`) || arg.includes(`"${id}"`));
      if (!written) unwritten.push({ spec: candidate.spec, line: candidate.line, id });
    }
  }
  assert.deepEqual(unwritten, [], 'every literal or table id is in the first argument of a configured call, every evaluated id in the file');
});

test('Title wrapper case ids AC-6: an argument no reader resolves gives one unresolved record', (t) => {
  const extra = [
    "import { test } from '@playwright/test';",
    '',
    "import { caseRef } from '../support/case-ref';",
    "import { refundIds } from '../support/refund-ids';",
    '',
    'function declareFor(id: number) {',
    "  test(caseRef(id, 'reads a parameter'), async () => {});",
    '}',
    '',
    "test(caseRef(process.env.CASE_ID, 'reads the environment'), async () => {});",
    '',
    "test(caseRef(refundIds['card'], 'reads an imported value'), async () => {});",
    '',
    "test('reads them in a body', async () => {",
    '  const check = (n: number) => caseRef.id(n);',
    '  caseRef.id(process.env.CASE_ID);',
    "  caseRef.id(refundIds['card']);",
    '});',
    '',
  ].join('\n');
  const { facts } = extractWith(t, {
    'tests/runtime.spec.ts': extra,
    'support/refund-ids.ts': "export const refundIds = { card: 9046 };\n",
  });
  const spec = 'tests/unresolved.spec.ts';
  const unresolved = (expression) => ({ ids: [], source: 'unresolved', expression });
  const evaluated = (id) => ({ ids: [id], source: 'evaluated', instance: {} });
  const expected = [evaluated(9042), evaluated(9041), unresolved("caseIdOf('drawer')"), unresolved('`${base}43`'), evaluated(9044)];
  [15, 17, 19, 21, 23].forEach((line, i) => {
    assert.deepEqual(caseFactsAt(facts, spec, line), [expected[i]], `title position, line ${line}`);
  });
  const body = caseFactsAt(facts, spec, 25);
  assert.deepEqual(body.slice(0, 5), expected, 'the same shapes in a test body');
  assert.equal(body.length, 6);
  const long = body[5].expression;
  assert.equal(long.length, 160, 'a long argument is cut at 160 characters');
  assert.ok(!/\s{2}|\n/.test(long), 'its white space is collapsed');
  assert.ok(long.startsWith("caseIdOf('a long reference name that keeps going') + caseIdOf('a second"));
  assert.deepEqual(caseFactsAt(facts, spec, 38), [], 'a TODO placeholder, in title position and in the body');
  assert.deepEqual(caseFactsAt(facts, spec, 42), [], 'a wrapper with one argument holds a title and no id');
  assert.equal(declarationsOf(facts, spec).length, 8, 'no declaration of the file is lost');

  const runtime = 'tests/runtime.spec.ts';
  assert.deepEqual(caseFactsAt(facts, runtime, 7), [unresolved('id')], 'a function parameter');
  assert.deepEqual(caseFactsAt(facts, runtime, 10), [unresolved('process.env.CASE_ID')], 'the environment');
  assert.deepEqual(caseFactsAt(facts, runtime, 12), [unresolved("refundIds['card']")], 'a subscript of an imported value');
  assert.deepEqual(
    caseFactsAt(facts, runtime, 14),
    [unresolved('n'), unresolved('process.env.CASE_ID'), unresolved("refundIds['card']")],
    'the same in a test body',
  );
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
  assert.equal(
    validateFacts([
      { ...base, ids: [], source: 'unresolved', expression: 'ids[key]', instance: { 'row.name': 'delta' } },
      { ...base, ids: [9101], source: 'evaluated', instance: { g: false, 'row.name': 'alpha' } },
      { ...base, ids: ['TC-4'], source: 'evaluated', instance: {} },
    ]),
    3,
    'the unresolved record with an instance, and the evaluated record',
  );
  assert.throws(
    () => validateFacts([{ ...base, ids: [], source: 'evaluated', instance: {} }]),
    /field "ids" must be non-empty when "source" is "evaluated"/,
  );
  for (const instance of [undefined, null, [], 'g=false', { g: { nested: true } }]) {
    const candidate = { ...base, ids: [9101], source: 'evaluated' };
    if (instance !== undefined) candidate.instance = instance;
    assert.throws(
      () => validateFacts([candidate]),
      /field "instance" must be an object of string, number or boolean values/,
      `instance ${JSON.stringify(instance)}`,
    );
  }
});

function declaration(expression) {
  return { type: 'pw_test', spec: 'tests/one.spec.ts', test: expression };
}

function site(titles) {
  return { titles };
}

/** A declaration whose title argument source is at hand, as title collection reads it from the file. */
function fromSource(source) {
  return { ...declaration(source), titleSource: source };
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
  for (const expression of ['caseRef(9001, title)', 'caseRef(9001, row.title)']) {
    assert.equal(echoedTitle(expression, CALLS), null, expression);
    assert.equal(refusalReason([declaration(expression)], [site(['anything at all'])], CALLS), null, expression);
    assert.equal(refusalReason([fromSource(expression)], [site(['anything at all'])], CALLS), null, `${expression}, read from the source`);
  }
  const template = fromSource('caseRef(9001, `refunds a ${kind}`)');
  assert.equal(refusalReason([template], [site(['[9001] refunds a sale'])], CALLS), null, 'a wrapped template is held to its literal parts');
  assert.equal(
    refusalReason([template], [site(['anything at all'])], CALLS),
    'declaration 1 reads "refunds a ${kind}", the listing resolves ["anything at all"] there',
  );

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
  assert.deepEqual(byRaw.get("caseRef(row.id, 'refunds a pending row')"), [9022, 'later'], 'each evaluated row joins in row order');
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
  const root = { root: join(dir, 'e2e') };
  assert.deepEqual(refusalsFor(facts, sitesBySpec, [], root), [], 'reading the titles from the source changes nothing here');
  assert.deepEqual(refusalsFor(facts, sitesBySpec, CALLS, root), []);

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

const HEAD = "import { test } from '@playwright/test';\n\nimport { caseRef } from '../support/case-ref';\n\n";

function resolvedFor(facts, dir, spec, titlesPerSite, calls = CALLS) {
  return refusalsFor(facts, sitesFor(spec, titlesPerSite), calls, { root: join(dir, 'e2e') })
    .filter((refusal) => refusal.spec === spec)
    .map((refusal) => refusal.reason);
}

test('Title wrapper case ids AC-16: a long wrapped title is read from the source, not from the cut test text', (t) => {
  const title = 'refunds a sale '.repeat(14).trim().slice(0, 200);
  assert.equal(title.length, 200);
  const spec = 'tests/long.spec.ts';
  const { dir, facts } = extractWith(t, { [spec]: `${HEAD}test(caseRef(9060, '${title}'), async () => {});\n` });
  assert.equal(declarationsOf(facts, spec)[0].test.length, 160, 'the pw_test text is cut');
  assert.deepEqual(resolvedFor(facts, dir, spec, [[`${title} (Case 9060)`]]), [], 'the full argument is in the runner title');
  const cut = `${title.slice(0, 160)} (Case 9060)`;
  assert.deepEqual(resolvedFor(facts, dir, spec, [[cut]]), [
    `declaration 1 reads ${JSON.stringify(title)}, the listing resolves ${JSON.stringify([cut])} there`,
  ]);
});

test('Title wrapper case ids AC-17: a string-literal title is compared after its escapes are read', (t) => {
  const spec = 'tests/escapes.spec.ts';
  const source = `${HEAD}test('it\\'s open', async () => {});\n\ntest("a \\"b\\"", async () => {});\n\ntest(caseRef(9061, 'it\\'s shut'), async () => {});\n`;
  const { dir, facts } = extractWith(t, { [spec]: source });
  assert.deepEqual(resolvedFor(facts, dir, spec, [["it's open"], ['a "b"'], ["it's shut (Case 9061)"]]), []);
  assert.deepEqual(resolvedFor(facts, dir, spec, [["it\\'s open"], ['a "b"'], ["it's shut (Case 9061)"]]), [
    `declaration 1 reads "it's open", the listing resolves ${JSON.stringify(["it\\'s open"])} there`,
  ]);
});

test('Title wrapper case ids AC-18: a configured call that is a member of another object is not that call', (t) => {
  const spec = 'tests/members.spec.ts';
  const source = [
    "import { test } from '@playwright/test';",
    '',
    "test('reads member calls', async () => {",
    '  x.tms.id(9111);',
    '  x?.tms.id(9111);',
    '  tms.id(9112);',
    '});',
    '',
  ].join('\n');
  const config = JSON.parse(readFileSync(join(process.cwd(), 'selftest', 'corpus', 'widget-till', 'till.config.json'), 'utf8'));
  config.caseId.calls = ['tms.id'];
  const { facts } = extractWith(t, { [spec]: source }, 'till.config.json', config);
  assert.deepEqual(caseFactsAt(facts, spec, 3), [{ ids: [9112], source: 'literal' }]);
});

test('Title wrapper case ids AC-20: a template title is held to its literal parts', (t) => {
  const spec = 'tests/templates.spec.ts';
  const source = [
    "import { test } from '@playwright/test';",
    '',
    "import { caseRef } from '../support/case-ref';",
    '',
    "const kind = 'sale';",
    "const title = 'anything';",
    '',
    'test(`refunds a ${kind} now`, async () => {});',
    '',
    'test(caseRef(9070, `voids a ${kind} today`), async () => {});',
    '',
    'test(`${title}`, async () => {});',
    '',
  ].join('\n');
  const { dir, facts } = extractWith(t, { [spec]: source });
  const aligned = [['refunds a sale now'], ['[9070] voids a sale today'], ['whatever the runner says']];
  assert.deepEqual(resolvedFor(facts, dir, spec, aligned), [], 'a plain template, a wrapped one and one with no literal part');
  assert.deepEqual(resolvedFor(facts, dir, spec, [['refunds a sale now (Case 1)'], aligned[1], aligned[2]]), [
    'declaration 1 reads "refunds a ${kind} now", the listing resolves ["refunds a sale now (Case 1)"] there',
  ], 'a plain template matches the whole runner title');
  assert.deepEqual(resolvedFor(facts, dir, spec, [aligned[1], aligned[0], aligned[2]]), [
    'declaration 1 reads "refunds a ${kind} now", the listing resolves ["[9070] voids a sale today"] there',
  ], 'two template titles with different literal parts, swapped');
});

test('Title wrapper case ids AC-21: the identity of an unresolved or evaluated record carries what tells it apart', () => {
  const base = { type: 'case_id', file: 'tests/one.spec.ts', line: 3, spec: 'tests/one.spec.ts' };
  const unresolved = (expression) => factIdentity({ ...base, ids: [], source: 'unresolved', expression });
  assert.notEqual(unresolved('row.id'), unresolved('rows[0].id'));
  assert.equal(unresolved('row.id'), unresolved('row.id'));
  const evaluated = (instance) => factIdentity({ ...base, ids: [9101], source: 'evaluated', instance });
  assert.notEqual(evaluated({ g: false }), evaluated({ g: true }));
  assert.equal(evaluated({ g: false, 'row.name': 'a' }), evaluated({ 'row.name': 'a', g: false }), 'key order does not matter');
  assert.notEqual(
    factIdentity({ ...base, ids: [], source: 'unresolved', expression: 'k', instance: { 'row.name': 'a' } }),
    factIdentity({ ...base, ids: [], source: 'unresolved', expression: 'k', instance: { 'row.name': 'b' } }),
  );
});

test('Title wrapper case ids AC-22: a computed title rests on its position', (t) => {
  const spec = 'tests/computed.spec.ts';
  const source = `${HEAD}const suffix = 'b';\n\ntest(caseRef(9080, 'a') + ' b', async () => {});\n\ntest('a' + suffix, async () => {});\n`;
  const { dir, facts } = extractWith(t, { [spec]: source });
  const listing = [['a (Case 9080) b'], ['a b']];
  const fromText = refusalsFor(facts, sitesFor(spec, listing), CALLS).filter((refusal) => refusal.spec === spec);
  assert.equal(fromText.length, 1, 'the text check alone holds the computed title to its source text');
  assert.deepEqual(resolvedFor(facts, dir, spec, listing), [], 'read from the source, both rest on their position');
});

test('Title wrapper case ids AC-23: the wrapper title check reads only the title argument', (t) => {
  const spec = 'tests/interpolated.spec.ts';
  const source = `${HEAD}const base = 90;\n\ntest(caseRef(\`\${base}1\`, 'opens the drawer'), async () => {});\n\ntest(caseRef('\${x}', 'closes the till'), async () => {});\n`;
  const { dir, facts } = extractWith(t, { [spec]: source });
  const swapped = [['closes the till (Case 2)'], ['opens the drawer (Case 901)']];
  const expected = ['declaration 1 reads "opens the drawer", the listing resolves ["closes the till (Case 2)"] there'];
  assert.deepEqual(resolvedFor(facts, dir, spec, swapped), expected, 'read from the source');
  assert.deepEqual(
    refusalsFor(facts, sitesFor(spec, swapped), CALLS)
      .filter((refusal) => refusal.spec === spec)
      .map((refusal) => refusal.reason),
    expected,
    'read from the test text',
  );
});
