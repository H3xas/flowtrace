import { test } from '@playwright/test';

test.describe.skip('a function describe', function () {
  test('reads the folded gate', async ({ request }) => {
    await request.get('gate/v1/folded');
  });
});

test.describe.fixme('a named function describe', async function parked() {
  test('is parked by a named function', async () => {});
});

test.describe('a function hook', function () {
  test.beforeEach(async function ({ page }) {
    test.skip(process.env.E2E_ENV !== 'dev', 'only on dev');
  });

  test('is guarded by a function hook', async ({ page }) => {
    await page.goto('/');
  });
});

test.describe('a function describe guard', function () {
  test.skip(process.env.E2E_ENV === 'stage');

  test('is guarded by its function describe', async function ({ request }) {
    const rows = [1, 2].map((id) => ({ id }));
    test.fixme(process.env.E2E_ENV === 'dev', 'its own guard');
  });
});

test.describe.skip('an expression describe', () =>
  test('is skipped by an expression body', async () => {}));
