import { test } from '@playwright/test';
import { stubEveryEndpoint } from '../helpers/mocks';

test('ignores a stub in a line comment', async ({ page }) => {
  // await page.route('**/market/v1/prices', (route) => route.fulfill({ json: [] }));
  await page.goto('/prices');
});

test('ignores a stub in a block comment', async ({ page }) => {
  /*
  await stubEveryEndpoint(page);
  */
  await page.goto('/prices');
});

test('ignores a stub name in a string', async ({ page }) => {
  const label = 'stubEveryEndpoint(page) runs in another suite';
  await page.goto(`/prices?note=${encodeURIComponent(label)}`);
});

test('reads a stub inside an interpolation', async ({ page }) => {
  await page.goto(`/prices?ready=${await stubEveryEndpoint(page)}`);
});
