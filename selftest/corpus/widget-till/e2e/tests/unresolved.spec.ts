import { test } from '@playwright/test';

import { caseRef } from '../support/case-ref';

const ids = [9040, 9041];
const base = 90;
const flag = true;
const someId = 9042;

function caseIdOf(name: string): number {
  return name.length;
}

test.describe('till/v1/refunds unread', () => {
  test(caseRef(someId, 'reads an identifier'), async () => {});

  test(caseRef(ids[1], 'reads a subscript'), async () => {});

  test(caseRef(caseIdOf('drawer'), 'reads a call'), async () => {});

  test(caseRef(`${base}43`, 'reads a template'), async () => {});

  test(caseRef(flag ? 9044 : 9045, 'reads a conditional'), async () => {});

  test('reads them in a body', async () => {
    caseRef.id(someId);
    caseRef.id(ids[1]);
    caseRef.id(caseIdOf('drawer'));
    caseRef.id(`${base}43`);
    caseRef.id(flag ? 9044 : 9045);
    caseRef.id(
      caseIdOf('a long reference name that keeps going') +
        caseIdOf('a second long reference name that keeps going') +
        caseIdOf('a third long reference name that keeps going past the cut'),
    );
  });

  test(caseRef('TODO', 'keeps a placeholder'), async () => {
    caseRef.id('TODO');
  });

  test(caseRef('holds a title only'), async () => {});
});
