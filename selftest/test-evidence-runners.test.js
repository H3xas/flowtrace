/**
 * What the Playwright and Cypress readers record as test evidence. Each test writes a small
 * invented repository into a temporary directory, runs `extract` over it and reads the facts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRepoFacts as extractFacts, runCli, writeRepo } from './helpers.js';
import { validateFacts } from '../lib/facts.js';

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

const STUB_SUPPORT = {
  'suite/support/endpoints.ts': `export default {
  catalogue: {
    listItems: { route: '**/api/items', method: 'GET' },
  },
};
`,
  'suite/support/stubs.ts': `export async function stubEndpoint(endpoint) {
  await page.route(endpoint.route, (route) => route.fulfill({ json: [] }));
}
export async function stubUrl(url) {
  await page.route(url, (route) => route.abort());
}
`,
};

const TESTS_SPEC = `import { test } from '@playwright/test';

test('shows the featured item', async ({ page }) => {
  await page.route('**/api/items/featured', (route) => route.fulfill({ json: {} }));
  await stubEndpoint(endpoints.catalogue.listItems);
  await stubUrl('**/api/items/42');
  await page.goto('/items');
});
`;

const PW_SPEC = `import { test } from '@playwright/test';

test('lists the items', async ({ page }) => {
  await page.route('**/api/items/featured', (route) => route.continue());
  await stubEndpoint(endpoints.catalogue.listItems);
  await page.goto('/items');
});
`;

test('Test evidence AC-9: a tests/ spec gives route stubs, with the registry and the helper index, when it is the only spec', (t) => {
  const dir = writeRepo(
    t,
    { 'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER, ...STUB_SUPPORT, 'suite/tests/items.spec.ts': TESTS_SPEC },
    PLAYWRIGHT_REPOS,
  );
  const stubs = extractFacts(dir, 'suite')
    .filter((fact) => fact.type === 'pw_stub')
    .map((fact) => [fact.spec, fact.test, fact.kind, fact.verb, fact.pattern, fact.resolved, fact.handler]);
  assert.deepEqual(stubs, [
    ['tests/items.spec.ts', 'shows the featured item', 'route', 'ANY', '**/api/items/featured', true, 'fulfill'],
    ['tests/items.spec.ts', 'shows the featured item', 'route', 'GET', '**/api/items', true, 'fulfill'],
    ['tests/items.spec.ts', 'shows the featured item', 'route', 'ANY', '**/api/items/42', true, 'abort'],
  ]);
});

test('Test evidence AC-9: a tests/ spec leaves the stubs of a .pw.ts spec as they are, and cover counts its own stubs', (t) => {
  const withTests = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      ...STUB_SUPPORT,
      'suite/e2e/items.pw.ts': PW_SPEC,
      'suite/tests/items.spec.ts': TESTS_SPEC,
      'items.area.txt': 'GET api/items\nGET api/items/featured\nGET api/items/*\n',
    },
    PLAYWRIGHT_REPOS,
  );
  const alone = writeRepo(
    t,
    { 'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER, ...STUB_SUPPORT, 'suite/e2e/items.pw.ts': PW_SPEC },
    PLAYWRIGHT_REPOS,
  );
  const pwStubs = (facts) => facts.filter((fact) => fact.type === 'pw_stub' && fact.spec === 'e2e/items.pw.ts');
  const both = extractFacts(withTests, 'suite');
  assert.deepEqual(pwStubs(both), pwStubs(extractFacts(alone, 'suite')));
  assert.equal(pwStubs(both).length, 2);

  const covered = runCli(['cover', '--area', 'items.area.txt', '--json', '--config', 'evidence.config.json'], { cwd: withTests });
  assert.equal(covered.status, 0, covered.stderr);
  assert.deepEqual(
    JSON.parse(covered.stdout).routes.map((route) => [route.key, route.evidence.playwrightSpecs, route.evidence.match]),
    [
      ['GET api/items', ['e2e/items.pw.ts', 'tests/items.spec.ts'], ['exact']],
      ['GET api/items/featured', ['e2e/items.pw.ts', 'tests/items.spec.ts'], ['exact']],
      ['GET api/items/*', ['tests/items.spec.ts'], ['parameter']],
    ],
  );
});

const TWIN_PW_SPEC = `import { test } from '@playwright/test';

