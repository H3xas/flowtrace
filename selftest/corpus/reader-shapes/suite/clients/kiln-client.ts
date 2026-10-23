import { APIRequestContext } from '@playwright/test';

const kilnBase = 'studio/v1/kilns';
const glazeRoot = `studio/v1/glazes`;

export class KilnClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async list() {
    return this.ctx.get(`${kilnBase}/all`);
  }

  async fire(id: string) {
    return this.ctx.post(`${kilnBase}/${id}/fire`);
  }

  async glazes() {
    return this.ctx.get(glazeRoot + '/list');
  }
}
