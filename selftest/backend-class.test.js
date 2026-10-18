import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI, REPO_ROOT, copyFixture, runCli, writeJsonFile } from './helpers.js';
import { goldenFacts } from './corpus/kettle-market/golden.mjs';

const CORPUS = 'kettle-market';
const BACKEND_REFUSAL =
  '"backend" must be an object with optional "mockCalls" and "patchCalls", each an array of call names ' +
  '(an identifier or a dotted chain of identifiers), with no name in both';

function corpusConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'kettle.config.json'), 'utf8'));
}

/** Writes `name` as the corpus configuration with `backend` replaced, or removed for `undefined`. */
function writeBackendConfig(dir, name, backend) {
  const config = corpusConfig(dir);
  if (backend === undefined) delete config.backend;
  else config.backend = backend;
  writeJsonFile(dir, name, config);
}

test('Backend class AC-10: every malformed backend value is one refusal with the configuration exit code', (t) => {
  const dir = copyFixture(t, CORPUS);
  const malformed = {
    'not an object': 'mockAllEndpoints',
    'an array': ['mockAllEndpoints'],
    'an unknown key': { mockCalls: [], spyCalls: [] },
    'a list that is not an array': { mockCalls: 'stubEveryEndpoint' },
    'an empty name': { patchCalls: [' '] },
    'a name that is not a callee': { mockCalls: ['stub every endpoint'] },
    'a name that is not a string': { mockCalls: [7] },
    'a name in both lists': { mockCalls: ['stubEveryEndpoint'], patchCalls: [' stubEveryEndpoint'] },
  };
  for (const [label, backend] of Object.entries(malformed)) {
    writeBackendConfig(dir, 'malformed.config.json', backend);
    for (const args of [
      ['extract', '--config', 'malformed.config.json'],
      ['check', '--config', 'malformed.config.json', '--area', 'kettle.area.txt'],
    ]) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 2, `${label} (${args[0]}): ${result.stderr}`);
      const first = result.stderr.split('\n')[0];
      assert.ok(first.endsWith(`malformed.config.json: ${BACKEND_REFUSAL}`), `${label} (${args[0]}): ${first}`);
    }
  }
});

test('Backend class AC-10: an empty backend, one list and names with outer spaces load', (t) => {
  const dir = copyFixture(t, CORPUS);
  for (const backend of [{}, { mockCalls: ['stubEveryEndpoint'] }, { patchCalls: ['  seedBasket ', 'seedBasket'] }]) {
    writeBackendConfig(dir, 'loads.config.json', backend);
    const result = runCli(['extract', '--config', 'loads.config.json'], { cwd: dir });
    assert.equal(result.status, 0, `${JSON.stringify(backend)}: ${result.stderr}`);
  }
});

/** Extracts the corpus under `backend` (the corpus key when omitted, none for `null`). */
function extractSuite(t, backend) {
  const dir = copyFixture(t, CORPUS);
  if (backend !== undefined) writeBackendConfig(dir, 'kettle.config.json', backend === null ? undefined : backend);
  const result = runCli(['extract', '--config', 'kettle.config.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', 'suite.json'), 'utf8')).facts;
}

function backendOf(facts, spec, title) {
  const found = facts.filter((candidate) => candidate.type === 'pw_backend' && candidate.spec === spec && candidate.test === title);
  assert.equal(found.length, 1, `one pw_backend for ${spec} :: ${title}`);
  return found[0];
}

function kinds(fact) {
  return fact.sites.map((site) => site.kind);
}

test('Backend class AC-1: hooks reach the tests of their describe block and of its inner blocks', (t) => {
  const facts = extractSuite(t);
  const spec = 'tests/describe-hooks.spec.ts';
  for (const title of ['lists the kettles', 'filters the kettles', 'opens one kettle']) {
    const fact = backendOf(facts, spec, title);
    assert.equal(fact.backend, 'mocked', title);
    assert.deepEqual(fact.sites, [{ line: 8, where: 'hook', kind: 'mock', call: 'stubEveryEndpoint' }], title);
  }
  for (const title of ['lists the live kettles', 'opens the live basket']) {
    const fact = backendOf(facts, spec, title);
    assert.equal(fact.backend, 'real', title);
    assert.ok(!kinds(fact).includes('mock'), title);
  }
  const parked = backendOf(facts, spec, 'compares two kettles');
  assert.equal(parked.skipped, true);
  assert.equal(parked.backend, 'mocked');
  for (const title of ['shows the price list', 'shows one price']) {
    const fact = backendOf(facts, 'tests/file-hook.spec.ts', title);
    assert.equal(fact.backend, 'patched', title);
    assert.deepEqual(fact.sites, [{ line: 4, where: 'hook', kind: 'fulfill', call: 'page.route' }], title);
  }
});

