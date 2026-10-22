import type { Page } from '@playwright/test';

export class CounterPage {
  constructor(private readonly page: Page) {}

  async prepare() {
    await this.page.goto('/counter');
  }
}
