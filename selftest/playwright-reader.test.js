import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, runCli } from './helpers.js';
import { extract as extractPlaywright } from '../lib/extract/playwright.js';
import { extract as extractWeb } from '../lib/extract/web.js';
import { extract as extractMobile } from '../lib/extract/mobile.js';
import { validateFacts } from '../lib/facts.js';
import { lexState, lexStep, maskLiteralText, readLiteral, blankComments, matchBalanced, splitArgs } from '../lib/extract/text.js';

function writeTree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-pw-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

async function read(t, files, options = {}) {
  return extractPlaywright(writeTree(t, files), options);
}

const ofType = (facts, type, title) => facts.filter((f) => f.type === type && (title === undefined || f.test === title));
const backendOf = (facts, title) => {
  const found = ofType(facts, 'pw_backend', title);
  assert.equal(found.length, 1, `one pw_backend for ${title}: ${JSON.stringify(found)}`);
  return found[0];
};
const titles = (facts) => ofType(facts, 'pw_test').map((f) => f.test);
const classes = (facts) => Object.fromEntries(ofType(facts, 'pw_backend').map((f) => [f.test, f.reason ? `${f.backend}:${f.reason}` : f.backend]));
const requests = (facts, title) => ofType(facts, 'pw_request', title).map((f) => `${f.verb} ${f.template}${f.resolved ? '' : ' (unresolved)'}`);

/** The offsets at which the shared lexer starts a regex literal. */
function regexStarts(text) {
  const starts = [];
  const state = lexState();
  for (let i = 0; i < text.length; ) {
    const next = lexStep(text, i, state);
    if (state.literal === 'regex') starts.push(i);
    i = next;
  }
  return starts;
}

const MOCK = { backendCalls: { mockCalls: ['mockAll'], patchCalls: [] } };

test('Playwright reader AC-1: one token rule tells a regex from a division, and every extractor reads past a regex', async (t) => {
  const division = ['a / b', '1 / 2', '(a) / b', 'a[0] / b', 'f() {} / b', "'s' / b", '`t` / b', 'x.y / 2'];
  for (const text of division) assert.deepEqual(regexStarts(text), [], `division: ${text}`);
  const keywords = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'];
  const regex = [
    ...keywords.map((word) => [`${word} /x/`, word.length + 1]),
    ['/x/', 0],
    ['a = /x/', 4],
    ['f(/x/)', 2],
    ['[1, /x/]', 4],
    ['a && /x/', 5],
    ['!/x/', 1],
    ['a ? /x/ : b', 4],
  ];
  for (const [text, at] of regex) assert.deepEqual(regexStarts(text), [at], `regex: ${text}`);

  const literal = (text, at = 0) => readLiteral(text, at, true);
  assert.deepEqual(literal('/a\\/b/ + c'), { kind: 'regex', end: 6 }, 'an escaped slash');
  assert.deepEqual(literal('/[/]/ + c'), { kind: 'regex', end: 5 }, 'a slash in a class');
  assert.deepEqual(literal('/[\\]/]/ + c'), { kind: 'regex', end: 7 }, 'an escaped bracket in a class');
  assert.deepEqual(literal(`/'"/ + c`), { kind: 'regex', end: 4 }, 'quotes in a regex');
  assert.deepEqual(literal('// c\nx'), { kind: 'comment', end: 4 }, 'a line comment is never an empty regex');
  assert.equal(literal('/abc\nx = 1;'), null, 'a regex that does not close on its line is no literal');

  const nested = '`a ${ /}/.test(s) ? `${ /* } */ b }` : c } d`;\nx = 1;\n';
  const masked = maskLiteralText(nested);
  const breaks = (text) => [...text].flatMap((ch, i) => (ch === '\n' ? [i] : []));
  assert.equal(masked.length, nested.length);
  assert.deepEqual(breaks(masked), breaks(nested), 'line breaks stay where they were');
  assert.ok(masked.endsWith('`;\nx = 1;\n'), 'the code after nested interpolations is code');
  assert.equal(matchBalanced('f(/[(]/, `${ g(/)/) }`)', 1), 22, 'a regex in an interpolation is one token');
  assert.deepEqual(splitArgs('/,/, b').map((p) => p.text), ['/,/', 'b']);
  assert.equal(blankComments('`${ a /* } */ }`').includes('}'), true);
  assert.equal(blankComments('`${ a /* } */ }`').length, '`${ a /* } */ }`'.length);
  const unterminated = '`abc ${ d';
  assert.equal(maskLiteralText(unterminated).length, unterminated.length, 'an unterminated template keeps its length');

  const spec = await read(t, {
    'e2e/regex.pw.ts': [
      "import { test } from '@playwright/test';",
      'const marker = /it\'s a "quote"\\/\\/x/;',
      "test('after a regex', async ({ page }) => {",
      "  await page.goto('/');",
      '});',
      '',
    ].join('\n'),
  });
  assert.deepEqual(titles(spec), ['after a regex']);
  const regexLine = 'const marker = /it\'s a "quote"\\/\\/x/;';
  const web = await extractWeb(writeTree(t, { 'src/Panel.tsx': `${regexLine}\nexport function Panel() {\n  return <div>panel</div>;\n}\n` }), {});
  assert.deepEqual(web.filter((f) => f.type === 'component').map((f) => f.name), ['Panel']);
  const mobile = await extractMobile(
    writeTree(t, {
      'src/app/features/panel.page.ts': `import { Component } from '@angular/core';\n${regexLine}\n\n@Component({\n  selector: 'app-panel',\n  templateUrl: './panel.page.html',\n})\nexport class PanelPage {\n  constructor() {}\n}\n`,
      'src/app/features/panel.page.html': '<div></div>\n',
    }),
    {},
  );
  assert.deepEqual(mobile.filter((f) => f.type === 'component').map((f) => f.name), ['PanelPage']);

  const source = readFileSync(join(REPO_ROOT, 'lib', 'extract', 'playwright.js'), 'utf8');
  assert.doesNotMatch(source, /^function (skipString|skipTemplate|matchBalanced|blankComments)\b/m);
});

