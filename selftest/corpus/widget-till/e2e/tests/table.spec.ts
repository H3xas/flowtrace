import { expect, test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

const refundRows = [
  { id: 9020, tender: 'card' },
  { id: 9021, tender: 'cash' },
];

const pendingRows = [{ id: 9022 }, { id: 'later' }];

test.describe('till/v1/refunds by row', () => {
  for (const row of refundRows) test(caseRef(row.id, 'refunds by tender'), async ({ request }) => {
    const response = await request.post('till/v1/refunds', { data: { tender: row.tender } });
    expect(response.status()).toBe(200);
  });

  for (const row of pendingRows) {
    test(caseRef(row.id, 'refunds a pending row'), async ({ request }) => {
      const response = await request.post('till/v1/refunds');
      expect(response.status()).toBe(200);
    });
  }
});