page.route('**/api/items/featured', (route) => route.continue());

test('lists the items', async ({ page, request }) => {
  await page.route('**/api/items', (route) => route.fulfill({ json: [] }));
  await request.get('api/items');
});

test('lists the items', async ({ page, request }) => {
  await page.route('**/api/items/42', (route) => route.abort());
  await request.get('api/items/42');
});
`;

const TWIN_CY_SPEC = `cy.intercept('GET', '**/api/items/featured');

describe('items', () => {
  it('lists the items', () => {
    cy.intercept('GET', '**/api/items');
  });

  it('lists the items', () => {
    cy.intercept('GET', '**/api/items/42');
  });
});
`;

test('Test evidence AC-13: a request, a stub and an intercept carry the line of their own test, or null outside a test', (t) => {
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'suite/e2e/items.pw.ts': TWIN_PW_SPEC,
      'web/cypress/e2e/items.cy.ts': TWIN_CY_SPEC,
      'mobile/cypress/e2e/items.cy.ts': TWIN_CY_SPEC,
    },
    {
      repos: [
        ...PLAYWRIGHT_REPOS.repos,
        { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
        { id: 'mobile', kind: 'mobile', root: 'mobile' },
      ],
    },
  );
  const owned = (repo, type, key) =>
    extractFacts(dir, repo)
      .filter((fact) => fact.type === type)
      .map((fact) => [fact[key], fact.test, fact.testLine]);

  assert.deepEqual(owned('suite', 'pw_stub', 'pattern'), [
    ['**/api/items/featured', '', null],
    ['**/api/items', 'lists the items', 5],
    ['**/api/items/42', 'lists the items', 10],
  ]);
  assert.deepEqual(owned('suite', 'pw_request', 'template'), [
    ['api/items', 'lists the items', 5],
    ['api/items/42', 'lists the items', 10],
  ]);
  const intercepts = [
    ['**/api/items/featured', '', null],
    ['**/api/items', 'lists the items', 4],
    ['**/api/items/42', 'lists the items', 8],
  ];
  assert.deepEqual(owned('web', 'cypress_intercept', 'pattern'), intercepts);
  assert.deepEqual(owned('mobile', 'cypress_intercept', 'pattern'), intercepts);
  for (const repo of ['web', 'mobile']) {
    const tests = extractFacts(dir, repo).filter((fact) => fact.type === 'cypress_test').map((fact) => fact.line);
    assert.deepEqual(tests, [4, 8], repo);
  }
});

const HANDLER_SPEC = `function replyWithItems(req) {
  req.reply({ body: [] });
}
const dropRequest = (req) => req.destroy();