test('Backend class AC-2: a patch inside a same-file helper names the helper', (t) => {
  const facts = extractSuite(t);
  const spec = 'e2e/basket.pw.ts';
  const discounted = backendOf(facts, spec, 'shows the discounted prices');
  assert.equal(discounted.backend, 'patched');
  assert.deepEqual(discounted.sites, [{ line: 4, where: 'helper', kind: 'fetch-fulfill', call: 'page.route', via: ['patchPrices'] }]);
  const stock = backendOf(facts, spec, 'shows the stock badge');
  assert.deepEqual(stock.sites, [{ line: 12, where: 'helper', kind: 'fulfill', call: 'page.route', via: ['fulfillStock'] }]);
  const drawer = backendOf(facts, spec, 'shows an empty drawer');
  assert.equal(drawer.backend, 'patched');
  assert.deepEqual(drawer.sites[0].via, ['emptyBasket']);
  const cache = backendOf(facts, spec, 'warms the cache first');
  assert.equal(cache.backend, 'real', 'the same-file function wins over the repo-wide stub helper');
  assert.deepEqual(cache.sites, []);
});

test('Backend class AC-3: spies and aborts are listed and leave the test real', (t) => {
  const facts = extractSuite(t);
  const spec = 'e2e/spies.pw.ts';
  for (const title of ['lets the prices through', 'falls back for the stock']) {
    const fact = backendOf(facts, spec, title);
    assert.equal(fact.backend, 'real', title);
    assert.deepEqual(kinds(fact), ['spy'], title);
  }
  const watched = backendOf(facts, spec, 'records the order requests');
  assert.equal(watched.backend, 'real');
  assert.deepEqual(watched.sites, [
    { line: 17, where: 'helper', kind: 'spy', call: 'page.route', via: ['watchOrders'], at: { file: 'helpers/watch.ts', line: 4 } },
  ]);
  const blocked = backendOf(facts, spec, 'blocks the images');
  assert.equal(blocked.backend, 'real');
  assert.deepEqual(kinds(blocked), ['abort']);
  const branch = backendOf(facts, spec, 'answers only the posts');
  assert.equal(branch.backend, 'patched');
  assert.deepEqual(kinds(branch), ['fulfill']);
});

test('Backend class AC-4: a stub in a comment or a string gives no site', (t) => {
  const facts = extractSuite(t);
  const spec = 'e2e/comments.pw.ts';
  for (const title of ['ignores a stub in a line comment', 'ignores a stub in a block comment', 'ignores a stub name in a string']) {
    const fact = backendOf(facts, spec, title);
    assert.equal(fact.backend, 'real', title);
    assert.deepEqual(fact.sites, [], title);
  }
  const interpolated = backendOf(facts, spec, 'reads a stub inside an interpolation');
  assert.equal(interpolated.backend, 'mocked');
  assert.deepEqual(interpolated.sites, [{ line: 22, where: 'test', kind: 'mock', call: 'stubEveryEndpoint' }]);
});

test('Backend class AC-5: the configuration supplies the full-mock and patch names', (t) => {
  const configured = extractSuite(t);
  const unconfigured = extractSuite(t, null);
  const spec = 'e2e/catalog.pw.ts';
  assert.equal(backendOf(configured, spec, 'browses a fully stubbed catalog').backend, 'mocked');
  const read = backendOf(unconfigured, spec, 'browses a fully stubbed catalog');
  assert.equal(read.backend, 'patched');
  assert.deepEqual(read.sites, [
    { line: 8, where: 'helper', kind: 'fulfill', call: 'page.route', via: ['stubEveryEndpoint'], at: { file: 'helpers/mocks.ts', line: 10 } },
  ]);
  assert.equal(backendOf(unconfigured, 'tests/describe-hooks.spec.ts', 'lists the kettles').backend, 'patched');

  const seeded = backendOf(configured, spec, 'starts from a seeded basket');
  assert.equal(seeded.backend, 'patched');
  assert.deepEqual(seeded.sites, [{ line: 13, where: 'test', kind: 'patch', call: 'seedBasket' }]);
  assert.equal(backendOf(unconfigured, spec, 'starts from a seeded basket').backend, 'real');
  assert.equal(backendOf(configured, spec, 'reads the fixture price list').backend, 'patched');
  assert.equal(backendOf(configured, spec, 'reads the catalog price list').backend, 'real', 'a dotted entry matches its own callee only');

  const { backend } = corpusConfig(join(REPO_ROOT, 'selftest', 'corpus', CORPUS));
  const names = [...backend.mockCalls, ...backend.patchCalls]
    .flatMap((name) => name.split('.'))
    .filter((segment) => segment !== 'fixtures');
  const libRoot = join(REPO_ROOT, 'lib');
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  for (const path of walk(libRoot)) {
    const text = readFileSync(path, 'utf8');
    for (const name of names) assert.ok(!text.includes(name), `${path} names the fixture call ${name}`);
  }
});

