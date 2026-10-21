import { APIRequestContext } from '@playwright/test';
import { ledgerRoot } from './ledger-paths';

export class LedgerClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async entries() {
    return this.ctx.get(`${ledgerRoot}/entries`);
  }
}