describe('handlers', () => {
  it('reads each handler form', () => {
    cy.intercept('GET', '**/api/spy');
    cy.intercept('GET', '**/api/fixture', { fixture: 'items.json' });
    cy.intercept('**/api/text', 'plain text');
    cy.intercept('GET', '**/api/reply', (req) => {
      req.reply({ body: [] });
    });
    cy.intercept('GET', '**/api/continue-send', (req) => {
      req.continue((res) => {
        res.send({ body: [] });
      });
    });
    cy.intercept('GET', '**/api/before-response', (req) => {
      req.on('before:response', (res) => res.send(200));
    });
    cy.intercept('GET', '**/api/response', (req) => req.on('response', (res) => res.send(200)));
    cy.intercept('GET', '**/api/continue', (req) => {
      req.continue();
    });
    cy.intercept('GET', '**/api/continue-look', (req) => {
      req.continue((res) => {
        expect(res.statusCode).to.eq(200);
      });
    });
    cy.intercept('GET', '**/api/destroy', (req) => {
      req.destroy();
    });
    cy.intercept('GET', '**/api/network-error', { forceNetworkError: true });
    cy.intercept('GET', '**/api/reply-network-error', (req) => req.reply({ forceNetworkError: true }));
    cy.intercept('GET', '**/api/named', replyWithItems);
    cy.intercept('GET', '**/api/named-arrow', dropRequest);
    cy.intercept('GET', '**/api/imported', importedHandler);
    cy.intercept('GET', '**/api/look', (req) => {
      cy.log('forceNetworkError');
      expect(req.body).to.exist;
    });
    cy.intercept('GET', '**/api/handed-on', (req) => {
      handOff(req);
    });
    cy.intercept({ method: 'GET', url: '**/api/matcher' }, function (req) {
      req.reply('ok');
    });
  });
});
`;

test('Test evidence AC-10: both Cypress readers give each intercept handler form the same pw_stub handler word', (t) => {
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'web/cypress/e2e/handlers.cy.ts': HANDLER_SPEC,
      'mobile/cypress/e2e/handlers.cy.ts': HANDLER_SPEC,
    },
    {
      repos: [
        PLAYWRIGHT_REPOS.repos[0],
        { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
        { id: 'mobile', kind: 'mobile', root: 'mobile' },
      ],
    },
  );
  const handlers = (repo) =>
    extractFacts(dir, repo)
      .filter((fact) => fact.type === 'cypress_intercept')
      .map((fact) => [fact.pattern.replace('**/api/', ''), fact.handler]);
  const expected = [
    ['spy', 'spy'],
    ['fixture', 'fulfill'],
    ['text', 'fulfill'],
    ['reply', 'fulfill'],
    ['continue-send', 'fetch-fulfill'],
    ['before-response', 'fetch-fulfill'],
    ['response', 'fetch-fulfill'],
    ['continue', 'spy'],
    ['continue-look', 'spy'],
    ['destroy', 'abort'],
    ['network-error', 'abort'],
    ['reply-network-error', 'abort'],
    ['named', 'fulfill'],
    ['named-arrow', 'abort'],
    ['imported', 'unresolved'],
    ['look', 'spy'],
    ['handed-on', 'unresolved'],
    ['matcher', 'fulfill'],
  ];
  assert.deepEqual(handlers('web'), expected);
  assert.deepEqual(handlers('mobile'), expected);
});

const CLASS_SUPPORT = `Cypress.Commands.add('stubPrices', () => {
  cy.intercept('GET', '**/api/items/prices', { fixture: 'prices.json' });
});
Cypress.Commands.add('watchItems', () => {
  cy.intercept('GET', '**/api/items');
});
export function stubFromOtherFile() {
  cy.intercept('GET', '**/api/items', { body: [] });
}
`;

const CLASS_SPEC = `function stubLocally() {
  cy.intercept('GET', '**/api/items', { body: [] });
}

beforeEach(() => {
  cy.watchItems();
});

describe('mocked', () => {
  before(() => {
    cy.mockEverything();
  });
  it('mocks through a describe hook', () => {
    cy.patchPrices();
  });
});

context('patched', () => {
  it('patches through a patch call', () => {
    cy.patchPrices();
  });
  it('patches through a custom command', () => {
    cy.stubPrices();
  });
  it('patches through a same-file function', () => {
    stubLocally();
  });
});

