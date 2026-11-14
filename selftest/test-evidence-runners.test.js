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
    stubs.map((fact) => fact.resolved),
    [false, false, false, true, false, false],
  );
  const requests = facts.filter((fact) => fact.type === 'pw_request').map((fact) => fact.template);
  assert.deepEqual(requests, ['api/items/*']);
});

test('Test evidence AC-29: a stub keeps its resolved value only for a bare name or a name.prop span', (t) => {
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'suite/support/paths.ts': `export const ITEMS = '**/api/items';
export const TWICE = '**/api/items';
export default {
  catalogue: {
    listItems: { route: '**/api/items\${query()}', method: 'GET' },
  },
};
`,
      'suite/support/other-paths.ts': `export const TWICE = '**/api/other';
`,
      'suite/support/stubs.ts': `export async function stubItems(url) {
  await page.route(url, (route) => route.fulfill({ json: [] }));
}
export async function stubEndpoint(endpoint) {
  await page.route(endpoint.route, (route) => route.fulfill({ json: [] }));
}
`,
      'suite/e2e/items.pw.ts': `import { test } from '@playwright/test';

test('stubs the items', async ({ page }) => {
  await page.route(\`**/api/items\${query()}\`, (route) => route.fulfill({ json: [] }));
  await page.route(\`**/api/items/\${itemId}\`, (route) => route.fulfill({ json: {} }));
  await page.route(\`**/api/items/\${ itemId }\`, (route) => route.fulfill({ json: {} }));
  await page.route(\`**/api/items/\${cfg.id}\`, (route) => route.fulfill({ json: {} }));
  await page.route(\`**/api/items/\${cfg.ids[0]}\`, (route) => route.fulfill({ json: {} }));
  await page.route(\`\${ITEMS}/\${a + b}\`, (route) => route.fulfill({ json: {} }));
  await page.route(\`\${ITEMS}\`, (route) => route.fulfill({ json: [] }));
  await page.route(\`\${TWICE}/\${itemId}\`, (route) => route.fulfill({ json: {} }));
  await stubItems(\`**/api/items\${query()}\`);
  await stubItems(\`**/api/items/\${itemId}\`);
  await stubEndpoint(endpoints.catalogue.listItems);
});
`,
      'suite/tests/items.spec.ts': `import { test } from '@playwright/test';

test('reads the items', async ({ request }) => {
  await request.get(\`api/items\${query()}\`);
  await request.get(\`api/items/\${itemId}\`);
  await request.get(\`api/items/\${cfg.ids[0]}\`);
  await request.get(\`api/items/\${a + b}\`);
});
`,
    },
    PLAYWRIGHT_REPOS,
  );
  const facts = extractFacts(dir, 'suite');
  const stubs = facts.filter((fact) => fact.type === 'pw_stub').map((fact) => [fact.pattern, fact.resolved]);
  assert.deepEqual(stubs, [
    ['**/api/items${query()}', false],
    ['**/api/items/${itemId}', true],
    ['**/api/items/${ itemId }', true],
    ['**/api/items/${cfg.id}', true],
    ['**/api/items/${cfg.ids[0]}', false],
    ['**/api/items/${a + b}', false],
    ['**/api/items', true],
    ['**/api/other/${itemId}', true],
    ['**/api/items${query()}', false],
    ['**/api/items/${itemId}', true],
    ['**/api/items${query()}', true],
  ]);
  const requests = facts.filter((fact) => fact.type === 'pw_request').map((fact) => [fact.template, fact.resolved]);
  assert.deepEqual(requests, [
    ['api/items${query()}', true],
    ['api/items/${itemId}', true],
    ['api/items/${cfg.ids[0]}', true],
    ['api/items/${a + b}', true],
  ]);
});
