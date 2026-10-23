import { APIRequestContext } from '@playwright/test';

const base = 'depot/v1/bins';

export class BinClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async open(id: string) {
    return this.ctx.post(`${base}/${id}/open`);
  }

  async close(id: string) {
    return this.ctx.post(`${base}/${id}/close`);
  }

  async label(id: string) {
    return this.ctx.put(`${base}/${id}/label`, { data: { text: 'spare fuses' } });
  }
}
