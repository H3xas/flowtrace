import { expect, test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

test.describe('till/v1/refunds', () => {
  test(caseRef(9001, 'refunds a sale'), async ({ request }) => {
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test.skip(caseRef(9002, 'refunds a voided sale'), async ({ request }) => {
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test.fixme(caseRef(9005, 'refunds a split tender'), async ({ request }) => {
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(400);
  });

  test(caseRef([9003, 9004], 'refunds two lines'), { tag: '@slow' }, async ({ request }) => {
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test(caseRef('TC-3', 'refunds a gift card'), async ({ request }) => {
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test(
    caseRef(
      9006,
      'refunds a sale over several lines',
    ),
    async ({ request }) => {
      const response = await request.post('till/v1/refunds');
      expect(response.status()).toBe(200);
    },
  );

  test(caseRef(9007, 'refunds by reference'), refundsByReference);
});

async function refundsByReference({ request }) {
  const response = await request.post('till/v1/refunds');
  expect(response.status()).toBe(200);
}
