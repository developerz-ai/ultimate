// One normalisation for the claim lease, or two stores disagreeing about what a lease of `0`
// means. A lease that is not a positive finite whole number of milliseconds is refused where it
// is written — the shape `concurrency: 0` and `stepTimeout: 0` are already refused in.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './driver-pg';
import { createMemoryOutboxStore } from './outbox';
import { DEFAULT_OUTBOX_CLAIM_LEASE_MS, resolveClaimLeaseMs } from './outbox-lease';
import { createPgOutboxStore } from './outbox-pg';

const executor: PgExecutor = {
  query<R>(): Promise<readonly R[]> {
    return Promise.resolve([] as readonly R[]);
  },
};

describe('resolveClaimLeaseMs', () => {
  test('an omitted lease is the default, and a positive whole one passes through', () => {
    expect(resolveClaimLeaseMs(undefined)).toBe(DEFAULT_OUTBOX_CLAIM_LEASE_MS);
    expect(resolveClaimLeaseMs(5_000)).toBe(5_000);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['infinite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('a %s lease is refused with an executable fix', (_label, value) => {
    // `0` claims and instantly un-claims every row — two relays back to reading, not claiming.
    // `Infinity` is the mirror image: the first relay to touch a row owns it forever.
    expect(() => resolveClaimLeaseMs(value)).toThrow(/claimLeaseMs/);
    try {
      resolveClaimLeaseMs(value);
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_INVARIANT');
      expect((error as { fix?: string }).fix).toContain('claimLeaseMs: 30_000');
    }
  });
});

describe('both stores consume the one normalisation', () => {
  test('the memory store refuses a bad lease at construction', () => {
    expect(() => createMemoryOutboxStore({ claimLeaseMs: 0 })).toThrow(/claimLeaseMs/);
  });

  test('the pg store refuses a bad lease at construction, not at the first claim', () => {
    // At the first claim it would be a relay tick failing in a log line nobody reads.
    expect(() =>
      createPgOutboxStore({
        executor,
        txExecutor: () => executor,
        claimLeaseMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/claimLeaseMs/);
  });
});
