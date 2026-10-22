import { expect, test } from '@playwright/test';
import { stubEveryEndpoint } from '../helpers/mocks';

test.describe.configure({ mode: 'parallel' });

test.describe('mocked shelf', () => {
  test.beforeEach(async ({ page }) => {
    await stubEveryEndpoint(page);
  });

  test('lists the kettles', async ({ page }) => {
    await page.goto('/kettles');
    await expect(page.getByRole('list')).toBeVisible();
  });

  test('filters the kettles', async ({ page }) => {
    await page.goto('/kettles?type=steel');
  });

  test.describe('inner shelf', () => {
    test('opens one kettle', async ({ page }) => {
      await page.goto('/kettles/1');
    });
  });
});

test.describe('live shelf', () => {
  test('lists the live kettles', async ({ page }) => {
    await page.goto('/kettles');
  });

  test('opens the live basket', async ({ page }) => {
    await page.goto('/basket');
  });
});

test.describe.skip('parked shelf', () => {
  test.beforeEach(async ({ page }) => {
    await stubEveryEndpoint(page);
  });

  test('compares two kettles', async ({ page }) => {
    await page.goto('/compare');
  });
});
