import { test } from '@playwright/test';
import { watchOrders } from '../helpers/watch';

test('lets the prices through', async ({ page }) => {
  await page.route('**/market/v1/prices', (route) => route.continue());
  await page.goto('/prices');
});

test('falls back for the stock', async ({ page }) => {
  await page.route('**/market/v1/stock', async (route) => {
    await route.fallback();
  });
});

test('records the order requests', async ({ page }) => {
  const seen: string[] = [];
  await watchOrders(page, seen);
  await page.goto('/orders');
});

test('blocks the images', async ({ page }) => {
  await page.route('**/*.png', (route) => route.abort());
  await page.goto('/');
});

test('answers only the posts', async ({ page }) => {
  await page.route('**/market/v1/orders', (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201 });
    return route.continue();
  });
});
