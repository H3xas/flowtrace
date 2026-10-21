import { test } from '@playwright/test';
import { ShelfClient } from '../clients/shelf-client';
import { ShelfSteps } from '../helpers/shelf-steps';
import { tidyShelf } from '../helpers/tidy';

test('tidies a shelf through two helpers', async ({ request }) => {
  const steps = new ShelfSteps(new ShelfClient(request));
  await tidyShelf(steps, 'shelf-7');
});
