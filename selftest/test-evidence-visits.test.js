import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { matchPagePath } from '../lib/join.js';
import { copyFixture, extractRepoFacts, runCli, writeRepo } from './helpers.js';

const ROUTE = 'POST clubs/v1/join/*';

const VISIT_SPEC = `import { test } from '@playwright/test';

async function openJoin(page) {
  await page.goto('/join');
}

test('a real visit', async ({ page }) => {
  await page.goto('https://club.test/join?ref=1#top');
});

test('a mocked visit', async ({ page }) => {
  await mockEverything(page);
  await page.goto('/join');
});

test('a patched visit', async ({ page }) => {
  await page.route('**/clubs/v1/join/*', (route) => route.fulfill({ json: {} }));
  await page.goto('/join');
});

test('an unknown visit', async ({ page }) => {
  await page.route('**/clubs/v1/join/*', importedHandler);
  await page.goto('/join');
});

test('a visit made twice', async ({ page }) => {
  await page.goto('/join');
  await page.goto('/kites/join');
});

test('a visit to a path no page answers', async ({ page }) => {
  await page.goto('/nowhere');
});

test('a visit to a path the reader cannot read', async ({ page }) => {
  await page.goto(\`/clubs/\${clubId}\`);
});

test('a visit to two pages of equal rank', async ({ page }) => {
  await page.goto('/invite/abc');
});

test('a visit to a literal page beside a parameter page', async ({ page }) => {
  await page.goto('/invite/new');
});

test.describe('hooks', () => {
  test.beforeEach(async ({ page }) => {
    await openJoin(page);
  });
  test('a visit through a hook and a helper', async ({ page }) => {});
});

test.skip('a skipped visit', async ({ page }) => {
  await page.goto('/join');
});
`;

const VISIT_CY = `describe('visits', () => {
  it('a cypress visit', () => {
    cy.visit('/join');
  });
  it('a visit through a command', () => {
    cy.openJoin();
  });
});
`;

const COMMANDS = `Cypress.Commands.add('openJoin', () => {
  cy.visit('/join');
});
`;

const INVITE_PAGES = {
  'web/src/invite/InviteCode.tsx': 'import React from "react";\n\nexport function InviteCode() {\n  return <p>code</p>;\n}\n',
  'web/src/invite/InviteToken.tsx': 'import React from "react";\n\nexport function InviteToken() {\n  return <p>token</p>;\n}\n',
  'web/src/invite/InviteNew.tsx': 'import React from "react";\n\nexport function InviteNew() {\n  return <p>new</p>;\n}\n',
};

const APP = `import React from 'react';
import { Route, Routes } from 'react-router-dom';
import JoinPage from './join/JoinPage';
import { Shell } from './layout/Shell';
import ClubFeed from './clubs/ClubFeed';
import ClubSidebar from './clubs/ClubSidebar';
import { InviteCode } from './invite/InviteCode';
import { InviteToken } from './invite/InviteToken';
import { InviteNew } from './invite/InviteNew';

export function App() {
  return (
    <Routes>
      <Route path="join" element={<JoinPage />} />
      <Route path="clubs/:clubId/*" element={<Shell main={<ClubFeed />} side={<ClubSidebar />} />} />
      <Route path="invite/:code" element={<InviteCode />} />
      <Route path="invite/:token" element={<InviteToken />} />
      <Route path="invite/new" element={<InviteNew />} />
    </Routes>
  );
}
`;

