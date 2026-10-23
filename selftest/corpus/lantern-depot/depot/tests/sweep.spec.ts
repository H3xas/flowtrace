import { test } from '@playwright/test';
import { BinClient } from '../clients/bin-client';
import { CreatedSweeper, DeclaredSweeper, PropertySweeper, sweepBins } from '../helpers/sweep';

test('sweeps bins through a helper function', async ({ request }) => {
  const bins = new BinClient(request);
  await sweepBins(bins, 'bin-1');
});

test('sweeps bins through a parameter property', async ({ request }) => {
  const sweeper = new PropertySweeper(new BinClient(request));
  await sweeper.sweep('bin-1');
});

test('sweeps bins through a field declaration', async ({ request }) => {
  const sweeper = new DeclaredSweeper(new BinClient(request));
  await sweeper.sweep('bin-1');
});

test('sweeps bins through a field the constructor creates', async ({ request }) => {
  const sweeper = new CreatedSweeper(request);
  await sweeper.sweep('bin-1');
});
