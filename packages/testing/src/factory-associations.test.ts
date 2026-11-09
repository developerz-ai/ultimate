// `hasMany(child, fk, { count })` is screened where it is written: a count that is not a whole
// number ≥ 0 is a coded refusal at the declaration, never an `Array.from({ length: 2.5 })` throw —
// or a silent NaN loop — three awaits into the first `create()`.

import { describe, expect, test } from 'bun:test';
import { defineFactory } from './factories';
import { hasMany } from './factory-associations';
import { comments } from './factory-fixture';
import { testName } from './test-types';

const child = defineFactory(comments, {
  defaults: (n, ids) => ({ id: ids.uuid(), orgId: '', postId: '', body: `c-${n}` }),
});

describe(testName('unit', 'hasMany count'), () => {
  test('a whole number of 0 or more is kept, and absent is 0', () => {
    expect(hasMany(child, 'postId', { count: 3 }).count).toBe(3);
    expect(hasMany(child, 'postId').count).toBe(0);
  });

  test('a fraction, a negative, NaN or Infinity is refused by code', () => {
    for (const count of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => hasMany(child, 'postId', { count })).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^X_/) }),
      );
    }
  });
});
