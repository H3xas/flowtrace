import { expect, test } from '@playwright/test';

async function discountPrices(page) {
  await page.route('**/catalog/v1/products*', async (route) => {
    const response = await route.fetch();
    const products = await response.json();
    await route.fulfill({ response, json: products.map((product) => ({ ...product, price: product.price / 2 })) });
  });
}

test.describe('storefront with discounted prices', () => {
  test.beforeEach(async ({ page }) => {
    await discountPrices(page);
  });

  test('shows the half-price banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Half price')).toBeVisible();
  });
});

test.describe('storefront on the live catalog', () => {
  test('lists the products', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('list')).toBeVisible();
  });
});
