// Single responsibility: noticing a pooled statement nobody answered. `statement_timeout` is the
// server's, so it cannot fire when the server or the path is gone, and the kernel's retransmit window
// is about 15 minutes. One timer per pool walks the statements in flight; a statement never arms one.

import type { Scheduler } from '@ultimat3/core';
import { statementUnanswered } from './errors';
import type { PinStatement } from './pool-pins';
import { unrefSchedule } from './pool-timer';
import { statementExcerpt } from './statement-excerpt';

/** Past `statementTimeoutMs` plus this, the server's own bound had to have answered. */
export const UNANSWERED_GRACE_MS = 5_000;
export const SWEEP_INTERVAL_MS = 1_000;

export interface PoolSweepOptions<Owner> {
  /** `statementTimeoutMs + UNANSWERED_GRACE_MS`. The caller skips the sweep when the role has none. */
  readonly deadlineMs: number;
  /** A statement on `owner` missed. Called before its caller hears, so a retry finds the new pool. */
  readonly onMiss: (owner: Owner, excerpt: string, waitedMs: number) => void;
  readonly schedule?: Scheduler | undefined;
}

export interface PoolSweep<Owner> {
  /** `sending`'s answer, or `X_DB_UNAVAILABLE` once it is past the deadline. */
  track<T>(owner: Owner, text: string, sending: Promise<T>): Promise<T>;
  /** A statement on a pin: aged by the same ticks, never rejected here (`pool-pins.ts`). */
  pinned(): PinStatement;
}

interface InFlight<Owner> {
  readonly owner: Owner;
  readonly text: string;
  readonly startedAtTick: number;
  readonly reject: (reason: unknown) => void;
}

/**
 * Age is counted in ticks that FIRED, never read from a clock. The funnel promises a statement no
 * clock read when nothing observes it (`observe.test.ts`), and the count is also the right answer to
 * a frozen process: a long GC or a SIGSTOP costs one tick however long it lasted, so answers sitting
 * unread in their sockets are never judged late. A statement began somewhere inside its first tick,
 * hence the extra one: nothing is judged before the deadline, and everything within one interval of it.
 */
export function poolSweep<Owner>(options: PoolSweepOptions<Owner>): PoolSweep<Owner> {
  const schedule = options.schedule ?? unrefSchedule;
  const ticksToMiss = Math.ceil(options.deadlineMs / SWEEP_INTERVAL_MS) + 1;
  // Insertion order is start order and every statement has the same deadline, so a walk stops at
  // the first one still in time, whatever the pool's size.
  const inFlight = new Set<InFlight<Owner>>();
  // Only their start tick: a pin statement keeps the timer armed so its age keeps counting.
  const pinnedAt = new Set<{ readonly startedAtTick: number }>();
  let ticks = 0;
  let armed = false;

  function arm(): void {
    armed = true;
    schedule(tick, SWEEP_INTERVAL_MS);
  }

  function tick(): void {
    armed = false;
    ticks += 1;
    for (const entry of inFlight) {
      const age = ticks - entry.startedAtTick;
      if (age < ticksToMiss) break;
      inFlight.delete(entry);
      const excerpt = statementExcerpt(entry.text);
      options.onMiss(entry.owner, excerpt, age * SWEEP_INTERVAL_MS);
      entry.reject(statementUnanswered(excerpt, options.deadlineMs));
    }
    if (inFlight.size > 0 || pinnedAt.size > 0) arm();
  }

  return {
    track<T>(owner: Owner, text: string, sending: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const entry: InFlight<Owner> = { owner, text, startedAtTick: ticks, reject };
        inFlight.add(entry);
        if (!armed) arm();
        // Both arms stay attached after a miss: the statement rejects when its pool closes, and
        // nobody else is left holding that promise.
        sending.then(
          (value) => {
            inFlight.delete(entry);
            resolve(value);
          },
          (error: unknown) => {
            inFlight.delete(entry);
            reject(error);
          },
        );
      });
    },
    pinned(): PinStatement {
      const entry = { startedAtTick: ticks };
      pinnedAt.add(entry);
      if (!armed) arm();
      return {
        overdue: () => ticks - entry.startedAtTick >= ticksToMiss,
        done: () => {
          pinnedAt.delete(entry);
        },
      };
    },
  };
}
