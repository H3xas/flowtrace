import { test } from '@playwright/test';
import { importedHandler } from '../helpers/handlers';
import { stubEveryEndpoint } from '../helpers/mocks';

test('mocks and patches', async ({ page }) => {
  await page.route('**/market/v1/prices', (route) => route.fulfill({ json: [] }));
  await stubEveryEndpoint(page);
});

test('mocks and cannot read a handler', async ({ page }) => {
  await page.route('**/market/v1/stock', importedHandler);
  await stubEveryEndpoint(page);
});

test('patches and cannot read a handler', async ({ page }) => {
  await page.route('**/market/v1/stock', importedHandler);
  await page.route('**/market/v1/prices', (route) => route.fulfill({ json: [] }));
});

test('spies and cannot read a handler', async ({ page }) => {
  await page.route('**/market/v1/orders', (route) => route.continue());
  await page.route('**/market/v1/stock', importedHandler);
});

test('replays an archive', async ({ page }) => {
  await page.routeFromHAR('hars/market.har', { url: '**/market/v1/**' });
  await page.goto('/');
});

test.skip('waits for a parked feature', async ({ page }) => {
  await page.route('**/market/v1/banner', (route) => route.fulfill({ json: {} }));
});

test.describe('late hook', () => {
  test('blocks then spies', async ({ page }) => {
    await page.route('**/*.css', (route) => route.abort());
  });

  test.beforeEach(async ({ page }) => {
    await page.route('**/market/v1/orders', (route) => route.continue());
  });
});
