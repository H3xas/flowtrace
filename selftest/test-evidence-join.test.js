/**
 * `join` reads the test evidence `cover` reads: one `tests` edge for each Cypress intercept,
 * Playwright API request and Playwright route stub that names a route, and one unjoined
 * entry, with its reason, for each that names none. The pinned worked-example export carries
 * the Playwright edges.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import test from 'node:test';
import { copyFixture, REPO_ROOT, runCli, writeRepo } from './helpers.js';

function extractAndJoin(t) {
  const dir = copyFixture(t, 'reef-ledger');
  const config = ['--config', 'reef.config.json'];
  const extracted = runCli(['extract', ...config], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = runCli(['join', ...config], { cwd: dir });
  assert.equal(joined.status, 0, joined.stderr);
  return { dir, config, flow: JSON.parse(readFileSync(joinPath(dir, 'out', 'flow.json'), 'utf8')) };
}

test('Test evidence AC-1: join gives a tests edge, with its source, for each kind of evidence that names a route', (t) => {
  const { flow } = extractAndJoin(t);
  const edges = flow.edges
    .filter((edge) => edge.kind === 'tests')
    .map((edge) => [edge.source, edge.key, `${edge.from.repo}:${edge.from.file}`, edge.from.ref, edge.match]);
  assert.deepEqual(edges, [
    ['cypress', 'GET reef/v1/sites', 'web:e2e/sites.cy.ts', 'lists the dive sites', 'exact'],
    ['playwright-api', 'GET reef/v1/sites', 'suite:tests/sites.spec.ts', 'lists the dive sites', 'exact'],
    ['playwright-stub', 'GET reef/v1/sites/closures', 'suite:ui/sites.pw.ts', 'shows the closures banner', 'exact'],
    ['playwright-api', 'POST reef/v1/sites/visits', 'suite:tests/sites.spec.ts', 'logs a visit', 'exact'],
  ]);
  for (const edge of flow.edges.filter((entry) => entry.kind === 'tests')) {
    assert.equal(edge.to.repo, 'backend');
  }
});

test('Test evidence AC-1: an opaque stub, a pattern with no path and an unmatched pattern each give one unjoined entry', (t) => {
  const { flow } = extractAndJoin(t);
  const entries = flow.unjoined.intercepts_without_route.map((entry) => ({
    key: entry.key,
    source: entry.source,
    reason: entry.reason ?? null,
    line: entry.fact.line,
  }));
  assert.deepEqual(entries, [
    { key: 'ANY ', source: 'playwright-stub', reason: 'opaque', line: 24 },
    { key: 'ANY *.png', source: 'playwright-stub', reason: 'no-path', line: 12 },
    { key: 'ANY reef/v1/forecast', source: 'playwright-stub', reason: null, line: 18 },
    { key: 'GET reef/v1/weather', source: 'playwright-api', reason: null, line: 15 },
  ]);
  assert.deepEqual(Object.keys(flow.unjoined).sort(), [
    'consume_without_publisher',
    'intercepts_without_route',
    'messages_without_contract',
    'mobile_calls_without_route',
    'publish_unresolved',
    'publish_without_consumer',
    'routes_without_caller',
  ]);
});

test('Test evidence AC-1: a request whose base the reader cannot read gives one unjoined entry with the unresolved-base reason', (t) => {
  const dir = copyFixture(t, 'reef-ledger');
  const config = ['--config', 'reef.config.json'];
  const spec = joinPath(dir, 'suite', 'tests', 'sites.spec.ts');
  const unknownBase = [
    "  test('lists the sites of a gateway', async ({ request }) => {",
    '    const response = await request.get(`${gateway()}/reef/v1/sites`);',
    '    expect(response.status()).toBe(200);',
    '  });',
    '});',
    '',
  ].join('\n');
  writeFileSync(spec, readFileSync(spec, 'utf8').replace(/\}\);\s*$/, unknownBase));
  assert.equal(runCli(['extract', ...config], { cwd: dir }).status, 0);
  assert.equal(runCli(['join', ...config], { cwd: dir }).status, 0);
  const flow = JSON.parse(readFileSync(joinPath(dir, 'out', 'flow.json'), 'utf8'));
  const entries = flow.unjoined.intercepts_without_route
    .filter((entry) => entry.reason === 'unresolved-base')
    .map((entry) => [entry.source, entry.fact.test, entry.fact.template]);
  assert.deepEqual(entries, [['playwright-api', 'lists the sites of a gateway', '${gateway()}/reef/v1/sites']]);
  assert.ok(!flow.edges.some((edge) => edge.kind === 'tests' && edge.from.ref === 'lists the sites of a gateway'));

  const covered = runCli(['cover', '--area', 'reef.area.txt', '--json', ...config], { cwd: dir });
  assert.equal(covered.status, 0, covered.stderr);
  assert.equal(JSON.parse(covered.stdout).notes.intercepts.unresolvedBase, 1);
});

test('Test evidence AC-1: the join change moves no cover route state, evidence count or parity', (t) => {
  const { dir, config } = extractAndJoin(t);
  const covered = runCli(['cover', '--area', 'reef.area.txt', '--json', ...config], { cwd: dir });
  assert.equal(covered.status, 0, covered.stderr);
  const report = JSON.parse(covered.stdout);
  assert.deepEqual(
    report.routes.map((route) => [route.key, route.state, route.evidence.intercepts, route.evidence.executing, route.parity]),
    [
      ['GET reef/v1/sites', 'route', 2, 2, { cypress: 'route', playwright: 'none' }],
      ['POST reef/v1/sites/visits', 'route', 1, 1, { cypress: 'none', playwright: 'none' }],
      ['GET reef/v1/sites/closures', 'route', 1, 1, { cypress: 'none', playwright: 'route' }],
      ['GET reef/v1/sites/*/tides', 'none', 0, 0, { cypress: 'none', playwright: 'none' }],
    ],
  );
  assert.equal(report.totals.parity.opaqueStubs, 1);
});

