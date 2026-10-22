import { test } from '@playwright/test';
import { pingA } from '../helpers/loop';
import { StorefrontPage } from '../pages/storefront-page';

test('opens the storefront with a banner', async ({ page }) => {
  const shop = new StorefrontPage(page);
  await shop.open();
});

test('opens a mocked storefront', async ({ page }) => {
  const shop = new StorefrontPage(page);
  await shop.openMocked();
});

test('opens the storefront through two layers', async ({ page }) => {
  const shop = new StorefrontPage(page);
  await shop.openDeep();
});

test('counts down without a stub', async ({ page }) => {
  pingA(3);
  await page.goto('/');
});
