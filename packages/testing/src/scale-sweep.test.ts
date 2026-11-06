// The scale verdict, pure: a shape that grows with the rows is red, one that holds is flat, a loop
// under `expectedQueryLoop` is listed with its reason and never red. The pass that feeds it is
// proven end to end in `exercise.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { StatementTally } from './scale-sweep';
import { judgeScale } from './scale-sweep';

const tally = (fingerprint: string, count: number, expected?: string): StatementTally => ({
  fingerprint,
  count,
  unexpected: expected === undefined ? count : 0,
  ...(expected === undefined ? {} : { expected }),
});

describe('unit · judgeScale', () => {
  test('a shape sent once per row grows: red, both counts named', () => {
    expect(
      judgeScale(
        [tally('posts.list', 1), tally('users.findById', 2)],
        [tally('posts.list', 1), tally('users.findById', 8)],
      ),
    ).toEqual({
      verdict: 'grows',
      shapes: [{ fingerprint: 'users.findById', small: 2, large: 8 }],
      expected: [],
    });
  });

  test('a preload is flat: the same shapes at both sizes', () => {
    const calls = [tally('posts.list', 1), tally('users.findMany', 1)];
    expect(judgeScale(calls, calls)).toEqual({ verdict: 'flat', expected: [] });
  });

  test('a shape absent at the small size grew from zero', () => {
    const proof = judgeScale([], [tally('tags.findById', 3)]);
    expect(proof.verdict === 'grows' && proof.shapes).toEqual([
      { fingerprint: 'tags.findById', small: 0, large: 3 },
    ]);
  });

  test('a declared loop grows and stays flat, its reason reported', () => {
    expect(
      judgeScale([tally('a.findById', 2, 'per field')], [tally('a.findById', 8, 'per field')]),
    ).toEqual({
      verdict: 'flat',
      expected: [{ fingerprint: 'a.findById', small: 2, large: 8, reason: 'per field' }],
    });
  });

  test('fewer statements at the large size is no growth', () => {
    expect(judgeScale([tally('a', 3)], [tally('a', 1)]).verdict).toBe('flat');
  });
});