test('Backend class AC-6: helpers in other files are followed to a fixed point', (t) => {
  const facts = extractSuite(t);
  const spec = 'e2e/storefront.pw.ts';
  const banner = backendOf(facts, spec, 'opens the storefront with a banner');
  assert.equal(banner.backend, 'patched');
  assert.deepEqual(banner.sites, [
    {
      line: 7,
      where: 'helper',
      kind: 'fulfill',
      call: 'page.route',
      via: ['StorefrontPage.open', 'primeBanner'],
      at: { file: 'helpers/network.ts', line: 8 },
    },
  ]);
  const mocked = backendOf(facts, spec, 'opens a mocked storefront');
  assert.equal(mocked.backend, 'mocked');
  assert.deepEqual(mocked.sites[0].via, ['StorefrontPage.openMocked', 'mockShell']);
  assert.deepEqual(mocked.sites[0].at, { file: 'helpers/mocks.ts', line: 15 });
  const deep = backendOf(facts, spec, 'opens the storefront through two layers');
  assert.equal(deep.backend, 'patched');
  assert.deepEqual(deep.sites[0].via, ['StorefrontPage.openDeep', 'layerOne', 'layerTwo']);
  const cycle = backendOf(facts, spec, 'counts down without a stub');
  assert.equal(cycle.backend, 'real');
  assert.deepEqual(cycle.sites, []);
});

test('Backend class AC-7: a region the reader cannot read gives unknown, unless a mock or patch decides', (t) => {
  const facts = extractSuite(t);
  const spec = 'e2e/unreadable.pw.ts';
  const expected = {
    'runs a shared scenario': ['unknown', 'body-by-reference'],
    'answers through an imported handler': ['unknown', 'named-handler'],
    'prepares through an ambiguous helper': ['unknown', 'ambiguous-helper'],
    'shows the counter': ['unknown', 'body-by-reference'],
    'prepares a mocked counter': ['mocked', undefined],
    'prepares a seeded counter': ['patched', undefined],
    'runs a mocked shared scenario': ['mocked', undefined],
  };
  for (const [title, [backend, reason]] of Object.entries(expected)) {
    const fact = backendOf(facts, spec, title);
    assert.equal(fact.backend, backend, title);
    assert.equal(fact.reason, reason, title);
  }
  for (const fact of facts.filter((candidate) => candidate.type === 'pw_backend')) {
    if (kinds(fact).includes('unresolved')) assert.notEqual(fact.backend, 'real', `${fact.spec} :: ${fact.test}`);
    if (fact.backend !== 'unknown') assert.equal(fact.reason, undefined, `${fact.spec} :: ${fact.test}`);
  }
});

test('Backend class AC-8: one fact per test, a fixed precedence and sites in source order', (t) => {
  const facts = extractSuite(t);
  const tests = facts.filter((candidate) => candidate.type === 'pw_test');
  const backends = facts.filter((candidate) => candidate.type === 'pw_backend');
  assert.ok(tests.some((candidate) => candidate.spec.startsWith('tests/')));
  assert.ok(tests.some((candidate) => candidate.spec.endsWith('.pw.ts')));
  assert.equal(backends.length, tests.length);
  const key = (candidate) => JSON.stringify([candidate.file, candidate.spec, candidate.line, candidate.test, candidate.skipped]);
  assert.deepEqual(backends.map(key), tests.map(key));

  const spec = 'e2e/precedence.pw.ts';
  const classes = {
    'mocks and patches': 'mocked',
    'mocks and cannot read a handler': 'mocked',
    'patches and cannot read a handler': 'patched',
    'spies and cannot read a handler': 'unknown',
    'replays an archive': 'patched',
    'blocks then spies': 'real',
  };
  for (const [title, backend] of Object.entries(classes)) assert.equal(backendOf(facts, spec, title).backend, backend, title);
  assert.deepEqual(backendOf(facts, spec, 'replays an archive').sites, [{ line: 26, where: 'test', kind: 'har', call: 'page.routeFromHAR' }]);
  const parked = backendOf(facts, spec, 'waits for a parked feature');
  assert.equal(parked.skipped, true);
  assert.equal(parked.backend, 'patched');
  const late = backendOf(facts, spec, 'blocks then spies');
  assert.deepEqual(late.sites.map((site) => [site.line, site.where, site.kind]), [[36, 'test', 'abort'], [40, 'hook', 'spy']]);
  for (const fact of backends) {
    const lines = fact.sites.map((site) => site.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b), `${fact.spec} :: ${fact.test}`);
  }

  assert.deepEqual(extractSuite(t), facts, 'two extractions give the same facts');
});

