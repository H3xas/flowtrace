import { test } from '@playwright/test';

import { sharedFlag } from '../support/flags';

let mutableFlag = false;

test.describe('an imported condition', () => {
  test.skip(sharedFlag, 'read from another file');

  test('reads an imported binding', async ({ request }) => {
    await request.get('gate/v1/unread');
  });
});

test.describe('a mutable condition', () => {
  test.skip(mutableFlag, 'read from a let binding');

  test('reads a let binding', async () => {});
});

test.describe('a condition outside the grammar', () => {
  test.skip(Math.random() > 2, 'a call nothing evaluates');

  test('reads a call', async () => {});
});

test.describe('a variable the configuration does not name', () => {
  test.skip(process.env.OTHER_FLAG === 'on', 'read from another variable');

  test('reads another variable', async () => {});
});

test.describe('a true guard and an unknown one', () => {
  test.skip(process.env.OTHER_FLAG === 'on');
  test.skip(process.env.E2E_ENV === 'dev', 'not on dev');

  test('reads both guards', async () => {});
});

test.describe.fixme('a static skip over both', () => {
  test.skip(process.env.OTHER_FLAG === 'on');
  test.skip(process.env.E2E_ENV === 'dev');

  test('reads a static skip first', async ({ request }) => {
    await request.get('gate/v1/parked');
  });
});
