import { test } from '@playwright/test';

function skipWhenAsked() {
  test.skip(true, 'a helper nothing here can place');
}

test.describe('a hook guard', () => {
  test.beforeEach(async () => {
    test.fixme(process.env.E2E_ENV !== 'dev', 'only on dev');
  });

  test('is guarded by its hook', async () => {});
});

test.describe('an outer describe', () => {
  test.skip(process.env.E2E_ENV === 'local', 'not on a local run');

  test.describe('an inner describe', () => {
    test.skip(process.env.E2E_ENV === 'stage');

    test('lists the outer guard first', async () => {
      test.fixme(process.env.E2E_ENV === 'dev', 'its own guard');
    });
  });
});

test('reads a guard under a condition', async () => {
  if (Date.now() > 0) {
    test.skip();
  }
});

test('is not guarded by the helper', async () => {
  skipWhenAsked();
});

for (const size of ['small', 'large']) {
  test.describe(`a ${size} loop describe`, () => {
    test.skip(size === 'large' && process.env.E2E_ENV === 'dev', 'large only off dev');

    test(`runs a ${size} case`, async () => {});
  });
}
