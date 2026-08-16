// Fleet-wide slot counting: the seam that makes `job.concurrency` true. `limits.ts` counts slots
// in ONE process's heap, so `perTenant: 2` on twenty pods is forty concurrent runs — the number a
// downstream API rate-limits you for. A lease is a row somewhere every replica can see, held for
// a TTL and renewed by the same heartbeat that renews the visibility lease, so a killed worker
// gives its slot back by expiry rather than by cleanup nobody runs.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { nowMs } from './clock';

/** A granted slot. `slot` plus `holder` is what renew and release are addressed by. */
export interface HeldLease {
  readonly key: string;
  readonly slot: number;
  readonly holder: string;
}

export interface LeaseStore {
  /**
   * Take a slot under `limit` for `key`, or answer `undefined`. Never over-grants; under
   * contention it may refuse a slot that is genuinely free, which costs one poll interval.
   */
  acquire(
    key: string,
    limit: number,
    ttlMs: number,
    holder: string,
  ): Promise<HeldLease | undefined>;
  /** Push the expiry out. `false` means the slot is no longer this holder's. */
  renew(lease: HeldLease, ttlMs: number): Promise<boolean>;
  release(lease: HeldLease): Promise<void>;
  /** Live slots for `key`. Diagnostics only — never the acquire decision, which must be atomic. */
  held(key: string): Promise<number>;
}

export interface MemoryLeaseStoreOptions {
  readonly clock?: Clock;
}

/**
 * The `x dev` / test implementation. One heap, so it is not a fleet gate — it exists so the
 * memory driver enforces `concurrency` with the same code path the pg driver does, and so the
 * "a second worker is refused" test is a real test rather than a pg-only one.
 */
export function createMemoryLeaseStore(options: MemoryLeaseStoreOptions = {}): LeaseStore {
  const clock = options.clock ?? systemClock;
  const slots = new Map<string, Map<number, { holder: string; expiresAt: number }>>();

  const live = (key: string): Map<number, { holder: string; expiresAt: number }> => {
    const at = nowMs(clock);
    const held = slots.get(key) ?? new Map();
    for (const [slot, entry] of held) if (entry.expiresAt <= at) held.delete(slot);
    slots.set(key, held);
    return held;
  };

  return {
    acquire(key, limit, ttlMs, holder) {
      const held = live(key);
      for (let slot = 0; slot < limit; slot += 1) {
        if (held.has(slot)) continue;
        held.set(slot, { holder, expiresAt: nowMs(clock) + ttlMs });
        return Promise.resolve({ key, slot, holder });
      }
      return Promise.resolve(undefined);
    },
    renew(lease, ttlMs) {
      const entry = live(lease.key).get(lease.slot);
      if (entry === undefined || entry.holder !== lease.holder) return Promise.resolve(false);
      entry.expiresAt = nowMs(clock) + ttlMs;
      return Promise.resolve(true);
    },
    release(lease) {
      const held = slots.get(lease.key);
      const entry = held?.get(lease.slot);
      // Only the holder gives it back: releasing a slot the TTL already handed to someone else
      // would let two runs share it, which is the whole failure this store exists to prevent.
      if (entry !== undefined && entry.holder === lease.holder) held?.delete(lease.slot);
      return Promise.resolve();
    },
    held(key) {
      return Promise.resolve(live(key).size);
    },
  };
}

/** The lease key for a job's own fleet-wide cap. One shape, so pg and memory agree on it. */
export function jobLeaseKey(jobName: string): string {
  return `job:${jobName}`;
}
