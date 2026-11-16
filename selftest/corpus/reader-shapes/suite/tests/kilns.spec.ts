import { test, expect } from '@playwright/test';
import { KilnClient } from '../clients/kiln-client';
import { openStudio, coolDown } from '../helpers/steps';

const ROWS = [
  { id: 'K-101', name: 'small' },
  { id: 'K-102', name: 'large' },
];

test('lists the kilns', async ({ request }) => {
  test.info().annotations.push({ type: 'case-id', description: 'C-11' });
  const kilns = new KilnClient(request);
  const response = await kilns.list();
  expect(response.status()).toBe(200);
});

test('fires one kiln', async ({ request }) => {
  const kilns = new KilnClient(request);
  await openStudio(request);
  const response = await kilns.fire('k1');
  expect(response.status()).toBe(204);
  const after = await request.get('studio/v1/kilns/k1');
  expect(after.status()).toBe(200);
});

test('cools down through a helper', async ({ request }) => {
  const kilns = new KilnClient(request);
  await coolDown(kilns);
  await kilns.glazes();
});

for (const row of ROWS) {
  test(`reads the ${row.name} kiln`, async ({ request }) => {
    tms.id(row.id);
    const response = await request.get(`studio/v1/kilns/${row.id}`);
    expect(response.ok()).toBeTruthy();
  });
}

test.describe.skip('parked', () => {
  test('waits for the new kiln', async ({ request }) => {
    await request.delete('studio/v1/kilns/old');
  });
});

test.skip('skipped on its own', async () => {});
