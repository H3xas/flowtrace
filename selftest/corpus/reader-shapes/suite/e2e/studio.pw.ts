import { test } from '@playwright/test';
import { stubKilns, watchGlazes } from '../helpers/steps';

test.beforeEach(async ({ page }) => {
  await page.route('**/studio/v1/banner', (route) => route.abort());
});

test('shows the stubbed kilns', async ({ page }) => {
  await stubKilns(page);
  await page.goto('/kilns');
});

test('mocks everything', async ({ page }) => {
  await stubEverything(page);
  await page.goto('/kilns');
});

test('seeds the kilns', async ({ page }) => {
  await seedKilns(page);
});

test('watches the glazes', async ({ page }) => {
  await watchGlazes(page);
  await page.goto('/glazes');
});

test('patches the prices', async ({ page }) => {
  await page.route('**/studio/v1/prices', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
  });
});

test('reads a real backend', async ({ page }) => {
  await page.goto('/');
});

test.describe('by reference', () => {
  const scenario = async () => {};
  test('passes a body by name', scenario);
});
