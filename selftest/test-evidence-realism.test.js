import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { extractRepoFacts, runCli, writeRepo } from './helpers.js';

const ITEMS_CONTROLLER = `using Microsoft.AspNetCore.Mvc;

namespace Tidepool.Api.Controllers
{
    [ApiController]
    [Route("api/items")]
    public class ItemController : ControllerBase
    {
        [HttpGet]
        public IActionResult List() { return Ok(); }

        [HttpGet("{id}")]
        public IActionResult Get(string id) { return Ok(); }

        [HttpGet("featured")]
        public IActionResult Featured() { return Ok(); }
    }
}
`;

const REACH_SPEC = `import { test } from '@playwright/test';

page.route('**/api/items/featured', (route) => route.continue());

test('a fulfilled stub', async ({ page }) => {
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
});

test('a fetched and fulfilled stub', async ({ page }) => {
  await page.route('**/api/items', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
  });
});

test('an aborted request', async ({ page }) => {
  await page.route('**/api/items', (route) => route.abort());
});

test('a handler the reader cannot read', async ({ page }) => {
  await page.route('**/api/items', importedHandler);
});

test('a spy beside a fulfilled stub of the same route', async ({ page }) => {
  await page.route('**/api/items', (route) => route.continue());
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
});

test('a spy in a real test', async ({ page, request }) => {
  await page.route('**/api/items', (route) => route.continue());
  await request.get('api/items');
});

test('a spy in a patched test', async ({ page, request }) => {
  await page.route('**/api/items', (route) => route.continue());
  await page.route('**/api/items/featured', (route) => route.fulfill({ json: {} }));
  await request.get('api/items');
});

test('a spy in a mocked test', async ({ page, request }) => {
  await mockEverything(page);
  await page.route('**/api/items', (route) => route.continue());
  await request.get('api/items');
});

test('a spy in an unknown test', async ({ page, request }) => {
  await page.route('**/api/items/42', importedHandler);
  await page.route('**/api/items', (route) => route.continue());
  await request.get('api/items');
});

test('a twin title', async ({ page }) => {
  await mockEverything(page);
  await page.route('**/api/items', (route) => route.continue());
});

test('a twin title', async ({ page }) => {
  await page.route('**/api/items', (route) => route.continue());
});

test.skip('a skipped spy', async ({ page }) => {
  await page.route('**/api/items', (route) => route.continue());
});
`;

const REACH_CY_SPEC = `describe('cypress', () => {
  it('a fixture stub', () => {
    cy.intercept('GET', '**/api/items', { fixture: 'items.json' });
  });
  it('a cypress spy', () => {
    cy.intercept('GET', '**/api/items');
  });
});
`;

const AREA = 'GET api/items\nGET api/items/featured\nGET api/items/*\n';

function reachCorpus(t) {
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'suite/e2e/reach.pw.ts': REACH_SPEC,
      'web/cypress/e2e/reach.cy.ts': REACH_CY_SPEC,
      'items.area.txt': AREA,
    },
    {
      backend: { mockCalls: ['mockEverything'] },
      repos: [
        { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
        { id: 'suite', kind: 'playwright', root: 'suite' },
        { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
      ],
    },
  );
  extractRepoFacts(dir, 'suite');
  return dir;
}

