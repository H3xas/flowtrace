/**
 * What the Playwright and Cypress readers record as test evidence. Each test writes a small
 * invented repository into a temporary directory, runs `extract` over it and reads the facts.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCli } from './helpers.js';

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

/** Writes `files` (path to text) and a configuration with `repos` into a new directory. */
export function writeRepo(t, files, config) {
  const dir = mkdtempSync(join(tmpdir(), 'flowtrace-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, 'evidence.config.json'), JSON.stringify({ out: 'out', ...config }, null, 2));
  return dir;
}

export function extractFacts(dir, repo) {
  const result = runCli(['extract', '--config', 'evidence.config.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
}

const PLAYWRIGHT_REPOS = {
  repos: [
    { id: 'api', kind: 'backend', root: 'backend', role: ['api'] },
    { id: 'suite', kind: 'playwright', root: 'suite' },
  ],
};

test('Test evidence AC-29: a stub pattern keeps a part the reader cannot read as one value span', (t) => {
  const long = 'catalogue.filters.map((filter) => encodeURIComponent(filter.name)).join(",")';
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'suite/e2e/items.pw.ts': `import { test } from '@playwright/test';

test('lists the items', async ({ page }) => {
  await page.route(\`**/api/items\${query()}\`, (route) => route.fulfill({ json: [] }));
  await page.route('**/api/items/' + pickId(), (route) => route.fulfill({ json: {} }));
  await page.route(\`**/api/items/\${${long}}\`, (route) => route.fulfill({ json: [] }));
  await page.route(\`**/api/items/\${itemId}\`, (route) => route.fulfill({ json: {} }));
  await page.route(\`**/api/items/\${featured ? 'featured' : itemId}\`, (route) => route.fulfill({ json: {} }));
  await page.route('**/api/items/' + ${long}, (route) => route.fulfill({ json: [] }));
  await page.goto('/items');
});
`,
      'suite/tests/items.spec.ts': `import { test } from '@playwright/test';

test('reads an item', async ({ request }) => {
  await request.get(\`api/items/\${featured ? 'featured' : itemId}\`);
});
`,
    },
    PLAYWRIGHT_REPOS,
  );
  const facts = extractFacts(dir, 'suite');
  const stubs = facts.filter((fact) => fact.type === 'pw_stub');
  assert.deepEqual(
    stubs.map((fact) => fact.pattern),
    [
      '**/api/items${query()}',
      '**/api/items/${pickId()}',
      `**/api/items/\${${long}}`,
      '**/api/items/${itemId}',
      "**/api/items/${featured ? 'featured' : itemId}",
      `**/api/items/\${${long}}`,
    ],
  );
  assert.deepEqual(
    [stubs[1], stubs[3], stubs[4], stubs[5]].map((fact) => fact.resolved),
    [false, true, false, false],
  );
  const requests = facts.filter((fact) => fact.type === 'pw_request').map((fact) => fact.template);
  assert.deepEqual(requests, ['api/items/*']);
});
