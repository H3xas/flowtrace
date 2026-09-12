import { expect, test } from '@playwright/test';

import { tms } from '../support/tms';

const receiptRows = [{ summary: 'prints a duplicate receipt' }];

test.skip();

test.describe('kiosk/v1/till', () => {
  test('opens the kiosk drawer', async ({ request }) => {
    test.skip(process.env.KIOSK !== 'on', 'kiosk build only');
    const response = await request.post('kiosk/v1/drawer');
    expect(response.status()).toBe(200);
  });

  test.skip('reprints a receipt', async ({ request }) => {
    const response = await request.post('kiosk/v1/receipts');
    expect(response.status()).toBe(201);
  });

  test('scans a label', { tag: '@slow' }, async ({ page }) => {
    const code = await page.inputValue('#sku');
    expect(/^SKU-/.test(code)).toBe(true);
  });

  test(tms.id(7, 'refunds a sale'), async ({ request }) => {
    const positive = { test: (value: number) => value > 0 };
    expect(positive.test(1)).toBe(true);
    const response = await request.post('kiosk/v1/refunds');
    expect(response.status()).toBe(200);
  });

  for (const row of receiptRows) {
    test(row.summary, async ({ page }) => {
      await page.goto('/kiosk');
      expect(page.url()).toContain('kiosk');
    });
  }
});
