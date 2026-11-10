// The lease-store suite over `memoryLeaseStore()` on a frozen clock, and the proof it can fail: a
// store that reads the count, awaits, then grants (over-grants under a race), and one whose renew
// revives a lapsed slot (the defect `SQL_LEASE_RENEW`'s expiry fence closed in Postgres).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { LeaseStore } from '@ultimat3/jobs';
import { memoryLeaseStore } from '@ultimat3/jobs';
import type { LeaseStoreSubject } from './lease-store-conformance';
import { LEASE_STORE_CHECKS, leaseStoreConformance } from './lease-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const onFrozenClock = (
  wrap: (inner: LeaseStore) => LeaseStore = (inner) => inner,
): LeaseStoreSubject => {
  const clock = frozenClock('2026-11-09T00:00:00.000Z');
  return { store: wrap(memoryLeaseStore({ clock })), elapse: clock.advance };
};

describe(testName('unit', 'the memory lease store'), () => {
  behavesLike(leaseStoreConformance, () => onFrozenClock());
});

/** Count, await (a round trip), then grant whatever is free — the read WAS the cap check. */
const readThenGrant = (inner: LeaseStore): LeaseStore => ({
  ...inner,
  async acquire(key, limit, ttlMs, holder) {
    const held = await inner.held(key);
    await Promise.resolve();
    return held >= limit ? undefined : inner.acquire(key, Number.MAX_SAFE_INTEGER, ttlMs, holder);
  },
});

/** A renew that re-acquires the slot it lost: the TTL becomes an expiry only others observe. */
const reviving = (inner: LeaseStore): LeaseStore => ({
  ...inner,
  async renew(lease, ttlMs) {
    if (await inner.renew(lease, ttlMs)) return true;
    const again = await inner.acquire(lease.key, lease.slot + 1, ttlMs, lease.holder);
    return again?.slot === lease.slot;
  },
});

const check = (prefix: string) =>
  LEASE_STORE_CHECKS.find((each) => each.name.startsWith(prefix)) ??
  expect.unreachable(`no lease-store check named ${prefix}`);

describe(testName('unit', 'a store that breaks the lease contract fails conformance'), () => {
  test('read-await-grant passes alone and over-grants the race', async () => {
    await check('slots are granted').run(onFrozenClock(readThenGrant));
    await expect(check('12 concurrent').run(onFrozenClock(readThenGrant))).rejects.toThrow();
  });

  test('a renew that revives a lapsed slot', async () => {
    await check('renew lands').run(onFrozenClock(reviving));
    await expect(check('a lapsed slot').run(onFrozenClock(reviving))).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = LEASE_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
