// The `LeaseStore` contract of `@ultimat3/jobs` as shared examples: `behavesLike(
// leaseStoreConformance, () => ({ store, elapse }))`. Fleet-wide `job.concurrency` is only as true
// as this: never over-grant under a race, never revive a lapsed slot, never free another's. Time
// passes through `elapse` (a frozen clock advances, a database ages its rows), never the wall clock.

import { expect, test } from 'bun:test';
import type { HeldLease, LeaseStore } from '@ultimat3/jobs';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

/** The store under test, and how to let `ms` pass on the clock its expiry reads. */
export interface LeaseStoreSubject {
  readonly store: LeaseStore;
  /** Let `ms` pass for every slot: `clock.advance`, or `expires_at` moved back by `ms`. */
  readonly elapse: (ms: number) => void | Promise<void>;
}

export interface LeaseStoreCheck {
  readonly name: string;
  run(subject: LeaseStoreSubject): Promise<void>;
}

/** Outlives every round trip a check makes before its `elapse`, however loaded the runner. */
const SHORT_TTL_MS = 5_000;
const PAST_SHORT_TTL_MS = 10_000;
const LONG_TTL_MS = 60_000;
/** Concurrent acquirers, and the cap only some of them fit under. */
const RACERS = 12;
const RACE_LIMIT = 3;

let minted = 0;
/** A key of this check's own, so checks sharing one store never count each other's slots. */
const keyOf = (): string => {
  minted += 1;
  return `job:conformance-${process.pid.toString(36)}-${minted.toString(36)}`;
};

const elapse = async (subject: LeaseStoreSubject, ms: number): Promise<void> => {
  await subject.elapse(ms);
};

const granted = (lease: HeldLease | undefined, what: string): HeldLease =>
  lease ?? expect.unreachable(`${what}: the store refused a slot that was free`);

