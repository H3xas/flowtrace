import { Page } from '@playwright/test';
import { ShelfClient } from '../clients/shelf-client';

export async function stubShelves(page: Page, shelves: ShelfClient) {
  await page.route('**/depot/v1/shelves/**', (route) => route.fulfill({ status: 200 }));
  await shelves.count();
}

export async function prepareShelves(page: Page, shelves: ShelfClient) {
  await stubShelves(page, shelves);
}
