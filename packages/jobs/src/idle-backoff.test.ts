// `restAfter` refuses a non-finite declared ceiling instead of letting `NaN` through `??`.

import { describe, expect, test } from 'bun:test';
import { restAfter } from './idle-backoff';

const pass = {
  found: false,
  dueInMs: null,
  backoffMs: 1_000,
  floorMs: 250,
  settled: true,
  announced: true,
} as const;

describe('restAfter', () => {
  test('a NaN declared ceiling is refused, not propagated into the delay', () => {
    expect(() => restAfter({ ...pass, declaredCeilingMs: Number.NaN })).toThrow(/idlePollMaxMs/);
  });

  test('a finite declared ceiling still bounds the rest', () => {
    expect(() => restAfter({ ...pass, declaredCeilingMs: 5_000 })).not.toThrow();
  });
});
