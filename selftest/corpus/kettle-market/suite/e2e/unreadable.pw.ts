import { test } from '@playwright/test';
import { seedBasket } from 'kettle-fixtures';
import { importedHandler } from '../helpers/handlers';
import { stubEveryEndpoint } from '../helpers/mocks';
import { CounterPage } from '../pages/counter-page';

async function sharedScenario({ page }) {
  await page.goto('/');
}

async function setupCounter({ page }) {
  await page.goto('/counter');
}

test('runs a shared scenario', sharedScenario);

test('answers through an imported handler', async ({ page }) => {
  await page.route('**/market/v1/prices', importedHandler);
});

test('prepares through an ambiguous helper', async ({ page }) => {
  const counter = new CounterPage(page);
  await counter.prepare(page);
});

test('prepares a mocked counter', async ({ page }) => {
  await stubEveryEndpoint(page);
  const counter = new CounterPage(page);
  await counter.prepare(page);
});

test('prepares a seeded counter', async ({ page }) => {
  await seedBasket(page);
  const counter = new CounterPage(page);
  await counter.prepare(page);
});

test.describe('counter by reference', () => {
  test.beforeEach(setupCounter);

  test('shows the counter', async ({ page }) => {
    await page.goto('/counter');
  });
});

test.describe('mocked by reference', () => {
  test.beforeEach(async ({ page }) => {
    await stubEveryEndpoint(page);
  });

  test('runs a mocked shared scenario', sharedScenario);
});
