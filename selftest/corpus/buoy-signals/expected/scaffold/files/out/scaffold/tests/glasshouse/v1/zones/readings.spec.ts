import { expect, test } from './fixtures';
import { Api, ApiClientFactory, Roles } from './utils';

const UNRESOLVED_PATH_PARAM = '';
const ROUTE_PATH = `glasshouse/v1/zones/${UNRESOLVED_PATH_PARAM}/readings`;

test.describe('GET glasshouse/v1/zones/*/readings', () => {
  test('reject · 403 Forbidden · context.Result → 403 Forbidden', async ({ session }) => {
    test.info().annotations.push({ type: 'case-id', description: 'TODO' });
    const ctx = await ApiClientFactory.get(Api.base, Roles.denied(), session);
    const response = await ctx.get(ROUTE_PATH);
    expect(response.status()).toBe(403);
  });

  test('effect · reads only · happy path', async ({ session }) => {
    test.info().annotations.push({ type: 'case-id', description: 'TODO' });
    const ctx = await ApiClientFactory.get(Api.base, Roles.admin(), session);
    const response = await ctx.get(ROUTE_PATH);
    expect(response.status()).toBe(200);
  });
});
