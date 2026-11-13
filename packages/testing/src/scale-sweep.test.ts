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

  test('a shape absent at the small size is another path, unproven — never red on its own', () => {
    const proof = judgeScale([tally('a.findById', 1)], [tally('a.findById', 1), tally('b', 3)]);
    expect(proof.verdict).toBe('unproven');
    expect(proof.verdict === 'unproven' ? proof.reason : '').toContain('b 0 → 3');
  });

  test('beside a shape that grew from one, the loop is red and the new path is not named', () => {
    const proof = judgeScale(
      [tally('users.findById', 2)],
      [tally('users.findById', 8), tally('tags.findMany', 1)],
    );
    expect(proof).toEqual({
      verdict: 'grows',
      shapes: [{ fingerprint: 'users.findById', small: 2, large: 8 }],
      expected: [],
    });
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