describe('real', () => {
  it('stays real with a spy, a comment and a string', () => {
    // cy.mockEverything();
    cy.log('cy.mockEverything()');
    stubFromOtherFile();
    mockEverything();
  });
  it('is unknown with a handler it cannot read', () => {
    cy.intercept('GET', '**/api/items', importedHandler);
  });
  it('is unknown with a body by reference', runElsewhere);
});
`;

test('Test evidence AC-11: each Cypress test of both readers has one backend class from its regions', (t) => {
  const dir = writeRepo(
    t,
    {
      'backend/src/Controllers/ItemController.cs': ITEMS_CONTROLLER,
      'web/cypress/support/commands.ts': CLASS_SUPPORT,
      'web/cypress/e2e/classes.cy.ts': CLASS_SPEC,
      'mobile/cypress/support/commands.ts': CLASS_SUPPORT,
      'mobile/cypress/e2e/classes.cy.ts': CLASS_SPEC,
    },
    {
      backend: { mockCalls: ['mockEverything'], patchCalls: ['patchPrices'] },
      repos: [
        PLAYWRIGHT_REPOS.repos[0],
        { id: 'web', kind: 'web', root: 'web', cypressSubpath: 'cypress' },
        { id: 'mobile', kind: 'mobile', root: 'mobile' },
      ],
    },
  );
  const expected = (prefix) => [
    ['mocks through a describe hook', 13, 'mocked', undefined, [
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
      [11, 'hook', 'mock', 'cy.mockEverything', undefined],
      [14, 'test', 'patch', 'cy.patchPrices', undefined],
    ]],
    ['patches through a patch call', 19, 'patched', undefined, [
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
      [20, 'test', 'patch', 'cy.patchPrices', undefined],
    ]],
    ['patches through a custom command', 22, 'patched', undefined, [
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
      [23, 'helper', 'fulfill', 'cy.intercept', ['cy.stubPrices']],
    ]],
    ['patches through a same-file function', 25, 'patched', undefined, [
      [2, 'helper', 'fulfill', 'cy.intercept', ['stubLocally']],
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
    ]],
    ['stays real with a spy, a comment and a string', 31, 'real', undefined, [
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
    ]],
    ['is unknown with a handler it cannot read', 37, 'unknown', 'unread-handler', [
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
      [38, 'test', 'unresolved', 'cy.intercept', undefined],
    ]],
    ['is unknown with a body by reference', 40, 'unknown', 'body-by-reference', [
      [6, 'helper', 'spy', 'cy.intercept', ['cy.watchItems']],
    ]],
  ].map(([title, line, backend, reason, sites]) => ({
    spec: `${prefix}e2e/classes.cy.ts`,
    title,
    line,
    backend,
    reason,
    sites: sites.map(([siteLine, where, kind, call, via]) => [siteLine, where, kind, call, via]),
  }));
  const classes = (repo) => {
    const facts = extractFacts(dir, repo);
    const tests = facts.filter((fact) => fact.type === 'cypress_test');
    const backends = facts.filter((fact) => fact.type === 'cypress_backend');
    assert.deepEqual(
      backends.map((fact) => [fact.spec, fact.test, fact.line, fact.skipped]),
      tests.map((fact) => [fact.spec, fact.test, fact.line, fact.skipped]),
      `${repo}: one class per test`,
    );
    return backends.map((fact) => ({
      spec: fact.spec,
      title: fact.test,
      line: fact.line,
      backend: fact.backend,
      reason: fact.reason,
      sites: fact.sites.map((site) => [site.line, site.where, site.kind, site.call, site.via]),
    }));
  };
  assert.deepEqual(classes('web'), expected(''));
  assert.deepEqual(classes('mobile'), expected('cypress/'));

  const complete = { type: 'cypress_backend', file: 'e2e/x.cy.ts', line: 3, spec: 'e2e/x.cy.ts', test: 't', skipped: false, backend: 'real', sites: [] };
  assert.equal(validateFacts([complete]), 1);
  for (const field of ['backend', 'sites']) {
    const { [field]: removed, ...partial } = complete;
    assert.throws(() => validateFacts([partial]), new RegExp(`Fact #0 \\(cypress_backend\\): missing required field "${field}"`));
  }
  assert.throws(() => validateFacts([{ ...complete, backend: 'stubbed' }]), /field "backend" must be one of/);
});
