import { test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

const ids: Record<string, number> = {
  'a|alpha': 9101,
  'b|alpha': 9104,
};

const LIST = [9211, 9212];

const ROWS = [{ id: 9221 }, { id: 9222 }];

test('reads a literal key', async () => {
  caseRef.id(ids['a|alpha']);
});

for (const flag of [false, true]) {
  test(`reads a ternary key ${flag}`, async () => {
    caseRef.id(ids[flag ? 'a|alpha' : 'b|alpha']);
  });

  test(`reads a bounded local ${flag}`, async () => {
    const id = flag ? 9201 : 9202;
    caseRef.id(id);
  });
}

test('reads an array element', async () => {
  caseRef.id(LIST[1]);
});

for (const { id } of ROWS) {
  test(`reads a destructured row ${id}`, async () => {
    caseRef.id(id);
  });
}

for (const [mode, id] of [
  ['open', 9231],
  ['shut', 9232],
] as const) {
  test(caseRef(id, `reads a row by position ${mode}`), async () => {});
}
