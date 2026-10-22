import { test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/market/v1/prices', (route) => route.fulfill({ json: [] }));
});

test('shows the price list', async ({ page }) => {
  await page.goto('/prices');
});

test.describe('price details', () => {
  test('shows one price', async ({ page }) => {
    await page.goto('/prices/1');
  });
});
