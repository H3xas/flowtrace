import type { Page } from '@playwright/test';

export async function watchOrders(page: Page, seen: string[]) {
  await page.route('**/market/v1/orders', async (route) => {
    seen.push(route.request().url());
    await route.fallback();
  });
}
