import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, copyFixture, runCli } from './helpers.js';

const CORPUS = 'lantern-console';
const CONFIG = 'lantern.config.json';
const AREA = 'lantern.area.txt';
const SETTINGS = 'GET lanterns/v1/settings';
const AUDIT = 'GET lanterns/v1/audit';

const WEB_SERVICE = 'src/services/settings.service.ts';
const MOBILE_SERVICE = 'src/app/features/settings/console-settings.service.ts';
const CYPRESS_FILES = [
  'e2e/settings.cy.js',
  'pages/settings.page.js',
  'support/commands.js',
  'cypress/e2e/settings.cy.ts',
  'cypress/support/commands.ts',
];

function pipeline(t) {
  const dir = copyFixture(t, CORPUS);
  const extracted = runCli(['extract', '--config', CONFIG], { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);
  const joined = runCli(['join', '--config', CONFIG], { cwd: dir });
  assert.equal(joined.status, 0, joined.stderr);
  const flow = JSON.parse(readFileSync(join(dir, 'out', 'flow.json'), 'utf8'));
  const facts = readdirSync(join(dir, 'out', 'facts'))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(join(dir, 'out', 'facts', name), 'utf8')).facts);
  return { dir, flow, facts };
}

const edgesOf = (flow, kind, key) => flow.edges.filter((edge) => edge.kind === kind && edge.key === key);

function coverReport(dir) {
  const covered = runCli(['cover', '--area', AREA, '--json', '--config', CONFIG], { cwd: dir });
  assert.equal(covered.status, 0, covered.stderr);
  return new Map(JSON.parse(covered.stdout).routes.map((route) => [route.key, route]));
}

test('Cypress evidence AC-1: five Cypress requests stay tests edges and only the two app requests are calls edges', (t) => {
  const { flow, facts } = pipeline(t);

  const gatewayFiles = facts
    .filter((fact) => fact.type === 'gateway_call')
    .map((fact) => fact.file);
  assert.deepEqual([...new Set(gatewayFiles)].sort(), [MOBILE_SERVICE, WEB_SERVICE].sort());

  assert.deepEqual(
    edgesOf(flow, 'calls', SETTINGS)
      .map((edge) => `${edge.from.repo}:${edge.from.file}`)
      .sort(),
    [`mobile:${MOBILE_SERVICE}`, `web:${WEB_SERVICE}`].sort(),
  );

  assert.deepEqual(
    edgesOf(flow, 'tests', SETTINGS)
      .map((edge) => `${edge.from.repo}:${edge.from.file}`)
      .sort(),
    [
      'mobile:cypress/e2e/settings.cy.ts',
      'mobile:cypress/support/commands.ts',
      'web:e2e/settings.cy.js',
      'web:pages/settings.page.js',
      'web:support/commands.js',
    ].sort(),
  );
});

test('Cypress evidence AC-2: cover counts every Cypress request and names its file', (t) => {
  const { dir } = pipeline(t);
  const route = coverReport(dir).get(SETTINGS);
  assert.ok(route, SETTINGS);
  assert.equal(route.evidence.intercepts, 5);
  assert.deepEqual(route.evidence.cypressSpecs, [...CYPRESS_FILES].sort());
});

test('Cypress evidence AC-3: a route only a page model intercepts has a tests edge and no caller', (t) => {
  const { dir, flow } = pipeline(t);

  const tests = edgesOf(flow, 'tests', AUDIT);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].from.repo, 'web');
  assert.equal(tests[0].from.file, 'pages/settings.page.js');
  assert.deepEqual(edgesOf(flow, 'calls', AUDIT), []);
  assert.deepEqual(
    flow.unjoined.routes_without_caller.map((entry) => entry.key),
    [AUDIT],
  );

  const route = coverReport(dir).get(AUDIT);
  assert.ok(route, AUDIT);
  assert.equal(route.evidence.intercepts, 1);
});

test('Cypress evidence AC-4: the span page lists only app call sites as callers', (t) => {
  const { dir } = pipeline(t);
  const page = join(dir, 'settings-span.html');
  const written = runCli(['span', SETTINGS, '--out', page, '--config', CONFIG], { cwd: dir });
  assert.equal(written.status, 0, written.stderr);

  const html = readFileSync(page, 'utf8');
  const heading = html.indexOf('where these calls are written');
  assert.ok(heading !== -1, 'the callers block is on the page');
  const block = html.slice(heading, html.indexOf('</details>', heading));
  const rows = [...block.matchAll(/<div class="where-site">([^<]*)<\/div>/g)].map((match) => match[1]);

  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith(`mobile — ${MOBILE_SERVICE}:`), rows[0]);
  assert.ok(rows[1].startsWith(`web — ${WEB_SERVICE}:`), rows[1]);
  for (const row of rows) assert.doesNotMatch(row, /cypress|\.cy\.|settings\.page\.js/);
});

test('Cypress evidence AC-5: the concepts guide states which edge kind is an app caller', () => {
  const concepts = readFileSync(join(REPO_ROOT, 'docs', 'concepts.md'), 'utf8');
  const start = concepts.indexOf('## The flow');
  const end = concepts.indexOf('## The walk');
  assert.ok(start !== -1 && end > start, '"The flow" section is in docs/concepts.md');
  const section = concepts.slice(start, end).replace(/\s+/g, ' ');

  assert.match(section, /Only a `calls` edge, built from a `gateway_call` fact, is an app caller/);
  assert.match(
    section,
    /A `tests` edge comes from a `cypress_intercept` written in a Cypress spec, a support file or a page model\. It is test evidence that `cover` counts, and no caller list reads it/,
  );
  assert.match(section, /A route that only a test requests stays in `routes_without_caller`/);
});