export const LEASE_STORE_CHECKS: readonly LeaseStoreCheck[] = [
  {
    name: 'slots are granted up to the limit, one each, and no further',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const a = granted(await store.acquire(key, 2, LONG_TTL_MS, 'a'), 'first');
      const b = granted(await store.acquire(key, 2, LONG_TTL_MS, 'b'), 'second');
      expect(a.slot).not.toBe(b.slot);
      expect([a.key, a.holder, b.holder]).toEqual([key, 'a', 'b']);
      expect(await store.acquire(key, 2, LONG_TTL_MS, 'c')).toBeUndefined();
      expect(await store.held(key)).toBe(2);
      expect(await store.acquire(key, 0, LONG_TTL_MS, 'd')).toBeUndefined();
    },
  },
  {
    name: `${RACERS} concurrent acquires never grant more than the limit`,
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const leases = await Promise.all(
        Array.from({ length: RACERS }, (_, n) =>
          store.acquire(key, RACE_LIMIT, LONG_TTL_MS, `r${n}`),
        ),
      );
      const slots = leases.flatMap((lease) => (lease === undefined ? [] : [lease.slot]));
      // A refusal under contention is allowed (one poll interval); an over-grant never is.
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.length).toBeLessThanOrEqual(RACE_LIMIT);
      expect(new Set(slots).size).toBe(slots.length);
      expect(await store.held(key)).toBe(slots.length);
    },
  },
  {
    name: 'keys are independent: a full key leaves another free',
    async run(subject) {
      const { store } = subject;
      const [full, other] = [keyOf(), keyOf()];
      granted(await store.acquire(full, 1, LONG_TTL_MS, 'a'), 'full');
      granted(await store.acquire(other, 1, LONG_TTL_MS, 'b'), 'other');
      expect([await store.held(full), await store.held(other)]).toEqual([1, 1]);
    },
  },
  {
    name: 'renew lands for the holder inside the TTL and never for another holder',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const lease = granted(await store.acquire(key, 1, SHORT_TTL_MS, 'a'), 'renewed');
      expect(await store.renew({ ...lease, holder: 'b' }, LONG_TTL_MS)).toBe(false);
      expect(await store.renew(lease, LONG_TTL_MS)).toBe(true);
      // Renewed past the short TTL it started with: still held once that has run out.
      await elapse(subject, PAST_SHORT_TTL_MS);
      expect(await store.held(key)).toBe(1);
      expect(await store.acquire(key, 1, LONG_TTL_MS, 'b')).toBeUndefined();
    },
  },
  {
    // `worker-fleet-slots.ts` reads `false` as `X_JOB_SLOT_LOST`: a store that revives the slot
    // keeps a run alive past a TTL every other worker has already seen expire.
    name: 'a lapsed slot is lost, not renewed — even with nobody else holding it',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const lease = granted(await store.acquire(key, 1, SHORT_TTL_MS, 'a'), 'lapsing');
      await elapse(subject, PAST_SHORT_TTL_MS);
      expect(await store.held(key)).toBe(0);
      expect(await store.renew(lease, LONG_TTL_MS)).toBe(false);
      expect(await store.held(key)).toBe(0);
    },
  },
  {
    name: 'an expired slot is granted again, and its old holder cannot renew it back',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const dead = granted(await store.acquire(key, 1, SHORT_TTL_MS, 'dead'), 'dead');
      expect(await store.acquire(key, 1, LONG_TTL_MS, 'live')).toBeUndefined();
      await elapse(subject, PAST_SHORT_TTL_MS);
      granted(await store.acquire(key, 1, LONG_TTL_MS, 'live'), 'reclaimed');
      expect(await store.renew(dead, LONG_TTL_MS)).toBe(false);
      expect(await store.holders(key)).toEqual(['live']);
    },
  },
  {
    name: 'release by a non-holder is a no-op; release by the holder frees the slot',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const lease = granted(await store.acquire(key, 1, LONG_TTL_MS, 'a'), 'released');
      await store.release({ ...lease, holder: 'b' });
      expect(await store.held(key)).toBe(1);
      await store.release(lease);
      expect(await store.held(key)).toBe(0);
      granted(await store.acquire(key, 1, LONG_TTL_MS, 'b'), 'after release');
    },
  },
  {
    // `withLock`'s token: a write fenced on it refuses a smaller one, so a later holder must
    // never show an earlier holder's number — not after a release, not after a takeover.
    name: 'every grant carries a fence greater than every earlier one, takeovers included',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      const fences: number[] = [];
      const fenceOf = (lease: HeldLease | undefined, what: string): number => {
        const { fence } = granted(lease, what);
        if (typeof fence !== 'number' || !Number.isSafeInteger(fence)) {
          return expect.unreachable(`${what}: the grant carries no whole-number fence`);
        }
        fences.push(fence);
        return fence;
      };
      fenceOf(await store.acquire(key, 2, LONG_TTL_MS, 'a'), 'slot 0');
      const second = granted(await store.acquire(key, 2, SHORT_TTL_MS, 'b'), 'slot 1');
      fenceOf(second, 'slot 1');
      // The same slot, released and granted again.
      await store.release(second);
      fenceOf(await store.acquire(key, 2, SHORT_TTL_MS, 'c'), 'slot 1 again');
      // The same slot, lapsed and TAKEN OVER without a release.
      await elapse(subject, PAST_SHORT_TTL_MS);
      fenceOf(await store.acquire(key, 2, LONG_TTL_MS, 'd'), 'slot 1 taken over');
      for (const [index, fence] of fences.entries()) {
        if (index > 0) expect(fence).toBeGreaterThan(fences[index - 1] ?? Number.NaN);
      }
    },
  },
  {
    name: 'holders names the live slots of one key in slot order, and nothing expired',
    async run(subject) {
      const { store } = subject;
      const key = keyOf();
      expect(await store.holders(key)).toEqual([]);
      granted(await store.acquire(key, 3, LONG_TTL_MS, 'first'), 'slot 0');
      granted(await store.acquire(key, 3, SHORT_TTL_MS, 'second'), 'slot 1');
      granted(await store.acquire(key, 3, LONG_TTL_MS, 'third'), 'slot 2');
      expect(await store.holders(key)).toEqual(['first', 'second', 'third']);
      await elapse(subject, PAST_SHORT_TTL_MS);
      expect(await store.holders(key)).toEqual(['first', 'third']);
    },
  },
];

export const leaseStoreConformance: SharedExamples<LeaseStoreSubject | Promise<LeaseStoreSubject>> =
  sharedExamples('a lease store', (subject) => {
    for (const check of LEASE_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
