import { expect, test } from '@playwright/test';

const zones = [{ id: 'z1' }];

for (const zone of zones) {
  test('a grower the relay ledger refuses gets no watchers', async ({ request }) => {
    const response = await request.get(`glasshouse/v1/zones/${zone.id}/watchers`);
    expect(response.status()).toBe(403);
  });
}