test('Playwright reader AC-2: a route regex with a slash or a quote keeps the test and reads its handler', async (t) => {
  const facts = await read(t, {
    'e2e/routes.pw.ts': [
      "import { test } from '@playwright/test';",
      "test('slash regex', async ({ page }) => {",
      '  await page.route(/api\\/prices\\//, async (route) => {',
      '    const response = await route.fetch();',
      '    await route.fulfill({ response });',
      '  });',
      '});',
      "test('double quote regex', async ({ page }) => {",
      '  await page.route(/"items/, (route) => route.continue());',
      '});',
      "test('single quote regex', async ({ page }) => {",
      "  await page.route(/it's/, (route) => route.continue());",
      '});',
      "test('paren regex', async ({ page }) => {",
      '  await page.route(/\\(/, (route) => route.continue());',
      '  await page.route(/[(]/, (route) => route.continue());',
      '});',
      "test('unread handler', async ({ page }) => {",
      '  await page.route(/x\\//, handler);',
      '});',
      '',
    ].join('\n'),
  });
  assert.deepEqual(titles(facts), ['slash regex', 'double quote regex', 'single quote regex', 'paren regex', 'unread handler']);
  assert.deepEqual(classes(facts), {
    'slash regex': 'patched',
    'double quote regex': 'real',
    'single quote regex': 'real',
    'paren regex': 'real',
    'unread handler': 'unknown:named-handler',
  });
  const stub = ofType(facts, 'pw_stub', 'slash regex');
  assert.equal(stub.length, 1);
  assert.equal(stub[0].handler, 'fetch-fulfill');
  assert.equal(stub[0].resolved, false);
});

test('Playwright reader AC-3: a comment inside an interpolation is not a call, and the code there still is', async (t) => {
  const facts = await read(
    t,
    {
      'e2e/comments.pw.ts': [
        "import { test } from '@playwright/test';",
        "test('block comment', async ({ page }) => {",
        '  await page.goto(`/a?x=${ /* mockAll() */ 1 }`);',
        '});',
        "test('line comment', async ({ page }) => {",
        '  await page.goto(`/a?x=${ 1 // mockAll()',
        '  }`);',
        '});',
        "test('code in an interpolation', async ({ page }) => {",
        '  await page.goto(`/a?x=${ mockAll() }`);',
        '});',
        "test('string', async ({ page }) => {",
        "  const label = 'mockAll()';",
        '});',
        "test('comment outside', async ({ page }) => {",
        '  // mockAll();',
        '});',
        '',
      ].join('\n'),
    },
    MOCK,
  );
  assert.deepEqual(classes(facts), {
    'block comment': 'real',
    'line comment': 'real',
    'code in an interpolation': 'mocked',
    string: 'real',
    'comment outside': 'real',
  });
  assert.equal(backendOf(facts, 'code in an interpolation').sites[0].line, 10);
});

test('Playwright reader AC-4: a parenthesized reference is a reference in the test and in its hooks', async (t) => {
  const facts = await read(
    t,
    {
      'e2e/refs.pw.ts': [
        "import { test } from '@playwright/test';",
        'const sharedScenario = async () => {};',
        "test('wrapped reference', (sharedScenario));",
        "test('bare reference', sharedScenario);",
        "test('wrapped arrow', (async () => { mockAll(); }));",
        "test.describe('hooks', () => {",
        '  test.beforeEach((sharedScenario));',
        '  test.beforeAll((sharedScenario));',
        "  test('under wrapped hooks', async () => {});",
        '});',
        '',
      ].join('\n'),
    },
    MOCK,
  );
  assert.deepEqual(classes(facts), {
    'wrapped reference': 'unknown:body-by-reference',
    'bare reference': 'unknown:body-by-reference',
    'wrapped arrow': 'mocked',
    'under wrapped hooks': 'unknown:body-by-reference',
  });
  const hookSites = backendOf(facts, 'under wrapped hooks').sites;
  assert.deepEqual(hookSites.map((s) => [s.where, s.call]), [['hook', 'test.beforeEach'], ['hook', 'test.beforeAll']]);
  for (const name of ['playwright.js', 'pw-backend.js']) {
    const source = readFileSync(join(REPO_ROOT, 'lib', 'extract', name), 'utf8');
    assert.match(source, /import \{[^}]*\bisInlineCallback\b[^}]*\} from '\.\/text\.js'/, name);
    assert.doesNotMatch(source, /INLINE_FUNCTION_RE/, name);
  }
});

test('Playwright reader AC-5: a dotted entry matches only the callee as written', async (t) => {
  const spec = [
    "import { test } from '@playwright/test';",
    "test('plain', async () => { await fixtures.seed(); });",
    "test('optional', async () => { await fixtures?.seed(); });",
    "test('spaced', async () => { await fixtures . seed(); });",
    "test('longer', async () => { await other.fixtures.seed(); });",
    "test('this', async function () { await this.fixtures.seed(); });",
    "test('namespace', async () => { await ns.api.mock(); });",
    "test('undotted', async () => { await seedAll(); });",
    '',
  ].join('\n');
  const facts = await read(t, { 'e2e/dotted.pw.ts': spec }, { backendCalls: { mockCalls: ['api.mock'], patchCalls: ['fixtures.seed', 'seedAll'] } });
  assert.deepEqual(classes(facts), {
    plain: 'patched',
    optional: 'patched',
    spaced: 'patched',
    longer: 'real',
    this: 'real',
    namespace: 'real',
    undotted: 'patched',
  });
  const own = await read(t, { 'e2e/dotted.pw.ts': spec }, { backendCalls: { mockCalls: [], patchCalls: ['this.fixtures.seed'] } });
  assert.equal(classes(own).this, 'patched');
  assert.equal(classes(own).plain, 'real');
});

