// Single responsibility: how many units of work may be out on the pool at once, and how long the
// next one waits. `Bun.SQL` queues past `max` with no bound and publishes no occupancy, so this counts
// in front of it: a statement and a pin each hold one slot, and a full pool refuses on one deadline.

import { isUltimateError, type Scheduler, throwIfAborted, tryUseContext } from '@ultimat3/core';
import { type DbError, poolAcquireTimeout } from './errors';
import type { PoolDemand } from './pool-gauge';
import { unrefSchedule } from './pool-timer';
import { statementVerb } from './statement-shape';

/**
 * How a queued waiter leaves early: when `signal` aborts, `reason()` is what it is refused with, or
 * `undefined` to keep its place. Asked only once the waiter actually queues.
 */
export interface QueueExit {
  readonly signal: AbortSignal;
  reason(): unknown;
}

export interface PoolGate {
  /**
   * Take a slot. `undefined` when one was free, so the path that never waits pays no promise and
   * sends in the caller's own turn. Otherwise resolves `true` when the slot arrives, `false` when
   * this pool retired first, and rejects past `acquireTimeoutMs` (`X_DB_POOL_EXHAUSTED`) or with
   * `exit`'s reason when its signal aborts first. `0` waits forever.
   */
  enter(acquireTimeoutMs: number, exit?: () => QueueExit | undefined): Promise<boolean> | undefined;
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
 * Whether the scope's abort takes a queued waiter out — the rule `statement-cancel.ts` applies to a
 * statement in flight, applied before it is sent. A coded reason (a deadline, a job's cancel) is
 * somebody answered: any waiter leaves with that very error. An uncoded hang-up takes out a pooled
 * `select` only, as core's `X_ABORTED`: a write or a pin keeps its place, since a click followed by a navigation must
 * keep landing (`abandonment()`). A scope already aborted when it asks is not watched at all.
 */
function scopeExit(statement: string | undefined): QueueExit | undefined {
  const ctx = tryUseContext();
  if (ctx === undefined || ctx.signal.aborted) return undefined;
  const { signal } = ctx;
  return {
    signal,
    reason() {
      if (isUltimateError(signal.reason)) return signal.reason;
      if (statement === undefined || statementVerb(statement) !== 'select') return undefined;
      try {
        throwIfAborted(ctx);
      } catch (aborted) {
        return aborted;
      }
      return undefined;
    },
  };
}

/**
 * A slot on the current pool, counted from the ask: a statement queued behind a full pool is exactly
 * what `db_pool_waiting` reports. Answers the pool itself when a slot was free, so a caller checking
 * `instanceof Promise` sends in its own turn. A retirement during the wait re-asks the pool that
 * replaced it, with a fresh deadline: the work was never sent, so it can only be late, never doubled.
 * `statement` is a pooled statement's text, `undefined` for a pin: its verb and the scope are read
 * only once it queues, so the path that never waits pays neither (`scopeExit`).
 */
export function takeSlot<P extends GatedPool>(
  connect: () => P,
  acquireTimeoutMs: number,
  statement: string | undefined,
): P | Promise<P> {
  const asked = connect();
  asked.demand.enter();
  const wait = asked.gate.enter(acquireTimeoutMs, () => scopeExit(statement));
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
    return takeSlot(connect, acquireTimeoutMs, statement);
  })();
}

/** The other half of `takeSlot`. */
export function freeSlot(pool: GatedPool): void {
  pool.gate.leave();
  pool.demand.leave();
}

interface Waiter {
  readonly settle: (admitted: boolean) => void;
  readonly refuse: (reason: unknown) => void;
  /** Drops the deadline and the abort listener: called on every way out of the queue. */
  disarm: () => void;
}

export function poolGate(max: number, schedule: Scheduler = unrefSchedule): PoolGate {
  let out = 0;
  // A Set: FIFO by insertion, and a waiter past its deadline leaves from the middle in O(1).
  const waiting = new Set<Waiter>();

  return {
    enter(acquireTimeoutMs, exit) {
      // `leave` hands a slot over rather than freeing it, so a free slot means nobody is queued.
      if (out < max) {
        out += 1;
        return undefined;
      }
      return new Promise<boolean>((settle, refuse) => {
        const waiter: Waiter = { settle, refuse, disarm: () => undefined };
        waiting.add(waiter);
        const disarmTimer =
          acquireTimeoutMs <= 0
            ? undefined
            : schedule(() => {
                waiting.delete(waiter);
                waiter.disarm();
                refuse(poolAcquireTimeout(acquireTimeoutMs, max));
              }, acquireTimeoutMs);
        const leaving = exit?.();
        const onAbort = (): void => {
          const reason = leaving?.reason();
          if (reason === undefined || !waiting.delete(waiter)) return;
          waiter.disarm();
          refuse(reason);
        };
        leaving?.signal.addEventListener('abort', onAbort, { once: true });
        waiter.disarm = () => {
          disarmTimer?.();
          leaving?.signal.removeEventListener('abort', onAbort);
        };
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
