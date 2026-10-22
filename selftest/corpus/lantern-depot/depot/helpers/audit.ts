import { APIRequestContext } from '@playwright/test';

export async function stampAudit(request: APIRequestContext, id: string) {
  return request.post(`depot/v1/audit/${id}`);
}