test('Test evidence AC-2: the pinned export carries the Playwright edges and keeps its format', () => {
  const pinned = JSON.parse(readFileSync(joinPath(REPO_ROOT, 'examples', 'demo-shop', 'exports', 'flowtrace-edges.json'), 'utf8'));
  assert.equal(pinned.format, 'flowtrace-edges');
  assert.equal(pinned.schemaVersion, 1);
  assert.deepEqual(pinned.provenance.factSetsWithoutEdges, []);
  for (const edge of pinned.edges) {
    assert.deepEqual(Object.keys(edge), ['kind', 'from', 'to', 'key', 'provenance']);
  }
  const e2e = pinned.edges.filter((edge) => edge.kind === 'tests' && edge.from.repo === 'e2e');
  assert.deepEqual([...new Set(e2e.map((edge) => edge.from.file))].sort(), [
    'tests/catalog.spec.ts',
    'tests/checkout.spec.ts',
    'ui/storefront.pw.ts',
  ]);

  const readme = readFileSync(joinPath(REPO_ROOT, 'examples', 'demo-shop', 'exports', 'README.md'), 'utf8');
  assert.match(readme, /Cypress intercept/);
  assert.match(readme, /Playwright API request/);
  assert.match(readme, /Playwright route stub/);
  assert.doesNotMatch(readme, /Here that is `e2e`/);
});

const TIDES_CONTROLLER = `using Microsoft.AspNetCore.Mvc;

namespace Harbour.Api.Controllers
{
    [ApiController]
    [Route("api/tides")]
    public class TideController : ControllerBase
    {
        [HttpGet]
        public IActionResult List() { return Ok(); }

        [HttpGet("{tideId}")]
        public IActionResult Get(string tideId) { return Ok(); }

        [HttpGet("{tideId}/readings")]
        public IActionResult Readings(string tideId) { return Ok(); }
    }
}
`;

const BUOYS_CONTROLLER = `using Microsoft.AspNetCore.Mvc;

namespace Harbour.Api.Controllers
{
    [ApiController]
    [Route("api/buoys")]
    public class BuoyController : ControllerBase
    {
        [HttpGet("north")]
        public IActionResult North() { return Ok(); }
    }
}
`;

function globCorpus(t) {
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/TideController.cs': TIDES_CONTROLLER,
      'backend/src/Controllers/BuoyController.cs': BUOYS_CONTROLLER,
      'web/cypress/e2e/tides.cy.ts': `describe('tides', () => {
  it('lists the tides', () => {
    cy.intercept('GET', '**/api/tides*').as('tides');
    cy.visit('/tides');
  });
  it('opens a buoy', () => {
    cy.intercept('GET', \`**/api/buoys/\${buoyId}\`).as('buoy');
    cy.visit('/buoys');
  });
});
`,
      'suite/ui/tides.pw.ts': `import { test } from '@playwright/test';

test('shows the tide detail', async ({ page }) => {
  await page.route('**/api/tides/**', (route) => route.fulfill({ json: {} }));
  await page.route(\`**/api/tides\${query()}\`, (route) => route.fulfill({ json: [] }));
  await page.route('**/api/tides/42/readings', (route) => route.fulfill({ json: [] }));
  await page.goto('/tides');
});
`,
      'harbour.area.txt': 'GET api/tides\nGET api/tides/*\nGET api/tides/*/readings\nGET api/buoys/north\n',
    },
    {
      repos: [
        { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
        { id: 'suite', kind: 'playwright', root: 'suite' },
        { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
      ],
    },
  );
  const config = ['--config', 'evidence.config.json'];
  assert.equal(runCli(['extract', ...config], { cwd: dir }).status, 0);
  return { dir, config };
}

