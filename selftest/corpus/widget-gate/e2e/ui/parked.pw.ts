import { test } from '@playwright/test';

test.describe.fixme('a parked screen', () => {
  test('stubs the parked list', async ({ page }) => {
    await page.route('**/gate/v1/parked', (route) => route.fulfill({ status: 200, body: '[]' }));
    await page.goto('/parked');
  });
});
