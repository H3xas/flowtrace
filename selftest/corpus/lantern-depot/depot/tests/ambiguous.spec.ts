import { test } from '@playwright/test';
import { closeAny } from '../helpers/ambiguous';

test('an untyped receiver inside a helper', async ({ request }) => {
  await closeAny(request, 'bin-9');
});

test('an untyped receiver in the test body', async ({ request }) => {
  const holder = await request.storageState();
  await holder.close('crate-9');
});
