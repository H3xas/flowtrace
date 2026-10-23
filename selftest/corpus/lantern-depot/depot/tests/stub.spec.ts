import { test } from '@playwright/test';
import { ShelfClient } from '../clients/shelf-client';
import { prepareShelves, stubShelves } from '../helpers/stub';

test('a stub helper is not a request', async ({ page, request }) => {
  const shelves = new ShelfClient(request);
  await stubShelves(page, shelves);
});

test('a chain through a stub helper stops there', async ({ page, request }) => {
  const shelves = new ShelfClient(request);
  await prepareShelves(page, shelves);
  await shelves.count();
});
