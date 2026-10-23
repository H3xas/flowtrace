import { APIRequestContext, expect } from '@playwright/test';
import { BinClient } from '../clients/bin-client';

export async function sweepBins(bins: BinClient, id: string) {
  await bins.open(id);
  expect((await bins.label(id)).ok()).toBeTruthy();
  await Promise.all([id].map((each) => bins.close(each)));
}

export class PropertySweeper {
  constructor(private readonly bins: BinClient) {}

  async sweep(id: string) {
    await this.bins.open(id);
    expect((await this.bins.label(id)).ok()).toBeTruthy();
    await Promise.all([id].map((each) => this.bins.close(each)));
  }
}

export class DeclaredSweeper {
  private readonly bins: BinClient;

  constructor(bins: BinClient) {
    this.bins = bins;
  }

  async sweep(id: string) {
    await this.bins.open(id);
    expect((await this.bins.label(id)).ok()).toBeTruthy();
    await Promise.all([id].map((each) => this.bins.close(each)));
  }
}

export class CreatedSweeper {
  private readonly bins;

  constructor(request: APIRequestContext) {
    this.bins = new BinClient(request);
  }

  async sweep(id: string) {
    await this.bins.open(id);
    expect((await this.bins.label(id)).ok()).toBeTruthy();
    await Promise.all([id].map((each) => this.bins.close(each)));
  }
}
