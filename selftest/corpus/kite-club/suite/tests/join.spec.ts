import { expect, test } from '@playwright/test';

test('a member joins a club', async ({ request }) => {
  const response = await request.post('/clubs/v1/join/c1');
  expect(response.status()).toBe(200);
});
