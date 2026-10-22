import { test } from '@playwright/test';
import { closeAny, dropAny } from '../helpers/ambiguous';

test('an untyped receiver inside a helper', async ({ request }) => {
  await closeAny(request, 'bin-9');
});

test('an untyped receiver in the test body', async ({ request }) => {
  const holder = await request.storageState();
  await holder.close('crate-9');
});

test('a verb name on an untyped receiver', async ({ request }) => {
  await dropAny(request, 'crate-6');
});
