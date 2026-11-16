import { expect, test } from './fixtures';
import { Api, ApiClientFactory, Roles } from './utils';

const UNRESOLVED_PATH_PARAM = '';
const ROUTE_PATH = `glasshouse/v1/zones/${UNRESOLVED_PATH_PARAM}/harvest-plan`;

test.describe('POST glasshouse/v1/zones/*/harvest-plan', () => {
  test('reject · 403 Forbidden · context.Result → 403 Forbidden', async ({ session }) => {
    test.info().annotations.push({ type: 'case-id', description: 'TODO' });
    const ctx = await ApiClientFactory.get(Api.base, Roles.denied(), session);
    const response = await ctx.post(ROUTE_PATH);
    expect(response.status()).toBe(403);
  });

  test('effect · db HarvestPlanRepository.InsertPlan · happy path', async ({ session }) => {
    test.info().annotations.push({ type: 'case-id', description: 'TODO' });
    const ctx = await ApiClientFactory.get(Api.base, Roles.admin(), session);
    const response = await ctx.post(ROUTE_PATH);
    expect(response.status()).toBe(200);
    const readBack = await ctx.get(ROUTE_PATH);
    expect(readBack.status()).toBe(200);
  });
});
