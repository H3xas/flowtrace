import { expect, test } from '@playwright/test';

test.describe('catalog/v1/products', () => {
  test('lists the products of a category', async ({ request }) => {
    const response = await request.get('catalog/v1/products?category=shoes');
    expect(response.status()).toBe(200);
  });

  test.skip('rejects a listing with no category', async ({ request }) => {
    const response = await request.get('catalog/v1/products');
    expect(response.status()).toBe(400);
  });
});
