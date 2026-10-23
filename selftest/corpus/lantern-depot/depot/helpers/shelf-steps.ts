import { ShelfClient } from '../clients/shelf-client';

export class ShelfSteps {
  constructor(private readonly shelves: ShelfClient) {}

  async renameThenRemove(id: string) {
    await this.shelves.rename(id);
    await this.shelves.remove(id);
  }
}
