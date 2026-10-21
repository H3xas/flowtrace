import { expect, test } from '@playwright/test';
import { BinClient } from '../clients/bin-client';

test('a client request inside expect', async ({ request }) => {
  const bins = new BinClient(request);
  expect((await bins.close('bin-3')).status()).toBe(403);
});

test('a client request on the line before expect', async ({ request }) => {
  const bins = new BinClient(request);
  const response = await bins.close('bin-3');
  expect(response.status()).toBe(403);
});

test('a direct request inside expect', async ({ request }) => {
  expect((await request.post('depot/v1/bins/bin-4/open')).status()).toBe(200);
});

test('a direct request on the line before expect', async ({ request }) => {
  const response = await request.post('depot/v1/bins/bin-4/open');
  expect(response.status()).toBe(200);
});

test('a second request inside expect', async ({ request }) => {
  const bins = new BinClient(request);
  await bins.open('bin-5');
  expect((await bins.close('bin-5')).status()).toBe(200);
});

test('a second request on the line before expect', async ({ request }) => {
  const bins = new BinClient(request);
  await bins.open('bin-5');
  const response = await bins.close('bin-5');
  expect(response.status()).toBe(200);
});
