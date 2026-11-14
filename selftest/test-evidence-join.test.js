/**
 * `join` reads the test evidence `cover` reads: one `tests` edge for each Cypress intercept,
 * Playwright API request and Playwright route stub that names a route, and one unjoined
 * entry, with its reason, for each that names none. The pinned worked-example export carries
 * the Playwright edges.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import test from 'node:test';
import { copyFixture, REPO_ROOT, runCli } from './helpers.js';

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
