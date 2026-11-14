import { expect, test } from '@playwright/test';
import { stubEveryPanel } from './panels';

test.describe('site list', () => {
  test('shows the closures banner', async ({ page }) => {
    await page.route('**/reef/v1/sites/closures', (route) => route.fulfill({ json: [{ site: 'blue-hole' }] }));
    await page.goto('/sites');
    await expect(page.getByText('Closed')).toBeVisible();
  });

  test('hides the site photos', async ({ page }) => {
    await page.route('**/*.png', (route) => route.abort());
    await page.goto('/sites');
    await expect(page.getByRole('list')).toBeVisible();
  });

  test('shows an empty forecast', async ({ page }) => {
    await page.route('**/reef/v1/forecast', (route) => route.fulfill({ json: [] }));
    await page.goto('/sites');
    await expect(page.getByText('No forecast')).toBeVisible();
  });

  test('shows the empty state', async ({ page }) => {
    await stubEveryPanel(page);
    await page.goto('/sites');
    await expect(page.getByText('No sites')).toBeVisible();
  });
});
