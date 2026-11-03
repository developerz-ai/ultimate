// Single responsibility: how many units of work may be out on the pool at once, and how long the
// next one waits. `Bun.SQL` queues past `max` with no bound and publishes no occupancy, so this counts
// in front of it: a statement and a pin each hold one slot, and a full pool refuses on one deadline.

import type { Scheduler } from '@ultimat3/core';
import { type DbError, poolAcquireTimeout } from './errors';
import type { PoolDemand } from './pool-gauge';
import { unrefSchedule } from './pool-timer';

export interface PoolGate {
  /**
   * Take a slot. `undefined` when one was free, so the path that never waits pays no promise and
   * sends in the caller's own turn. Otherwise resolves `true` when the slot arrives, `false` when
   * this pool retired first, and rejects past `acquireTimeoutMs` (`X_DB_POOL_EXHAUSTED`). `0` waits
   * forever.
   */
  enter(acquireTimeoutMs: number): Promise<boolean> | undefined;
  /** Give a slot back. The oldest waiter inherits it, so a newcomer never overtakes the queue. */
  leave(): void;
  /** This pool is gone but the database may not be: everyone queued asks the next pool. */
  handOverWaiting(): void;
  /** Reject everyone still queued. Slots already held are untouched. */
  refuseWaiting(reason: DbError): void;
}

/** What `takeSlot` needs of a pool: the gate that admits to it and the counter that reports it. */
export interface GatedPool {
  readonly gate: PoolGate;
  readonly demand: PoolDemand;
}

/**
 * A slot on the current pool, counted from the ask: a statement queued behind a full pool is exactly
 * what `db_pool_waiting` reports. Answers the pool itself when a slot was free, so a caller checking
 * `instanceof Promise` sends in its own turn. A retirement during the wait re-asks the pool that
 * replaced it, with a fresh deadline: the work was never sent, so it can only be late, never doubled.
 */
export function takeSlot<P extends GatedPool>(
  connect: () => P,
  acquireTimeoutMs: number,
): P | Promise<P> {
  const asked = connect();
  asked.demand.enter();
  const wait = asked.gate.enter(acquireTimeoutMs);
  if (wait === undefined) return asked;
  return (async () => {
    let admitted: boolean;
    try {
      admitted = await wait;
    } catch (error) {
      asked.demand.leave();
      throw error;
    }
    if (admitted) return asked;
    asked.demand.leave();
    return takeSlot(connect, acquireTimeoutMs);
  })();
}

/** The other half of `takeSlot`. */
export function freeSlot(pool: GatedPool): void {
  pool.gate.leave();
  pool.demand.leave();
}

interface Waiter {
  readonly settle: (admitted: boolean) => void;
  readonly refuse: (reason: DbError) => void;
  disarm: () => void;
}

export function poolGate(max: number, schedule: Scheduler = unrefSchedule): PoolGate {
  let out = 0;
  // A Set: FIFO by insertion, and a waiter past its deadline leaves from the middle in O(1).
  const waiting = new Set<Waiter>();

  return {
    enter(acquireTimeoutMs) {
      // `leave` hands a slot over rather than freeing it, so a free slot means nobody is queued.
      if (out < max) {
        out += 1;
        return undefined;
      }
      return new Promise<boolean>((settle, refuse) => {
        const waiter: Waiter = { settle, refuse, disarm: () => undefined };
        waiting.add(waiter);
        if (acquireTimeoutMs <= 0) return;
        waiter.disarm = schedule(() => {
          waiting.delete(waiter);
          refuse(poolAcquireTimeout(acquireTimeoutMs, max));
        }, acquireTimeoutMs);
      });
    },
    leave() {
      const next = waiting.values().next();
      if (next.done === true) {
        out = Math.max(0, out - 1);
        return;
      }
      // Handed over: `out` does not move, the slot changes hands.
      waiting.delete(next.value);
      next.value.disarm();
      next.value.settle(true);
    },
    handOverWaiting() {
      for (const waiter of waiting) {
        waiter.disarm();
        waiter.settle(false);
      }
      waiting.clear();
    },
    refuseWaiting(reason) {
      for (const waiter of waiting) {
        waiter.disarm();
        waiter.refuse(reason);
      }
      waiting.clear();
    },
  };
}
