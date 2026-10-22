import type { Page } from '@playwright/test';

export async function prepare(page: Page) {
  await page.route('**/market/v1/basket', (route) => route.fulfill({ json: { items: [] } }));
}
