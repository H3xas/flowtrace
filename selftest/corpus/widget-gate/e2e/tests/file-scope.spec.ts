import { test } from '@playwright/test';

test.skip(process.env.E2E_ENV === 'stage', 'not on the staging environment');

test('runs unless staged', async () => {});

test.describe('a describe below the file guard', () => {
  test('runs unless staged too', async () => {});
});