function visitCorpus(t) {
  const dir = copyFixture(t, 'kite-club');
  const files = {
    'suite/e2e/visits.pw.ts': VISIT_SPEC,
    'web/cypress/e2e/visits.cy.ts': VISIT_CY,
    'web/cypress/support/commands.ts': COMMANDS,
    'web/src/app.tsx': APP,
    'visits.area.txt': `${ROUTE}\n`,
    ...INVITE_PAGES,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const config = JSON.parse(readFileSync(join(dir, 'kite.config.json'), 'utf8'));
  writeFileSync(join(dir, 'visits.config.json'), JSON.stringify({ ...config, backend: { mockCalls: ['mockEverything'] } }, null, 2));
  const extracted = runCli(['extract', '--config', 'visits.config.json'], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  return dir;
}

function factsOf(dir, repo) {
  return JSON.parse(readFileSync(join(dir, 'out', 'facts', `${repo}.json`), 'utf8')).facts;
}

function cover(dir, json = true) {
  const result = runCli(['cover', '--area', 'visits.area.txt', ...(json ? ['--json'] : []), '--config', 'visits.config.json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function rewriteFacts(dir, change) {
  const factsDir = join(dir, 'out', 'facts');
  for (const name of readdirSync(factsDir)) {
    const path = join(factsDir, name);
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.facts = document.facts.map(change).filter(Boolean);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  }
}

const zero = () => ({ real: 0, patched: 0, mocked: 0, unknown: 0, none: 0 });

test('Test evidence AC-15: a page visit gives a visit fact from the regions of its test', (t) => {
  const dir = visitCorpus(t);
  const visits = factsOf(dir, 'suite').filter((fact) => fact.type === 'pw_visit' && fact.spec === 'e2e/visits.pw.ts');
  const row = (fact) => [fact.test, fact.path, fact.where, fact.skipped, fact.reason ?? null];
  assert.deepEqual(visits.map(row), [
    ['a real visit', 'https://club.test/join?ref=1#top', 'test', false, null],
    ['a mocked visit', '/join', 'test', false, null],
    ['a patched visit', '/join', 'test', false, null],
    ['an unknown visit', '/join', 'test', false, null],
    ['a visit made twice', '/join', 'test', false, null],
    ['a visit made twice', '/kites/join', 'test', false, null],
    ['a visit to a path no page answers', '/nowhere', 'test', false, null],
    ['a visit to a path the reader cannot read', null, 'test', false, 'not-literal'],
    ['a visit to two pages of equal rank', '/invite/abc', 'test', false, null],
    ['a visit to a literal page beside a parameter page', '/invite/new', 'test', false, null],
    ['a visit through a hook and a helper', '/join', 'helper', false, null],
    ['a skipped visit', '/join', 'test', true, null],
  ]);
  const tests = new Map(factsOf(dir, 'suite').filter((fact) => fact.type === 'pw_test').map((fact) => [fact.test, fact.line]));
  for (const visit of visits) assert.equal(visit.testLine, tests.get(visit.test), visit.test);
  const helper = visits.find((visit) => visit.where === 'helper');
  assert.equal(helper.line, 4, 'the line of the call inside the helper');

  const cypress = factsOf(dir, 'web').filter((fact) => fact.type === 'cypress_visit');
  assert.deepEqual(
    cypress.map((fact) => [fact.spec, fact.test, fact.file, fact.path, fact.where]),
    [
      ['e2e/join.cy.ts', 'posts the join request', 'e2e/join.cy.ts', '/kites/clubs/c1', 'test'],
      ['e2e/visits.cy.ts', 'a cypress visit', 'e2e/visits.cy.ts', '/join', 'test'],
      ['e2e/visits.cy.ts', 'a visit through a command', 'support/commands.ts', '/join', 'helper'],
    ],
  );

  const report = cover(dir);
  assert.deepEqual(report.notes.visits, { matched: 12, unmatched: 1, ambiguous: 1, unread: 1 });
});

test('Test evidence AC-15: a fixture that a test uses gives its visits and email reads, as it gives its stubs', (t) => {
  const fixtures = [
    "import { test as base } from '@playwright/test';",
    'export const test = base.extend({',
    '  onJoin: async ({ page }, use) => {',
    "    await page.route('**/clubs/v1/join/*', (route) => route.fulfill({ json: {} }));",
    "    await page.goto('/join');",
    "    await readMail({ subject: 'Welcome aboard' });",
    '    await use();',
    '  },',
    '  unused: async ({ page }, use) => {',
    "    await page.goto('/elsewhere');",
    '    await use();',
    '  },',
    '});',
    '',
  ].join('\n');
  const spec = [
    "import { test } from '../support/fixtures';",
    '',
    "test('a fixture visit', async ({ onJoin }) => {});",
    '',
  ].join('\n');
  const dir = writeRepo(t, { 'suite/support/fixtures.ts': fixtures, 'suite/e2e/fixture.pw.ts': spec }, {
    repos: [{ id: 'suite', kind: 'playwright', root: 'suite' }],
    email: { reads: [{ call: 'readMail', subject: '0.subject' }] },
  });
  const facts = extractRepoFacts(dir, 'suite').filter((fact) => fact.spec === 'e2e/fixture.pw.ts');
  const backend = facts.find((fact) => fact.type === 'pw_backend');
  assert.ok(backend.sites.some((site) => site.where === 'fixture'), JSON.stringify(backend.sites));
  const row = (fact) => [fact.type, fact.test, fact.testLine, fact.file, fact.line, fact.where, fact.path ?? fact.subject];
  assert.deepEqual(facts.filter((fact) => fact.type === 'pw_visit' || fact.type === 'email_read').map(row), [
    ['pw_visit', 'a fixture visit', 3, 'support/fixtures.ts', 5, 'fixture', '/join'],
    ['email_read', 'a fixture visit', 3, 'support/fixtures.ts', 6, 'fixture', 'Welcome aboard'],
  ]);
});

test('Test evidence AC-15: a visit path meets the page that ranks first, by the route comparator', () => {
  const pages = [
    { key: 'code', paths: ['/invite/:code'] },
    { key: 'token', paths: ['/invite/{token}'] },
    { key: 'new', paths: ['/invite/new'] },
    { key: 'shell', paths: ['/clubs/:clubId/*', '/kites/clubs/:clubId/*'] },
    { key: 'root', paths: ['/'] },
  ];
  assert.deepEqual(matchPagePath(pages, '/invite/new'), { page: pages[2] });
  assert.deepEqual(matchPagePath(pages, '/Invite/New/'), { page: pages[2] });
  assert.deepEqual(matchPagePath(pages, '/invite/abc'), { ambiguous: true, candidates: ['code', 'token'] });
  assert.deepEqual(matchPagePath(pages, '/clubs/7'), { page: pages[3] });
  assert.deepEqual(matchPagePath(pages, '/kites/clubs/7/feed/latest'), { page: pages[3] });
  assert.deepEqual(matchPagePath(pages, '/'), { page: pages[4] });
  assert.equal(matchPagePath(pages, '/invite'), null);
  assert.equal(matchPagePath(pages, '/invite/a/b'), null);
});

test('Test evidence AC-16: page reach counts the tests by class that visit a page reaching the route', (t) => {
  const dir = visitCorpus(t);
  const report = cover(dir);
  const route = report.routes.find((candidate) => candidate.key === ROUTE);
  assert.deepEqual(route.pageReach, {
    executing: { real: 5, patched: 1, mocked: 1, unknown: 1, none: 0 },
    skipped: { ...zero(), real: 1 },
  });

  const shape = (candidate) => ({
    key: candidate.key,
    state: candidate.state,
    levels: candidate.levels,
    evidence: candidate.evidence,
    parity: candidate.parity,
    seeds: candidate.seeds,
    realism: candidate.realism,
  });
  rewriteFacts(dir, (fact) => (fact.type === 'pw_visit' || fact.type === 'cypress_visit' ? null : fact));
  const without = cover(dir);
  assert.deepEqual(without.routes.map(shape), report.routes.map(shape));
  assert.deepEqual(without.totals, report.totals);
  assert.deepEqual(without.realism, report.realism);
  assert.deepEqual(without.routes.find((candidate) => candidate.key === ROUTE).pageReach, { executing: zero(), skipped: zero() });
});

test('Test evidence AC-16: a visiting test with no class fact counts as none', (t) => {
  const dir = visitCorpus(t);
  rewriteFacts(dir, (fact) => (fact.type === 'pw_backend' || fact.type === 'cypress_backend' ? null : fact));
  const route = cover(dir).routes.find((candidate) => candidate.key === ROUTE);
  assert.deepEqual(route.pageReach, { executing: { ...zero(), none: 8 }, skipped: { ...zero(), none: 1 } });
});

test('Test evidence AC-16: a test that an environment guard skips, or whose guard is unknown, counts as skipped', (t) => {
  const dir = visitCorpus(t);
  const states = { 'a real visit': 'environment-skip', 'a mocked visit': 'unknown' };
  rewriteFacts(dir, (fact) => (fact.type === 'pw_test' && states[fact.test] ? { ...fact, eligibility: states[fact.test], skipped: false } : fact));
  const route = cover(dir).routes.find((candidate) => candidate.key === ROUTE);
  assert.deepEqual(route.pageReach, {
    executing: { real: 4, patched: 1, mocked: 0, unknown: 1, none: 0 },
    skipped: { ...zero(), real: 2, mocked: 1 },
  });
});

test('Test evidence AC-17: cover shows a page-reach line labelled inferred', (t) => {
  const dir = visitCorpus(t);
  assert.match(
    cover(dir, false),
    /\n {2}page reach \(inferred\) {2}executing 5 real, 1 patched, 1 mocked, 1 unknown, 0 none; skipped 1 real, 0 patched, 0 mocked, 0 unknown, 0 none\n/,
  );
  const md = join(dir, 'cover.md');
  const written = runCli(['cover', '--area', 'visits.area.txt', '--md', md, '--config', 'visits.config.json'], { cwd: dir });
  assert.equal(written.status, 0, written.stderr);
  assert.match(
    readFileSync(md, 'utf8'),
    /\nPage reach \(inferred potential reach, not named evidence\), tests by backend class: executing 5 real, 1 patched, 1 mocked, 1 unknown, 0 none; skipped 1 real, 0 patched, 0 mocked, 0 unknown, 0 none\.\n/,
  );
});
