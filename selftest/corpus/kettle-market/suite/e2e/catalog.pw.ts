import { test } from '@playwright/test';
import { seedBasket } from 'kettle-fixtures';
import * as fixtures from 'kettle-fixtures';
import * as catalog from '../helpers/catalog-lists';
import { stubEveryEndpoint } from '../helpers/mocks';

test('browses a fully stubbed catalog', async ({ page }) => {
  await stubEveryEndpoint(page);
  await page.goto('/catalog');
});

test('starts from a seeded basket', async ({ page }) => {
  await seedBasket(page);
  await page.goto('/basket');
});

test('reads the fixture price list', async ({ page }) => {
  await fixtures.priceList(page);
});

test('reads the catalog price list', async ({ page }) => {
  await catalog.priceList(page);
});
