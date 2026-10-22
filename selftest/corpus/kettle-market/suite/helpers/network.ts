import type { Page } from '@playwright/test';

export async function primeCache(page: Page) {
  await page.route('**/market/v1/cache', (route) => route.fulfill({ status: 204 }));
}

export async function primeBanner(page: Page) {
  await page.route('**/market/v1/banner', (route) => route.fulfill({ json: { text: 'sale' } }));
}

export async function layerOne(page: Page) {
  await layerTwo(page);
}

export async function layerTwo(page: Page) {
  await page.route('**/market/v1/stock', async (route) => {
    await route.fulfill({ json: [] });
  });
}
