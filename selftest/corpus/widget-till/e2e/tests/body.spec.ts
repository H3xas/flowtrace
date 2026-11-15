import { expect, test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

test.describe('till/v1/refunds in a body', () => {
  test('refunds a store credit', async ({ request }) => {
    caseRef.id(9010);
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test('refunds a coupon', async ({ request }) => {
    caseRef.id(9011, 'note');
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test(caseRef(9012, 'refunds a voucher'), async ({ request }) => {
    caseRef.id(9013);
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test('refunds a deposit', async ({ request }) => {
    test.info().annotations.push({ type: 'case-id', description: '9014' });
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });

  test('refunds with no reference', async ({ request }) => {
    caseRef.id();
    const response = await request.post('till/v1/refunds');
    expect(response.status()).toBe(200);
  });
});
