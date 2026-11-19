// The shared-port seam: when a process is a supervised child, what it asks Bun.serve for, and how a
// container-wide count is split between children.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { childShare, sharedPortOption, supervisedChild } from './shared-port';

const child = (value: string | undefined) => ({ ULTIMATE_CHILD: value });

function refusal(run: () => unknown): { code: string; cause: string; fix: string } {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
    return expect.unreachable('threw something that is not an UltimateError');
  }
  return expect.unreachable('did not refuse');
}

describe('supervisedChild', () => {
  test('unset or empty is not a child', () => {
    expect(supervisedChild({})).toBeUndefined();
    expect(supervisedChild(child(undefined))).toBeUndefined();
    expect(supervisedChild(child(''))).toBeUndefined();
  });

  test('i/N is a zero-based index of a count', () => {
    expect(supervisedChild(child('0/2'))).toEqual({ index: 0, count: 2 });
    expect(supervisedChild(child('3/4'))).toEqual({ index: 3, count: 4 });
    expect(supervisedChild(child('0/1'))).toEqual({ index: 0, count: 1 });
  });

  test.each([
    'x',
    '1',
    '/2',
    '1/',
    '2/2',
    '5/2',
    '0/0',
    '-1/2',
    '1.5/2',
    '01/2',
    '0/02',
    ' 0/2',
    '0/2 ',
    '0/2/3',
    '0x1/2',
    '0/99999999999999999999',
  ])('a malformed %p is a coded refusal, never a silent single process', (value) => {
    const refused = refusal(() => supervisedChild(child(value)));
    expect(refused.code).toBe('X_INVARIANT');
    expect(refused.cause).toContain('ULTIMATE_CHILD');
    expect(refused.fix).toContain('unset ULTIMATE_CHILD');
  });
});

describe('sharedPortOption', () => {
  test('a supervised child on Linux shares the port', () => {
    expect(sharedPortOption(child('1/2'), 'linux')).toEqual({ reusePort: true });
  });

  test('off Linux the key is ABSENT, not false: Bun would ignore it and balance nothing', () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const option = sharedPortOption(child('1/2'), platform);
      expect(option).toEqual({});
      expect(Object.keys(option)).toEqual([]);
    }
  });

  test('an unsupervised process never shares, on any platform', () => {
    expect(Object.keys(sharedPortOption({}, 'linux'))).toEqual([]);
    expect(Object.keys(sharedPortOption(child(''), 'linux'))).toEqual([]);
  });

  test('the platform defaults to this process', () => {
    const expected: { readonly reusePort?: true } =
      process.platform === 'linux' ? { reusePort: true } : {};
    expect(sharedPortOption(child('0/2'))).toEqual(expected);
  });

  test('a malformed ULTIMATE_CHILD refuses here too', () => {
    expect(refusal(() => sharedPortOption(child('9/2'), 'linux')).code).toBe('X_INVARIANT');
  });
});

describe('childShare', () => {
  const shares = (total: number, count: number): number[] =>
    Array.from({ length: count }, (_, index) => childShare(total, index, count));
  const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

  test('an even split', () => {
    expect(shares(20, 2)).toEqual([10, 10]);
    expect(shares(8, 4)).toEqual([2, 2, 2, 2]);
  });

  test('the remainder goes to the lowest indices', () => {
    expect(shares(10, 3)).toEqual([4, 3, 3]);
    expect(shares(11, 4)).toEqual([3, 3, 3, 2]);
  });

  test('every child gets at least one, so a total under the count sums to the count', () => {
    expect(shares(2, 4)).toEqual([1, 1, 1, 1]);
    expect(shares(0, 3)).toEqual([1, 1, 1]);
  });

  test('the shares sum to max(total, count) across a sweep', () => {
    for (let count = 1; count <= 9; count += 1) {
      for (let total = 0; total <= 40; total += 1) {
        const split = shares(total, count);
        expect(sum(split)).toBe(Math.max(total, count));
        expect(Math.min(...split)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('one child takes the whole total', () => {
    expect(childShare(20, 0, 1)).toBe(20);
  });

  test.each([
    [10, 2, 2],
    [10, -1, 2],
    [10, 0, 0],
    [10, 0.5, 2],
    [-1, 0, 2],
    [1.5, 0, 2],
    [Number.NaN, 0, 2],
    [Number.POSITIVE_INFINITY, 0, 2],
  ])('childShare(%p, %p, %p) is a coded refusal', (total, index, count) => {
    expect(refusal(() => childShare(total, index, count)).code).toBe('X_INVARIANT');
  });
});
