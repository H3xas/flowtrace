import { test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

test.describe('till/v1/drawer in order', () => {
  test(caseRef(1, 'opens the drawer'), async () => {});

  test(caseRef(2, 'closes the till'), async () => {});

  test(caseRef(3, 'counts the float'), async () => {});
});
