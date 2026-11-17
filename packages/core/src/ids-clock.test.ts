// Owns one question: what `uuidV7` does when the CLOCK it reads is not an instant it can encode.
// An Invalid Date minted `00000000-0NaN-7…` and stored `NaN` as the high-water mark, so the next
// id skipped the monotonic clamp; a pre-1970 instant (which `frozenClock` accepts on purpose) was
// refused outright — it now mints at the field's floor, 0, and still sorts monotonically.

import { describe, expect, test } from 'bun:test';
import type { Clock } from './clock';
import { renderThrowable } from './error-render';
import { isUltimateError, type UltimateError } from './errors';
import { isUuid, resetIdCounter, uuidV7 } from './ids';

const at = (epochMs: number): Clock => ({ now: () => new Date(epochMs), monotonic: () => 0 });

const caught = (fn: () => unknown): UltimateError => {
  try {
    fn();
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
    return expect.unreachable(`expected an UltimateError, got ${renderThrowable(thrown)}`);
  }
  return expect.unreachable('expected a refusal, nothing was thrown');
};

describe('uuidV7 clock screen', () => {
  for (const [label, epochMs] of [
    ['an Invalid Date', Number.NaN],
    ['an instant past 48 bits', 2 ** 48],
  ] as const) {
    test(`refuses ${label} rather than minting a non-UUID`, () => {
      resetIdCounter();
      const error = caught(() => uuidV7(at(epochMs)));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('uuidV7');
    });
  }

  test('a refused instant does not poison the monotonic clamp for the next id', () => {
    resetIdCounter();
    const first = uuidV7(at(10_000));
    caught(() => uuidV7(at(Number.NaN)));
    const next = uuidV7(at(5_000));
    expect(isUuid(next)).toBe(true);
    expect(next > first).toBe(true);
  });

  test('a pre-1970 clock mints at timestamp 0 rather than refusing', () => {
    resetIdCounter();
    const moonLanding = Date.parse('1969-07-20T20:17:00Z');
    const id = uuidV7(at(moonLanding));
    expect(isUuid(id)).toBe(true);
    expect(id.startsWith('00000000-0000-7')).toBe(true);
    expect(uuidV7(at(-5)) > id).toBe(true);
  });

  test('the edges that ARE encodable still mint — the non-vacuity half', () => {
    resetIdCounter();
    expect(isUuid(uuidV7(at(0)))).toBe(true);
    resetIdCounter();
    expect(isUuid(uuidV7(at(2 ** 48 - 1)))).toBe(true);
  });
});
