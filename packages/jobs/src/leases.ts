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
  /**
   * The `holder` of every live slot under `key`, in slot order. Read after a REFUSED acquire and
   * never before one: it tells a key another run holds from a key this run's own previous claim
   * still holds — a slot is released a moment after its job is nacked and expires a moment after
   * its job's lease, so a retried, resumed or redelivered run can meet itself. Under
   * `whenBusy: 'fail'` that difference is a run failed by its own leftovers. Required: a store
   * that cannot answer cannot hold a keyed cap, and the type says so before a deploy does.
   */
  holders(key: string): Promise<readonly string[]>;
}

export interface MemoryLeaseStoreOptions {
  readonly clock?: Clock;
}

/** The memory store, plus the one seam a test reads to see what it still retains. */
export interface MemoryLeaseStore extends LeaseStore {
  /** Keys with at least one live slot. A key nothing holds is not retained — see `live`. */
  tracked(): number;
}

/**
 * The `x dev` / test implementation. One heap, so it is not a fleet gate — it exists so the
 * memory driver enforces `concurrency` with the same code path the pg driver does, and so the
 * "a second worker is refused" test is a real test rather than a pg-only one.
 */
export function memoryLeaseStore(options: MemoryLeaseStoreOptions = {}): MemoryLeaseStore {
  const clock = options.clock ?? systemClock;
  type Slots = Map<number, { holder: string; expiresAt: number }>;
  const slots = new Map<string, Slots>();

  /**
   * The live slots of `key`, expired ones dropped — and the KEY dropped with its last slot. A
   * keyed cap makes the key app data (one per account, per connection), so a map that kept an
   * empty entry for every key it was ever asked about grew for the life of the process.
   */
  const live = (key: string): Slots => {
    const at = nowMs(clock);
    const held: Slots = slots.get(key) ?? new Map();
    for (const [slot, entry] of held) if (entry.expiresAt <= at) held.delete(slot);
    if (held.size === 0) slots.delete(key);
    return held;
  };

  return {
    acquire(key, limit, ttlMs, holder) {
      const held = live(key);
      for (let slot = 0; slot < limit; slot += 1) {
        if (held.has(slot)) continue;
        held.set(slot, { holder, expiresAt: nowMs(clock) + ttlMs });
        slots.set(key, held);
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
      if (held !== undefined && entry !== undefined && entry.holder === lease.holder) {
        held.delete(lease.slot);
        if (held.size === 0) slots.delete(lease.key);
      }
      return Promise.resolve();
    },
    held(key) {
      return Promise.resolve(live(key).size);
    },
    holders(key) {
      const held = [...live(key)].sort(([a], [b]) => a - b);
      return Promise.resolve(held.map(([, entry]) => entry.holder));
    },
    tracked() {
      for (const key of [...slots.keys()]) live(key);
      return slots.size;
    },
  };
}

/**
 * The lease key for a job's fleet-wide cap. One shape, so pg and memory agree on it.
 *
 * A KEYED cap takes its own prefix and an encoded name. `job:<name>:<key>` would be the plain key
 * of a job named `<name>:<key>`, and job `a` keyed `b:c` would share a slot table with job `a:b`
 * keyed `c` — two unrelated jobs blocking each other with nothing naming why. The plain shape is
 * unchanged: rows a running fleet holds must keep counting through a rolling deploy.
 */
export function jobLeaseKey(jobName: string, key?: string): string {
  return key === undefined ? `job:${jobName}` : `job-key:${encodeURIComponent(jobName)}:${key}`;
}
