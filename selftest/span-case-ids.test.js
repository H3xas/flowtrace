/**
 * A tested row on the span page names the case ids its tests carry. A case id written there
 * that no reader resolved is shown by its expression, so the page never says "no case id"
 * for a test that does name one.
 *
 * The specs are written into a copy of `corpus/widget-till/`, whose backend holds the route
 * and whose configuration names the case-id calls.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { renderSpanHtml } from '../lib/render-span-html.js';
import { span } from '../lib/span.js';
import { copyFixture, extract } from './helpers.js';

const ROUTE = 'POST till/v1/refunds';
const HEAD = "import { expect, test } from '@playwright/test';\n\nimport { caseRef } from '../support/case-ref';\n\n";
const POSTS = "  const response = await request.post('till/v1/refunds');\n  expect(response.status()).toBe(200);\n";

function spanWith(t, source) {
  const dir = copyFixture(t, 'widget-till');
  const tests = join(dir, 'e2e', 'tests');
  for (const name of readdirSync(tests)) rmSync(join(tests, name));
  writeFileSync(join(tests, 'refunds.spec.ts'), source);
  extract(dir, 'till.config.json');
  const sets = readdirSync(join(dir, 'out', 'facts'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, 'out', 'facts', name), 'utf8')));
  const model = span(sets, ROUTE);
  assert.equal(model.error, undefined);
  return { model, html: renderSpanHtml(model) };
}

test('Span case ids AC-19: an unresolved case id is shown by its expression, not as no case id', (t) => {
  const { model, html } = spanWith(t, `${HEAD}test(caseRef(idOf(drawerName), 'refunds by a call'), async ({ request }) => {\n${POSTS}});\n`);
  const [entry] = model.evidence.verifying;
  assert.deepEqual(entry.caseIds, []);
  assert.deepEqual(entry.unresolvedCaseIds, ['idOf(drawerName)']);
  assert.ok(html.includes('case id not read: idOf(drawerName)'), 'the marker names the expression');
  assert.ok(!html.includes('no case id:'), 'the row does not say it has no case id');
});

test('Span case ids AC-19: a row with a resolved id and an unresolved record shows both', (t) => {
  const source = `${HEAD}test(caseRef(9050, 'refunds with both'), async ({ request }) => {\n  caseRef.id(idOf(drawerName));\n${POSTS}});\n`;
  const { model, html } = spanWith(t, source);
  const [entry] = model.evidence.verifying;
  assert.deepEqual(entry.caseIds, [9050]);
  assert.deepEqual(entry.unresolvedCaseIds, ['idOf(drawerName)']);
  assert.ok(html.includes('case 9050'));
  assert.ok(html.includes('case id not read: idOf(drawerName)'));
});

test('Span case ids AC-19: a test with no case id keeps the no case id text and an empty list', (t) => {
  const { model, html } = spanWith(t, `${HEAD}test('refunds with no case', async ({ request }) => {\n${POSTS}});\n`);
  const [entry] = model.evidence.verifying;
  assert.deepEqual(entry.unresolvedCaseIds, []);
  assert.ok(html.includes('no case id:'));
});
