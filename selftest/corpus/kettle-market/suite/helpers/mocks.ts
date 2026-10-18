import type { Page } from '@playwright/test';

const ENDPOINTS = [
  { route: '**/market/v1/prices', body: [] },
  { route: '**/market/v1/stock', body: [] },
];

export async function stubEveryEndpoint(page: Page) {
  for (const endpoint of ENDPOINTS) {
    await page.route(endpoint.route, (route) => route.fulfill({ json: endpoint.body }));
  }
}

export async function mockShell(page: Page) {
  await stubEveryEndpoint(page);
}