test('Playwright reader AC-6: a test call that does not close is one unread test, and the readable tests keep their facts', async (t) => {
  const facts = await read(t, {
    'e2e/unbalanced.pw.ts': [
      "import { test, expect } from '@playwright/test';",
      "test('first readable', async ({ request }) => {",
      "  const response = await request.get('api/one/items');",
      '  expect(response.status()).toBe(200);',
      '});',
      "test('regex after a paren', async ({ page }) => {",
      '  if (ready) /[(]/.test(name);',
      '});',
      "test('second readable', async ({ request }) => {",
      "  await request.get('api/two/items');",
      '});',
      'test();',
      "test.skip('guard');",
      "test.fixme('guard', 'reason');",
      "test('never closes', async ({ request }) => {",
      "  await request.get('api/three/items');",
      '',
    ].join('\n'),
  });
  assert.deepEqual(titles(facts), ['first readable', 'regex after a paren', 'second readable', 'never closes']);
  for (const title of ['regex after a paren', 'never closes']) {
    const declared = ofType(facts, 'pw_test', title);
    assert.equal(declared.length, 1);
    assert.equal(declared[0].unread, 'unbalanced-call');
    assert.equal(backendOf(facts, title).backend, 'unknown');
    assert.deepEqual(backendOf(facts, title).sites, []);
    assert.equal(backendOf(facts, title).reason, 'unbalanced-call');
    for (const type of ['pw_request', 'pw_assert', 'case_id']) assert.deepEqual(ofType(facts, type, title), [], `${type} of ${title}`);
  }
  assert.deepEqual(requests(facts, 'first readable'), ['GET api/one/items']);
  assert.equal(ofType(facts, 'pw_assert', 'first readable').length, 1);
  assert.deepEqual(requests(facts, 'second readable'), ['GET api/two/items']);
  for (const title of ['first readable', 'second readable']) assert.equal('unread' in ofType(facts, 'pw_test', title)[0], false);
  for (const declared of ofType(facts, 'pw_test')) {
    assert.equal(ofType(facts, 'pw_backend').filter((b) => b.file === declared.file && b.line === declared.line).length, 1);
  }
});

const CONTAINMENT = {
  'tests/three.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    "test('one', async ({ request }) => {",
    "  test.info().annotations.push({ type: 'case-id', description: 'C1' });",
    "  const response = await request.get('api/one/items');",
    '  expect(response.status()).toBe(200);',
    '});',
    "test('two', async ({ request }) => {",
    "  test.info().annotations.push({ type: 'case-id', description: 'C2' });",
    "  const response = await request.get('api/two/items');",
    '  expect(response.status()).toBe(200);',
    '});',
    "test('three', async ({ request }) => {",
    "  test.info().annotations.push({ type: 'case-id', description: 'C3' });",
    "  const response = await request.get('api/three/items');",
    '  expect(response.status()).toBe(200);',
    '});',
    '',
  ].join('\n'),
  'e2e/stubs.pw.ts': [
    "import { test } from '@playwright/test';",
    "import { stubPrices } from '../helpers/stubs';",
    "test('stubbed', async ({ page }) => {",
    '  await stubPrices(page);',
    "  await page.route('**/api/stock', (route) => route.fulfill({ json: [] }));",
    '});',
    '',
  ].join('\n'),
  'e2e/other.pw.ts': [
    "import { test } from '@playwright/test';",
    "test('other', async ({ page }) => {",
    "  await page.route('**/api/other', (route) => route.fulfill({ json: [] }));",
    '});',
    '',
  ].join('\n'),
  'helpers/stubs.ts': [
    'export async function stubPrices(page) {',
    "  await page.route('**/api/prices', (route) => route.fulfill({ json: [] }));",
    '}',
    '',
  ].join('\n'),
  'helpers/more.ts': [
    'export async function stubBanner(page) {',
    "  await page.route('**/api/banner', (route) => route.fulfill({ json: [] }));",
    '}',
    '',
  ].join('\n'),
};

test('Playwright reader AC-7: a reader that fails inside one test changes the facts of that test only', async (t) => {
  const dir = writeTree(t, CONTAINMENT);
  const plain = await extractPlaywright(dir);
  const spec = 'tests/three.spec.ts';
  const ofTest = (facts, title) => facts.filter((f) => f.spec === spec && f.test === title);
  const ofSpec = (facts) => facts.filter((f) => f.spec === spec);
  for (const point of ['assert', 'case-id', 'request', 'backend']) {
    const failed = await extractPlaywright(dir, {
      readerFault: (at, context) => {
        if (at === point && context.spec === spec && context.test === 'two') throw new Error('injected');
      },
    });
    assert.deepEqual(ofTest(failed, 'one'), ofTest(plain, 'one'), `${point}: one`);
    assert.deepEqual(ofTest(failed, 'three'), ofTest(plain, 'three'), `${point}: three`);
    const two = ofSpec(failed).filter((f) => f.test === 'two' || (f.type === 'case_id' && f.line === 7));
    assert.deepEqual(two.filter((f) => f.type === 'pw_test').map((f) => f.unread), ['reader-failure'], point);
    assert.deepEqual(two.filter((f) => f.type === 'pw_request' || f.type === 'pw_assert'), [], `${point}: partial facts are discarded`);
    const backend = two.filter((f) => f.type === 'pw_backend');
    assert.deepEqual(backend.map((f) => [f.backend, f.reason, f.sites.length]), [['unknown', 'reader-failure', 0]], point);
    const caseIds = ofSpec(failed).filter((f) => f.type === 'case_id' && f.line === 7);
    assert.equal(caseIds.length, point === 'case-id' ? 0 : 1, `${point}: a finished case id stays`);
  }
  const stubsOf = (facts) => facts.filter((f) => f.type === 'pw_stub').map((f) => `${f.spec} ${f.kind} ${f.pattern || f.helper}`).sort();
  const specFailed = await extractPlaywright(dir, {
    readerFault: (at, context) => {
      if (at === 'stub-spec' && context.spec === 'e2e/stubs.pw.ts') throw new Error('injected');
    },
  });
  assert.deepEqual(stubsOf(specFailed), stubsOf(plain).filter((s) => !s.startsWith('e2e/stubs.pw.ts')));
  assert.ok(stubsOf(specFailed).includes('e2e/other.pw.ts route **/api/other'));
  const indexFailed = await extractPlaywright(dir, {
    readerFault: (at, context) => {
      if (at === 'stub-index' && context.file === 'helpers/more.ts') throw new Error('injected');
    },
  });
  assert.deepEqual(stubsOf(indexFailed), stubsOf(plain), 'the helpers of the other files stay');
  const indexOwnFailed = await extractPlaywright(dir, {
    readerFault: (at, context) => {
      if (at === 'stub-index' && context.file === 'helpers/stubs.ts') throw new Error('injected');
    },
  });
  assert.deepEqual(
    stubsOf(indexOwnFailed),
    stubsOf(plain).filter((s) => s !== 'e2e/stubs.pw.ts opaque stubPrices'),
    'only the helpers of the failed file are lost',
  );
});

