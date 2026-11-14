import { test } from '@playwright/test';

import { caseRef } from '../support/case-ref';
import { sharedIds, sharedRows } from '../support/shared';

const ids: Record<string, number> = {
  'a|alpha': 9101,
  'a|beta': 9102,
};

let mutableId = 9231;
var oldId = 9232;

function idOf(name: string): number {
  return name.length;
}

const A = [1, 2, 3, 4, 5];
const B = [1, 2, 3, 4, 5];
const C = [1, 2, 3];
const D = [1, 2, 3, 4, 5, 6, 7, 8];

test('reads an absent key', async () => {
  caseRef.id(ids['z|none']);
});

test('reads a parameter', async () => {
  const check = (n: number) => caseRef.id(n);
  check(9233);
});

test('reads a call result', async () => {
  caseRef.id(idOf('drawer'));
});

test('reads the environment', async () => {
  caseRef.id(process.env.CASE_ID);
});

test('reads a let binding', async () => {
  caseRef.id(mutableId);
});

test('reads a var binding', async () => {
  caseRef.id(oldId);
});

test('reads an imported map', async () => {
  caseRef.id(sharedIds['a|alpha']);
});

for (const row of sharedRows) {
  test('reads an imported loop array', async () => {
    caseRef.id(row.id);
  });
}

for (const a of A) {
  for (const b of B) {
    for (const c of C) {
      test('reads past the instance limit', async () => {
        caseRef.id([a, b, c]);
      });
    }
  }
}

for (const a of D) {
  for (const b of D) {
    test('reads up to the instance limit', async () => {
      caseRef.id([a, b]);
    });
  }
}

for (const row of [{ name: 'alpha' }, { name: 'delta' }]) {
  test('reads one absent key among present ones', async () => {
    caseRef.id(ids[`a|${row.name}`]);
  });
}
