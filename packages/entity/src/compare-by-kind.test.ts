// `memory-match.ts` is the ONE statement of how a column compares, and `@ultimat3/query`'s matcher
// calls it too. What a stored row answers in every driver is `@ultimat3/testing`'s
// `entityDriverConformance`; left here, the pairs no stored row can hold.

import { describe, expect, test } from 'bun:test';
import { compareByKind, sameValueOfKind } from './memory-match';
import type { ColumnKind } from './types';

const idAt = (hex: string): string => `00000000-0000-7000-8000-0000000000${hex}`;

describe('the rule itself, on the pairs no stored row can hold', () => {
  test.each<[ColumnKind | undefined, unknown, unknown, number]>([
    // One driver's `int8` beside a literal, with no declared kind at all.
    [undefined, 2, 10n, -1],
    [undefined, 10n, 2, 1],
    [undefined, 2, 2n, 0],
    [undefined, 9007199254740993n, 9007199254740992, 1],
    [undefined, 1.5, 2n, -1],
    // The form a cursor revives, against the row's own text.
    ['bigint', 9n, '10', -1],
    ['bigint', 1e21, '999999999999999999999', 1],
    ['numeric', '-0.00', '0', 0],
    ['uuid', idAt('0A'), idAt('0a'), 0],
    ['uuid', idAt('0B'), idAt('0a'), 1],
    // Digits in a TEXT column are characters, and so are digits with no kind.
    ['text', '10', '9', -1],
    [undefined, '10', '9', -1],
    ['text', '\u{1F600}', '\uFF01', 1],
    [undefined, 'ab', 'a\u{1F600}', -1],
  ])('%p: %p against %p orders %p, and equality agrees', (kind, left, right, order) => {
    expect(compareByKind(kind, left, right)).toBe(order);
    expect(compareByKind(kind, right, left)).toBe(-order || 0);
    expect(sameValueOfKind(kind, left, right)).toBe(order === 0);
  });

  test('NaN equals nothing, itself included', () => {
    expect(sameValueOfKind('integer', Number.NaN, Number.NaN)).toBe(false);
  });
});
