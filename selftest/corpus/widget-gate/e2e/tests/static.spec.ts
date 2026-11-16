import { test } from '@playwright/test';

test('runs with no guard', async () => {});

test.skip('is skipped as declared', async () => {});

test.fixme('is marked to fix', async () => {});

test.describe.skip('a skipped describe', () => {
  test('sits one level down', async () => {});

  test.describe('a nested describe', () => {
    test('sits two levels down', async () => {});
  });
});

test.describe.fixme('a describe marked to fix', () => {
  test.describe('a nested describe', () => {
    test('sits two levels down', async () => {});
  });
});

test.describe('a describe with a bare skip', () => {
  test.skip();

  test('is skipped with no condition', async () => {});
});

test.describe('a describe with a bare fixme', () => {
  test.fixme();

  test('is marked with no condition', async () => {});
});
