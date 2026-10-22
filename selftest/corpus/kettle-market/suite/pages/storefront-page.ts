import type { Page } from '@playwright/test';
import { mockShell } from '../helpers/mocks';
import { layerOne, primeBanner } from '../helpers/network';

export class StorefrontPage {
  constructor(private readonly page: Page) {}

  async open() {
    await primeBanner(this.page);
    await this.page.goto('/');
  }

  async openMocked() {
    await mockShell(this.page);
    await this.page.goto('/');
  }

  async openDeep() {
    await layerOne(this.page);
  }
}
