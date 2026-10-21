import { test } from '@playwright/test';
import { CrateClient } from '../clients/crate-client';
import { stampAudit } from '../helpers/audit';

test('a request in a top-level helper function', async ({ request }) => {
  await stampAudit(request, 'audit-2');
});

test('a client method named after a verb', async ({ request }) => {
  const crates = new CrateClient(request);
  await crates.delete('crate-4');
});