function cover(dir, json = true) {
  const result = runCli(['cover', '--area', 'items.area.txt', ...(json ? ['--json'] : []), '--config', 'evidence.config.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

/** Writes every fact set again through `change`, which maps one fact to a fact or null. */
function rewriteFacts(dir, change) {
  const factsDir = join(dir, 'out', 'facts');
  for (const name of readdirSync(factsDir)) {
    const path = join(factsDir, name);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.facts = document.facts.map(change).filter(Boolean);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  }
}

const row = (entry) => [entry.test, entry.source, entry.handler ?? '-', entry.backend, entry.reach, entry.skipped];
const sorted = (rows) => [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

test('Test evidence AC-14: each evidence entry carries the class of its test, its handler and its reach', (t) => {
  const dir = reachCorpus(t);
  const report = cover(dir);
  const route = (key) => report.routes.find((candidate) => candidate.key === key);

  assert.deepEqual(
    sorted(route('GET api/items').realism.entries.map(row)),
    sorted([
      ['a fulfilled stub', 'playwright-stub', 'fulfill', 'patched', 'stubbed', false],
      ['a fetched and fulfilled stub', 'playwright-stub', 'fetch-fulfill', 'patched', 'backend', false],
      ['an aborted request', 'playwright-stub', 'abort', 'real', 'blocked', false],
      ['a handler the reader cannot read', 'playwright-stub', 'unresolved', 'unknown', 'unknown', false],
      ['a spy beside a fulfilled stub of the same route', 'playwright-stub', 'spy', 'patched', 'stubbed', false],
      ['a spy beside a fulfilled stub of the same route', 'playwright-stub', 'fulfill', 'patched', 'stubbed', false],
      ['a spy in a real test', 'playwright-stub', 'spy', 'real', 'backend', false],
      ['a spy in a real test', 'playwright-api', '-', 'real', 'backend', false],
      ['a spy in a patched test', 'playwright-stub', 'spy', 'patched', 'backend', false],
      ['a spy in a patched test', 'playwright-api', '-', 'patched', 'backend', false],
      ['a spy in a mocked test', 'playwright-stub', 'spy', 'mocked', 'stubbed', false],
      ['a spy in a mocked test', 'playwright-api', '-', 'mocked', 'stubbed', false],
      ['a spy in an unknown test', 'playwright-stub', 'spy', 'unknown', 'unknown', false],
      ['a spy in an unknown test', 'playwright-api', '-', 'unknown', 'unknown', false],
      ['a twin title', 'playwright-stub', 'spy', 'mocked', 'stubbed', false],
      ['a twin title', 'playwright-stub', 'spy', 'real', 'backend', false],
      ['a skipped spy', 'playwright-stub', 'spy', 'real', 'backend', true],
      ['a fixture stub', 'cypress', 'fulfill', 'patched', 'stubbed', false],
      ['a cypress spy', 'cypress', 'spy', 'real', 'backend', false],
    ]),
  );
  assert.deepEqual(route('GET api/items').realism.executing, { stubbed: 7, backend: 7, blocked: 1, unknown: 3 });
  assert.deepEqual(route('GET api/items').realism.skipped, { stubbed: 0, backend: 1, blocked: 0, unknown: 0 });
  assert.deepEqual(
    sorted(route('GET api/items/featured').realism.entries.map(row)),
    sorted([
      ['', 'playwright-stub', 'spy', 'none', 'unknown', false],
      ['a spy in a patched test', 'playwright-stub', 'fulfill', 'patched', 'stubbed', false],
    ]),
  );
  assert.deepEqual(route('GET api/items/*').realism.entries.map(row), [
    ['a spy in an unknown test', 'playwright-stub', 'unresolved', 'unknown', 'unknown', false],
  ]);
  const twins = route('GET api/items').realism.entries.filter((entry) => entry.test === 'a twin title');
  assert.equal(new Set(twins.map((entry) => entry.testLine)).size, 2, 'two tests with one title keep their own lines');

  const before = (candidate) => ({
    key: candidate.key,
    state: candidate.state,
    levels: candidate.levels,
    evidence: candidate.evidence,
    parity: candidate.parity,
    seeds: candidate.seeds,
  });
  rewriteFacts(dir, (fact) => {
    if (fact.type === 'pw_backend' || fact.type === 'cypress_backend') return null;
    const { testLine, handler, ...rest } = fact;
    return rest;
  });
  const without = cover(dir);
  assert.deepEqual(without.routes.map(before), report.routes.map(before));
  assert.deepEqual(without.totals, report.totals);
  assert.deepEqual(without.notes.intercepts, report.notes.intercepts);
});

test('Test evidence AC-14: a fact set without the test line gives every entry the class none', (t) => {
  const dir = reachCorpus(t);
  rewriteFacts(dir, (fact) => {
    const { testLine, ...rest } = fact;
    return rest;
  });
  const items = cover(dir).routes.find((route) => route.key === 'GET api/items');
  assert.deepEqual([...new Set(items.realism.entries.map((entry) => entry.backend))], ['none']);
  for (const entry of items.realism.entries) {
    assert.equal(entry.testLine, null);
    if (entry.handler === 'spy' || entry.source === 'playwright-api') assert.equal(entry.reach, 'unknown', entry.test);
  }
  assert.deepEqual(items.realism.executing, { stubbed: 3, backend: 1, blocked: 1, unknown: 13 });
});

test('Test evidence AC-17: cover shows a realism line for each route with named evidence and a realism total', (t) => {
  const dir = reachCorpus(t);
  const report = cover(dir);
  const sum = { executing: { stubbed: 0, backend: 0, blocked: 0, unknown: 0 }, skipped: { stubbed: 0, backend: 0, blocked: 0, unknown: 0 } };
  for (const route of report.routes) {
    for (const part of ['executing', 'skipped']) for (const reach of Object.keys(sum[part])) sum[part][reach] += route.realism[part][reach];
  }
  assert.deepEqual(report.realism, sum);
  assert.deepEqual(report.realism.executing, { stubbed: 8, backend: 7, blocked: 1, unknown: 5 });

  const text = cover(dir, false);
  assert.match(text, /\n {2}realism {2}executing 7 stubbed, 7 backend, 1 blocked, 3 unknown; skipped 0 stubbed, 1 backend, 0 blocked, 0 unknown\n/);
  assert.match(text, /\n {2}realism {2}executing 0 stubbed, 0 backend, 0 blocked, 1 unknown; skipped 0 stubbed, 0 backend, 0 blocked, 0 unknown\n/);

  const md = join(dir, 'cover.md');
  const written = runCli(['cover', '--area', 'items.area.txt', '--md', md, '--config', 'evidence.config.json'], { cwd: dir });
  assert.equal(written.status, 0, written.stderr);
  const markdown = readFileSync(md, 'utf8');
  assert.match(
    markdown,
    /\nRealism of the named evidence: executing 1 stubbed, 0 backend, 0 blocked, 1 unknown; skipped 0 stubbed, 0 backend, 0 blocked, 0 unknown\.\n/,
  );
  assert.equal(markdown.match(/^Realism of the named evidence:/gm).length, 3);
});

test('Test evidence AC-13: cover joins an entry to the class of its own test when two tests share a title', (t) => {
  const dir = reachCorpus(t);
  const items = cover(dir).routes.find((route) => route.key === 'GET api/items');
  const classes = JSON.parse(readFileSync(join(dir, 'out', 'facts', 'suite.json'), 'utf8'))
    .facts.filter((fact) => fact.type === 'pw_backend' && fact.test === 'a twin title')
    .map((fact) => [fact.line, fact.backend]);
  assert.equal(classes.length, 2);
  assert.deepEqual(
    items.realism.entries.filter((entry) => entry.test === 'a twin title').map((entry) => [entry.testLine, entry.backend, entry.reach]),
    classes.map(([line, backend]) => [line, backend, backend === 'mocked' ? 'stubbed' : 'backend']),
  );
  assert.deepEqual(
    classes.map(([, backend]) => backend),
    ['mocked', 'real'],
  );
});

test('Test evidence AC-13: a skipped test and an executing namesake keep their own skip, in one spec and across repositories', (t) => {
  const spec = `import { test } from '@playwright/test';

test.skip('a namesake', async ({ page }) => {
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
});

test('a namesake', async ({ page }) => {
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
});
`;
  const other = `import { test } from '@playwright/test';

test('a namesake', async ({ page }) => {
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
});
`;
  const skippedOther = other.replace("test('a namesake'", "test.skip('a namesake'");
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'suite/e2e/twins.pw.ts': spec,
      'second/e2e/twins.pw.ts': skippedOther,
      'third/e2e/twins.pw.ts': other,
      'items.area.txt': AREA,
    },
    {
      repos: [
        { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
        { id: 'suite', kind: 'playwright', root: 'suite' },
        { id: 'second', kind: 'playwright', root: 'second' },
        { id: 'third', kind: 'playwright', root: 'third' },
      ],
    },
  );
  extractRepoFacts(dir, 'suite');
  const items = cover(dir).routes.find((route) => route.key === 'GET api/items');
  assert.deepEqual(
    items.realism.entries.map((entry) => [entry.spec, entry.testLine, entry.skipped]).sort((a, b) => a[1] - b[1] || (a[2] ? 1 : -1)),
    [
      ['e2e/twins.pw.ts', 3, false],
      ['e2e/twins.pw.ts', 3, true],
      ['e2e/twins.pw.ts', 3, true],
      ['e2e/twins.pw.ts', 7, false],
    ],
  );
  assert.deepEqual(items.realism.executing.stubbed, 2);
  assert.deepEqual(items.realism.skipped.stubbed, 2);
});
