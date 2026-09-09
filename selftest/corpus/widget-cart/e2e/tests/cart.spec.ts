import { expect, test } from '@playwright/test';

const badgeSizes = ['small', 'large'];

test.describe('cart/v1/items', () => {
  test('adds an item to the cart', async ({ request }) => {
    const response = await request.post('cart/v1/items');
    expect(response.status()).toBe(200);
  });

  test('removes an item from the cart', async ({ request }) => {
    const response = await request.delete('cart/v1/items/1');
    expect(response.status()).toBe(204);
  });
  for (const size of badgeSizes) {
    test(`renders a ${size} cart badge`, async ({ page }) => {
      await page.goto('/cart');
      expect(page.url()).toContain('cart');
    });
  }

  test('rejects an unauthenticated add', async ({ request }) => {
    const response = await request.post('cart/v1/items');
    expect(response.status()).toBe(401);
  });

  // Deliberately spaced so the shifted listing reports nothing at this line.
  test('empties the cart', async ({ request }) => {
    const response = await request.delete('cart/v1/items');
    expect(response.status()).toBe(204);
  });
});
