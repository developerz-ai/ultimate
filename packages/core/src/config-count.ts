// Single responsibility: the numeric domain a config count or window must sit in. Takes the key as
// a string and the value as `unknown`, because `validate` is the boundary an untyped JS config
// crosses — a `'60s'` arrives here however the interface types the field.

import { describeValue } from './error-render';

/**
 * Why `value` is not a whole number ≥ `min`, or `undefined` when it is one. `NaN`, `Infinity` and
 * `2.5` each passed `concurrency < 1` — every comparison with `NaN` is false — and a fraction or an
 * infinity then reaches `Array.from({ length })`, a `setTimeout` or a loop bound.
 */
export function countIssue(key: string, value: unknown, min: 0 | 1): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min) return undefined;
  // A number is printed as itself — `describeValue` answers "a number" for 2.5 and -3 alike.
  const shown = typeof value === 'number' ? numberText(value) : describeValue(value);
  return `${key} must be a whole number ${min === 1 ? 'of at least 1' : 'of 0 or more'}, not ${shown}`;
}

const numberText = (value: number): string => `${value}`;