test('Backend class AC-8: validateFacts refuses a pw_backend without backend or sites', (t) => {
  const dir = copyFixture(t, CORPUS);
  const complete = { type: 'pw_backend', file: 'e2e/x.pw.ts', line: 3, spec: 'e2e/x.pw.ts', test: 't', skipped: false, backend: 'real', sites: [] };
  for (const field of ['backend', 'sites']) {
    const { [field]: removed, ...partial } = complete;
    writeJsonFile(dir, 'provider.json', { producer: 'backend-lister', facts: [partial] });
    const config = corpusConfig(dir);
    config.repos[1].factsProvider = { file: 'provider.json', merge: 'prefer-external' };
    writeJsonFile(dir, 'provider.config.json', config);
    const result = runCli(['extract', '--config', 'provider.config.json'], { cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`Fact #0 \\(pw_backend\\): missing required field "${field}"`));
  }
});

/** Writes `out/facts/*.json` again without `pw_backend` facts and without `pw_stub.handler`. */
function stripBackendFacts(dir) {
  const factsDir = join(dir, 'out', 'facts');
  for (const name of readdirSync(factsDir)) {
    const path = join(factsDir, name);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.facts = document.facts
      .filter((candidate) => candidate.type !== 'pw_backend')
      .map((candidate) => {
        if (candidate.type !== 'pw_stub') return candidate;
        const { handler, ...rest } = candidate;
        return rest;
      });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  }
}

function joinAndCover(dir, config, area) {
  const run = (args) => {
    const result = runCli([...args, '--config', config], { cwd: dir });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  return {
    join: run(['join']),
    flow: readFileSync(join(dir, 'out', 'flow.json'), 'utf8'),
    cover: run(['cover', '--area', area]),
    coverJson: run(['cover', '--area', area, '--json']),
  };
}

test('Backend class AC-9: pw_stub keeps its base facts, and join and cover read the same input the same way', (t) => {
  const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'selftest', 'corpus', CORPUS, 'base-facts.json'), 'utf8'));
  assert.deepEqual(goldenFacts(CLI), golden);

  const example = mkdtempSync(join(tmpdir(), 'flowtrace-selftest-'));
  t.after(() => rmSync(example, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, 'examples', 'demo-shop'), example, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes('out') });
  const inputs = [
    { dir: copyFixture(t, CORPUS), config: 'kettle.config.json', area: 'kettle.area.txt', repo: 'suite' },
    { dir: example, config: 'flowtrace.config.json', area: join(REPO_ROOT, 'areas', 'checkout.txt'), repo: 'e2e' },
  ];
  const handlers = new Set(['fulfill', 'fetch-fulfill', 'abort', 'spy', 'unresolved']);
  for (const input of inputs) {
    const extracted = runCli(['extract', '--config', input.config], { cwd: input.dir });
    assert.equal(extracted.status, 0, extracted.stderr);
    const facts = JSON.parse(readFileSync(join(input.dir, 'out', 'facts', `${input.repo}.json`), 'utf8')).facts;
    const stubs = facts.filter((candidate) => candidate.type === 'pw_stub');
    assert.ok(stubs.length > 0, input.repo);
    for (const stub of stubs) assert.ok(handlers.has(stub.handler), `${stub.spec}:${stub.line} ${stub.handler}`);
    const withBackend = joinAndCover(input.dir, input.config, input.area);
    stripBackendFacts(input.dir);
    const without = joinAndCover(input.dir, input.config, input.area);
    assert.deepEqual(without, withBackend, input.repo);
  }
});