test('Test evidence AC-5: join reads an intercept or stub glob by path segment, and a request template as before', (t) => {
  const { dir, config } = globCorpus(t);
  const joined = runCli(['join', ...config], { cwd: dir });
  assert.equal(joined.status, 0, joined.stderr);
  const flow = JSON.parse(readFileSync(joinPath(dir, 'out', 'flow.json'), 'utf8'));
  const edges = flow.edges
    .filter((edge) => edge.kind === 'tests')
    .map((edge) => [edge.source, edge.callerKey, edge.key, edge.match]);
  assert.deepEqual(edges, [
    ['cypress', 'GET api/tides*', 'GET api/tides', 'prefix'],
    ['playwright-stub', 'ANY api/tides/42/readings', 'GET api/tides/*/readings', 'parameter'],
  ]);
});

test('Test evidence AC-6: join names the candidates of a glob or value pattern that two routes fit equally', (t) => {
  const { dir, config } = globCorpus(t);
  assert.equal(runCli(['join', ...config], { cwd: dir }).status, 0);
  const flow = JSON.parse(readFileSync(joinPath(dir, 'out', 'flow.json'), 'utf8'));
  const entries = flow.unjoined.intercepts_without_route.map((entry) => ({
    key: entry.key,
    pattern: entry.fact.pattern,
    source: entry.source,
    reason: entry.reason ?? null,
    candidates: entry.candidates ?? null,
  }));
  assert.deepEqual(entries, [
    { key: 'ANY api/tides*', pattern: '**/api/tides${query()}', source: 'playwright-stub', reason: 'ambiguous', candidates: ['GET api/tides', 'GET api/tides/*', 'GET api/tides/*/readings'] },
    { key: 'ANY api/tides/*', pattern: '**/api/tides/**', source: 'playwright-stub', reason: 'ambiguous', candidates: ['GET api/tides/*', 'GET api/tides/*/readings'] },
    { key: 'GET api/buoys/*', pattern: '**/api/buoys/${buoyId}', source: 'cypress', reason: null, candidates: null },
  ]);
});

test('Test evidence AC-29: cover counts a value pattern that fits no route parameter as unmatched and a tail value as ambiguous', (t) => {
  const { dir, config } = globCorpus(t);
  const covered = runCli(['cover', '--area', 'harbour.area.txt', '--json', ...config], { cwd: dir });
  assert.equal(covered.status, 0, covered.stderr);
  const report = JSON.parse(covered.stdout);
  assert.deepEqual(report.notes.intercepts, { noPath: 0, unmatched: 1, unresolvedBase: 0, ambiguous: 2 });
  assert.deepEqual(
    report.routes.map((route) => [route.key, route.evidence.intercepts, route.evidence.match]),
    [
      ['GET api/tides', 1, ['prefix']],
      ['GET api/tides/*', 0, []],
      ['GET api/tides/*/readings', 1, ['parameter']],
      ['GET api/buoys/north', 0, []],
    ],
  );
  const text = runCli(['cover', '--area', 'harbour.area.txt', '--md', 'cover.md', ...config], { cwd: dir });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /intercepts skipped as evidence: 0 with no path · 1 matching no route · 0 with an unknown base · 2 ambiguous/);
  const markdown = readFileSync(joinPath(dir, 'cover.md'), 'utf8');
  assert.match(markdown, /Intercepts skipped as evidence: 0 with no path, 1 matching no route, 0 with an unknown base, 2 ambiguous\./);
});

test('Test evidence AC-7: cover places a route stub with a literal segment on its parameter route', (t) => {
  const { dir, config } = globCorpus(t);
  const covered = runCli(['cover', '--area', 'harbour.area.txt', '--json', ...config], { cwd: dir });
  assert.equal(covered.status, 0, covered.stderr);
  const route = JSON.parse(covered.stdout).routes.find((entry) => entry.key === 'GET api/tides/*/readings');
  assert.equal(route.state, 'route');
  assert.deepEqual(route.evidence.playwrightSpecs, ['ui/tides.pw.ts']);
  assert.deepEqual(route.evidence.match, ['parameter']);
  assert.deepEqual(route.parity, { cypress: 'none', playwright: 'route' });
});
