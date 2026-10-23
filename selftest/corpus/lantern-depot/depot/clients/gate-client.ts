import { APIRequestContext } from '@playwright/test';

export class GateClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async doors() {
    return this.ctx.get(`${area}/doors`);
  }

  async bays() {
    return this.ctx.get(`${dockRoot}/bays`);
  }
}
