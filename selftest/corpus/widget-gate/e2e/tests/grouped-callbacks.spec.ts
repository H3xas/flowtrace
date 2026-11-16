import { test } from '@playwright/test';

test.describe.skip('a grouped describe', (() => {
  test('reads the grouped gate', async ({ request }) => {
    await request.get('gate/v1/grouped');
  });
}));

test.describe('a grouped describe guard', ((function () {
  test.skip(process.env.E2E_ENV === 'stage');

  test('is guarded by its grouped describe', async () => {});
})));

test.describe('a grouped hook', () => {
  test.beforeEach(( /* grouped */ async ({ page }) => {
    test.skip(process.env.E2E_ENV !== 'dev', 'only on dev');
  }));

  test('is guarded by a grouped hook', async ({ page }) => {
    await page.goto('/');
  });
});

test('a grouped test body', (async ({ request }) => {
  test.fixme(process.env.E2E_ENV === 'dev', 'not on dev');
  await request.get('gate/v1/wrapped');
}));

test.describe.fixme('a grouped expression describe', (() =>
  test('is parked by a grouped expression body', async () => {})));
