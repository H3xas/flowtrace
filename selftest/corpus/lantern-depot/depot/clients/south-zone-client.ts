import { APIRequestContext } from '@playwright/test';

const area = 'depot/v1/zones/south';

export class SouthZoneClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async lamps() {
    return this.ctx.get(`${area}/lamps`);
  }
}
