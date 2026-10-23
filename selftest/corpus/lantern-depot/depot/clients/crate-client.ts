import { APIRequestContext } from '@playwright/test';

const base = 'depot/v2/crates';

export class CrateClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async close(id: string) {
    return this.ctx.post(`${base}/${id}/close`);
  }

  async delete(id: string) {
    return this.ctx.delete(`${base}/${id}`);
  }
}
