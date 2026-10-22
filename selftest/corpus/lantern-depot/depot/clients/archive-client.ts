import { APIRequestContext } from '@playwright/test';

const ledgerRoot = 'depot/v9/archive';

export class ArchiveClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async pages() {
    return this.ctx.get(`${ledgerRoot}/pages`);
  }
}
