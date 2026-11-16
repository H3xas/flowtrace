import { test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

const ids: Record<string, number> = {
  'a|alpha': 9101,
  'a|beta': 9102,
  'a|gamma': 9103,
  'b|alpha': 9104,
  'b|beta': 9105,
  'b|gamma': 9106,
};

const ROWS = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }] as const;

for (const g of [false, true]) {
  for (const row of ROWS) {
    test(`polls ${row.name} in a body`, async () => {
      caseRef.id(ids[`${g ? 'b' : 'a'}|${row.name}`]);
    });

    test(caseRef(ids[`${g ? 'b' : 'a'}|${row.name}`], `polls ${row.name} in a title`), async () => {});
  }
}

[false, true].forEach((g) => {
  for (const row of ROWS) {
    test(`polls ${row.name} under forEach`, async () => {
      caseRef.id(ids[`${g ? 'b' : 'a'}|${row.name}`]);
    });
  }
});
