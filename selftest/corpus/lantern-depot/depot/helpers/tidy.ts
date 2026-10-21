import { ShelfSteps } from './shelf-steps';

export const tidyShelf = async (steps: ShelfSteps, id: string) => {
  await steps.renameThenRemove(id);
};
