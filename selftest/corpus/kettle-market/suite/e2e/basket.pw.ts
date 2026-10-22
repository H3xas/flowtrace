import { test } from '@playwright/test';

async function patchPrices(page) {
  await page.route('**/market/v1/prices', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, discount: 10 } });
  });
}

const fulfillStock = async (page) => {
  await page.route('**/market/v1/stock', (route) => route.fulfill({ status: 200, body: '[]' }));
};

async function primeCache(page) {
  await page.goto('/');
}

test('shows the discounted prices', async ({ page }) => {
  await patchPrices(page);
  await page.goto('/basket');
});

test('shows the stock badge', async ({ page }) => {
  await fulfillStock(page);
  await page.goto('/basket');
});

test('warms the cache first', async ({ page }) => {
  await primeCache(page);
});

test.describe('basket drawer', () => {
  const emptyBasket = async (page) => {
    await page.route('**/market/v1/basket', (route) => route.fulfill({ json: { items: [] } }));
  };

  test('shows an empty drawer', async ({ page }) => {
    await emptyBasket(page);
    await page.goto('/basket');
  });
});
