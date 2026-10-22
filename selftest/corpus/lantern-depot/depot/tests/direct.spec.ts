import { expect, test } from '@playwright/test';

test('a direct request in the test body', async ({ request }) => {
  const response = await request.get('depot/v1/shelves/count');
  expect(response.status()).toBe(200);
});
