import { test } from '@playwright/test';

const supported = ["dev", "local"].includes(process.env.E2E_ENV ?? "");

test.describe('a supported environment only', () => {
  test.skip(!supported, 'needs a supported environment');

  test('reads the gate', async ({ request }) => {
    await request.get('gate/v1/staged');
  });

  test('reads the gate again', async () => {});
});

test('runs outside the describe', async ({ request }) => {
  await request.get('gate/v1/open');
});
