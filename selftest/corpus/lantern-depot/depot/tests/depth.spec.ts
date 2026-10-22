import { test } from '@playwright/test';
import { BinClient } from '../clients/bin-client';
import { CrateClient } from '../clients/crate-client';
import { levelOne, levelZero } from '../helpers/deep';
import { pingSouth, spinEast } from '../helpers/cycle';

test('four bodies reach the request', async ({ request }) => {
  await levelOne(new CrateClient(request), 'crate-1');
});

test('a fifth body is past the bound', async ({ request }) => {
  await levelZero(new CrateClient(request), 'crate-1');
});

test('two helpers that call each other', async ({ request }) => {
  await spinEast('bin-2');
  await pingSouth(new BinClient(request), 'bin-2', true);
});

test('a test after the cycle', async ({ request }) => {
  const bins = new BinClient(request);
  await bins.label('bin-2');
});