test('Playwright reader AC-8: the fact schema accepts unread only on pw_test and only with its two values', () => {
  const base = { type: 'pw_test', file: 'e2e/a.pw.ts', line: 1, spec: 'e2e/a.pw.ts', test: 't', skipped: false };
  assert.equal(validateFacts([{ ...base, unread: 'unbalanced-call' }, { ...base, unread: 'reader-failure' }, base]), 3);
  assert.throws(() => validateFacts([{ ...base, unread: 'gone' }]), /^Error: Fact #0 \(pw_test\): field "unread" must be one of: unbalanced-call, reader-failure$/);
  const backend = { type: 'pw_backend', file: 'e2e/a.pw.ts', line: 1, spec: 'e2e/a.pw.ts', test: 't', skipped: false, backend: 'unknown', sites: [], unread: 'reader-failure' };
  assert.throws(() => validateFacts([backend]), /field "unread" is only valid on pw_test/);
  const schema = readFileSync(join(REPO_ROOT, 'docs', 'fact-schema.md'), 'utf8');
  for (const term of ['unread', 'unbalanced-call', 'reader-failure', 'unread-fixture', 'unread-option', 'unresolved-base', '`fixture`']) {
    assert.ok(schema.includes(term), `docs/fact-schema.md names ${term}`);
  }
});

const FIXTURES = {
  'support/clients.ts': [
    'export class Alpha {',
    '  constructor(private request) {}',
    "  async getSettings() { return this.request.get('api/alpha/settings'); }",
    '}',
    'export class Beta {',
    '  constructor(private request) {}',
    "  async getSettings() { return this.request.get('api/beta/settings'); }",
    '}',
    '',
  ].join('\n'),
  'support/base.ts': [
    "import { test as base } from '@playwright/test';",
    'export const test = base.extend({',
    '  seeded: async function ({ page }, use) {',
    "    await page.route('**/api/seed', (route) => route.fulfill({ json: {} }));",
    '    await use();',
    '  },',
    '});',
    '',
  ].join('\n'),
  'support/fixtures.ts': [
    "import { test as level } from './base';",
    "import { Alpha } from './clients';",
    'export const test = level.extend<{ client: Alpha; plain: unknown }>({',
    '  mockFlag: [false, { option: true }],',
    '  mockMode: [\'off\', { option: true }],',
    '  client: async ({ request }, use) => {',
    '    await use(new Alpha(request));',
    '  },',
    '  built: async ({ request }, use) => {',
    '    await use(new Alpha(request));',
    '  },',
    '  plain: async ({ request }, use) => {',
    '    await use(request);',
    '  },',
    '  async stubbed({ page, mockFlag }, use) {',
    '    if (mockFlag) {',
    '      mockAll(page);',
    '    }',
    '    await use();',
    '  },',
    '  async unstubbed({ page, mockFlag }, use) {',
    '    if (!mockFlag) mockAll(page);',
    '    await use();',
    '  },',
    '  async moded({ page, mockMode }, use) {',
    '    if (mockMode) mockAll(page);',
    '    await use();',
    '  },',
    '  dependent: async ({ seeded }, use) => {',
    '    await use();',
    '  },',
    '  watcher: [async ({ page }, use) => {',
    "    await page.route('**/api/watch', (route) => route.continue());",
    '    await use();',
    '  }, { auto: true }],',
    '  late: async ({ page }, use) => {',
    '    await use();',
    '    mockAll(page);',
    '  },',
    '  broken: makeFixture(),',
    '});',
    '',
  ].join('\n'),
  'e2e/fixtures.pw.ts': [
    "import { test } from '../support/fixtures';",
    "test('by parameter', async ({ seeded }) => {});",
    "test('by dependency', async ({ dependent }) => {});",
    "test('auto only', async ({ page }) => {});",
    "test('after use', async ({ late }) => {});",
    "test('unread value', async ({ broken }) => {});",
    "test('not defined', async ({ nowhere }) => {});",
    "test('option default', async ({ stubbed }) => {});",
    "test('negated default', async ({ unstubbed }) => {});",
    "test('client', async ({ client }) => {",
    '  await client.getSettings();',
    '});',
    "test('built client', async ({ built }) => {",
    '  await built.getSettings();',
    '});',
    "test('untyped client', async ({ plain }) => {",
    '  await plain.getSettings();',
    '});',
    "test.describe('hooked', () => {",
    '  test.beforeEach(async ({ seeded }) => {});',
    "  test('by hook', async ({ page }) => {});",
    '});',
    "test.describe('after hooks', () => {",
    '  test.afterEach(async ({ page }) => { mockAll(page); });',
    '  test.afterAll(async () => { mockAll(); });',
    "  test('after hooks only', async ({ page }) => {});",
    '});',
    '',
  ].join('\n'),
  'e2e/local.pw.ts': [
    "import { test as base } from '@playwright/test';",
    'const test = base.extend({',
    '  stub: async ({ page }, use) => {',
    "    await page.route('**/api/local', async (route) => route.fulfill({ response: await route.fetch() }));",
    '    await use();',
    '  },',
    '});',
    "test('local extend', async ({ stub }) => {});",
    '',
  ].join('\n'),
  'e2e/options.pw.ts': [
    "import { test } from '../support/fixtures';",
    'test.use({ mockFlag: true });',
    "test('file scope on', async ({ stubbed }) => {});",
    "test('file scope negated', async ({ unstubbed }) => {});",
    "test.describe('inner', () => {",
    '  test.use({ mockFlag: true });',
    '  test.use({ mockFlag: false });',
    "  test('last use in a scope wins', async ({ stubbed }) => {});",
    "  test.describe('deeper', () => {",
    '    test.use({ mockFlag: 1 });',
    "    test('innermost wins', async ({ stubbed }) => {});",
    '  });',
    '});',
    "test.describe('literals', () => {",
    "  test.use({ mockMode: '' });",
    "  test('empty string', async ({ moded }) => {});",
    '});',
    "test.describe('null', () => {",
    '  test.use({ mockMode: null });',
    "  test('null value', async ({ moded }) => {});",
    '});',
    "test.describe('string', () => {",
    "  test.use({ mockMode: 'on' });",
    "  test('string value', async ({ moded }) => {});",
    '});',
    "test.describe('zero', () => {",
    '  test.use({ mockMode: 0 });',
    "  test('zero value', async ({ moded }) => {});",
    '});',
    "test.describe('not literal', () => {",
    '  test.use({ mockFlag: process.env.MOCK });',
    "  test('unread option', async ({ stubbed }) => {});",
    '});',
    "test.describe('spread', () => {",
    '  test.use({ ...shared });',
    "  test('spread value', async ({ stubbed }) => {});",
    '});',
    "test.describe('spread then pair', () => {",
    '  test.use({ ...shared, mockFlag: true });',
    "  test('pair after a spread', async ({ stubbed }) => {});",
    '});',
    "test.describe('pair then spread', () => {",
    '  test.use({ mockFlag: false, ...shared });',
    "  test('spread after a pair', async ({ stubbed }) => {});",
    '});',
    "test.describe('shorthand', () => {",
    '  test.use({ mockFlag });',
    "  test('shorthand value', async ({ stubbed }) => {});",
    '});',
    "test.describe('whole object', () => {",
    '  test.use(sharedOptions);',
    "  test('object by name', async ({ stubbed }) => {});",
    '});',
    "test.describe('other option', () => {",
    "  test.use({ mockMode: 'on' });",
    "  test('another option only', async ({ stubbed }) => {});",
    '});',
    '',
  ].join('\n'),
  'e2e/auto.pw.ts': [
    "import { test as base } from '@playwright/test';",
    'const test = base.extend({',
    '  answered: [async ({ page }, use) => {',
    "    await page.route('**/api/auto', (route) => route.fulfill({ json: {} }));",
    '    await use();',
    '  }, { auto: true }],',
    '});',
    "test('auto stub', async ({ page }) => {});",
    '',
  ].join('\n'),
  'e2e/cycle.pw.ts': [
    "import { test } from '../support/loop-a';",
    "test('cycle', async ({ page }) => {});",
    '',
  ].join('\n'),
  'support/loop-a.ts': "import { test as b } from './loop-b';\nexport const test = b.extend({});\n",
  'support/loop-b.ts': "import { test as a } from './loop-a';\nexport const test = a.extend({});\n",
  'e2e/outside.pw.ts': [
    "import { test } from '../../elsewhere/fixtures';",
    "test('outside root', async ({ seeded }) => {});",
    '',
  ].join('\n'),
  'e2e/excluded.pw.ts': [
    "import { test } from '../node_modules/shared/fixtures';",
    "test('excluded import', async ({ seeded }) => {});",
    '',
  ].join('\n'),
  'node_modules/shared/fixtures.ts': [
    "import { test as base } from '@playwright/test';",
    "export const test = base.extend({ seeded: async ({ page }, use) => { mockAll(page); await use(); } });",
    '',
  ].join('\n'),
};

test('Playwright reader AC-9: a stub in a counted fixture region decides the class', async (t) => {
  const facts = await read(t, FIXTURES, MOCK);
  const cls = classes(facts);
  const spec = 'e2e/fixtures.pw.ts';
  const inSpec = (title) => backendOf(facts.filter((f) => f.spec === spec), title);
  assert.equal(cls['by parameter'], 'patched');
  assert.deepEqual(inSpec('by parameter').sites, [
    { line: 2, where: 'fixture', kind: 'fulfill', call: 'page.route', at: { file: 'support/base.ts', line: 4 }, fixture: 'seeded' },
    { line: 2, where: 'fixture', kind: 'spy', call: 'page.route', at: { file: 'support/fixtures.ts', line: 33 }, fixture: 'watcher' },
  ]);
  assert.equal(cls['by dependency'], 'patched');
  assert.equal(cls['by hook'], 'patched');
  assert.deepEqual(inSpec('auto only').sites.map((s) => [s.kind, s.fixture]), [['spy', 'watcher']]);
  assert.equal(cls['auto only'], 'real');
  assert.equal(cls['after use'], 'real');
  assert.equal(cls['after hooks only'], 'real');
  assert.equal(cls['unread value'], 'unknown:unread-fixture');
  assert.equal(cls['not defined'], 'unknown:unread-fixture');
  assert.equal(cls['local extend'], 'patched');
  assert.equal(cls['auto stub'], 'patched', 'an auto fixture counts for a test that does not name it');
  assert.deepEqual(backendOf(facts, 'auto stub').sites.map((s) => [s.where, s.kind, s.fixture]), [['fixture', 'fulfill', 'answered']]);
  assert.deepEqual(backendOf(facts, 'local extend').sites.map((s) => [s.line, s.kind, s.at]), [[4, 'fetch-fulfill', undefined]]);
  assert.equal(cls.cycle, 'real');
  assert.equal(cls['outside root'], 'real');
  assert.equal(cls['excluded import'], 'real');
});

test('Playwright reader AC-10: test.use sets the option value that gates a fixture stub', async (t) => {
  const cls = classes(await read(t, FIXTURES, MOCK));
  assert.equal(cls['option default'], 'real');
  assert.equal(cls['negated default'], 'mocked');
  assert.equal(cls['file scope on'], 'mocked');
  assert.equal(cls['file scope negated'], 'real');
  assert.equal(cls['last use in a scope wins'], 'real');
  assert.equal(cls['innermost wins'], 'mocked');
  assert.equal(cls['empty string'], 'real');
  assert.equal(cls['null value'], 'real');
  assert.equal(cls['string value'], 'mocked');
  assert.equal(cls['zero value'], 'real');
  assert.equal(cls['unread option'], 'unknown:unread-option');
  assert.equal(cls['spread value'], 'unknown:unread-option');
  assert.equal(cls['pair after a spread'], 'mocked');
  assert.equal(cls['spread after a pair'], 'unknown:unread-option');
  assert.equal(cls['shorthand value'], 'unknown:unread-option');
  assert.equal(cls['object by name'], 'unknown:unread-option');
  assert.equal(cls['another option only'], 'mocked', 'a use that sets another option keeps the file scope value');
});

test('Playwright reader AC-11: a fixture type types the receiver of a helper call', async (t) => {
  const facts = await read(t, FIXTURES, MOCK);
  const settled = (title) => ofType(facts, 'pw_request', title).map((f) => [f.template, f.receiver, f.via, f.reason]);
  assert.deepEqual(settled('client'), [['api/alpha/settings', 'Alpha', 'helper', undefined]]);
  assert.deepEqual(settled('built client'), [['api/alpha/settings', 'Alpha', 'helper', undefined]]);
  assert.deepEqual(ofType(facts, 'pw_request', 'untyped client').map((f) => f.reason), ['ambiguous-receiver']);
});

test('Playwright reader AC-12: an aliased helper import reaches its definition', async (t) => {
  const facts = await read(t, {
    'helpers/index.ts': [
      "export async function actual(request) { return request.put('api/alias'); }",
      "export const arrowActual = async (request) => request.put('api/alias/arrow');",
      'export class ActualClient {',
      '  constructor(private request) {}',
      "  async run() { return this.request.put('api/alias/class'); }",
      '}',
      '',
    ].join('\n'),
    'tests/alias.spec.ts': [
      "import { test } from '@playwright/test';",
      "import { actual as renamed, arrowActual as arrowRenamed, ActualClient as Renamed } from '../helpers';",
      "test('aliased function', async ({ request }) => {",
      '  await renamed(request);',
      '});',
      "test('aliased arrow', async ({ request }) => {",
      '  await arrowRenamed(request);',
      '});',
      "test('aliased class', async ({ request }) => {",
      '  const client = new Renamed(request);',
      '  await client.run();',
      '});',
      '',
    ].join('\n'),
  });
  assert.deepEqual(requests(facts, 'aliased function'), ['PUT api/alias']);
  assert.deepEqual(requests(facts, 'aliased arrow'), ['PUT api/alias/arrow']);
  assert.deepEqual(requests(facts, 'aliased class'), ['PUT api/alias/class']);
});

test('Playwright reader AC-13: a .route( inside a literal never makes a stub helper', async (t) => {
  const facts = await read(t, {
    'helpers/quoted.ts': [
      'export async function singleQuoted(request) {',
      "  const note = 'page.route(';",
      "  return request.get('api/quoted/single');",
      '}',
      'export async function doubleQuoted(request) {',
      '  const note = "page.route(";',
      "  return request.get('api/quoted/double');",
      '}',
      'export async function templated(request) {',
      '  const note = `page.route(`;',
      "  return request.get('api/quoted/template');",
      '}',
      'export async function realStub(page, request) {',
      "  await page.route('**/api/x', (route) => route.fulfill({ json: [] }));",
      "  return request.get('api/quoted/stub');",
      '}',
      'export class QuotedClient {',
      '  constructor(private request) {}',
      '  async read() {',
      "    const note = 'page.route(';",
      "    return this.request.get('api/quoted/method');",
      '  }',
      '}',
      'export async function noteOnly(page) {',
      "  const note = 'page.route(';",
      '}',
      '',
    ].join('\n'),
    'tests/quoted.spec.ts': [
      "import { test } from '@playwright/test';",
      "import { singleQuoted, doubleQuoted, templated, realStub, QuotedClient } from '../helpers/quoted';",
      "test('quoted', async ({ page, request }) => {",
      '  await singleQuoted(request);',
      '  await doubleQuoted(request);',
      '  await templated(request);',
      '  await realStub(page, request);',
      '  const client = new QuotedClient(request);',
      '  await client.read();',
      '});',
      '',
    ].join('\n'),
    'e2e/quoted.pw.ts': [
      "import { test } from '@playwright/test';",
      "import { noteOnly } from '../helpers/quoted';",
      "test('note only', async ({ page }) => {",
      '  await noteOnly(page);',
      '});',
      '',
    ].join('\n'),
  });
  assert.deepEqual(requests(facts, 'quoted'), ['GET api/quoted/single', 'GET api/quoted/double', 'GET api/quoted/template', 'GET api/quoted/method']);
  assert.deepEqual(ofType(facts, 'pw_stub', 'note only'), []);
});

test('Playwright reader AC-14: an inline type marker in an export list exports no value', async (t) => {
  const facts = await read(t, {
    'clients/inline-client.ts': [
      "const constBase = 'api/v1/inline';",
      'export class InlineClient {',
      '  constructor(private request) {}',
      '  async list() { return this.request.get(`${constBase}/items`); }',
      '}',
      'export class MixedClient {',
      '  constructor(private request) {}',
      '  async list() { return this.request.get(`${constBase}/mixed`); }',
      '}',
      '',
    ].join('\n'),
    'clients/types.ts': [
      'class InlineClient {}',
      "const constBase = 'api/v9/other';",
      'const mixedValue = 1;',
      'class MixedClient {}',
      'export { type InlineClient };',
      'export { type constBase };',
      'export { mixedValue as mv, type MixedClient };',
      'export type { InlineClient as Plain };',
      'export { type MixedClient as Renamed };',
      'export { type InlineClient as default };',
      '',
    ].join('\n'),
    'tests/types.spec.ts': [
      "import { test } from '@playwright/test';",
      "import { InlineClient, MixedClient } from '../clients/inline-client';",
      "test('inline type entry', async ({ request }) => {",
      '  const client = new InlineClient(request);',
      '  await client.list();',
      '});',
      "test('mixed type entry', async ({ request }) => {",
      '  const client = new MixedClient(request);',
      '  await client.list();',
      '});',
      '',
    ].join('\n'),
  });
  assert.deepEqual(requests(facts, 'inline type entry'), ['GET api/v1/inline/items']);
  assert.deepEqual(requests(facts, 'mixed type entry'), ['GET api/v1/inline/mixed']);
  assert.deepEqual(ofType(facts, 'pw_request').map((f) => f.reason).filter(Boolean), []);
});

const ROOMS = {
  'flowtrace.config.json': JSON.stringify({
    out: 'out',
    repos: [
      { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
      { id: 'suite', kind: 'playwright', root: 'suite' },
    ],
  }),
  'rooms.area.txt': 'POST lobby/v1/rooms/join/*\nPOST lobby/v1/rooms/leave/*\nPOST other/v1/*/join/*\n',
  'backend/src/Controllers/RoomsController.cs': [
    'using Microsoft.AspNetCore.Mvc;',
    'namespace Lobby.Api.Controllers',
    '{',
    '    [ApiController]',
    '    [Route("lobby/v1/rooms")]',
    '    public class RoomsController : ControllerBase',
    '    {',
    '        [HttpPost("join/{id}")]',
    '        public IActionResult Join(string id) { return Ok(); }',
    '        [HttpPost("leave/{id}")]',
    '        public IActionResult Leave(string id) { return Ok(); }',
    '    }',
    '}',
    '',
  ].join('\n'),
  'backend/src/Controllers/OtherController.cs': [
    'using Microsoft.AspNetCore.Mvc;',
    'namespace Lobby.Api.Controllers',
    '{',
    '    [ApiController]',
    '    [Route("other/v1")]',
    '    public class OtherController : ControllerBase',
    '    {',
    '        [HttpPost("{kind}/join/{id}")]',
    '        public IActionResult Join(string kind, string id) { return Ok(); }',
    '    }',
    '}',
    '',
  ].join('\n'),
  'suite/clients/paths.ts': [
    'export const roomsBase = "lobby/v1/rooms"',
    "export const typedBase = 'lobby/v1/rooms' as const;",
    'export const joinBase = `${roomsBase}/join`;',
    'export const loopA = `${loopB}/a`;',
    'export const loopB = `${loopA}/b`;',
    '',
  ].join('\n'),
  'suite/clients/rooms-client.ts': [
    "import { roomsBase, typedBase, joinBase, loopA } from './paths';",
    'const dynamicBase = process.env.ROOMS_BASE;',
    'export class RoomsClient {',
    '  constructor(private readonly ctx) {}',
    '  async join(roomId) { return this.ctx.post(`${roomsBase}/join/${roomId}`); }',
    '  async typedJoin(roomId) { return this.ctx.post(`${typedBase}/join/${roomId}`); }',
    '  async nestedJoin(roomId) { return this.ctx.post(`${joinBase}/${roomId}`); }',
    '  async localJoin(roomId) {',
    '    const url = `${roomsBase}/join/${roomId}`;',
    '    return this.ctx.post(url);',
    '  }',
    '  async hiddenJoin(roomId) {',
    '    const roomsBase = `lobby/v1/rooms/join/${roomId}`;',
    '    return this.ctx.post(roomsBase);',
    '  }',
    "  async leave(roomId) { return this.ctx.post(roomsBase + '/leave/' + roomId); }",
    '  async loop(roomId) { return this.ctx.post(`${loopA}/${roomId}`); }',
    '  async dynamicJoin(id) { return this.ctx.post(`${dynamicBase}/join/${id}`); }',
    '  async paramJoin(base, id) { return this.ctx.post(`${base}/join/${id}`); }',
    '  async envJoin(id) { return this.ctx.post(`${process.env.BASE}/join/${id}`); }',
    '  async callJoin(id) { return this.ctx.post(`${baseOf()}/join/${id}`); }',
    '  async bare(id) { return this.ctx.post(`${id}`); }',
  "  private readonly fieldBase = 'lobby/v1/rooms';",
  '  async fieldJoin(id) { return this.ctx.post(`${this.fieldBase}/join/${id}`); }',
    '}',
    '',
  ].join('\n'),
  'suite/tests/rooms.spec.ts': [
    "import { test } from '@playwright/test';",
    "import { RoomsClient } from '../clients/rooms-client';",
    ...[
      'join', 'typedJoin', 'nestedJoin', 'localJoin', 'hiddenJoin', 'leave', 'loop',
      'dynamicJoin', 'envJoin', 'callJoin', 'bare', 'fieldJoin',
    ].flatMap((method) => [
      `test('${method}', async ({ request }) => {`,
      '  const rooms = new RoomsClient(request);',
      `  await rooms.${method}('r1');`,
      '});',
    ]),
    "test('paramJoin', async ({ request }) => {",
    '  const rooms = new RoomsClient(request);',
    "  await rooms.paramJoin(process.env.X, 'r1');",
    '});',
    '',
  ].join('\n'),
};

function roomsRun(t) {
  const dir = writeTree(t, ROOMS);
  const extracted = runCli(['extract', '--config', 'flowtrace.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const set = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'suite.json'), 'utf8'));
  return { dir, facts: set.facts };
}

test('Playwright reader AC-15: a const URL base folds in every written form', (t) => {
  const { dir, facts } = roomsRun(t);
  const join = ofType(facts, 'pw_request', 'join')[0];
  assert.deepEqual([join.verb, join.template, join.resolved, join.via], ['POST', 'lobby/v1/rooms/join/${roomId}', true, 'helper']);
  assert.deepEqual(join.chain.map((link) => [link.file, link.call]), [
    ['tests/rooms.spec.ts', 'rooms.join'],
    ['clients/rooms-client.ts', 'this.ctx.post'],
  ]);
  for (const title of ['typedJoin', 'localJoin', 'hiddenJoin']) {
    assert.deepEqual(requests(facts, title), ['POST lobby/v1/rooms/join/${roomId}'], title);
  }
  assert.deepEqual(requests(facts, 'nestedJoin'), ['POST lobby/v1/rooms/join/${roomId}']);
  assert.deepEqual(requests(facts, 'leave'), ['POST lobby/v1/rooms/leave/${roomId}']);
  assert.deepEqual(requests(facts, 'loop').map((r) => r.endsWith('(unresolved)')), [true], 'a const cycle ends unresolved');
  for (const fact of ofType(facts, 'pw_request')) assert.doesNotMatch(fact.template, /\$\{(roomsBase|typedBase|joinBase)\}/);
  const cover = runCli(['cover', '--config', 'flowtrace.config.json', '--area', 'rooms.area.txt', '--json'], { cwd: dir });
  assert.equal(cover.status, 0, cover.stderr);
  const report = JSON.parse(cover.stdout);
  const route = report.routes.find((r) => r.key === 'POST lobby/v1/rooms/join/*');
  assert.ok(route, JSON.stringify(report.routes.map((r) => r.key)));
  assert.equal(route.state, 'route', JSON.stringify(route));
  assert.ok(route.evidence.tests.some((entry) => entry.test === 'join'), JSON.stringify(route.evidence.tests));
});

test('Playwright reader AC-16: a request with an unknown base gives no evidence and is counted', (t) => {
  const { dir, facts } = roomsRun(t);
  for (const title of ['dynamicJoin', 'paramJoin', 'envJoin', 'callJoin', 'loop', 'fieldJoin']) {
    const [fact] = ofType(facts, 'pw_request', title);
    assert.equal(fact.resolved, false, title);
    assert.equal(fact.reason, 'unresolved-base', title);
  }
  assert.equal(ofType(facts, 'pw_request', 'dynamicJoin')[0].template, '${dynamicBase}/join/${id}');
  assert.equal(ofType(facts, 'pw_request', 'paramJoin')[0].template, '${base}/join/${id}');
  const cover = runCli(['cover', '--config', 'flowtrace.config.json', '--area', 'rooms.area.txt', '--json'], { cwd: dir });
  assert.equal(cover.status, 0, cover.stderr);
  const report = JSON.parse(cover.stdout);
  const other = report.routes.find((r) => r.key === 'POST other/v1/*/join/*');
  assert.equal(other.file, 'src/Controllers/OtherController.cs', 'the unrelated route exists');
  assert.equal(other.state, 'none', JSON.stringify(other));
  const known = report.routes.find((r) => r.key === 'POST lobby/v1/rooms/join/*');
  assert.ok(known.evidence.tests.some((entry) => entry.test === 'join'), 'a literal base and a later parameter still match');
  assert.equal(report.notes.intercepts.unresolvedBase, 6);
  const text = runCli(['cover', '--config', 'flowtrace.config.json', '--area', 'rooms.area.txt'], { cwd: dir });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /6 with an unknown base/);
  const markdown = runCli(['cover', '--config', 'flowtrace.config.json', '--area', 'rooms.area.txt', '--md', 'cover.md'], { cwd: dir });
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(readFileSync(join(dir, 'cover.md'), 'utf8'), /6 with an unknown base/);

  // A facts file written before the reason existed gets the same rule, because cover reads the
  // template, not the reason.
  const factsPath = join(dir, 'out', 'facts', 'suite.json');
  const set = JSON.parse(readFileSync(factsPath, 'utf8'));
  for (const fact of set.facts) {
    if (fact.reason === 'unresolved-base') {
      delete fact.reason;
      fact.resolved = true;
    }
  }
  const older = set.facts.find((fact) => fact.type === 'pw_request' && fact.test === 'join');
  set.facts.push({ ...older, line: older.line + 1, template: '${id}' });
  writeFileSync(factsPath, JSON.stringify(set));
  const again = JSON.parse(runCli(['cover', '--config', 'flowtrace.config.json', '--area', 'rooms.area.txt', '--json'], { cwd: dir }).stdout);
  assert.equal(again.notes.intercepts.unresolvedBase, 6);
  assert.equal(again.notes.intercepts.noPath, report.notes.intercepts.noPath + 1, 'a template with no slash is still no path');
  assert.equal(again.routes.find((r) => r.key === 'POST other/v1/*/join/*').state, 'none');
});

test('Playwright reader AC-17: the shapes the reader read before give the same facts', async () => {
  const corpus = join(REPO_ROOT, 'selftest', 'corpus', 'reader-shapes');
  const expected = JSON.parse(readFileSync(join(corpus, 'expected-facts.json'), 'utf8'));
  const facts = await extractPlaywright(join(corpus, 'suite'), {
    caseIdCalls: ['tms.id'],
    backendCalls: { mockCalls: ['stubEverything'], patchCalls: ['seedKilns'] },
  });
  assert.deepEqual(facts, expected);
  assert.ok(new Set(expected.map((f) => f.type)).size >= 6, 'the fixture holds every fact type it pins');
});
