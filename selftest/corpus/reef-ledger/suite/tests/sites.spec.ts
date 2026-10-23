import { expect, test } from '@playwright/test';

test.describe('reef/v1/sites', () => {
  test('lists the dive sites', async ({ request }) => {
    const response = await request.get('reef/v1/sites');
    expect(response.status()).toBe(200);
  });

  test('logs a visit', async ({ request }) => {
    const response = await request.post('reef/v1/sites/visits', { data: { site: 'blue-hole' } });
    expect(response.status()).toBe(202);
  });

  test('reads the weather', async ({ request }) => {
    const response = await request.get('reef/v1/weather');
    expect(response.status()).toBe(200);
  });
});
