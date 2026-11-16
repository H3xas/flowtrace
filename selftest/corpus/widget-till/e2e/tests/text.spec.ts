import { test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

const rows = [{ id: 9031 }];

test.describe('till/v1/drawer by text', () => {
  const caseId = 9030;

  test(caseRef(caseId, '4012 opens the drawer'), async () => {});

  test(caseRef(rows[0].id, 'opens the drawer again'), async () => {});
});
