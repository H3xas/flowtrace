import { APIRequestContext } from '@playwright/test';

const base = 'depot/v1/shelves';

export class ShelfClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async rename(id: string) {
    return this.ctx.put(`${base}/${id}`, { data: { label: 'north wall' } });
  }

  async remove(id: string) {
    return this.ctx.delete(`${base}/${id}`);
  }

  async count() {
    return this.ctx.get(`${base}/count`);
  }
}
