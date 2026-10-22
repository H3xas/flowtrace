import { test } from '@playwright/test';
import { ArchiveClient } from '../clients/archive-client';
import { BinClient } from '../clients/bin-client';
import { GateClient } from '../clients/gate-client';
import { LedgerClient } from '../clients/ledger-client';
import { NorthZoneClient } from '../clients/north-zone-client';
import { ShelfClient } from '../clients/shelf-client';
import { SouthZoneClient } from '../clients/south-zone-client';

test('each client reads the base of its own file', async ({ request }) => {
  const shelves = new ShelfClient(request);
  const bins = new BinClient(request);
  await shelves.count();
  await bins.open('bin-8');
});

test('an imported const reads the value of the file that exports it', async ({ request }) => {
  const ledger = new LedgerClient(request);
  const archive = new ArchiveClient(request);
  await ledger.entries();
  await archive.pages();
});

test('a name with two values and a name with one', async ({ request }) => {
  const north = new NorthZoneClient(request);
  const south = new SouthZoneClient(request);
  const gate = new GateClient(request);
  await north.lamps();
  await south.lamps();
  await gate.doors();
  await gate.bays();
});
