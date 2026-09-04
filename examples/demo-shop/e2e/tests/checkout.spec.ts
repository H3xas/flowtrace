import { expect, test } from '@playwright/test';

test.describe('orders/v1/checkout', () => {
  test('places an order when the cart holds an item', async ({ request }) => {
    const response = await request.post('orders/v1/checkout', {
      data: { paymentToken: 'tok_demo' },
    });
    expect(response.status()).toBe(200);
  });

  test('rejects a checkout with no payment token', async ({ request }) => {
    const response = await request.post('orders/v1/checkout', { data: {} });
    expect(response.status()).toBe(400);
  });

  test('lists the cart', async ({ request }) => {
    const response = await request.get('orders/v1/cart');
    expect(response.status()).toBe(200);
    expect(await response.json()).toHaveProperty('items');
  });

  test.skip('rejects a cart item with no quantity', async ({ request }) => {
    const response = await request.post('orders/v1/cart/items', { data: { productId: 'sku_demo' } });
    expect(response.status()).toBe(400);
  });
});
